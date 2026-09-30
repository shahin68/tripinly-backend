import { HttpStatus, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  type Page,
  toPage,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import type { ModerationAction, Report } from '../../generated/prisma/client';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { SessionRevocationService } from '../auth/session-revocation.service';
import { MarkersService } from '../markers/markers.service';
import { thumbUrl } from '../photos/photo-keys';
import { PhotosService } from '../photos/photos.service';
import { recomputePopularity } from '../places/popularity';
import { CommentsService } from '../social/comments.service';
import { likedPlaceIds, lockTrip, TripsService } from '../trips/trips.service';
import {
  describeTargets,
  type TargetInfo,
  targetKey,
  type TargetRef,
} from './report-targets';
import type {
  AdminReportDto,
  AdminReportsQueryDto,
  ReviewAction,
  ReviewReportDto,
} from './reports.dto';

type ReportWithReporter = Report & {
  reporter: { id: string; username: string | null } | null;
};

/**
 * Admin review of reports (moderation skill). Every action is written to the
 * audit log and resolves all open reports on the same target.
 */
@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly trips: TripsService,
    private readonly markers: MarkersService,
    private readonly photos: PhotosService,
    private readonly comments: CommentsService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly revocations: SessionRevocationService,
    private readonly events: EventEmitter2,
  ) {}

  /** Oldest first, so nothing waits forever. */
  async list(query: AdminReportsQueryDto): Promise<Page<AdminReportDto>> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.prisma.report.findMany({
      where: {
        status: query.status ?? 'open',
        ...(after && {
          OR: [
            { createdAt: { gt: new Date(after.at) } },
            { createdAt: new Date(after.at), id: { gt: after.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: { reporter: { select: { id: true, username: true } } },
    });
    const dtos = await this.toDtos(rows);
    const byId = new Map(dtos.map((dto) => [dto.id, dto]));
    return toPage(
      rows,
      limit,
      (row) => ({ at: row.createdAt.toISOString(), id: row.id }),
      (row) => byId.get(row.id)!,
    );
  }

  async review(
    adminId: string,
    reportId: string,
    input: ReviewReportDto,
  ): Promise<AdminReportDto> {
    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });
    if (!report) throw AppException.notFound();
    const ref: TargetRef = report;
    const info = (await describeTargets(this.prisma, [ref])).get(
      targetKey(ref),
    )!;

    let audited: TargetRef = ref;
    switch (input.action) {
      case 'dismiss':
        break;
      case 'hide_content':
        this.requireContent(ref, info, input.action);
        await this.hide(ref);
        break;
      case 'delete_content':
        this.requireContent(ref, info, input.action);
        await this.remove(adminId, ref);
        break;
      case 'suspend_user': {
        if (!info.exists || !info.ownerId) throw notApplicable(input.action);
        await this.suspend(adminId, info.ownerId);
        audited = { targetType: 'user', targetId: info.ownerId };
        break;
      }
    }

    const reviewedAt = new Date();
    const action: ModerationAction = input.action;
    await this.prisma.$transaction([
      this.prisma.report.updateMany({
        where: {
          OR: [
            { id: report.id },
            {
              targetType: report.targetType,
              targetId: report.targetId,
              status: 'open',
            },
          ],
        },
        data: {
          status: action === 'dismiss' ? 'dismissed' : 'actioned',
          action,
          reviewedById: adminId,
          reviewedAt,
        },
      }),
      this.prisma.adminAuditLog.create({
        data: {
          adminId,
          action,
          targetType: audited.targetType,
          targetId: audited.targetId,
          reportId: report.id,
          note: input.note,
        },
      }),
    ]);

    const updated = await this.prisma.report.findUniqueOrThrow({
      where: { id: report.id },
      include: { reporter: { select: { id: true, username: true } } },
    });
    return (await this.toDtos([updated]))[0];
  }

  private requireContent(
    ref: TargetRef,
    info: TargetInfo,
    action: ReviewAction,
  ): void {
    if (ref.targetType === 'user') throw notApplicable(action);
    if (!info.exists) throw AppException.notFound();
  }

  /**
   * Hidden content disappears for everyone but admins and its author, who sees
   * it marked hidden. Hiding a public trip or liked marker updates popularity.
   */
  private async hide(ref: TargetRef): Promise<void> {
    const now = new Date();
    switch (ref.targetType) {
      case 'trip':
        await this.prisma.$transaction(async (tx) => {
          await lockTrip(tx, ref.targetId);
          await tx.trip.updateMany({
            where: { id: ref.targetId, hiddenAt: null },
            data: { hiddenAt: now },
          });
          await recomputePopularity(
            tx,
            await likedPlaceIds(tx, { tripId: ref.targetId }),
          );
        });
        return;
      case 'marker':
        await this.prisma.$transaction(async (tx) => {
          const marker = await tx.marker.update({
            where: { id: ref.targetId },
            data: { hiddenAt: now },
            select: { placeId: true, likeCount: true },
          });
          if (marker.likeCount > 0) {
            await recomputePopularity(tx, [marker.placeId]);
          }
        });
        return;
      case 'photo':
        await this.prisma.$transaction(async (tx) => {
          const { tripId } = await tx.photo.findUniqueOrThrow({
            where: { id: ref.targetId },
            select: { tripId: true },
          });
          // Trip first, like every other photo write, so locks never cross.
          await lockTrip(tx, tripId);
          const photo = await tx.photo.update({
            where: { id: ref.targetId },
            data: { hiddenAt: now },
            select: { id: true, markerId: true },
          });
          const marker = await tx.marker.findUnique({
            where: { id: photo.markerId },
            select: { coverPhotoId: true },
          });
          if (marker?.coverPhotoId !== photo.id) return;
          const next = await tx.photo.findFirst({
            where: {
              markerId: photo.markerId,
              status: 'ready',
              hiddenAt: null,
            },
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
            select: { id: true },
          });
          await tx.marker.update({
            where: { id: photo.markerId },
            data: { coverPhotoId: next?.id ?? null },
          });
        });
        return;
      case 'comment':
        await this.prisma.comment.update({
          where: { id: ref.targetId },
          data: { hiddenAt: now },
        });
        return;
      case 'user':
        return;
    }
  }

  /** Hard delete through the owning service, with storage cleanup and events. */
  private async remove(adminId: string, ref: TargetRef): Promise<void> {
    switch (ref.targetType) {
      case 'trip':
        return this.trips.remove(adminId, ref.targetId);
      case 'marker':
        await this.markers.remove(adminId, ref.targetId);
        return;
      case 'photo':
        await this.photos.remove(adminId, ref.targetId);
        return;
      case 'comment':
        await this.comments.remove(adminId, ref.targetId);
        return;
      case 'user':
        return;
    }
  }

  /**
   * Signs the user out everywhere at once and keeps them out; their public
   * content leaves discovery while suspended.
   */
  private async suspend(adminId: string, userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, status: true },
    });
    if (!user || user.status === 'deleting') throw AppException.notFound();
    if (user.role === 'admin') throw AppException.forbidden();
    await this.prisma.user.update({
      where: { id: userId },
      data: { status: 'suspended' },
    });
    await this.refreshTokens.revokeAll(userId);
    await this.revocations.revoke(userId, ErrorCode.ACCOUNT_SUSPENDED);
    this.events.emit(
      DomainEvents.ACCOUNT_CLOSED,
      domainEvent(DomainEvents.ACCOUNT_CLOSED, adminId, {
        userId,
        reason: 'suspended',
      }),
    );
  }

  private async toDtos(rows: ReportWithReporter[]): Promise<AdminReportDto[]> {
    if (rows.length === 0) return [];
    const [infos, counts] = await Promise.all([
      describeTargets(this.prisma, rows),
      this.prisma.report.groupBy({
        by: ['targetType', 'targetId'],
        where: {
          status: 'open',
          OR: rows.map((row) => ({
            targetType: row.targetType,
            targetId: row.targetId,
          })),
        },
        _count: { _all: true },
      }),
    ]);
    const countOf = new Map(counts.map((c) => [targetKey(c), c._count._all]));
    const ownerIds = [
      ...new Set(
        [...infos.values()].flatMap((info) =>
          info.ownerId ? [info.ownerId] : [],
        ),
      ),
    ];
    const owners = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, username: true },
        })
      ).map((user) => [user.id, user]),
    );
    return rows.map((row) => {
      const info = infos.get(targetKey(row))!;
      return {
        id: row.id,
        targetType: row.targetType,
        targetId: row.targetId,
        reason: row.reason,
        details: row.details,
        status: row.status,
        action: row.action,
        createdAt: row.createdAt.toISOString(),
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
        reporter: row.reporter,
        openReportCount: countOf.get(targetKey(row)) ?? 0,
        target: {
          exists: info.exists,
          owner: info.ownerId ? (owners.get(info.ownerId) ?? null) : null,
          text: info.text,
          thumbUrl: thumbUrl(this.storage, info.photoId),
          tripId: info.tripId,
          hidden: info.hidden,
        },
      };
    });
  }
}

function notApplicable(action: ReviewAction): AppException {
  return new AppException(ErrorCode.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, {
    fields: { action: [`notApplicable:${action}`] },
  });
}
