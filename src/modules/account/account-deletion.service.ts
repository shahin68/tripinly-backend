import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Job } from 'bullmq';
import { createHmac } from 'node:crypto';
import type { Env } from '../../common/config/env';
import { decrypt } from '../../common/crypto/crypto';
import { IdempotencyStore } from '../../common/idempotency/idempotency.store';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { AppleIdentityVerifier } from '../auth/identity/apple-identity.verifier';
import { RevenueCatClient } from '../billing/revenuecat.client';
import { closeReportsOnMissingTargets } from '../moderation/report-targets';
import { EmailService } from '../notifications/email/email.service';
import { PhotoJobsService } from '../photos/photos.queue';
import { PhotosService } from '../photos/photos.service';
import { recomputePopularity } from '../places/popularity';
import { CommentsService } from '../social/comments.service';
import { recountLikes } from '../social/counters.service';
import { TripsService } from '../trips/trips.service';
import { USERNAME_HOLD_DAYS } from '../users/username';
import type { DeleteAccountJob } from './account.queue';
import { exportPrefix } from './export-keys';

const BATCH = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const LIKE_TYPES = ['trip', 'marker', 'photo', 'comment'] as const;

/** Keyed hash of a deleted user's id: links their consent proofs without naming them. */
export function consentSubjectHash(userId: string, key: Buffer): string {
  return createHmac('sha256', key).update(userId).digest('hex');
}

/**
 * Deletes everything about a user, in the order of the account-deletion
 * skill. Every step is idempotent and progress is kept in the job data, so a
 * retry after a crash picks up where the last attempt stopped.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);
  private readonly encryptionKey: Buffer;
  private readonly retentionYears: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
    private readonly photos: PhotosService,
    private readonly comments: CommentsService,
    private readonly photoJobs: PhotoJobsService,
    private readonly storage: StorageService,
    private readonly apple: AppleIdentityVerifier,
    private readonly revenueCat: RevenueCatClient,
    private readonly email: EmailService,
    private readonly events: EventEmitter2,
    private readonly idempotency: IdempotencyStore,
    config: ConfigService<Env, true>,
  ) {
    this.encryptionKey = Buffer.from(
      config.get('ENCRYPTION_KEY', { infer: true }),
      'base64',
    );
    this.retentionYears = config.get('CONSENT_PROOF_RETENTION_YEARS', {
      infer: true,
    });
  }

  async run(job: Job<DeleteAccountJob>): Promise<void> {
    const { userId } = job.data;
    const save = (patch: Partial<DeleteAccountJob>) =>
      job.updateData({ ...job.data, ...patch });

    if (!job.data.userDeleted) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { status: true, locale: true },
      });
      if (!user) {
        await save({ userDeleted: true });
      } else {
        if (user.status !== 'deleting') {
          this.logger.warn(
            'Deletion job for an account not marked deleting; skipped',
          );
          return;
        }
        if (job.data.email === undefined) {
          await save({
            email: await this.contactEmail(userId),
            locale: user.locale,
          });
        }
        if (!job.data.photoIds) {
          await save({ photoIds: await this.collectPhotoIds(userId) });
        }
        await this.deleteOwnedTrips(userId);
        await this.deleteContentElsewhere(userId);
        await this.deleteLikes(userId);
        await this.cleanUpReferences(userId);
        if (!job.data.appleRevoked) {
          await this.revokeApple(userId);
          await save({ appleRevoked: true });
        }
        if (!job.data.revenueCatDeleted) {
          await this.revenueCat.deleteSubscriber(userId);
          await save({ revenueCatDeleted: true });
        }
        await this.deleteUserRow(userId);
        await save({ userDeleted: true });
      }
    }

    if (!job.data.idempotencyPurged) {
      // Stored responses to content-creating POSTs (24 h).
      await this.idempotency.purgeUser(userId);
      await save({ idempotencyPurged: true });
    }

    if (!job.data.filesQueued) {
      await this.photoJobs.deleteFiles(job.data.photoIds ?? []);
      if (this.storage.enabled) {
        await this.storage.deletePrefix(exportPrefix(userId));
      }
      await save({ filesQueued: true });
    }

    if (!job.data.emailed) {
      if (job.data.email) {
        await this.email.send(
          'account_deletion_confirmed',
          job.data.email,
          job.data.locale ?? 'en',
          {},
        );
      }
      // The address is dropped as soon as it's no longer needed.
      await save({ emailed: true, email: null });
    }
    this.logger.log('Account deleted');
  }

  /** The address a confirmation goes to: the first identity that has one. */
  private async contactEmail(userId: string): Promise<string | null> {
    const identity = await this.prisma.authIdentity.findFirst({
      where: { userId, email: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { email: true },
    });
    return identity?.email ?? null;
  }

  /** Photos they uploaded anywhere, plus every photo in trips they own. */
  private async collectPhotoIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.photo.findMany({
      where: { OR: [{ uploaderId: userId }, { trip: { ownerId: userId } }] },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** Every trip they own, even with other editors (days, markers, photos, comments, likes go with it). */
  private async deleteOwnedTrips(userId: string): Promise<void> {
    for (;;) {
      const trips = await this.prisma.trip.findMany({
        where: { ownerId: userId },
        select: { id: true },
        take: BATCH,
      });
      if (trips.length === 0) return;
      for (const trip of trips) await this.trips.remove(userId, trip.id);
    }
  }

  /**
   * Their photos (covers pass on) and comments in other people's trips, and
   * their memberships. Markers they added stay, without an author.
   */
  private async deleteContentElsewhere(userId: string): Promise<void> {
    for (;;) {
      const photos = await this.prisma.photo.findMany({
        where: { uploaderId: userId },
        select: { id: true, markerId: true, tripId: true },
        take: BATCH,
      });
      if (photos.length === 0) break;
      for (const photo of photos) await this.photos.remove(userId, photo);
    }
    for (;;) {
      const comments = await this.prisma.comment.findMany({
        where: { authorId: userId },
        select: { id: true, markerId: true, tripId: true },
        take: BATCH,
      });
      if (comments.length === 0) break;
      for (const comment of comments) {
        await this.comments.remove(userId, comment);
      }
    }
    const memberships = await this.prisma.tripMember.findMany({
      where: { userId },
      select: { tripId: true },
    });
    await this.prisma.tripMember.deleteMany({ where: { userId } });
    for (const { tripId } of memberships) {
      this.events.emit(
        DomainEvents.MEMBER_REMOVED,
        domainEvent(
          DomainEvents.MEMBER_REMOVED,
          userId,
          { userId, reason: 'left' },
          tripId,
        ),
      );
    }
  }

  /** All their likes, then the counts and place popularity they fed. */
  private async deleteLikes(userId: string): Promise<void> {
    for (;;) {
      const likes = await this.prisma.like.findMany({
        where: { userId },
        select: { id: true, targetType: true, targetId: true },
        take: BATCH * 10,
      });
      if (likes.length === 0) return;
      const idsOf = (type: string) =>
        likes.filter((l) => l.targetType === type).map((l) => l.targetId);
      await this.prisma.$transaction(async (tx) => {
        const markers = await tx.marker.findMany({
          where: { id: { in: idsOf('marker') } },
          select: { placeId: true },
        });
        await tx.like.deleteMany({
          where: { id: { in: likes.map((like) => like.id) } },
        });
        for (const type of LIKE_TYPES) {
          await recountLikes(tx, type, idsOf(type));
        }
        await recomputePopularity(tx, [
          ...markers.map((marker) => marker.placeId),
          ...idsOf('place'),
        ]);
      });
    }
  }

  /**
   * Notifications they caused: grouped ones (likes, collaborator changes) lose
   * them from their list and pass to the next person, or go when nobody is
   * left; the rest are deleted. Reports they filed lose the reporter by
   * foreign key; reports about them or their deleted content are closed.
   */
  private async cleanUpReferences(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        UPDATE notifications SET
          payload = jsonb_set(payload, '{likerIds}', (payload->'likerIds') - ${userId}::text),
          count = greatest(count - 1, 0)
        WHERE type = 'likes_grouped' AND payload->'likerIds' ? ${userId}::text`,
      this.prisma.$executeRaw`
        UPDATE notifications SET
          payload = jsonb_set(payload, '{actorIds}', (payload->'actorIds') - ${userId}::text)
        WHERE type = 'trip_changed_by_collaborator' AND payload->'actorIds' ? ${userId}::text`,
      // Theirs alone (or not grouped): delete.
      this.prisma.$executeRaw`
        DELETE FROM notifications
        WHERE "actorId" = ${userId}::uuid AND NOT (
          (type = 'likes_grouped' AND jsonb_array_length(payload->'likerIds') > 0)
          OR (type = 'trip_changed_by_collaborator' AND jsonb_array_length(payload->'actorIds') > 0)
        )`,
      // Shared with others: the latest remaining person becomes the actor.
      this.prisma.$executeRaw`
        UPDATE notifications SET "actorId" = (
          CASE type
            WHEN 'likes_grouped' THEN payload->'likerIds'->>0
            ELSE payload->'actorIds'->>0
          END)::uuid
        WHERE "actorId" = ${userId}::uuid`,
    ]);
    await closeReportsOnMissingTargets(this.prisma, userId);
  }

  private async revokeApple(userId: string): Promise<void> {
    const identities = await this.prisma.authIdentity.findMany({
      where: { userId, provider: 'apple', appleRefreshToken: { not: null } },
      select: { appleRefreshToken: true },
    });
    for (const identity of identities) {
      let token: string;
      try {
        token = decrypt(identity.appleRefreshToken!, this.encryptionKey);
      } catch {
        this.logger.warn(
          'Apple refresh token could not be decrypted; revocation skipped',
        );
        continue;
      }
      await this.apple.revoke(token);
    }
  }

  /**
   * Consent proof, username hold and the user row in one transaction. The
   * rest (identities, tokens, devices, blocks, notifications to them,
   * entitlements, invites, exports, settings) goes with the row by cascade.
   */
  private async deleteUserRow(userId: string): Promise<void> {
    const retainUntil = new Date();
    retainUntil.setUTCFullYear(
      retainUntil.getUTCFullYear() + this.retentionYears,
    );
    const subjectHash = consentSubjectHash(userId, this.encryptionKey);
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { username: true, consents: true },
      });
      if (!user) return;
      if (user.consents.length > 0) {
        await tx.consentProof.createMany({
          data: user.consents.map((consent) => ({
            subjectHash,
            documentType: consent.documentType,
            version: consent.version,
            locale: consent.locale,
            grantedAt: consent.grantedAt,
            withdrawnAt: consent.withdrawnAt,
            retainUntil,
          })),
        });
      }
      if (user.username) {
        const releasedAt = new Date(Date.now() + USERNAME_HOLD_DAYS * DAY_MS);
        await tx.usernameHold.upsert({
          where: { username: user.username },
          create: { username: user.username, releasedAt },
          update: { releasedAt },
        });
      }
      await tx.user.delete({ where: { id: userId } });
    });
  }
}
