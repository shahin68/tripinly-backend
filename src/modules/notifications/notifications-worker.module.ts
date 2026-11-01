import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BlocksService } from '../moderation/blocks.service';
import { RealtimeWorkerModule } from '../realtime/realtime-worker.module';
import { TripAccessService } from '../trips/trip-access.service';
import { FcmPushProvider } from './fcm.push-provider';
import { NotificationPlanner } from './notification-planner';
import { NotificationPublisher } from './notification-publisher';
import { NotificationRenderer } from './notification-renderer';
import { NOTIFICATIONS_QUEUE } from './notifications.queue';
import { NotificationsProcessor } from './notifications.processor';
import { PushProvider } from './push.provider';
import { PushService } from './push.service';

/** Worker side: planning and sending pushes. */
@Module({
  imports: [
    BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE }),
    RealtimeWorkerModule,
  ],
  providers: [
    NotificationsProcessor,
    NotificationPlanner,
    NotificationPublisher,
    NotificationRenderer,
    PushService,
    { provide: PushProvider, useClass: FcmPushProvider },
    TripAccessService,
    BlocksService,
  ],
})
export class NotificationsWorkerModule {}
