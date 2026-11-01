import { Injectable } from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  toPage,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { BlocksService } from '../moderation/blocks.service';
import { TripAccessService } from '../trips/trip-access.service';
import { NotificationRenderer, resolveLanguage } from './notification-renderer';
import {
  type MarkReadDto,
  type NewActivityDto,
  type NotificationPageDto,
  type NotificationSettingsDto,
  toNotificationDto,
  type UpdateNotificationSettingsDto,
} from './notifications.dto';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: NotificationRenderer,
    private readonly access: TripAccessService,
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
      distinct: ['markerId'],
      select: { markerId: true },
    });
    return { markerIds: rows.map((row) => row.markerId!) };
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
        select: { locale: true },
      }),
    ]);
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
    return { ...page, unreadCount };
  }

  async markRead(userId: string, input: MarkReadDto): Promise<void> {
    await this.prisma.notification.updateMany({
      where: {
        recipientId: userId,
        readAt: null,
        ...(input.all
          ? {}
          : input.markerId
            ? { markerId: input.markerId }
            : { id: { in: input.ids ?? [] } }),
      },
      data: { readAt: new Date() },
    });
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
