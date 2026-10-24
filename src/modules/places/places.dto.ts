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
import { UserSummaryDto } from '../users/user-summary';

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

export const COVER_SOURCES = ['trip', 'commons'] as const;
export type CoverSource = (typeof COVER_SOURCES)[number];

const NUMBER = '-?\\d{1,3}(\\.\\d+)?';
const BBOX_PATTERN = new RegExp(`^${NUMBER},${NUMBER},${NUMBER},${NUMBER}$`);

export const toCategoryList = ({ value }: { value: unknown }) =>
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

/** Squares in one tiles request; a phone view plus the ring around it fits. */
export const MAX_TILES_PER_REQUEST = 16;
const TILE = '\\d{1,2}/-?\\d{1,7}/-?\\d{1,7}';
const TILES_PATTERN = new RegExp(
  `^${TILE}(,${TILE}){0,${MAX_TILES_PER_REQUEST - 1}}$`,
);

export class TilesQueryDto extends PickType(InViewQueryDto, [
  'zoom',
  'categories',
  'limit',
] as const) {
  @ApiProperty({
    example: '13/4469/2840,13/4470/2840',
    description: `Comma-separated map squares \`z/x/y\`, at most ${MAX_TILES_PER_REQUEST}. A square is \`360 / 2^z\` degrees a side on a plain longitude/latitude grid: x covers longitudes \`[x·side, (x+1)·side]\`, y latitudes \`[y·side, (y+1)·side]\` (both may be negative). A square too large for the zoom returns BBOX_TOO_LARGE.`,
  })
  @Matches(TILES_PATTERN, { message: 'invalidTiles' })
  tiles: string;
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

export const SEARCH_SCOPES = ['all', 'destination'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export class SearchQueryDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 100,
    example: 'stephansdom',
    description:
      'From the first letter. A single letter only searches Photon (prefix matches such as cities); our places need two',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 100)
  q: string;

  @ApiPropertyOptional({
    enum: SEARCH_SCOPES,
    default: 'all',
    description:
      '`all`: our places, then Photon addresses and cities. `destination`: only countries, regions, cities and districts (Photon), most important first, for a trip destination',
  })
  @IsOptional()
  @IsIn(SEARCH_SCOPES)
  scope?: SearchScope;

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
    description: 'A hot spot (hotCount > 0); show the Tripinly pin style',
  })
  isTripinly: boolean;

  @ApiProperty({
    description:
      "How many people marked the place hot (a stop's flame marks its place); a custom spot counts only while a public trip has it",
  })
  hotCount: number;

  @ApiProperty({
    minimum: 0,
    maximum: 100,
    description:
      'How well known the place is, 0–100, from QRank (Wikimedia page views) and OSM tags; 0 when unknown. Size map pins by it (thresholds in GET /v1/app-config)',
  })
  prominence: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Id of the cover when it is a Tripinly photo (a place photo or a trip photo), or null (a Commons cover has only coverImageId)',
  })
  coverPhotoId: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Id of the cover image, a Tripinly photo or a Commons image (stable; cache the image by it and coverSource), or null',
  })
  coverImageId: string | null;

  @ApiProperty({
    enum: COVER_SOURCES,
    nullable: true,
    description:
      '`trip`: a Tripinly photo (a place photo or a trip photo); `commons`: a Wikimedia Commons image (credit it on tap from GET /places/{id}); null without a cover',
  })
  coverSource: CoverSource | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Thumbnail of the cover, also drawn in the map pin: the place's photo, or a photo on a stop here in a public trip, with the most likes, once at least APP_PLACE_PHOTO_PIN_MIN_LIKES (3) people other than its uploader liked it (ties: the newest); else the place's first Wikimedia Commons image; signed, valid ≥ 1 h",
  })
  coverThumbUrl: string | null;

  @ApiProperty({ description: 'I marked the place hot' })
  hotByMe: boolean;
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

export class PlaceTileDto {
  @ApiProperty({ example: '13/4469/2840', description: 'The square, as asked' })
  tile: string;

  @ApiProperty({
    type: [PlaceItemDto],
    description: 'What in-view returns for the square',
  })
  places: PlaceItemDto[];

  @ApiProperty({ type: [PlaceClusterDto] })
  clusters: PlaceClusterDto[];
}

export class TilesResponseDto {
  @ApiProperty({ type: [PlaceTileDto] })
  tiles: PlaceTileDto[];

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
  hotCount: number;

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

export class ImageCreditDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Who to credit (the uploader's own wording when given)",
  })
  author: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Title of the work; set only where the licence requires it (CC before 4.0)',
  })
  title: string | null;

  @ApiProperty({
    example: 'CC BY-SA 4.0',
    description: 'Licence name, or "Public domain"',
  })
  license: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Link the licence name here',
  })
  licenseUrl: string | null;

  @ApiProperty({
    description: 'The file page on Wikimedia Commons; link the author here',
  })
  sourceUrl: string;
}

export class PlaceImageDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Stable; cache the image by it and source',
  })
  id: string;

  @ApiProperty({ enum: COVER_SOURCES })
  source: CoverSource;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '256 px square; signed, valid ≥ 1 h',
  })
  thumbUrl: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Up to 1600 px (trip) or 1280 px wide (Commons), uncropped; signed, valid ≥ 1 h',
  })
  displayUrl: string | null;

  @ApiProperty({ type: Number, nullable: true })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true })
  height: number | null;

  @ApiProperty({
    type: ImageCreditDto,
    nullable: true,
    description:
      'For Commons images: show "© author · licence · Wikimedia Commons" under the image (with the title first when set, and "· cropped" where the app crops it). Null for trip photos',
  })
  credit: ImageCreditDto | null;
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
  'hotCount',
  'prominence',
  'coverPhotoId',
  'coverImageId',
  'coverSource',
  'coverThumbUrl',
  'hotByMe',
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
    deprecated: true,
    description:
      'Use images. Up to 10 photos that may represent the place (same rule as coverThumbUrl), most likes first',
  })
  photoThumbUrls: string[];

  @ApiProperty({
    type: () => [PlaceImageDto],
    description:
      'Images for the card: up to 10 photos that may represent the place (place photos and public trip photos, most likes first), then its Wikimedia Commons images. The first one is the cover',
  })
  images: PlaceImageDto[];

  @ApiProperty({
    type: UserSummaryDto,
    nullable: true,
    description:
      "Who made this user place, credited as 'Added by': set only while they have it in one of their public trips, and never for someone with a block either way. Null for OSM places",
  })
  addedBy: UserSummaryDto | null;

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
