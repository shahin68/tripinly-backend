import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, IsUUID, Length } from 'class-validator';
import type { Page } from '../../common/pagination/pagination';
import { UserSummaryDto } from '../users/user-summary';

/**
 * What `/likes/{targetType}/…` likes. `place_image` is a place's Commons image
 * in its Photos list. Places aren't liked but marked hot (PUT /places/{id}/hot),
 * and a stop's flame marks its place (E1).
 */
export const LIKE_TARGET_TYPES = [
  'trip',
  'photo',
  'comment',
  'place_image',
] as const;
export type LikeTargetTypeValue = (typeof LIKE_TARGET_TYPES)[number];
/** Every kind of stored like: a hot mark on a place is stored as a like of type `place`. */
export type StoredLikeType = LikeTargetTypeValue | 'place';

export class LikeParamsDto {
  @ApiProperty({ enum: LIKE_TARGET_TYPES })
  @IsIn(LIKE_TARGET_TYPES)
  targetType: LikeTargetTypeValue;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  targetId: string;
}

export class LikeStateDto {
  @ApiProperty({ enum: LIKE_TARGET_TYPES })
  targetType: LikeTargetTypeValue;

  @ApiProperty({ format: 'uuid' })
  targetId: string;

  @ApiProperty()
  liked: boolean;

  @ApiProperty({ description: "The target's like count after the change" })
  likeCount: number;
}

export class HotStateDto {
  @ApiProperty({ format: 'uuid' })
  placeId: string;

  @ApiProperty({ description: 'I marked the place hot' })
  hot: boolean;

  @ApiProperty({ description: "The place's hotCount after the change" })
  hotCount: number;
}

export const COMMENT_MAX_LENGTH = 1000;

export class CreateCommentDto {
  @ApiProperty({ minLength: 1, maxLength: COMMENT_MAX_LENGTH })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, COMMENT_MAX_LENGTH)
  body: string;
}

export class CommentDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  markerId: string;

  @ApiProperty()
  body: string;

  @ApiProperty({ type: UserSummaryDto })
  author: UserSummaryDto;

  @ApiProperty()
  likeCount: number;

  @ApiProperty()
  likedByMe: boolean;

  @ApiProperty({ description: 'I wrote it, or I own the trip' })
  canDelete: boolean;

  @ApiProperty()
  createdAt: string;
}

export class CommentPageDto implements Page<CommentDto> {
  @ApiProperty({ type: [CommentDto] })
  items: CommentDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}
