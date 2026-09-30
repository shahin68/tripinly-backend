import type { TripChangeKind } from './notification-types';

export const NOTIFICATIONS_QUEUE = 'notifications';

export const NotificationJobs = {
  /** Decide recipients for a domain event and write in-app notifications. */
  PLAN: 'plan',
  /** Send the push for one notification. */
  PUSH: 'push',
  /** Close a batched or grouped notification and send its summary push. */
  FLUSH: 'flush',
} as const;

/** What the api hands the worker: a compact form of the domain event. */
export type PlanInput =
  | {
      kind: 'comment_created';
      actorId: string;
      tripId: string;
      markerId: string;
      commentId: string;
      body: string;
      recipientIds: string[];
    }
  | { kind: 'comment_deleted'; commentId: string }
  | {
      kind: 'added_to_trip';
      actorId: string;
      tripId: string;
      userIds: string[];
    }
  | {
      kind: 'trip_changed';
      actorId: string;
      tripId: string;
      change: TripChangeKind;
    }
  | {
      kind: 'liked';
      actorId: string;
      targetType: 'trip' | 'marker' | 'photo' | 'comment';
      targetId: string;
      tripId: string;
    };

export interface NotificationJobData {
  notificationId: string;
}

/** Retries for push and flush jobs (FCM hiccups). */
export const DELIVERY_RETRIES = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
} as const;

/** BullMQ custom job ids can't contain ':'. */
export const pushJobId = (notificationId: string): string =>
  `push-${notificationId}`;
export const flushJobId = (notificationId: string): string =>
  `flush-${notificationId}`;
