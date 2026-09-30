import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
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
import { NOTIFICATION_TYPES } from './notification-types';

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

  @ApiProperty({ type: NotificationTripDto, nullable: true })
  trip: NotificationTripDto | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  markerId: string | null;

  @ApiProperty({
    description:
      'trip_changed_by_collaborator: number of changes; likes_grouped: number of people; else 1',
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
}

export class MarkReadDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: 100,
    description: 'Mark these as read. Send either ids or all.',
  })
  @ValidateIf((o: MarkReadDto) => o.all === undefined)
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids?: string[];

  @ApiPropertyOptional({ enum: [true], description: 'Mark everything as read' })
  @IsOptional()
  @Equals(true)
  all?: true;
}

export class NotificationSettingsDto {
  @ApiProperty({ description: 'Push for comments on my places' })
  commentOnMarker: boolean;

  @ApiProperty({ description: 'Push when someone adds me to a trip' })
  addedToTrip: boolean;

  @ApiProperty({
    description: 'Push for collaborator changes (batched per 10 minutes)',
  })
  tripChangedByCollaborator: boolean;

  @ApiProperty({ description: 'Push for likes (at most one per hour)' })
  likesGrouped: boolean;
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
    trip: trip ? { id: trip.id, title: trip.title } : null,
    markerId: row.markerId,
    count: row.count,
    title: text.title,
    body: text.body,
    deepLink,
    read: row.readAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
