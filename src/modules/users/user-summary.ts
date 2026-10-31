import { ApiProperty } from '@nestjs/swagger';
import type { User } from '../../generated/prisma/client';
import { thumbUrl, type UrlSigner } from '../photos/photo-keys';

export class UserSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'jonas.k' })
  username: string;

  @ApiProperty({ example: 'Jonas' })
  displayName: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'The profile photo, the image cache key; null when there is none (apps show the letter avatar)',
  })
  avatarPhotoId: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Signed 256 px square thumb of the profile photo, or null',
  })
  avatarThumbUrl: string | null;
}

export const USER_SUMMARY_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarPhotoId: true,
} as const;

export type UserSummaryRow = Pick<
  User,
  'id' | 'username' | 'displayName' | 'avatarPhotoId'
>;

/** Only onboarded users appear to others, so username and displayName are set. */
export function toUserSummary(
  user: UserSummaryRow,
  signer: UrlSigner,
): UserSummaryDto {
  return {
    id: user.id,
    username: user.username ?? '',
    displayName: user.displayName ?? '',
    avatarPhotoId: user.avatarPhotoId,
    avatarThumbUrl: thumbUrl(signer, user.avatarPhotoId),
  };
}
