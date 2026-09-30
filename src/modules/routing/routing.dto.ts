import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsBoolean,
  IsIn,
  IsOptional,
  IsUUID,
  Matches,
} from 'class-validator';
import type { PlaceCategory } from '../../generated/prisma/client';
import { PLACE_CATEGORIES } from '../markers/markers.dto';
import { PlaceItemDto, toCategoryList } from '../places/places.dto';
import { ROUTING_MODES, type RoutingMode } from './routing.provider';

export const ROUTING_ATTRIBUTION =
  '© openrouteservice.org | © OpenStreetMap contributors';

const POINT_PATTERN = /^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;

class ModeAndCategoriesDto {
  @ApiPropertyOptional({ enum: ROUTING_MODES, default: 'walking' })
  @IsOptional()
  @IsIn(ROUTING_MODES)
  mode?: RoutingMode;

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
}

export class DayRouteQueryDto extends ModeAndCategoriesDto {}

export class OptimizeQueryDto {
  @ApiPropertyOptional({
    enum: ROUTING_MODES,
    default: 'walking',
    description: 'Travel mode for premium travel times',
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
    description: 'travel_time with Tripinly Pro, otherwise straight_line',
  })
  mode: (typeof OPTIMIZE_MODES)[number];

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Minutes saved against the current order (travel_time only)',
  })
  savedMinutes: number | null;

  @ApiProperty({
    description:
      'Pro user, but travel times were unavailable: straight_line was used',
  })
  degraded: boolean;

  @ApiProperty({ description: 'The order was saved (apply=true)' })
  applied: boolean;
}
