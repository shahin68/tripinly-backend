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
] as const satisfies readonly NotificationType[];

/**
 * The per-type push switch in notification_settings: each switch turns off
 * its whole group (Likes covers flames and saves; New followers covers
 * friends; Added to trips covers accepted join requests).
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
  commentId: string;
  markerName: string;
  excerpt: string;
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
}

export interface PlaceHotPayload {
  placeId: string;
  placeName: string;
  /** The hot count reached, one of HOT_MILESTONES. */
  milestone: number;
}

export type NotificationPayload =
  | CommentPayload
  | TripChangesPayload
  | LikesPayload
  | PlaceHotPayload
  | Record<string, never>;

/**
 * Hot counts at which a spot's creator hears that it is getting hot, once
 * each (Shahin, 2026-11-01: rarely, pushes cost money).
 */
export const HOT_MILESTONES = [5, 25, 100, 500, 1000, 5000] as const;

/** Follow and friend pushes: at most one per pair per day, so toggling can't spam. */
export const FOLLOW_REPEAT_SECONDS = 24 * 60 * 60;

export function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= COMMENT_EXCERPT_LENGTH
    ? flat
    : `${flat.slice(0, COMMENT_EXCERPT_LENGTH - 1).trimEnd()}…`;
}
