import { Injectable } from '@nestjs/common';
import { COLLABORATOR_BATCH_MS, LIKES_WINDOW_MS } from './notification-types';

/** Batching windows; a provider so tests can shorten them. */
@Injectable()
export class NotificationTimings {
  readonly collaboratorBatchMs: number = COLLABORATOR_BATCH_MS;
  readonly likesWindowMs: number = LIKES_WINDOW_MS;
}
