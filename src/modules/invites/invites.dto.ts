import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUUID, Length, Matches } from 'class-validator';
import { UserSummaryDto } from '../users/user-summary';

export class InviteDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'tripinly://app/invites/3q2…',
    description: 'Only returned when the invite is created',
  })
  url?: string;

  @ApiPropertyOptional({
    description: 'Only returned when the invite is created',
  })
  token?: string;

  @ApiProperty()
  expiresAt: string;

  @ApiProperty()
  createdAt: string;
}

export class InvitesDto {
  @ApiProperty({
    type: [InviteDto],
    description: 'Active (not expired, not revoked) invites',
  })
  items: InviteDto[];
}

export class InvitePreviewDto {
  @ApiProperty({ format: 'uuid' })
  tripId: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ type: UserSummaryDto })
  owner: UserSummaryDto;

  @ApiProperty({ type: String, nullable: true })
  startDate: string | null;

  @ApiProperty({ type: String, nullable: true })
  endDate: string | null;

  @ApiProperty()
  expiresAt: string;

  @ApiProperty({ description: 'The caller is already a member' })
  alreadyMember: boolean;
}

export class InviteTokenParamDto {
  @ApiProperty()
  @IsString()
  @Length(20, 100)
  @Matches(/^[A-Za-z0-9_-]+$/)
  token: string;
}

export class InviteParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  inviteId: string;
}
