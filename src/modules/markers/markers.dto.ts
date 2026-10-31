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
import type { Prisma } from '../../generated/prisma/client';
import { thumbUrl, type UrlSigner } from '../photos/photo-keys';
import { placeImageThumbUrl } from '../places/place-image-keys';
import type { PlaceCover } from '../places/place-covers.service';
import { PUBLIC_STOP_WHERE } from '../places/popularity';
import {
  toUserSummary,
  USER_SUMMARY_SELECT,
  UserSummaryDto,
} from '../users/user-summary';

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
      'Client-chosen ID, so the app can show the marker before the response; 409 ID_CONFLICT if taken',
  })
  @IsOptional()
  @IsUUID('all')
  id?: string;

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
      'With location: the custom pin or Photon result name; leave it out for a tap on the map and the server names the stop. With placeId, overrides the place name.',
  })
  @ValidateIf((o: CreateMarkerDto) => o.name !== undefined)
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

export class CopyMarkerDto {
  @ApiProperty({
    format: 'uuid',
    description: 'A day of a trip I own or edit',
  })
  @IsUUID()
  dayId: string;

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

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      "The image the stop's pin shows, cached by this id: the cover picked from the stop's photo grid (a photo or a Commons image), else the place's image. Null when there is neither",
  })
  coverPhotoId: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Its thumbnail; signed URL, expires after ~1 h',
  })
  coverThumbUrl: string | null;

  @ApiProperty()
  photoCount: number;

  @ApiProperty({
    description:
      "How many people marked the place hot: a stop's flame marks its place, so every stop at a place shows the same count",
  })
  hotCount: number;

  @ApiProperty({ description: 'I marked the place hot' })
  hotByMe: boolean;

  @ApiProperty({
    description:
      'False for a custom spot that is only in private trips: it has no flame button',
  })
  canMarkHot: boolean;

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

export const MARKER_INCLUDE = {
  createdBy: { select: USER_SUMMARY_SELECT },
  coverPhoto: {
    select: {
      uploaderId: true,
      markerId: true,
      placeId: true,
      hiddenAt: true,
      uploader: { select: { status: true } },
      marker: {
        select: {
          hiddenAt: true,
          trip: { select: { ownerId: true, visibility: true, hiddenAt: true } },
        },
      },
    },
  },
  coverImage: { select: { status: true } },
  // Whether the place is public, for canMarkHot (see PlaceMatchingService.isLikeable).
  place: {
    select: {
      source: true,
      popularity: true,
      markers: { where: PUBLIC_STOP_WHERE, select: { id: true }, take: 1 },
    },
  },
  _count: {
    select: { photos: { where: { status: 'ready', hiddenAt: null } } },
  },
} satisfies Prisma.MarkerInclude;

export type MarkerWithCreator = Prisma.MarkerGetPayload<{
  include: typeof MARKER_INCLUDE;
}>;

/** What a stop's picked cover needs, also for the trip's card. */
type CoverFields = Pick<
  MarkerWithCreator,
  'id' | 'coverPhotoId' | 'coverImageId' | 'coverPhoto' | 'coverImage'
>;

/** The people whose block with the viewer hides the stop's picked cover: its uploader and, from another trip, that trip's owner. */
export function coverPeople(marker: Pick<CoverFields, 'coverPhoto'>): string[] {
  const photo = marker.coverPhoto;
  if (!photo) return [];
  const owner = photo.marker?.trip.ownerId;
  return owner ? [photo.uploaderId, owner] : [photo.uploaderId];
}

/**
 * The cover the trip picked, while it may still show: a picked photo of
 * another trip only while that trip and stop are public and unhidden (a
 * private trip's photos never leave it), never a hidden photo, one by an
 * inactive account or across a block (`hiddenUserIds`, see `coverPeople`).
 */
export function pickedCover(
  marker: CoverFields,
  signer: UrlSigner,
  hiddenUserIds: ReadonlySet<string>,
): { id: string; thumbUrl: string | null } | null {
  const photo = marker.coverPhoto;
  if (marker.coverPhotoId && photo) {
    const other = photo.marker;
    const shown =
      photo.markerId === marker.id ||
      photo.placeId !== null ||
      (other !== null &&
        other.hiddenAt === null &&
        other.trip.visibility === 'public' &&
        other.trip.hiddenAt === null);
    const visible =
      shown &&
      photo.hiddenAt === null &&
      photo.uploader.status === 'active' &&
      !coverPeople(marker).some((id) => hiddenUserIds.has(id));
    return visible
      ? {
          id: marker.coverPhotoId,
          thumbUrl: thumbUrl(signer, marker.coverPhotoId),
        }
      : null;
  }
  if (marker.coverImageId && marker.coverImage?.status === 'ready') {
    return {
      id: marker.coverImageId,
      thumbUrl: placeImageThumbUrl(signer, marker.coverImageId),
    };
  }
  return null;
}

/**
 * `hiddenUserIds`: people with a block with the viewer. They show as no
 * creator, and their cover isn't shown (see `pickedCover`). `likedIds`:
 * targets the viewer liked (see `likedAmong`), here places. `placeCovers`:
 * the places' images for this viewer (`PlacesService.coversOf`), shown by a
 * stop without a picked cover; left out in live events, which reach many
 * viewers.
 */
export function toMarkerDto(
  marker: MarkerWithCreator,
  signer: UrlSigner,
  hiddenUserIds: ReadonlySet<string> = new Set(),
  likedIds: ReadonlySet<string> = new Set(),
  placeCovers: ReadonlyMap<string, PlaceCover> = new Map(),
): MarkerDto {
  const creatorHidden =
    marker.createdById !== null && hiddenUserIds.has(marker.createdById);
  const cover =
    pickedCover(marker, signer, hiddenUserIds) ??
    placeCovers.get(marker.placeId) ??
    null;
  return {
    id: marker.id,
    tripId: marker.tripId,
    dayId: marker.dayId,
    placeId: marker.placeId,
    name: marker.name,
    location: { lat: marker.lat, lng: marker.lng },
    time: marker.time,
    position: marker.position,
    coverPhotoId: cover?.id ?? null,
    coverThumbUrl: cover?.thumbUrl ?? null,
    photoCount: marker._count.photos,
    hotCount: marker.place.popularity,
    hotByMe: likedIds.has(marker.placeId),
    canMarkHot:
      marker.place.source === 'osm' ||
      marker.place.popularity > 0 ||
      marker.place.markers.length > 0,
    commentCount: marker.commentCount,
    createdBy:
      marker.createdBy && !creatorHidden
        ? toUserSummary(marker.createdBy, signer)
        : null,
    createdAt: marker.createdAt.toISOString(),
    updatedAt: marker.updatedAt.toISOString(),
  };
}
