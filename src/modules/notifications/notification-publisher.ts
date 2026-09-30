import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { UserEvents } from '../realtime/realtime.rooms';
import { NotificationRenderer, resolveLanguage } from './notification-renderer';
import { toNotificationDto } from './notifications.dto';

/** Sends notification.created to the recipient's user room, in their saved language. */
@Injectable()
export class NotificationPublisher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: NotificationRenderer,
    private readonly realtime: RealtimePublisher,
  ) {}

  async publish(notificationId: string): Promise<void> {
    const row = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: { recipient: { select: { locale: true } } },
    });
    if (!row) return;
    const { recipient, ...notification } = row;
    const context = await this.renderer.context([notification]);
    const lang = resolveLanguage(recipient.locale);
    this.realtime.toUser(notification.recipientId, {
      event: UserEvents.NOTIFICATION_CREATED,
      tripId: notification.tripId,
      actorId: notification.actorId,
      at: notification.updatedAt.toISOString(),
      data: toNotificationDto(
        notification,
        context,
        this.renderer.text(notification, context, lang),
        this.renderer.deepLink(notification),
      ),
    });
  }
}
