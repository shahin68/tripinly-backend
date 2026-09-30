import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
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
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import type { PlaceCategory } from '../../generated/prisma/client';
import {
  LocationDto,
  OSM_TYPES,
  PLACE_CATEGORIES,
  TIME_PATTERN,
} from '../markers/markers.dto';

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

const NUMBER = '-?\\d{1,3}(\\.\\d+)?';
const BBOX_PATTERN = new RegExp(`^${NUMBER},${NUMBER},${NUMBER},${NUMBER}$`);

const toCategoryList = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((category) => category.trim())
        .filter(Boolean)
    : value;

class BboxQueryDto {
  @ApiProperty({
    example: '16.35,48.19,16.39,48.22',
    description: 'minLng,minLat,maxLng,maxLat of the visible map area',
  })
  @Matches(BBOX_PATTERN, { message: 'invalidBbox' })
  bbox: string;
}

export class InViewQueryDto extends BboxQueryDto {
  @ApiProperty({
    minimum: 0,
    maximum: 22,
    example: 15,
    description: 'Map zoom level (fractions allowed)',
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(22)
  zoom: number;

  @ApiPropertyOptional({
    type: String,
    example: 'cafe,attraction',
    description: `Comma-separated: ${PLACE_CATEGORIES.join(', ')}`,
  })
  @IsOptional()
  @Transform(toCategoryList)
  @ArrayMaxSize(PLACE_CATEGORIES.length)
  @ArrayUnique()
  @IsIn(PLACE_CATEGORIES, { each: true })
  categories?: PlaceCategory[];

  @ApiPropertyOptional({ minimum: 10, maximum: 200, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(200)
  limit?: number;
}

export class PopularQueryDto extends BboxQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Leave out places already in this trip (you must be able to view it)',
  })
  @IsOptional()
  @IsUUID()
  excludeTripId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/** Coordinates are used for this query only: never stored, logged or echoed in errors. */
export class NearbyQueryDto {
  @ApiProperty({ example: 48.2082 })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: 16.3738 })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  lng: number;

  @ApiPropertyOptional({ minimum: 0.1, maximum: 50, default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.1)
  @Max(50)
  radiusKm?: number;

  @ApiPropertyOptional({ description: 'nextCursor from the previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class SearchQueryDto {
  @ApiProperty({ minLength: 2, maxLength: 100, example: 'stephansdom' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(2, 100)
  q: string;

  @ApiPropertyOptional({
    example: 48.2082,
    description: 'With lng: ranks results near this point. Not stored.',
  })
  @ValidateIf((o: SearchQueryDto) => o.lat !== undefined || o.lng !== undefined)
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ example: 16.3738 })
  @ValidateIf((o: SearchQueryDto) => o.lat !== undefined || o.lng !== undefined)
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  lng?: number;
}

/** A place on the map: in-view, popular, nearby and along-the-way results. */
export class PlaceItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'Localized from OSM name:<lang> when available' })
  name: string;

  @ApiProperty({ enum: PLACE_CATEGORIES })
  category: PlaceCategory;

  @ApiProperty({ type: LocationDto })
  location: LocationDto;

  @ApiProperty({
    description:
      'Liked on Tripinly (popularity > 0); show the Tripinly pin style',
  })
  isTripinly: boolean;

  @ApiProperty({
    description: 'Popularity: likes on public markers here + place likes',
  })
  likeCount: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Most-liked public photo here (from the photos stage on)',
  })
  coverThumbUrl: string | null;

  @ApiProperty({ description: 'From the social stage on; false until then' })
  likedByMe: boolean;
}

export class PlaceClusterDto {
  @ApiProperty({ description: 'Tripinly places in this cluster' })
  count: number;

  @ApiProperty({
    type: LocationDto,
    description: 'Centre of the clustered places',
  })
  location: LocationDto;
}

export class InViewResponseDto {
  @ApiProperty({
    type: [PlaceItemDto],
    description:
      'Tripinly places first (by popularity), then OSM places from zoom 14',
  })
  places: PlaceItemDto[];

  @ApiProperty({
    type: [PlaceClusterDto],
    description:
      'Below zoom 14, when there are more Tripinly places than `limit`; else empty',
  })
  clusters: PlaceClusterDto[];

  @ApiProperty({ example: OSM_ATTRIBUTION })
  attribution: string;
}

export class PopularResponseDto {
  @ApiProperty({ type: [PlaceItemDto] })
  items: PlaceItemDto[];

  @ApiProperty({ example: OSM_ATTRIBUTION })
  attribution: string;
}

export class NearbyPlaceDto extends PlaceItemDto {
  @ApiProperty({ description: 'From the query point, in metres' })
  distanceMeters: number;
}

export class NearbyPageDto {
  @ApiProperty({
    type: [NearbyPlaceDto],
    description:
      'Tripinly places by popularity and distance. When fewer than 10 are in range, the first page is topped up with OSM sights by distance.',
  })
  items: NearbyPlaceDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;

  @ApiProperty({ example: OSM_ATTRIBUTION })
  attribution: string;
}

export const SEARCH_SOURCES = ['place', 'photon'] as const;

export class SearchResultDto {
  @ApiProperty({
    enum: SEARCH_SOURCES,
    description:
      'place: one of our places (send placeId). photon: an address, street or city (send name + location + osmType/osmId).',
  })
  source: (typeof SEARCH_SOURCES)[number];

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Our place id; null for photon',
  })
  id: string | null;

  @ApiProperty()
  name: string;

  @ApiProperty({
    enum: PLACE_CATEGORIES,
    nullable: true,
    description: 'null for photon',
  })
  category: PlaceCategory | null;

  @ApiProperty({ type: LocationDto })
  location: LocationDto;

  @ApiProperty()
  isTripinly: boolean;

  @ApiProperty()
  likeCount: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'city',
    description:
      'Photon type: house, street, locality, district, city, county, state, country, other',
  })
  type: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Stephansplatz 1, Wien, Austria',
    description: 'Photon: street, city and country for telling results apart',
  })
  address: string | null;

  @ApiProperty({ enum: OSM_TYPES, nullable: true })
  osmType: (typeof OSM_TYPES)[number] | null;

  @ApiProperty({ type: String, nullable: true, example: '240109189' })
  osmId: string | null;
}

export class SearchResponseDto {
  @ApiProperty({
    type: [SearchResultDto],
    description: 'Our places first, then Photon results we do not already have',
  })
  items: SearchResultDto[];

  @ApiProperty({ example: OSM_ATTRIBUTION })
  attribution: string;
}

export class PlaceTagsDto {
  @ApiProperty({ type: String, nullable: true })
  website: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Mo-Su 08:00-21:00',
    description: 'OSM opening_hours syntax',
  })
  openingHours: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'austrian' })
  cuisine: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Q167679' })
  wikidata: string | null;
}

export class PlaceDetailDto extends PickType(PlaceItemDto, [
  'id',
  'name',
  'category',
  'location',
  'isTripinly',
  'likeCount',
  'coverThumbUrl',
  'likedByMe',
] as const) {
  @ApiProperty({ enum: ['osm', 'user'] })
  source: 'osm' | 'user';

  @ApiProperty({
    description: 'false when OSM no longer has it; existing markers keep it',
  })
  isActive: boolean;

  @ApiProperty({ enum: OSM_TYPES, nullable: true })
  osmType: (typeof OSM_TYPES)[number] | null;

  @ApiProperty({ type: String, nullable: true })
  osmId: string | null;

  @ApiProperty({ type: PlaceTagsDto })
  tags: PlaceTagsDto;

  @ApiProperty({
    type: [String],
    description:
      'A few public photo thumbnails (from the photos stage on; empty until then)',
  })
  photoThumbUrls: string[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: OSM_ATTRIBUTION,
    description: 'Set for OSM-derived places',
  })
  attribution: string | null;
}

export class AddToTripDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  dayId: string;

  @ApiPropertyOptional({ example: '14:30', description: 'Local time HH:mm' })
  @IsOptional()
  @Matches(TIME_PATTERN)
  time?: string;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Insert position; appended when omitted',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  position?: number;
}
