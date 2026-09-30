import { ApiProperty } from '@nestjs/swagger';

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
