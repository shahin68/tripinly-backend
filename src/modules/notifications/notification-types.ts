import type {
  NotificationSettings,
  NotificationType,
} from '../../generated/prisma/client';

export const NOTIFICATION_TYPES = [
  'comment_on_marker',
  'added_to_trip',
  'trip_changed_by_collaborator',
  'likes_grouped',
] as const satisfies readonly NotificationType[];

/** The per-type push switch in notification_settings. */
export const SETTING_FOR_TYPE = {
  comment_on_marker: 'commentOnMarker',
  added_to_trip: 'addedToTrip',
  trip_changed_by_collaborator: 'tripChangedByCollaborator',
  likes_grouped: 'likesGrouped',
} as const satisfies Record<
  NotificationType,
  keyof Omit<NotificationSettings, 'userId' | 'updatedAt'>
>;

/** Collaborator changes collect this long per trip and recipient before one push. */
export const COLLABORATOR_BATCH_MS = 10 * 60 * 1000;
/** At most one likes push per recipient per window. */
export const LIKES_WINDOW_MS = 60 * 60 * 1000;

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
/** Actor and trip ids kept on a group row; enough to name people and tell trips apart. */
export const GROUP_ID_CAP = 10;
/** Distinct likers tracked per likes group. */
export const LIKERS_CAP = 500;

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
}

export type NotificationPayload =
  CommentPayload | TripChangesPayload | LikesPayload | Record<string, never>;

export function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= COMMENT_EXCERPT_LENGTH
    ? flat
    : `${flat.slice(0, COMMENT_EXCERPT_LENGTH - 1).trimEnd()}…`;
}
