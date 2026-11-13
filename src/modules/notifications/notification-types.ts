import type {
  NotificationSettings,
  NotificationType,
} from '../../generated/prisma/client';

export const NOTIFICATION_TYPES = [
  'comment_on_marker',
  'added_to_trip',
  'trip_changed_by_collaborator',
  'likes_grouped',
  'join_requested',
  'followed',
  'became_friends',
  'join_accepted',
  'trip_saved',
  'place_hot',
  'comment_reply',
  'comment_mention',
  'join_declined',
  'removed_from_trip',
] as const satisfies readonly NotificationType[];

/** A new comment on a stop, a reply, or a mention in either: payload CommentPayload. */
export const COMMENT_TYPES = [
  'comment_on_marker',
  'comment_reply',
  'comment_mention',
] as const satisfies readonly NotificationType[];

/**
 * The per-type push switch in notification_settings: each switch turns off
 * its whole group (Comments covers replies and mentions; Likes covers flames
 * and saves; New followers covers friends; Added to trips covers accepted
 * join requests).
 */
export const SETTING_FOR_TYPE = {
  comment_on_marker: 'commentOnMarker',
  added_to_trip: 'addedToTrip',
  trip_changed_by_collaborator: 'tripChangedByCollaborator',
  likes_grouped: 'likesGrouped',
  join_requested: 'joinRequested',
  followed: 'newFollowers',
  became_friends: 'newFollowers',
  join_accepted: 'addedToTrip',
  trip_saved: 'likesGrouped',
  place_hot: 'likesGrouped',
  comment_reply: 'commentOnMarker',
  comment_mention: 'commentOnMarker',
  join_declined: 'addedToTrip',
  removed_from_trip: 'addedToTrip',
} as const satisfies Record<
  NotificationType,
  keyof Omit<NotificationSettings, 'userId' | 'updatedAt'>
>;

/** Collaborator changes that count toward trip_changed_by_collaborator. */
export const TRIP_CHANGE_KINDS = [
  'trip_updated',
  'day_added',
  'day_deleted',
  'place_added',
  'place_updated',
  'place_deleted',
  'places_reordered',
  'photo_added',
] as const;
export type TripChangeKind = (typeof TRIP_CHANGE_KINDS)[number];

export const COMMENT_EXCERPT_LENGTH = 80;

/** Payloads stored in notifications.payload, per type. */
export interface CommentPayload {
  /** The latest comment; its text is [excerpt]. */
  commentId: string;
  markerName: string;
  excerpt: string;
  /** A group's comments, oldest first (since 2026-11-07; single rows have only commentId). */
  commentIds?: string[];
}

export interface TripChangesPayload {
  actorIds: string[];
  kinds: Partial<Record<TripChangeKind, number>>;
}

export interface LikesPayload {
  likerIds: string[];
  tripIds: string[];
  /** What was liked; absent on rows from before 2026-11-01 ("liked your post"). */
  targetType?: 'trip' | 'photo' | 'comment';
  /** The photo's or comment's stop name. */
  markerName?: string;
  /** The liked comment's text, shortened. */
  excerpt?: string;
  /** The highest APP_NOTIFICATION_MILESTONES count already pushed. */
  milestone?: number;
}

export interface PlaceHotPayload {
  placeId: string;
  placeName: string;
  /** The highest APP_NOTIFICATION_MILESTONES count already pushed. */
  milestone?: number;
}

/**
 * join_declined and removed_from_trip: the trip is named here, not in
 * tripId, so the entry stays (and pushes) after access to it is gone.
 */
export interface MembershipPayload {
  tripId: string;
  tripTitle: string;
}

/**
 * Every grouped row's people, latest first (since 2026-11-07; the row's actorId
 * is the first). The center shows up to [SHOWN_ACTORS] of them.
 */
export interface GroupPayload {
  actorIds?: string[];
}

export const SHOWN_ACTORS = 3;

/** Up to [SHOWN_ACTORS] people of a row, latest first. */
export function shownActorIds(row: {
  actorId: string | null;
  payload: unknown;
}): string[] {
  const ids = (row.payload as GroupPayload | null)?.actorIds;
  return (ids?.length ? ids : row.actorId ? [row.actorId] : []).slice(
    0,
    SHOWN_ACTORS,
  );
}

export type NotificationPayload =
  | CommentPayload
  | TripChangesPayload
  | LikesPayload
  | PlaceHotPayload
  | MembershipPayload
  | Record<string, never>;

/**
 * The count to push for: one of [milestones] that is above the one already
 * pushed. Likes and flames in between show only in the notification center.
 */
export function milestoneReached(
  count: number,
  milestones: readonly number[],
  pushed = 0,
): number | undefined {
  return milestones.includes(count) && count > pushed ? count : undefined;
}

/** Friend pushes: at most one per pair per day, so toggling can't spam (a follow pushes once per pair ever). */
export const FOLLOW_REPEAT_SECONDS = 24 * 60 * 60;

export function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= COMMENT_EXCERPT_LENGTH
    ? flat
    : `${flat.slice(0, COMMENT_EXCERPT_LENGTH - 1).trimEnd()}…`;
}

/**
 * About a stop's comments: a new comment or reply, a mention, or a like on a
 * comment. Their "new" mark clears once the stop's comments are seen; the rest
 * clear when the stop opens.
 */
export function isAboutComments(row: {
  type: string;
  payload: unknown;
}): boolean {
  return (
    (COMMENT_TYPES as readonly string[]).includes(row.type) ||
    (row.type === 'likes_grouped' &&
      (row.payload as Partial<LikesPayload> | null)?.targetType === 'comment')
  );
}

/**
 * Where a stop's news is seen, so its "new" mark clears there (Shahin,
 * 2026-11-13): comments in its comments, photos (a photo added or liked) in
 * its photos, flames (no mark, a one-off flicker of the flame) when the stop
 * opens, the rest when the stop opens.
 */
export const NEWS_KINDS = ['comments', 'photos', 'hot', 'other'] as const;
export type NewsKind = (typeof NEWS_KINDS)[number];

export function newsKind(row: { type: string; payload: unknown }): NewsKind {
  if (isAboutComments(row)) return 'comments';
  if (row.type === 'place_hot') return 'hot';
  const payload = row.payload as
    (Partial<LikesPayload> & Partial<TripChangesPayload>) | null;
  if (row.type === 'likes_grouped' && payload?.targetType === 'photo')
    return 'photos';
  if (
    row.type === 'trip_changed_by_collaborator' &&
    payload?.kinds?.photo_added
  )
    return 'photos';
  return 'other';
}
