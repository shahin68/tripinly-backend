import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
} from 'class-validator';
import type { PlaceCategory } from '../../generated/prisma/client';
import { PLACE_CATEGORIES } from '../markers/markers.dto';
import { PlaceItemDto, toCategoryList } from '../places/places.dto';
import { ROUTING_MODES, type RoutingMode } from './routing.provider';
import { TRANSIT_VEHICLES } from './transit/transit.provider';

/** Route lines also go by public transport; best order does not. */
export const ROUTE_MODES = [...ROUTING_MODES, 'transit'] as const;
export type RouteMode = (typeof ROUTE_MODES)[number];

export const ROUTING_ATTRIBUTION =
  '© openrouteservice.org | © OpenStreetMap contributors';

/** Public transport routes: MOTIS on our timetables and OSM streets. */
export function transitAttribution(credit: string): string {
  return `Timetables: ${credit} | © OpenStreetMap contributors`;
}

const POINT_PATTERN = /^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;

class ModeAndCategoriesDto {
  @ApiPropertyOptional({
    enum: ROUTE_MODES,
    default: 'walking',
    description:
      'transit: public transport (tram, U-Bahn, train, bus) where app-config `transitAreas` covers both ends; 422 TRANSIT_NO_COVERAGE elsewhere',
  })
  @IsOptional()
  @IsIn(ROUTE_MODES)
  mode?: RouteMode;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-11-17T09:42:00Z',
    description:
      'transit only: leave at this time (default now). The app sends the open trip day at the current clock time',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  departAt?: string;

  @ApiPropertyOptional({
    type: String,
    example: 'cafe,attraction',
    description: `Places along the way, comma-separated: ${PLACE_CATEGORIES.join(', ')}. All when omitted`,
  })
  @IsOptional()
  @Transform(toCategoryList)
  @ArrayMaxSize(PLACE_CATEGORIES.length)
  @ArrayUnique()
  @IsIn(PLACE_CATEGORIES, { each: true })
  categories?: PlaceCategory[];
}

export class RouteQueryDto extends ModeAndCategoriesDto {
  @ApiProperty({ example: '48.2082,16.3738', description: 'lat,lng' })
  @Matches(POINT_PATTERN, { message: 'invalidPoint' })
  from: string;

  @ApiProperty({ example: '48.1986,16.3417', description: 'lat,lng' })
  @Matches(POINT_PATTERN, { message: 'invalidPoint' })
  to: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: "Leave this trip's places out of alongTheWay",
  })
  @IsOptional()
  @IsUUID()
  excludeTripId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The place at the start, if the route starts at one: left out of alongTheWay',
  })
  @IsOptional()
  @IsUUID()
  fromPlaceId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The place at the end, if the route goes to one: left out of alongTheWay',
  })
  @IsOptional()
  @IsUUID()
  toPlaceId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'transit only: arrive by this time instead (not with departAt)',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  arriveBy?: string;
}

export class DayRouteQueryDto extends ModeAndCategoriesDto {}

export class OptimizeQueryDto {
  @ApiPropertyOptional({
    enum: ROUTING_MODES,
    default: 'walking',
    description: 'Travel mode for the travel times',
  })
  @IsOptional()
  @IsIn(ROUTING_MODES)
  mode?: RoutingMode;

  @ApiPropertyOptional({
    default: false,
    description: 'Save the proposed order (owner or editor)',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  apply?: boolean;
}

export class RouteLegDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Null for A→B routes',
  })
  fromMarkerId: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  toMarkerId: string | null;

  @ApiProperty()
  distanceMeters: number;

  @ApiProperty()
  durationSeconds: number;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'transit only: when this leg sets off',
  })
  departure?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'transit only' })
  arrival?: string;

  @ApiPropertyOptional({ description: 'transit only: changes on this leg' })
  transfers?: number;

  @ApiPropertyOptional({
    type: () => [TransitStepDto],
    description:
      'transit only: walks and rides in order. A leg without a connection is one straight walk step, with degraded=true',
  })
  steps?: TransitStepDto[];
}

export class TransitLineDto {
  @ApiProperty({ example: 'U2' })
  name: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '#A862A4',
    description: "The line's own colour, #RRGGBB; null when the feed has none",
  })
  color: string | null;

  @ApiProperty({ type: String, nullable: true, example: '#FFFFFF' })
  textColor: string | null;
}

export class TransitPlaceDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Museumsquartier',
    description: "The stop's name; null at the route's own start and end",
  })
  name: string | null;

  @ApiProperty()
  lat: number;

  @ApiProperty()
  lng: number;

  @ApiProperty({ format: 'date-time' })
  time: string;
}

export class TransitStepDto {
  @ApiProperty({ enum: ['walk', 'ride'] })
  kind: 'walk' | 'ride';

  @ApiProperty({ enum: TRANSIT_VEHICLES, nullable: true, type: String })
  vehicle: (typeof TRANSIT_VEHICLES)[number] | null;

  @ApiProperty({ type: TransitLineDto, nullable: true })
  line: TransitLineDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Karlsplatz',
    description: 'Where the ride is heading',
  })
  headsign: string | null;

  @ApiProperty({ type: TransitPlaceDto })
  from: TransitPlaceDto;

  @ApiProperty({ type: TransitPlaceDto })
  to: TransitPlaceDto;

  @ApiProperty({ description: 'Stops passed between getting on and off' })
  stops: number;

  @ApiProperty()
  distanceMeters: number;

  @ApiProperty()
  durationSeconds: number;

  @ApiProperty({ description: 'Encoded polyline, precision 5' })
  polyline: string;
}

export class RouteDto {
  @ApiProperty({ description: 'Encoded polyline, precision 5' })
  polyline: string;

  @ApiProperty()
  distanceMeters: number;

  @ApiProperty()
  durationSeconds: number;

  @ApiProperty({ type: [RouteLegDto] })
  legs: RouteLegDto[];

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'transit only: when the route sets off',
  })
  departure?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'transit only' })
  arrival?: string;

  @ApiPropertyOptional({ description: 'transit only: changes in all' })
  transfers?: number;

  @ApiPropertyOptional({
    description:
      "transit only: the date is beyond (or before) the published timetable, so the times are the same weekday's in the current one",
  })
  typicalTimes?: boolean;
}

export class AlongTheWayDto {
  @ApiProperty({ type: PlaceItemDto })
  place: PlaceItemDto;

  @ApiProperty()
  distanceFromRouteMeters: number;

  @ApiProperty({ description: '0 at the start, 1 at the end' })
  positionAlongRoute: number;

  @ApiProperty()
  etaFromStartSeconds: number;
}

export class RouteResponseDto {
  @ApiProperty({
    type: RouteDto,
    nullable: true,
    description: 'Null for a day with fewer than two markers',
  })
  route: RouteDto | null;

  @ApiProperty({
    type: [AlongTheWayDto],
    description: 'Ordered along the route',
  })
  alongTheWay: AlongTheWayDto[];

  @ApiProperty({
    description:
      'True when routing is unavailable (quota used up, not configured): the route is straight lines with estimated times',
  })
  degraded: boolean;

  @ApiProperty({ example: ROUTING_ATTRIBUTION })
  attribution: string;
}

export const OPTIMIZE_MODES = ['straight_line', 'travel_time'] as const;

export class OptimizeResultDto {
  @ApiProperty({ format: 'uuid' })
  dayId: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Proposed order; the first marker stays first',
  })
  markerIds: string[];

  @ApiProperty({
    enum: OPTIMIZE_MODES,
    description:
      'travel_time, or straight_line when travel times are unavailable',
  })
  mode: (typeof OPTIMIZE_MODES)[number];

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Minutes saved against the current order (travel_time only)',
  })
  savedMinutes: number | null;

  @ApiProperty({
    description: 'Travel times were unavailable: straight_line was used',
  })
  degraded: boolean;

  @ApiProperty({ description: 'The order was saved (apply=true)' })
  applied: boolean;
}
