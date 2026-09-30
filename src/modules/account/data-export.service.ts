import { Injectable, Logger } from '@nestjs/common';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { I18nService } from 'nestjs-i18n';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toCalendarDate } from '../../common/dates/calendar-date';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { EmailService } from '../notifications/email/email.service';
import { resolveLanguage } from '../notifications/notification-renderer';
import { photoKeys } from '../photos/photo-keys';
import { exportKey } from './export-keys';

/** How long an export's file and link live. */
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const date = (value: Date | null) => (value ? toCalendarDate(value) : null);
const iso = (value: Date | null) => value?.toISOString() ?? null;

/**
 * Builds the GDPR export ZIP (account-deletion skill) in a temp file, uploads
 * it, emails a link valid 7 days, and expires it afterwards.
 */
@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly email: EmailService,
    private readonly i18n: I18nService,
  ) {}

  async build(exportId: string): Promise<void> {
    const row = await this.prisma.dataExport.findUnique({
      where: { id: exportId },
      include: { user: { select: { status: true, locale: true } } },
    });
    if (!row || row.status !== 'pending') return;
    if (row.user.status !== 'active') {
      await this.markFailed(exportId);
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), 'tripinly-export-'));
    const path = join(dir, 'export.zip');
    try {
      await this.writeZip(row.userId, row.createdAt, row.user.locale, path);
      const { size } = await stat(path);
      const key = exportKey(row.userId, row.id);
      await this.storage.putFile(key, path, size, 'application/zip');
      const readyAt = new Date();
      const expiresAt = new Date(readyAt.getTime() + EXPORT_TTL_MS);
      await this.prisma.dataExport.update({
        where: { id: exportId },
        data: { status: 'ready', bytes: size, readyAt, expiresAt },
      });
      const to = await this.contactEmail(row.userId);
      const downloadUrl = this.storage.signedGetUrlFor(
        key,
        EXPORT_TTL_MS / 1000,
      );
      if (to && downloadUrl) {
        await this.email.send('data_export_ready', to, row.user.locale, {
          downloadUrl,
        });
      }
      this.logger.log(`Data export ready (${size} bytes)`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async markFailed(exportId: string): Promise<void> {
    await this.prisma.dataExport.updateMany({
      where: { id: exportId, status: 'pending' },
      data: { status: 'failed' },
    });
  }

  /** Deletes the files of exports past their time and marks them expired. */
  async expireOld(): Promise<number> {
    const due = await this.prisma.dataExport.findMany({
      where: { status: 'ready', expiresAt: { lte: new Date() } },
      select: { id: true, userId: true },
      take: 500,
    });
    for (const row of due) {
      if (this.storage.enabled) {
        await this.storage.deletePrefix(exportKey(row.userId, row.id));
      }
      await this.prisma.dataExport.update({
        where: { id: row.id },
        data: { status: 'expired' },
      });
    }
    return due.length;
  }

  private async contactEmail(userId: string): Promise<string | null> {
    const identity = await this.prisma.authIdentity.findFirst({
      where: { userId, email: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { email: true },
    });
    return identity?.email ?? null;
  }

  private async writeZip(
    userId: string,
    createdAt: Date,
    locale: string,
    path: string,
  ): Promise<void> {
    const out = createWriteStream(path);
    const finished = once(out, 'finish');
    let failure: Error | null = null;
    const zip = new Zip((error, chunk, final) => {
      if (error) {
        failure = error;
        out.destroy(error);
        return;
      }
      out.write(chunk);
      if (final) out.end();
    });
    const drain = async () => {
      if (failure) throw failure as Error;
      if (out.writableNeedDrain) await once(out, 'drain');
    };
    const addJson = async (name: string, data: unknown) => {
      const file = new ZipDeflate(name, { level: 6 });
      zip.add(file);
      file.push(Buffer.from(JSON.stringify(data, null, 2), 'utf8'), true);
      await drain();
    };

    const lang = resolveLanguage(locale);
    const readme = new ZipDeflate('README.txt', { level: 6 });
    zip.add(readme);
    readme.push(
      Buffer.from(
        String(
          this.i18n.t('export.readme', {
            lang,
            args: { createdAt: createdAt.toISOString() },
          }),
        ),
        'utf8',
      ),
      true,
    );
    await addJson('profile.json', await this.profile(userId));
    await addJson('consents.json', await this.consents(userId));
    await addJson('trips.json', await this.trips(userId));
    await addJson('comments.json', await this.comments(userId));
    await addJson('likes.json', await this.likes(userId));
    await addJson('notifications.json', await this.notifications(userId));
    await addJson('blocks.json', await this.blocks(userId));
    await addJson('reports.json', await this.reports(userId));

    // Originals, already stripped of location and camera data at processing.
    let cursor: string | undefined;
    for (;;) {
      const photos = await this.prisma.photo.findMany({
        where: { uploaderId: userId, status: 'ready' },
        select: { id: true, mimeType: true },
        orderBy: { id: 'asc' },
        take: 50,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (photos.length === 0) break;
      for (const photo of photos) {
        let body: Buffer;
        try {
          body = await this.storage.get(photoKeys(photo.id).original);
        } catch {
          continue; // deleted meanwhile
        }
        const file = new ZipPassThrough(
          `photos/${photo.id}.${EXTENSIONS[photo.mimeType] ?? 'bin'}`,
        );
        zip.add(file);
        file.push(body, true);
        await drain();
      }
      cursor = photos[photos.length - 1].id;
    }

    zip.end();
    await finished;
    if (failure) throw failure as Error;
  }

  private async profile(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        identities: {
          select: { provider: true, email: true, createdAt: true },
        },
        devices: {
          select: {
            platform: true,
            locale: true,
            lastSeenAt: true,
            createdAt: true,
          },
        },
        entitlements: {
          select: {
            feature: true,
            source: true,
            expiresAt: true,
            createdAt: true,
          },
        },
        notificationSettings: true,
      },
    });
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      birthDate: date(user.birthDate),
      locale: user.locale,
      defaultTripVisibility: user.defaultTripVisibility,
      createdAt: iso(user.createdAt),
      onboardedAt: iso(user.onboardedAt),
      signInMethods: user.identities.map((identity) => ({
        provider: identity.provider,
        email: identity.email,
        createdAt: iso(identity.createdAt),
      })),
      devices: user.devices.map((device) => ({
        platform: device.platform,
        locale: device.locale,
        lastSeenAt: iso(device.lastSeenAt),
        createdAt: iso(device.createdAt),
      })),
      paidFeatures: user.entitlements.map((entitlement) => ({
        feature: entitlement.feature,
        source: entitlement.source,
        expiresAt: iso(entitlement.expiresAt),
        createdAt: iso(entitlement.createdAt),
      })),
      notificationSettings: user.notificationSettings
        ? {
            commentOnMarker: user.notificationSettings.commentOnMarker,
            addedToTrip: user.notificationSettings.addedToTrip,
            tripChangedByCollaborator:
              user.notificationSettings.tripChangedByCollaborator,
            likesGrouped: user.notificationSettings.likesGrouped,
          }
        : null,
    };
  }

  private async consents(userId: string) {
    const rows = await this.prisma.consent.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      documentType: row.documentType,
      version: row.version,
      locale: row.locale,
      grantedAt: iso(row.grantedAt),
      withdrawnAt: iso(row.withdrawnAt),
      recordedAt: iso(row.createdAt),
    }));
  }

  private async trips(userId: string) {
    const memberships = await this.prisma.tripMember.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: {
        trip: {
          include: {
            days: {
              orderBy: { position: 'asc' },
              include: {
                markers: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
              },
            },
          },
        },
      },
    });
    return memberships.map(({ role, trip }) => ({
      id: trip.id,
      title: trip.title,
      role,
      visibility: trip.visibility,
      startDate: date(trip.startDate),
      endDate: date(trip.endDate),
      copiedFromTripId: trip.copiedFromTripId,
      createdAt: iso(trip.createdAt),
      days: trip.days.map((day) => ({
        id: day.id,
        position: day.position,
        markers: day.markers.map((marker) => ({
          id: marker.id,
          name: marker.name,
          lat: marker.lat,
          lng: marker.lng,
          time: marker.time,
          placeId: marker.placeId,
          addedByMe: marker.createdById === userId,
          createdAt: iso(marker.createdAt),
        })),
      })),
    }));
  }

  private async comments(userId: string) {
    const rows = await this.prisma.comment.findMany({
      where: { authorId: userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      tripId: row.tripId,
      markerId: row.markerId,
      body: row.body,
      createdAt: iso(row.createdAt),
    }));
  }

  private async likes(userId: string) {
    const rows = await this.prisma.like.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      targetType: row.targetType,
      targetId: row.targetId,
      createdAt: iso(row.createdAt),
    }));
  }

  private async notifications(userId: string) {
    const rows = await this.prisma.notification.findMany({
      where: { recipientId: userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      tripId: row.tripId,
      markerId: row.markerId,
      count: row.count,
      details: row.payload,
      readAt: iso(row.readAt),
      createdAt: iso(row.createdAt),
    }));
  }

  private async blocks(userId: string) {
    const rows = await this.prisma.block.findMany({
      where: { blockerId: userId },
      orderBy: { createdAt: 'asc' },
      include: { blocked: { select: { username: true } } },
    });
    return rows.map((row) => ({
      username: row.blocked.username,
      createdAt: iso(row.createdAt),
    }));
  }

  private async reports(userId: string) {
    const rows = await this.prisma.report.findMany({
      where: { reporterId: userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      targetType: row.targetType,
      targetId: row.targetId,
      reason: row.reason,
      details: row.details,
      status: row.status,
      createdAt: iso(row.createdAt),
    }));
  }
}
