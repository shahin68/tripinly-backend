import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import type { Photo, PhotoStatus } from '../../generated/prisma/client';
import { ImageCreditDto } from '../places/places.dto';
import { toUserSummary, UserSummaryDto } from '../users/user-summary';
import { photoKeys, type UrlSigner } from './photo-keys';

/** HEIC isn't decodable by our image library; the app converts to JPEG before upload. */
export const PHOTO_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export type PhotoMimeType = (typeof PHOTO_MIME_TYPES)[number];
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
export const MAX_PHOTOS_PER_MARKER = 30;
/** A place's gallery shows at most this many photos, the most liked first. */
export const MAX_PLACE_GALLERY = 100;

export const PHOTO_SOURCES = ['user', 'commons'] as const;
export type PhotoSource = (typeof PHOTO_SOURCES)[number];

export class UploadUrlRequestDto {
  @ApiProperty({
    enum: PHOTO_MIME_TYPES,
    description: 'Other types → 415 UNSUPPORTED_MEDIA_TYPE',
  })
  @IsString()
  @MaxLength(100)
  mimeType: string;

  @ApiProperty({
    example: 2_400_000,
    description: `Size of the file to upload. Over ${MAX_PHOTO_BYTES} bytes → 413 UPLOAD_TOO_LARGE`,
  })
  @IsInt()
  @Min(1)
  bytes: number;
}

export class PhotoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The stop of a trip photo; null for a place photo',
  })
  markerId: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The place of a place photo; null for a trip photo',
  })
  placeId: string | null;

  @ApiProperty({
    enum: ['pending_upload', 'processing', 'ready', 'failed'],
    description:
      'Only ready photos are shown to viewers; editors also see processing and failed ones',
  })
  status: PhotoStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '256 px square, signed, valid ≥ 1 h; null until ready',
  })
  thumbUrl: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '≤ 1600 px long edge, signed, valid ≥ 1 h; null until ready',
  })
  displayUrl: string | null;

  @ApiProperty({ type: Number, nullable: true })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true })
  height: number | null;

  @ApiProperty({ description: 'Gallery order, 0-based; 0 for place photos' })
  position: number;

  @ApiProperty()
  likeCount: number;

  @ApiProperty()
  likedByMe: boolean;

  @ApiProperty({ type: UserSummaryDto, nullable: true })
  uploader: UserSummaryDto | null;

  @ApiProperty()
  createdAt: string;

  @ApiProperty({
    enum: PHOTO_SOURCES,
    description:
      "`user`: uploaded by someone in the app. `commons`: one of a place's Wikimedia Commons images, only in a place's Photos list; like it with targetType place_image, and show its credit",
  })
  source: PhotoSource;

  @ApiProperty({
    type: ImageCreditDto,
    nullable: true,
    description:
      'Commons images only: show "© author · licence · Wikimedia Commons" with it. Null for photos people uploaded',
  })
  credit: ImageCreditDto | null;
}

export class UploadUrlResponseDto {
  @ApiProperty({
    type: PhotoDto,
    description: 'The new photo, status pending_upload',
  })
  photo: PhotoDto;

  @ApiProperty({
    description: 'PUT the file here with exactly the headers below',
  })
  uploadUrl: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { 'Content-Type': 'image/jpeg', 'Content-Length': '2400000' },
    description: 'Send these headers with the PUT',
  })
  uploadHeaders: Record<string, string>;

  @ApiProperty({
    description: 'The upload URL stops working after this (10 minutes)',
  })
  expiresAt: string;
}

export class CoverDto {
  @ApiProperty({
    format: 'uuid',
    description:
      "A ready photo or Commons image in the stop's photo grid (GET /markers/{id}/photos)",
  })
  @IsUUID()
  photoId: string;
}

export type PhotoWithUploader = Photo & {
  uploader: { id: string; username: string | null; displayName: string | null };
};

export const PHOTO_INCLUDE = {
  uploader: { select: { id: true, username: true, displayName: true } },
} as const;

export function toPhotoDto(
  photo: PhotoWithUploader,
  signer: UrlSigner,
  hiddenUserIds: ReadonlySet<string> = new Set(),
  likedIds: ReadonlySet<string> = new Set(),
): PhotoDto {
  const keys = photoKeys(photo.id);
  const ready = photo.status === 'ready';
  return {
    id: photo.id,
    markerId: photo.markerId,
    placeId: photo.placeId,
    status: photo.status,
    thumbUrl: ready ? signer.signedGetUrl(keys.thumb) : null,
    displayUrl: ready ? signer.signedGetUrl(keys.display) : null,
    width: photo.width,
    height: photo.height,
    position: photo.position,
    likeCount: photo.likeCount,
    likedByMe: likedIds.has(photo.id),
    uploader: hiddenUserIds.has(photo.uploaderId)
      ? null
      : toUserSummary(photo.uploader),
    createdAt: photo.createdAt.toISOString(),
    source: 'user',
    credit: null,
  };
}
