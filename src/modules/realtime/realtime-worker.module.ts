import { Module } from '@nestjs/common';
import { RealtimeListener } from './realtime.listener';
import { RealtimePublisher } from './realtime.publisher';

/** Worker side: publishes events raised in the worker (photo processing, notifications). */
@Module({
  providers: [RealtimePublisher, RealtimeListener],
  exports: [RealtimePublisher],
})
export class RealtimeWorkerModule {}
