import type { TripChangeKind } from './notification-types';

export const NOTIFICATIONS_QUEUE = 'notifications';

export const NotificationJobs = {
  /** Decide recipients for a domain event and write in-app notifications. */
  PLAN: 'plan',
  /** Send the push for one notification. */
  PUSH: 'push',
  /**
   * Close a batched or grouped notification and send its summary push. Nothing
   * schedules it since every push goes out at once (2026-11-01); it stays so
   * groups opened before that deploy still send.
   */
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
      /** The main comment, when this is a reply. */
      parentId?: string | null;
      /** Trip people it @mentions (checked by the api). */
      mentionIds?: string[];
    }
  | { kind: 'comment_deleted'; commentId: string }
  | {
      kind: 'added_to_trip';
      actorId: string;
      tripId: string;
      userIds: string[];
      /** The owner accepted their request to join (join_accepted push). */
      viaJoinRequest?: boolean;
    }
  | {
      kind: 'join_requested';
      actorId: string;
      tripId: string;
      ownerId: string;
    }
  | {
      kind: 'trip_changed';
      actorId: string;
      tripId: string;
      change: TripChangeKind;
      /** What changed (stop, day or photo id), so the same change twice counts as a repeat; the trip when absent. */
      subjectId?: string;
      /** The stop it is about (added, edited, or a photo added to it), so the push opens on it. */
      markerId?: string;
    }
  | {
      kind: 'liked';
      actorId: string;
      targetType: 'trip' | 'photo' | 'comment';
      targetId: string;
      /** Absent for a photo in a place's gallery. */
      tripId?: string;
      /** The like count after this like (absent on jobs queued before 2026-11-07). */
      count?: number;
    }
  | { kind: 'followed'; actorId: string; followeeId: string }
  | { kind: 'trip_saved'; actorId: string; tripId: string }
  | {
      kind: 'place_hot';
      placeId: string;
      hotCount: number;
      /** Who gave the flame (absent on jobs queued before 2026-11-07). */
      actorId?: string;
    }
  | {
      /** The owner declined a join request, or removed a member. */
      kind: 'join_declined' | 'removed_from_trip';
      actorId: string;
      tripId: string;
      userId: string;
    };

export interface NotificationJobData {
  notificationId: string;
}

/** Retries for push and flush jobs (FCM hiccups). */
export const DELIVERY_RETRIES = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
} as const;

/**
 * BullMQ custom job ids can't contain ':'. A grouped entry pushes again at
 * its next milestone, so [version] (its update time) tells the pushes apart.
 */
export const pushJobId = (notificationId: string, version?: number): string =>
  version === undefined
    ? `push-${notificationId}`
    : `push-${notificationId}-${version}`;
