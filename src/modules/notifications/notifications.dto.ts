import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import type {
  Notification,
  NotificationType,
} from '../../generated/prisma/client';
import { UserSummaryDto } from '../users/user-summary';
import type { RenderContext, RenderedText } from './notification-renderer';
import {
  isAboutComments,
  NEWS_KINDS,
  newsKind,
  type NewsKind,
  NOTIFICATION_TYPES,
  shownActorIds,
} from './notification-types';

export class NotificationTripDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  title: string;
}

export class NotificationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: NOTIFICATION_TYPES })
  type: NotificationType;

  @ApiProperty({
    type: UserSummaryDto,
    nullable: true,
    description: 'Who caused it (the latest person for grouped types)',
  })
  actor: UserSummaryDto | null;

  @ApiProperty({
    type: [UserSummaryDto],
    description:
      'Up to 3 people of a grouped row, latest first (actor is the first; added 2026-11-07)',
  })
  actors: UserSummaryDto[];

  @ApiProperty({ type: NotificationTripDto, nullable: true })
  trip: NotificationTripDto | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  markerId: string | null;

  @ApiProperty({
    description:
      'About the stop\'s comments (a new comment or a like on one): its "new" mark clears when the comments are seen (added 2026-11-05)',
  })
  aboutComments: boolean;

  @ApiProperty({
    enum: NEWS_KINDS,
    description:
      "Where the stop's news is seen (added 2026-11-13): comments in its comments, photos in its photos (their buttons carry a red dot until then), hot (flames: no mark, the flame flickers once) and other when the stop opens",
  })
  newsKind: NewsKind;

  @ApiProperty({
    description:
      'Comments, replies, trip changes, saves and follows: how many in the group; likes_grouped: people who liked the item; place_hot: flames on the spot; else 1',
  })
  count: number;

  @ApiProperty({ description: 'Localized, same text as the push' })
  title: string;

  @ApiProperty()
  body: string;

  @ApiProperty({ example: 'tripinly://trips/0b7c…' })
  deepLink: string;

  @ApiProperty()
  read: boolean;

  @ApiProperty()
  createdAt: string;

  @ApiProperty({
    description:
      'Grouped types keep collecting until their push goes out; the same id may arrive again with a higher count',
  })
  updatedAt: string;
}

export class NotificationPageDto {
  @ApiProperty({ type: [NotificationDto] })
  items: NotificationDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;

  @ApiProperty({ description: 'Unread notifications in total' })
  unreadCount: number;

  @ApiProperty({
    description:
      'Entries new or updated since I last opened the notification center (POST /notifications/seen): its red indicator (added 2026-11-07)',
  })
  unseenCount: number;
}

export const READ_KINDS = NEWS_KINDS;
export type ReadKind = (typeof READ_KINDS)[number];

export class MarkReadDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: 100,
    description: 'Mark these as read. Send ids, markerId or all.',
  })
  @ValidateIf(
    (o: MarkReadDto) => o.all === undefined && o.markerId === undefined,
  )
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids?: string[];

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Mark everything about this stop as read (sent when I open it, which clears its "new" mark)',
  })
  // Required with kind.
  @ValidateIf(
    (o: MarkReadDto) => o.markerId !== undefined || o.kind !== undefined,
  )
  @IsUUID()
  markerId?: string;

  @ApiPropertyOptional({
    enum: READ_KINDS,
    description:
      'With markerId: only that kind of news (newsKind): comments when its comments are seen, photos when its photos are, hot and other when the stop opens (added 2026-11-05; photos and hot 2026-11-13, other no longer includes them); without it, everything about the stop',
  })
  @ValidateIf((o: MarkReadDto) => o.kind !== undefined)
  @IsIn(READ_KINDS)
  kind?: ReadKind;

  @ApiPropertyOptional({ enum: [true], description: 'Mark everything as read' })
  @IsOptional()
  @Equals(true)
  all?: true;
}

export class NotificationSettingsDto {
  @ApiProperty({ description: 'Push for comments on my places' })
  commentOnMarker: boolean;

  @ApiProperty({
    description:
      'Push when someone adds me to a trip or accepts my request to join',
  })
  addedToTrip: boolean;

  @ApiProperty({ description: 'Push for collaborator changes' })
  tripChangedByCollaborator: boolean;

  @ApiProperty({
    description:
      'Push for likes on my trips, photos and comments, saves of my trips, and my spots getting hot',
  })
  likesGrouped: boolean;

  @ApiProperty({ description: 'Push when someone asks to join my trip' })
  joinRequested: boolean;

  @ApiProperty({
    description: 'Push when someone follows me or we become friends',
  })
  newFollowers: boolean;
}

export class NewActivityDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Stops of this trip with unread notifications for me other than flames (the pins\' "new" marks)',
  })
  markerIds: string[];

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Those of markerIds with unread notifications about their comments, which clear when the comments are seen (added 2026-11-05)',
  })
  commentMarkerIds: string[];

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      "Stops with unread news about their photos (added or liked): the photos button's red dot, until the photos are seen (added 2026-11-13)",
  })
  photoMarkerIds: string[];

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      "Stops whose spot got flames I haven't seen: no mark, the flame flickers once when the stop opens (added 2026-11-13)",
  })
  hotMarkerIds: string[];

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Stops with the rest of the news (changes by others), seen when the stop opens (added 2026-11-13)',
  })
  otherMarkerIds: string[];
}

export class UpdateNotificationSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  commentOnMarker?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  addedToTrip?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  tripChangedByCollaborator?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  likesGrouped?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  joinRequested?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  newFollowers?: boolean;
}

export function toNotificationDto(
  row: Notification,
  context: RenderContext,
  text: RenderedText,
  deepLink: string,
): NotificationDto {
  const trip = row.tripId ? context.trips.get(row.tripId) : undefined;
  return {
    id: row.id,
    type: row.type,
    actor: (row.actorId && context.actors.get(row.actorId)) || null,
    actors: shownActorIds(row)
      .map((id) => context.actors.get(id))
      .filter((user): user is UserSummaryDto => !!user),
    trip: trip ? { id: trip.id, title: trip.title } : null,
    markerId: row.markerId,
    aboutComments: isAboutComments(row),
    newsKind: newsKind(row),
    count: row.count,
    title: text.title,
    body: text.body,
    deepLink,
    read: row.readAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * What notifications.changed carries to my own room: notifications read,
 * removed, all removed (cleared, `ids` empty) or the center seen, on any
 * device. `tripIds`: trips whose stop marks may have changed (reload
 * GET /trips/{id}/new-activity); `unseenCount` as in GET /notifications.
 */
export interface NotificationsChange {
  change: 'read' | 'removed' | 'cleared' | 'seen';
  ids: string[];
  tripIds: string[];
  unseenCount: number;
}
