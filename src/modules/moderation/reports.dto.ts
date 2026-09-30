import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQueryDto, type Page } from '../../common/pagination/pagination';

export const REPORT_TARGET_TYPES = [
  'user',
  'trip',
  'marker',
  'photo',
  'comment',
] as const;
export type ReportTargetTypeValue = (typeof REPORT_TARGET_TYPES)[number];

export const REPORT_REASONS = [
  'spam',
  'harassment',
  'nudity',
  'violence',
  'hate',
  'other',
] as const;

export const REPORT_STATUSES = ['open', 'actioned', 'dismissed'] as const;

/** What an admin can do with a report. */
export const REVIEW_ACTIONS = [
  'dismiss',
  'hide_content',
  'suspend_user',
  'delete_content',
] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

export class CreateReportDto {
  @ApiProperty({ enum: REPORT_TARGET_TYPES })
  @IsIn(REPORT_TARGET_TYPES)
  targetType!: ReportTargetTypeValue;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  targetId!: string;

  @ApiProperty({ enum: REPORT_REASONS })
  @IsIn(REPORT_REASONS)
  reason!: (typeof REPORT_REASONS)[number];

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  details?: string;
}

export class ReportDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: REPORT_TARGET_TYPES })
  targetType!: ReportTargetTypeValue;

  @ApiProperty({ format: 'uuid' })
  targetId!: string;

  @ApiProperty({ enum: REPORT_REASONS })
  reason!: (typeof REPORT_REASONS)[number];

  @ApiProperty({ enum: REPORT_STATUSES })
  status!: (typeof REPORT_STATUSES)[number];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AdminReportsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: REPORT_STATUSES, default: 'open' })
  @IsOptional()
  @IsIn(REPORT_STATUSES)
  status?: (typeof REPORT_STATUSES)[number];
}

export class ReviewReportDto {
  @ApiProperty({
    enum: REVIEW_ACTIONS,
    description:
      'hide_content and delete_content need a trip, marker, photo or comment; suspend_user suspends the reported user or the author of the reported content.',
  })
  @IsIn(REVIEW_ACTIONS)
  action!: ReviewAction;

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'Kept in the audit log.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ReportUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  username!: string | null;
}

export class ReportTargetDto {
  @ApiProperty({ description: 'False once the target was deleted.' })
  exists!: boolean;

  @ApiProperty({
    type: ReportUserDto,
    nullable: true,
    description: 'The reported user, or the owner/author of the content.',
  })
  owner!: ReportUserDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Trip title, marker name, comment body or display name. Photos: null.',
  })
  text!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Photo thumbnail URL.',
  })
  thumbUrl!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  tripId!: string | null;

  @ApiProperty({
    description: 'Hidden by moderation, or the user is suspended.',
  })
  hidden!: boolean;
}

export class AdminReportDto extends ReportDto {
  @ApiProperty({ type: String, nullable: true })
  details!: string | null;

  @ApiProperty({
    enum: [...REVIEW_ACTIONS, 'target_deleted'],
    nullable: true,
    type: String,
  })
  action!: ReviewAction | 'target_deleted' | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reviewedAt!: string | null;

  @ApiProperty({
    type: ReportUserDto,
    nullable: true,
    description: 'Null once the reporter deleted their account.',
  })
  reporter!: ReportUserDto | null;

  @ApiProperty({
    description: 'Open reports on the same target, this one included.',
  })
  openReportCount!: number;

  @ApiProperty({ type: ReportTargetDto })
  target!: ReportTargetDto;
}

export class AdminReportsDto implements Page<AdminReportDto> {
  @ApiProperty({ type: [AdminReportDto] })
  items!: AdminReportDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
