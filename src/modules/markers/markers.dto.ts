import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { Marker, User } from '../../generated/prisma/client';
import { toUserSummary, UserSummaryDto } from '../users/user-summary';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const OSM_TYPES = ['node', 'way', 'relation'] as const;
export const PLACE_CATEGORIES = [
  'cafe',
  'restaurant',
  'bar',
  'attraction',
  'museum',
  'historic',
  'park',
  'nature',
  'landmark',
  'other',
] as const;

export class LocationDto {
  @ApiProperty({ example: 48.2082, minimum: -90, maximum: 90 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: 16.3738, minimum: -180, maximum: 180 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  lng: number;
}

export class CreateMarkerDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'A place from our in-view, search or along-the-way results. Omit when sending location.',
  })
  @ValidateIf(
    (o: CreateMarkerDto) => o.placeId !== undefined || o.location === undefined,
  )
  @IsUUID()
  placeId?: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 120,
    description:
      'Required with location (custom pin or Photon result). With placeId, overrides the place name.',
  })
  @ValidateIf(
    (o: CreateMarkerDto) => o.name !== undefined || o.location !== undefined,
  )
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional({
    type: LocationDto,
    description: 'Custom pin or Photon result. Omit when sending placeId.',
  })
  @ValidateIf(
    (o: CreateMarkerDto) => o.location !== undefined || o.placeId === undefined,
  )
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;

  @ApiPropertyOptional({
    enum: OSM_TYPES,
    description: 'From a Photon result, with osmId',
  })
  @ValidateIf(
    (o: CreateMarkerDto) => o.osmType !== undefined || o.osmId !== undefined,
  )
  @IsIn(OSM_TYPES)
  osmType?: (typeof OSM_TYPES)[number];

  @ApiPropertyOptional({
    type: String,
    example: '240109189',
    description: 'From a Photon result, with osmType',
  })
  @ValidateIf(
    (o: CreateMarkerDto) => o.osmType !== undefined || o.osmId !== undefined,
  )
  @Matches(/^[1-9]\d{0,18}$/)
  osmId?: string;

  @ApiPropertyOptional({
    enum: PLACE_CATEGORIES,
    description: 'Category for a new place; defaults to other',
  })
  @IsOptional()
  @IsIn(PLACE_CATEGORIES)
  category?: (typeof PLACE_CATEGORIES)[number];

  @ApiPropertyOptional({ example: '14:30', description: 'Local time HH:mm' })
  @IsOptional()
  @Matches(TIME_PATTERN)
  time?: string;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Insert position in the day; appended when omitted',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  position?: number;
}

export class UpdateMarkerDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '09:15' })
  @ValidateIf((o: UpdateMarkerDto) => o.time !== null && o.time !== undefined)
  @Matches(TIME_PATTERN)
  time?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Link to another existing place',
  })
  @IsOptional()
  @IsUUID()
  placeId?: string;

  @ApiPropertyOptional({
    type: LocationDto,
    description: 'Move the pin; the place is matched again',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Move to another day of the same trip',
  })
  @IsOptional()
  @IsUUID()
  dayId?: string;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Position in the (target) day',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  position?: number;
}

export class MarkerOrderDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: "All of the day's marker IDs in the new order",
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  markerIds: string[];
}

export class MarkerDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tripId: string;

  @ApiProperty({ format: 'uuid' })
  dayId: string;

  @ApiProperty({ format: 'uuid' })
  placeId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: LocationDto })
  location: LocationDto;

  @ApiProperty({ type: String, nullable: true, example: '14:30' })
  time: string | null;

  @ApiProperty()
  position: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  coverPhotoId: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Signed URL, expires after ~1 h',
  })
  coverThumbUrl: string | null;

  @ApiProperty()
  photoCount: number;

  @ApiProperty()
  likeCount: number;

  @ApiProperty()
  likedByMe: boolean;

  @ApiProperty()
  commentCount: number;

  @ApiProperty({
    type: UserSummaryDto,
    nullable: true,
    description: 'Null after the creator deleted their account',
  })
  createdBy: UserSummaryDto | null;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}

export type MarkerWithCreator = Marker & {
  createdBy: Pick<User, 'id' | 'username' | 'displayName'> | null;
};

export const MARKER_INCLUDE = {
  createdBy: { select: { id: true, username: true, displayName: true } },
} as const;

export function toMarkerDto(marker: MarkerWithCreator): MarkerDto {
  return {
    id: marker.id,
    tripId: marker.tripId,
    dayId: marker.dayId,
    placeId: marker.placeId,
    name: marker.name,
    location: { lat: marker.lat, lng: marker.lng },
    time: marker.time,
    position: marker.position,
    // Photos, likes and comments arrive in stages 5 and 6.
    coverPhotoId: null,
    coverThumbUrl: null,
    photoCount: 0,
    likeCount: marker.likeCount,
    likedByMe: false,
    commentCount: marker.commentCount,
    createdBy: marker.createdBy ? toUserSummary(marker.createdBy) : null,
    createdAt: marker.createdAt.toISOString(),
    updatedAt: marker.updatedAt.toISOString(),
  };
}
