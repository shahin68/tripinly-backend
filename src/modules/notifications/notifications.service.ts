import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { I18nContext } from 'nestjs-i18n';
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  toPage,
} from '../../common/pagination/pagination';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { BlocksService } from '../moderation/blocks.service';
import { TripAccessService } from '../trips/trip-access.service';
import { NotificationRenderer, resolveLanguage } from './notification-renderer';
import { newsKind, type NewsKind } from './notification-types';
import {
  type MarkReadDto,
  type NewActivityDto,
  type NotificationPageDto,
  type NotificationSettingsDto,
  type NotificationsChange,
  toNotificationDto,
  type UpdateNotificationSettingsDto,
} from './notifications.dto';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: NotificationRenderer,
    private readonly access: TripAccessService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * The stops of a trip with unread notifications for me, shown as "new"
   * marks on their pins; the same entries the list shows (no blocked actors).
   */
  async newActivity(userId: string, tripId: string): Promise<NewActivityDto> {
    await this.access.assert(userId, tripId, 'view');
    const rows = await this.prisma.notification.findMany({
      where: {
        AND: [
          visibleTo(userId),
          { tripId, readAt: null, markerId: { not: null } },
        ],
      },
      select: { markerId: true, type: true, payload: true },
    });
    const unique = (list: typeof rows) => [
      ...new Set(list.map((row) => row.markerId!)),
    ];
    const of = (kind: NewsKind) =>
      unique(rows.filter((row) => newsKind(row) === kind));
    return {
      // Flames put no mark on the pin (Shahin, 2026-11-13).
      markerIds: unique(rows.filter((row) => newsKind(row) !== 'hot')),
      commentMarkerIds: of('comments'),
      photoMarkerIds: of('photos'),
      hotMarkerIds: of('hot'),
      otherMarkerIds: of('other'),
    };
  }

  /** Newest first, leaving out what visibleTo leaves out. */
  async list(
    userId: string,
    cursor?: string,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<NotificationPageDto> {
    const visible = visibleTo(userId);
    const position = cursor ? decodeCursor(cursor) : undefined;
    const [rows, unreadCount, user] = await Promise.all([
      this.prisma.notification.findMany({
        where: {
          AND: [
            visible,
            position
              ? {
                  OR: [
                    { createdAt: { lt: new Date(position.at) } },
                    {
                      createdAt: new Date(position.at),
                      id: { lt: position.id },
                    },
                  ],
                }
              : {},
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.prisma.notification.count({ where: { ...visible, readAt: null } }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { locale: true, notificationsSeenAt: true },
      }),
    ]);
    const unseenCount = await this.unseenCount(
      userId,
      user?.notificationsSeenAt,
    );
    const context = await this.renderer.context(rows);
    const lang = resolveLanguage(I18nContext.current()?.lang, user?.locale);
    const page = toPage(
      rows,
      limit,
      (row) => ({ at: row.createdAt.toISOString(), id: row.id }),
      (row) =>
        toNotificationDto(
          row,
          context,
          this.renderer.text(row, context, lang),
          this.renderer.deepLink(row, context),
        ),
    );
    return { ...page, unreadCount, unseenCount };
  }

  /** The notification center was opened: what's in it now counts as seen. */
  async markSeen(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { notificationsSeenAt: new Date() },
    });
    await this.changed(userId, 'seen', []);
  }

  async markRead(userId: string, input: MarkReadDto): Promise<void> {
    const rows = await this.prisma.notification.findMany({
      where: {
        recipientId: userId,
        readAt: null,
        ...(input.all
          ? {}
          : input.markerId
            ? { markerId: input.markerId }
            : { id: { in: input.ids ?? [] } }),
      },
      select: { id: true, type: true, payload: true, tripId: true },
    });
    // Picked in code: old likes rows have no targetType in their payload.
    const read = input.kind
      ? rows.filter((row) => newsKind(row) === input.kind)
      : rows;
    if (read.length === 0) return;
    await this.prisma.notification.updateMany({
      where: { id: { in: read.map((row) => row.id) }, readAt: null },
      data: { readAt: new Date() },
    });
    await this.changed(userId, 'read', read);
  }

  /**
   * Takes one of my notifications out of the center (only the notification:
   * the comment, like or follow stays). Unknown or someone else's: nothing.
   */
  async remove(userId: string, id: string): Promise<void> {
    const rows = await this.prisma.notification.findMany({
      where: { id, recipientId: userId },
      select: { id: true, tripId: true },
    });
    if (rows.length === 0) return;
    await this.prisma.notification.deleteMany({ where: { id } });
    await this.changed(userId, 'removed', rows);
  }

  /** Empties my notification center. */
  async clear(userId: string): Promise<void> {
    const rows = await this.prisma.notification.findMany({
      where: { recipientId: userId },
      distinct: ['tripId'],
      select: { tripId: true },
    });
    if (rows.length === 0) return;
    await this.prisma.notification.deleteMany({
      where: { recipientId: userId },
    });
    await this.changed(userId, 'cleared', rows);
  }

  /**
   * Entries new or back on top since I last opened the center and not read
   * yet: read somewhere else, an entry stops counting (2026-11-07).
   */
  private async unseenCount(
    userId: string,
    seenAt?: Date | null,
  ): Promise<number> {
    return this.prisma.notification.count({
      where: {
        AND: [
          visibleTo(userId),
          { readAt: null },
          seenAt ? { createdAt: { gt: seenAt } } : {},
        ],
      },
    });
  }

  /** Every screen and device of mine drops the same dots (notifications.changed). */
  private async changed(
    userId: string,
    change: NotificationsChange['change'],
    rows: { id?: string; tripId: string | null }[],
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificationsSeenAt: true },
    });
    const data: NotificationsChange = {
      change,
      ids: change === 'cleared' ? [] : rows.map((row) => row.id!),
      tripIds: [
        ...new Set(
          rows.map((row) => row.tripId).filter((id): id is string => !!id),
        ),
      ],
      unseenCount: await this.unseenCount(userId, user?.notificationsSeenAt),
    };
    this.events.emit(
      DomainEvents.NOTIFICATIONS_CHANGED,
      domainEvent(DomainEvents.NOTIFICATIONS_CHANGED, userId, data),
    );
  }

  async settings(userId: string): Promise<NotificationSettingsDto> {
    const row = await this.prisma.notificationSettings.findUnique({
      where: { userId },
    });
    return pickSettings(row ?? {});
  }

  async updateSettings(
    userId: string,
    input: UpdateNotificationSettingsDto,
  ): Promise<NotificationSettingsDto> {
    const changes = {
      commentOnMarker: input.commentOnMarker,
      addedToTrip: input.addedToTrip,
      tripChangedByCollaborator: input.tripChangedByCollaborator,
      likesGrouped: input.likesGrouped,
      joinRequested: input.joinRequested,
      newFollowers: input.newFollowers,
    };
    const row = await this.prisma.notificationSettings.upsert({
      where: { userId },
      create: { userId, ...changes },
      update: changes,
    });
    return pickSettings(row);
  }
}

/** Everything is on unless switched off; no row means all on. */
function pickSettings(
  row: Partial<NotificationSettingsDto>,
): NotificationSettingsDto {
  return {
    commentOnMarker: row.commentOnMarker ?? true,
    addedToTrip: row.addedToTrip ?? true,
    tripChangedByCollaborator: row.tripChangedByCollaborator ?? true,
    likesGrouped: row.likesGrouped ?? true,
    joinRequested: row.joinRequested ?? true,
    newFollowers: row.newFollowers ?? true,
  };
}

/**
 * Left out of every view: entries caused by someone with a block either way,
 * and entries about trips I can no longer see (removed from a private trip).
 */
function visibleTo(userId: string): Prisma.NotificationWhereInput {
  return {
    recipientId: userId,
    AND: [
      {
        OR: [
          { actorId: null },
          { actor: { is: BlocksService.notBlockedWith(userId) } },
        ],
      },
      {
        OR: [
          { tripId: null },
          { trip: { is: { visibility: 'public', hiddenAt: null } } },
          { trip: { is: { members: { some: { userId } } } } },
        ],
      },
    ],
  };
}
