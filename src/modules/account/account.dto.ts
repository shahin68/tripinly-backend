import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class AccountDeletionDto {
  @ApiProperty({ enum: ['deleting'], example: 'deleting' })
  status!: 'deleting';
}

export class DataExportDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['pending', 'ready', 'failed', 'expired'] })
  status!: 'pending' | 'ready' | 'failed' | 'expired';

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  readyAt!: string | null;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'The file and its link are deleted at this time.',
  })
  expiresAt!: string | null;

  @ApiProperty({ nullable: true, type: Number, description: 'ZIP size.' })
  bytes!: number | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Signed ZIP download link while ready, valid until expiresAt. Never log it.',
  })
  downloadUrl!: string | null;
}

/** Exactly one of `subject` or `username` (checked by the service). */
export class DevDeleteAccountQueryDto {
  @ApiPropertyOptional({
    example: 'alice',
    description:
      'A developer account by the subject it signs in with (case-sensitive, as in POST /auth/dev)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{1,64}$/)
  subject?: string;

  @ApiPropertyOptional({
    example: 'alice',
    description: 'Any account by its username, with or without the @',
  })
  @IsOptional()
  @IsString()
  @Length(1, 31)
  username?: string;
}
