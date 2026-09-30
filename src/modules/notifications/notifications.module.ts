import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { NotificationRenderer } from './notification-renderer';
import { NotificationsController } from './notifications.controller';
import { NotificationsListener } from './notifications.listener';
import { NOTIFICATIONS_QUEUE } from './notifications.queue';
import { NotificationsService } from './notifications.service';

/** API side: the in-app list and settings, and domain events → plan jobs. */
@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE })],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationRenderer,
    NotificationsListener,
  ],
})
export class NotificationsModule {}
