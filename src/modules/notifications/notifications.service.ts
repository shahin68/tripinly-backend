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
import { NotificationRenderer, resolveLanguage } from './notification-renderer';
import {
  type MarkReadDto,
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
  ) {}

  /**
   * Newest first. Left out: entries caused by someone with a block either way,
   * and entries about trips I can no longer see (removed from a private trip).
   */
  async list(
    userId: string,
    cursor?: string,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<NotificationPageDto> {
    const visible: Prisma.NotificationWhereInput = {
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
          this.renderer.deepLink(row),
        ),
    );
    return { ...page, unreadCount };
  }

  async markRead(userId: string, input: MarkReadDto): Promise<void> {
    await this.prisma.notification.updateMany({
      where: {
        recipientId: userId,
        readAt: null,
        ...(input.all ? {} : { id: { in: input.ids ?? [] } }),
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
  };
}
