import { Module } from '@nestjs/common';
import { CoreModule } from './common/core.module';
import { QueueModule } from './common/queue/queue.module';
import { OsmImportWorkerModule } from './modules/osm-import/osm-import-worker.module';

/**
 * The worker process: BullMQ processors (thumbnails, push, email, deletion,
 * export, popularity recompute, like grouping) register here as they are built.
 */
@Module({
  imports: [CoreModule, QueueModule, OsmImportWorkerModule],
})
export class WorkerModule {}
