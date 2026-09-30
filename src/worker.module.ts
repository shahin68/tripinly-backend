import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CoreModule } from './common/core.module';
import { QueueModule } from './common/queue/queue.module';
import { EmailWorkerModule } from './modules/notifications/email/email-worker.module';
import { NotificationsWorkerModule } from './modules/notifications/notifications-worker.module';
import { OsmImportWorkerModule } from './modules/osm-import/osm-import-worker.module';
import { PhotosWorkerModule } from './modules/photos/photos-worker.module';
import { RealtimeWorkerModule } from './modules/realtime/realtime-worker.module';
import { SocialWorkerModule } from './modules/social/social-worker.module';

/**
 * The worker process: BullMQ processors (thumbnails, OSM import, counters,
 * notifications and push, email; deletion and export in stage 9).
 */
@Module({
  imports: [
    CoreModule,
    // Events raised here (photo processing) reach sockets via RealtimeWorkerModule.
    EventEmitterModule.forRoot(),
    QueueModule,
    OsmImportWorkerModule,
    PhotosWorkerModule,
    SocialWorkerModule,
    RealtimeWorkerModule,
    NotificationsWorkerModule,
    EmailWorkerModule,
  ],
})
export class WorkerModule {}
