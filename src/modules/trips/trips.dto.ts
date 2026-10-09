import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { Page } from '../../common/pagination/pagination';
import { LocationDto, MarkerDto } from '../markers/markers.dto';
import { UserSummaryDto } from '../users/user-summary';
import { VISIBILITIES, type VisibilityValue } from '../users/users.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const TRIP_ROLES = ['owner', 'editor'] as const;
export const MY_ROLES = ['owner', 'editor', 'viewer'] as const;

export class DestinationDto {
  @ApiProperty({ minLength: 1, maxLength: 200, example: 'Paris' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  name: string;

  @ApiProperty({ type: LocationDto })
  @IsObject()
  @ValidateNested()
  @Type(() => LocationDto)
  location: LocationDto;
}

export class CreateTripDto {
  @ApiProperty({ minLength: 1, maxLength: 100, example: 'Vienna weekend' })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  title: string;

  @ApiPropertyOptional({
    example: '2026-10-09',
    description: 'Without dates the trip has one "Day 1"',
  })
  @IsOptional()
  @Matches(DATE)
  startDate?: string;

  @ApiPropertyOptional({
    example: '2026-10-11',
    description: 'Needs startDate; one day is created per date (max 20)',
  })
  @IsOptional()
  @Matches(DATE)
  endDate?: string;

  @ApiPropertyOptional({
    enum: VISIBILITIES,
    description: "Defaults to the user's defaultTripVisibility",
  })
  @IsOptional()
  @IsIn(VISIBILITIES)
  visibility?: VisibilityValue;

  @ApiPropertyOptional({
    type: DestinationDto,
    description:
      'Where the trip goes, e.g. a city from GET /places/search. The map opens there while the trip has no markers',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DestinationDto)
  destination?: DestinationDto;

  @ApiPropertyOptional({
    type: [String],
    maxItems: 20,
    description: 'Added as editors',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  memberUsernames?: string[];
}

export class UpdateTripDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  title?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '2026-10-09',
    description: 'null removes the dates (days stay, shown as "Day n")',
  })
  @ValidateIf(
    (o: UpdateTripDto) => o.startDate !== null && o.startDate !== undefined,
  )
  @Matches(DATE)
  startDate?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: '2026-10-11',
    description:
      'Resizes the trip: adds empty days, or removes trailing days if they have no markers (else 400 fields.endDate = ["daysNotEmpty"])',
  })
  @IsOptional()
  @Matches(DATE)
  endDate?: string;

  @ApiPropertyOptional({ enum: VISIBILITIES })
  @IsOptional()
  @IsIn(VISIBILITIES)
  visibility?: VisibilityValue;

  @ApiPropertyOptional({
    type: DestinationDto,
    nullable: true,
    description: 'null removes the destination',
  })
  @ValidateIf(
    (o: UpdateTripDto) => o.destination !== null && o.destination !== undefined,
  )
  @IsObject()
  @ValidateNested()
  @Type(() => DestinationDto)
  destination?: DestinationDto | null;
}

export class TripMemberDto {
  @ApiProperty({ type: UserSummaryDto })
  user: UserSummaryDto;

  @ApiProperty({ enum: TRIP_ROLES })
  role: (typeof TRIP_ROLES)[number];
}

export class TripDayDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description: '0-based; the client shows "Day n" as position + 1',
  })
  position: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-10-09',
    description: 'startDate + position, or null',
  })
  date: string | null;

  @ApiProperty({ type: [MarkerDto] })
  markers: MarkerDto[];
}

export class CopiedFromDto {
  @ApiProperty({ format: 'uuid' })
  tripId: string;

  @ApiProperty({ type: UserSummaryDto })
  owner: UserSummaryDto;
}

export class TripDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ type: String, nullable: true, example: '2026-10-09' })
  startDate: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-10-11' })
  endDate: string | null;

  @ApiProperty({ type: DestinationDto, nullable: true })
  destination: DestinationDto | null;

  @ApiProperty({ enum: VISIBILITIES })
  visibility: VisibilityValue;

  @ApiProperty({ type: UserSummaryDto })
  owner: UserSummaryDto;

  @ApiProperty({ enum: MY_ROLES })
  myRole: (typeof MY_ROLES)[number];

  @ApiProperty({ type: [TripMemberDto] })
  members: TripMemberDto[];

  @ApiProperty()
  likeCount: number;

  @ApiProperty()
  likedByMe: boolean;

  @ApiProperty()
  copyCount: number;

  @ApiProperty({
    type: CopiedFromDto,
    nullable: true,
    description: 'Shown as "Copied from @handle" while the source exists',
  })
  copiedFrom: CopiedFromDto | null;

  @ApiProperty({ type: [TripDayDto] })
  days: TripDayDto[];

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}

export class TripSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ type: String, nullable: true })
  startDate: string | null;

  @ApiProperty({ type: String, nullable: true })
  endDate: string | null;

  @ApiProperty({ enum: VISIBILITIES })
  visibility: VisibilityValue;

  @ApiProperty({ type: UserSummaryDto })
  owner: UserSummaryDto;

  @ApiProperty({ enum: MY_ROLES })
  role: (typeof MY_ROLES)[number];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'First cover photo in the trip (from stage 5)',
  })
  coverThumbUrl: string | null;

  @ApiProperty()
  dayCount: number;

  @ApiProperty()
  markerCount: number;

  @ApiProperty()
  likeCount: number;

  @ApiProperty()
  likedByMe: boolean;

  @ApiProperty()
  copyCount: number;

  @ApiProperty()
  updatedAt: string;
}

export class TripSummaryPageDto implements Page<TripSummaryDto> {
  @ApiProperty({ type: [TripSummaryDto] })
  items: TripSummaryDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

export class MeStatsDto {
  @ApiProperty({ description: 'Trips I own or collaborate on' })
  tripCount: number;

  @ApiProperty({ description: 'Markers I created' })
  markerCount: number;

  @ApiProperty({ description: 'Photos I uploaded (from stage 5)' })
  photoCount: number;
}

export class AddMemberDto {
  @ApiProperty({ example: 'anna.n' })
  @IsString()
  @MaxLength(60)
  username: string;
}

export class MemberParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId: string;
}
