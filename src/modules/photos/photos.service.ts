import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Env } from '../../common/config/env';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  StorageService,
  UPLOAD_URL_TTL_SECONDS,
} from '../../common/storage/storage.service';
import {
  coverPeople,
  MARKER_INCLUDE,
  type MarkerDto,
  toMarkerDto,
} from '../markers/markers.dto';
import { BlocksService } from '../moderation/blocks.service';
import { PlaceMatchingService } from '../places/place-matching.service';
import { placeImageCredit } from '../places/commons-metadata';
import { placeImageKeys } from '../places/place-image-keys';
import { PlaceCoversService } from '../places/place-covers.service';
import { COMMONS_ORDER } from '../places/places.service';
import { likedAmong } from '../social/liked';
import { TripAccessService } from '../trips/trip-access.service';
import { lockTrip } from '../trips/trips.service';
import type { PhotoStatus } from '../../generated/prisma/client';
import { photoKeys } from './photo-keys';
import {
  MAX_PHOTO_BYTES,
  MAX_PHOTOS_PER_MARKER,
  MAX_PLACE_GALLERY,
  PHOTO_INCLUDE,
  PHOTO_MIME_TYPES,
  type PhotoDto,
  type PhotoMimeType,
  type PhotoWithUploader,
  toPhotoDto,
  type UploadUrlRequestDto,
  type UploadUrlResponseDto,
} from './photos.dto';
import { PhotoJobsService } from './photos.queue';

/** The parts of a photo that say where it belongs. */
type PhotoRef = {
  id: string;
  markerId: string | null;
  tripId: string | null;
  placeId: string | null;
};

/**
 * Photo uploads, gallery, order, cover and deletion (photo-pipeline skill).
 * Files go straight from the app to storage with pre-signed URLs; the worker
 * processes them. Trip photos: trip access decides everything; uploads need
 * edit rights. Place photos: anyone who can see the place may add one, up to
 * APP_PLACE_PHOTO_DAILY_LIMIT a day; only the uploader deletes it. Profile
 * photos: only the user's own, through /me/avatar.
 */
@Injectable()
export class PhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly blocks: BlocksService,
    private readonly storage: StorageService,
    private readonly jobs: PhotoJobsService,
    private readonly places: PlaceMatchingService,
    private readonly covers: PlaceCoversService,
    private readonly config: ConfigService<Env, true>,
    private readonly events: EventEmitter2,
  ) {}

  async requestUpload(
    userId: string,
    markerId: string,
    input: UploadUrlRequestDto,
  ): Promise<UploadUrlResponseDto> {
    this.storage.assertEnabled();
    const { trip } = await this.access.assertForMarker(
      userId,
      markerId,
      'edit_content',
    );
    assertUploadable(input);

    const photo = await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, trip.id);
      const count = await tx.photo.count({
        where: { markerId, status: { not: 'failed' } },
      });
      if (count >= MAX_PHOTOS_PER_MARKER) {
        throw new AppException(
          ErrorCode.PHOTO_LIMIT_REACHED,
          HttpStatus.UNPROCESSABLE_ENTITY,
          {
            max: MAX_PHOTOS_PER_MARKER,
          },
        );
      }
      const last = await tx.photo.aggregate({
        where: { markerId },
        _max: { position: true },
      });
      return tx.photo.create({
        data: {
          markerId,
          tripId: trip.id,
          uploaderId: userId,
          mimeType: input.mimeType,
          bytes: input.bytes,
          position: (last._max.position ?? -1) + 1,
        },
        include: PHOTO_INCLUDE,
      });
    });
    return this.uploadResponse(photo, input);
  }

  /** A place photo (B1–B3): no trip; counts toward the uploader's daily limit. */
  async requestPlaceUpload(
    userId: string,
    placeId: string,
    input: UploadUrlRequestDto,
  ): Promise<UploadUrlResponseDto> {
    this.storage.assertEnabled();
    await this.places.assertVisible(this.prisma, userId, placeId);
    assertUploadable(input);
    const max = this.config.get('APP_PLACE_PHOTO_DAILY_LIMIT', { infer: true });

    const photo = await this.prisma.$transaction(async (tx) => {
      // The place lock keeps a user place from being removed (with its photos) mid-upload,
      // and the user lock makes the daily count exact under parallel uploads.
      const place = await tx.$queryRaw<unknown[]>`
        SELECT 1 FROM places WHERE id = ${placeId}::uuid FOR UPDATE`;
      if (place.length === 0) throw AppException.notFound();
      await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const today = await tx.photo.count({
        where: {
          uploaderId: userId,
          placeId: { not: null },
          status: { not: 'failed' },
          createdAt: { gt: new Date(Date.now() - DAY_MS) },
        },
      });
      if (today >= max) {
        throw new AppException(
          ErrorCode.DAILY_PHOTO_LIMIT_REACHED,
          HttpStatus.UNPROCESSABLE_ENTITY,
          { max },
        );
      }
      return tx.photo.create({
        data: {
          placeId,
          uploaderId: userId,
          mimeType: input.mimeType,
          bytes: input.bytes,
          position: 0,
        },
        include: PHOTO_INCLUDE,
      });
    });
    return this.uploadResponse(photo, input);
  }

  /**
   * A profile photo: no trip, no place. It becomes the avatar once processed
   * (the previous one is deleted then). Allowed during onboarding.
   */
  async requestAvatarUpload(
    userId: string,
    input: UploadUrlRequestDto,
  ): Promise<UploadUrlResponseDto> {
    this.storage.assertEnabled();
    assertUploadable(input);
    const photo = await this.prisma.photo.create({
      data: {
        uploaderId: userId,
        mimeType: input.mimeType,
        bytes: input.bytes,
        position: 0,
      },
      include: PHOTO_INCLUDE,
    });
    return this.uploadResponse(photo, input);
  }

  /** Back to the letter avatar. Harmless without a profile photo. */
  async removeAvatar(userId: string): Promise<void> {
    const photoId = await this.prisma.$transaction(async (tx) => {
      const [user] = await tx.$queryRaw<{ avatarPhotoId: string | null }[]>`
        SELECT "avatarPhotoId" FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      if (!user?.avatarPhotoId) return null;
      await tx.photo.delete({ where: { id: user.avatarPhotoId } });
      return user.avatarPhotoId;
    });
    if (photoId) await this.jobs.deleteFiles([photoId]);
  }

  private async uploadResponse(
    photo: PhotoWithUploader,
    input: UploadUrlRequestDto,
  ): Promise<UploadUrlResponseDto> {
    const uploadUrl = await this.storage.presignPut(
      photoKeys(photo.id).original,
      input.mimeType,
      input.bytes,
    );
    return {
      photo: toPhotoDto(photo, this.storage),
      uploadUrl,
      uploadHeaders: {
        'Content-Type': input.mimeType,
        'Content-Length': String(input.bytes),
      },
      expiresAt: new Date(
        Date.now() + UPLOAD_URL_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }

  /** The uploader confirms the upload; the worker takes it from here. Repeating it is harmless. */
  async complete(userId: string, photoId: string): Promise<PhotoDto> {
    this.storage.assertEnabled();
    const photo = await this.findPhoto(photoId);
    if (photo.tripId) {
      await this.access.assert(userId, photo.tripId, 'edit_content');
    }
    if (photo.uploaderId !== userId) throw AppException.forbidden();
    if (photo.status !== 'pending_upload')
      return toPhotoDto(photo, this.storage);

    const uploaded = await this.storage.head(photoKeys(photo.id).original);
    if (!uploaded) throw AppException.validation({ upload: ['notUploaded'] });
    if (uploaded.bytes > MAX_PHOTO_BYTES) {
      await this.prisma.photo.update({
        where: { id: photo.id },
        data: { status: 'failed' },
      });
      throw uploadTooLarge();
    }
    if (uploaded.bytes !== photo.bytes) {
      throw AppException.validation({ upload: ['sizeMismatch'] });
    }

    const { count } = await this.prisma.photo.updateMany({
      where: { id: photo.id, status: 'pending_upload' },
      data: { status: 'processing' },
    });
    const current = await this.findPhoto(photo.id);
    if (count === 1) {
      await this.jobs.process(photo.id);
      const dto = toPhotoDto(current, this.storage);
      this.events.emit(
        DomainEvents.PHOTO_PROCESSING,
        domainEvent(
          DomainEvents.PHOTO_PROCESSING,
          userId,
          { photo: dto },
          photo.tripId ?? undefined,
        ),
      );
      return dto;
    }
    return toPhotoDto(current, this.storage);
  }

  /**
   * A stop's photo grid. First the members' uploads still processing or
   * failed, newest first. Then one ranking by likes of the stop's photos, the
   * place's popular photos (see `placeItems`) and its Commons images; on a
   * tie the stop's own photos go first, then the newest. A private trip's
   * photos stay in it: other trips only get public trips' photos.
   */
  async gallery(userId: string, markerId: string): Promise<PhotoDto[]> {
    const { role } = await this.access.assertForMarker(
      userId,
      markerId,
      'view',
    );
    const { placeId } = await this.prisma.marker.findUniqueOrThrow({
      where: { id: markerId },
      select: { placeId: true },
    });
    const [own, place] = await Promise.all([
      this.prisma.photo.findMany({
        where: {
          markerId,
          status: role ? { in: ['processing', 'ready', 'failed'] } : 'ready',
          OR: [{ hiddenAt: null }, { uploaderId: userId }],
        },
        include: PHOTO_INCLUDE,
      }),
      this.placeItems(userId, placeId, { ownUploads: false }),
    ]);
    const hidden = await this.blocks.blockedAmong(
      userId,
      own.map((photo) => photo.uploaderId),
    );
    const visible = own.filter((photo) => !hidden.has(photo.uploaderId));
    const ownIds = new Set(visible.map((photo) => photo.id));
    const pending = visible
      .filter((photo) => photo.status !== 'ready')
      .sort(newestFirst)
      .map((photo) => toPhotoDto(photo, this.storage, hidden));
    const stop = visible
      .filter((photo) => photo.status === 'ready')
      .map((photo) => ({
        dto: toPhotoDto(photo, this.storage, hidden),
        ofStop: true,
      }));
    const others = place.photos
      .filter((dto) => !ownIds.has(dto.id))
      .map((dto) => ({ dto, ofStop: false }));
    const commons = place.commons.map((dto) => ({ dto, ofStop: false }));
    const ranked = [...stop, ...others, ...commons]
      .sort(
        (a, b) =>
          b.dto.likeCount - a.dto.likeCount ||
          Number(b.ofStop) - Number(a.ofStop) ||
          b.dto.createdAt.localeCompare(a.dto.createdAt) ||
          a.dto.id.localeCompare(b.dto.id),
      )
      .map((item) => item.dto);
    const grid = [...pending, ...ranked];
    const liked = await likedAmong(
      this.prisma,
      userId,
      {
        type: 'photo',
        ids: grid.filter((dto) => dto.source === 'user').map((dto) => dto.id),
      },
      {
        type: 'place_image',
        ids: grid
          .filter((dto) => dto.source === 'commons')
          .map((dto) => dto.id),
      },
    );
    return grid.map((dto) => withLiked(dto, liked));
  }

  /**
   * A place's photos (at most MAX_PLACE_GALLERY). First people's photos, most
   * liked first, then newest (see `placeItems`), then the place's Commons
   * images, most liked first. The uploader also sees their own place photos
   * still processing or failed.
   */
  async placeGallery(userId: string, placeId: string): Promise<PhotoDto[]> {
    await this.places.assertVisible(this.prisma, userId, placeId);
    const { photos, commons } = await this.placeItems(userId, placeId, {
      ownUploads: true,
    });
    const gallery = [
      ...photos,
      ...commons.slice(0, MAX_PLACE_GALLERY - photos.length),
    ];
    const liked = await likedAmong(
      this.prisma,
      userId,
      { type: 'photo', ids: photos.map((dto) => dto.id) },
      { type: 'place_image', ids: commons.map((dto) => dto.id) },
    );
    return gallery.map((dto) => withLiked(dto, liked));
  }

  /**
   * A place's people's photos (at most MAX_PLACE_GALLERY, most liked first,
   * then newest): the photos added to the place, and the public trip photos
   * taken there that may represent it (enough likes, see
   * PlaceCoversService.representativePhotos); with `ownUploads`, the viewer's
   * own place photos still processing or failed too. And its ready Commons
   * images, most liked first. Trip photos and Commons images are their own
   * rows, never copies. Blocks don't hide place photos (C7), only who
   * uploaded them. likedByMe is left false.
   */
  private async placeItems(
    userId: string,
    placeId: string,
    { ownUploads }: { ownUploads: boolean },
  ): Promise<{ photos: PhotoDto[]; commons: PhotoDto[] }> {
    const representative = await this.covers.representativePhotoIds(
      userId,
      placeId,
    );
    const [photos, images] = await Promise.all([
      this.prisma.photo.findMany({
        where: {
          OR: [
            {
              placeId,
              OR: [
                { status: 'ready', hiddenAt: null },
                ...(ownUploads
                  ? [
                      {
                        uploaderId: userId,
                        status: {
                          in: [
                            'processing',
                            'ready',
                            'failed',
                          ] as PhotoStatus[],
                        },
                      },
                    ]
                  : []),
              ],
            },
            { id: { in: representative } },
          ],
        },
        orderBy: [{ likeCount: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        take: MAX_PLACE_GALLERY,
        include: PHOTO_INCLUDE,
      }),
      this.prisma.placeImage.findMany({
        where: { placeId, status: 'ready' },
        orderBy: COMMONS_ORDER,
        take: MAX_PLACE_GALLERY,
      }),
    ]);
    const hidden = await this.blocks.blockedAmong(
      userId,
      photos.map((photo) => photo.uploaderId),
    );
    return {
      photos: photos.map((photo) => toPhotoDto(photo, this.storage, hidden)),
      commons: images.map((image): PhotoDto => {
        const keys = placeImageKeys(image.id);
        return {
          id: image.id,
          markerId: null,
          placeId,
          status: 'ready',
          thumbUrl: this.storage.signedGetUrl(keys.thumb),
          displayUrl: this.storage.signedGetUrl(keys.display),
          width: image.width,
          height: image.height,
          position: 0,
          likeCount: image.likeCount,
          likedByMe: false,
          uploader: null,
          createdAt: image.createdAt.toISOString(),
          source: 'commons',
          credit: placeImageCredit(image),
        };
      }),
    };
  }

  /**
   * Picks the stop's cover, shown on its pin: any ready photo or Commons
   * image in its photo grid (see `gallery`).
   */
  async setCover(
    userId: string,
    markerId: string,
    photoId: string,
  ): Promise<MarkerDto> {
    const { trip } = await this.access.assertForMarker(
      userId,
      markerId,
      'edit_content',
    );
    const picked = (await this.gallery(userId, markerId)).find(
      (dto) => dto.id === photoId,
    );
    if (!picked) throw AppException.validation({ photoId: ['notFound'] });
    if (picked.status !== 'ready')
      throw AppException.validation({ photoId: ['notReady'] });

    const commons = picked.source === 'commons';
    const marker = await this.prisma.marker.update({
      where: { id: markerId },
      data: {
        coverPhotoId: commons ? null : photoId,
        coverImageId: commons ? photoId : null,
      },
      include: MARKER_INCLUDE,
    });
    this.events.emit(
      DomainEvents.MARKER_COVER_CHANGED,
      domainEvent(
        DomainEvents.MARKER_COVER_CHANGED,
        userId,
        { markerId, photoId },
        trip.id,
      ),
    );
    const [hidden, liked] = await Promise.all([
      this.blocks.blockedAmong(
        userId,
        [marker.createdById, ...coverPeople(marker)].filter(
          (id): id is string => !!id,
        ),
      ),
      likedAmong(this.prisma, userId, {
        type: 'place',
        ids: [marker.placeId],
      }),
    ]);
    return toMarkerDto(marker, this.storage, hidden, liked);
  }

  /**
   * Trip photos: the uploader, the trip owner or an editor. Place photos: only the uploader (B2).
   * Files are deleted by the worker after the commit.
   */
  async delete(userId: string, photoId: string): Promise<void> {
    const photo = await this.findPhoto(photoId);
    if (photo.uploaderId !== userId) {
      if (!photo.tripId) throw AppException.forbidden();
      await this.access.assert(userId, photo.tripId, 'edit_content');
    }
    await this.remove(userId, photo);
  }

  /**
   * Deletes a photo without an access check (moderation, account deletion,
   * and delete above). Stops that had it as their cover (this one, and other
   * trips that picked it) go back to their place's image. Returns false when
   * it was already gone.
   */
  async remove(actorId: string, target: string | PhotoRef): Promise<boolean> {
    const photo =
      typeof target === 'string'
        ? await this.prisma.photo.findUnique({
            where: { id: target },
            select: { id: true, markerId: true, tripId: true, placeId: true },
          })
        : target;
    if (!photo) return false;
    if (!photo.markerId || !photo.tripId) {
      const { count } = await this.prisma.photo.deleteMany({
        where: { id: photo.id },
      });
      if (count === 0) return false;
      await this.jobs.deleteFiles([photo.id]);
      return true;
    }
    const { markerId, tripId } = photo;

    const coverPhotoId = await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, tripId);
      const marker = await tx.marker.findUniqueOrThrow({
        where: { id: markerId },
        select: { coverPhotoId: true },
      });
      const { count } = await tx.photo.deleteMany({ where: { id: photo.id } });
      if (count === 0) return undefined;
      // A deleted cover isn't replaced: the pin goes back to the place's image.
      return marker.coverPhotoId === photo.id ? null : marker.coverPhotoId;
    });

    if (coverPhotoId === undefined) return false;
    await this.jobs.deleteFiles([photo.id]);
    this.events.emit(
      DomainEvents.PHOTO_DELETED,
      domainEvent(
        DomainEvents.PHOTO_DELETED,
        actorId,
        { photoId: photo.id, markerId, coverPhotoId },
        tripId,
      ),
    );
    return true;
  }

  private async findPhoto(photoId: string): Promise<PhotoWithUploader> {
    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      include: PHOTO_INCLUDE,
    });
    if (!photo) throw AppException.notFound();
    return photo;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sets likedByMe on a DTO built for this request. */
function withLiked(dto: PhotoDto, liked: ReadonlySet<string>): PhotoDto {
  dto.likedByMe = liked.has(dto.id);
  return dto;
}

function newestFirst(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): number {
  return (
    b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)
  );
}

function assertUploadable(input: UploadUrlRequestDto): void {
  if (!PHOTO_MIME_TYPES.includes(input.mimeType as PhotoMimeType)) {
    throw new AppException(
      ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      {
        allowed: PHOTO_MIME_TYPES,
      },
    );
  }
  if (input.bytes > MAX_PHOTO_BYTES) {
    throw uploadTooLarge();
  }
}

function uploadTooLarge(): AppException {
  return new AppException(
    ErrorCode.UPLOAD_TOO_LARGE,
    HttpStatus.PAYLOAD_TOO_LARGE,
    {
      maxBytes: MAX_PHOTO_BYTES,
    },
  );
}
