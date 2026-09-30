import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BlocksService } from '../moderation/blocks.service';
import { TripAccessService } from '../trips/trip-access.service';
import {
  NotificationRenderer,
  type RenderedText,
  resolveLanguage,
} from './notification-renderer';
import { SETTING_FOR_TYPE } from './notification-types';
import { PushProvider } from './push.provider';

/**
 * Sends one notification's push to all of the recipient's devices, each in its
 * own language. Re-checks access at send time, so nothing about a trip reaches
 * someone who lost access while the push waited.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly renderer: NotificationRenderer,
    private readonly provider: PushProvider,
  ) {}

  /** Returns how many devices were sent to (for logs and tests). */
  async send(notificationId: string): Promise<number> {
    const row = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: {
        recipient: {
          select: {
            status: true,
            locale: true,
            notificationSettings: true,
            devices: { select: { fcmToken: true, locale: true } },
          },
        },
      },
    });
    if (!row || row.recipient.status !== 'active') return 0;
    const { recipient, ...notification } = row;

    if (notification.tripId && !(await this.canView(row))) {
      // Lost access: the in-app entry would reveal the trip too.
      await this.prisma.notification.delete({ where: { id: row.id } });
      return 0;
    }
    if (
      notification.actorId &&
      (
        await BlocksService.blockedAmong(this.prisma, row.recipientId, [
          notification.actorId,
        ])
      ).size > 0
    ) {
      return 0;
    }
    const setting = SETTING_FOR_TYPE[notification.type];
    if (recipient.notificationSettings?.[setting] === false) return 0;
    if (!this.provider.enabled || recipient.devices.length === 0) return 0;

    const context = await this.renderer.context([notification]);
    const deepLink = this.renderer.deepLink(notification);
    const texts = new Map<string, RenderedText>();
    const messages = recipient.devices.map((device) => {
      const lang = resolveLanguage(device.locale, recipient.locale);
      let text = texts.get(lang);
      if (!text) {
        text = this.renderer.text(notification, context, lang);
        texts.set(lang, text);
      }
      return {
        token: device.fcmToken,
        title: text.title,
        body: text.body,
        data: {
          type: notification.type,
          notificationId: notification.id,
          deepLink,
        },
      };
    });

    const results = await this.provider.send(messages);
    const gone = results
      .filter((result) => result.unregistered)
      .map((r) => r.token);
    if (gone.length > 0) {
      await this.prisma.device.deleteMany({
        where: { fcmToken: { in: gone } },
      });
      this.logger.log(`Removed ${gone.length} unregistered device(s)`);
    }
    return results.filter((result) => result.ok).length;
  }

  private async canView(row: {
    recipientId: string;
    tripId: string | null;
  }): Promise<boolean> {
    try {
      await this.access.assert(row.recipientId, row.tripId!, 'view');
      return true;
    } catch {
      return false;
    }
  }
}
