import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination';

export const EXPLORE_PERIODS = [
  'week',
  'month',
  'year',
  'season',
  'all',
] as const;
export type ExplorePeriod = (typeof EXPLORE_PERIODS)[number];

export class ExploreTripsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    default: true,
    description: 'false leaves out trips the caller owns or edits',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeMine?: boolean;

  @ApiPropertyOptional({
    enum: EXPLORE_PERIODS,
    default: 'all',
    description:
      'Every trip (all), only trips created in the last 7, 30 or 365 days (week, month, year), or trips travelled in the current season (season: Dec–Feb, Mar–May, Jun–Aug, Sep–Nov); always ranked by likes, newest first on ties',
  })
  @IsOptional()
  @IsIn(EXPLORE_PERIODS)
  period?: ExplorePeriod;

  /** With [lng]: only trips with a stop near this point. Used for this query only: never stored, logged or echoed in errors. */
  @ApiPropertyOptional({
    example: 48.2082,
    description: 'Nearby filter, with lng',
  })
  @ValidateIf(
    (query: ExploreTripsQueryDto) =>
      query.lng !== undefined || query.lat !== undefined,
  )
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({
    example: 16.3738,
    description: 'Nearby filter, with lat',
  })
  @ValidateIf(
    (query: ExploreTripsQueryDto) =>
      query.lat !== undefined || query.lng !== undefined,
  )
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  lng?: number;
}
