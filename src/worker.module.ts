import { Module } from '@nestjs/common';
import { CoreModule } from './common/core.module';

/**
 * The worker process: BullMQ processors (thumbnails, push, email, deletion,
 * export, popularity recompute, like grouping) register here as they are built.
 */
@Module({
  imports: [CoreModule],
})
export class WorkerModule {}
