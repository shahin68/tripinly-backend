import { Module } from '@nestjs/common';
import { RealtimeListener } from './realtime.listener';
import { RealtimePublisher } from './realtime.publisher';
import { ViewingService } from './viewing.service';

/** Worker side: publishes events raised in the worker (photo processing, notifications). */
@Module({
  providers: [RealtimePublisher, RealtimeListener, ViewingService],
  exports: [RealtimePublisher, ViewingService],
})
export class RealtimeWorkerModule {}
