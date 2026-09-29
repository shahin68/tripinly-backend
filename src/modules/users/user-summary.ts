import { ApiProperty } from '@nestjs/swagger';
import type { User } from '../../generated/prisma/client';

export class UserSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'jonas.k' })
  username: string;

  @ApiProperty({ example: 'Jonas' })
  displayName: string;
}

export const USER_SUMMARY_SELECT = {
  id: true,
  username: true,
  displayName: true,
} as const;

/** Only onboarded users appear to others, so username and displayName are set. */
export function toUserSummary(
  user: Pick<User, 'id' | 'username' | 'displayName'>,
): UserSummaryDto {
  return {
    id: user.id,
    username: user.username ?? '',
    displayName: user.displayName ?? '',
  };
}
