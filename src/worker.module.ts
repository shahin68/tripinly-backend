import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CoreModule } from './common/core.module';
import { QueueModule } from './common/queue/queue.module';
import { OsmImportWorkerModule } from './modules/osm-import/osm-import-worker.module';
import { PhotosWorkerModule } from './modules/photos/photos-worker.module';
import { SocialWorkerModule } from './modules/social/social-worker.module';

/**
 * The worker process: BullMQ processors (thumbnails, push, email, deletion,
 * export, popularity recompute, like grouping) register here as they are built.
 */
@Module({
  imports: [
    CoreModule,
    // Worker events reach realtime through Redis once stage 8 bridges them.
    EventEmitterModule.forRoot(),
    QueueModule,
    OsmImportWorkerModule,
    PhotosWorkerModule,
    SocialWorkerModule,
  ],
})
export class WorkerModule {}
