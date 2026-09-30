import { HttpStatus, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  StorageService,
  UPLOAD_URL_TTL_SECONDS,
} from '../../common/storage/storage.service';
import {
  MARKER_INCLUDE,
  type MarkerDto,
  toMarkerDto,
} from '../markers/markers.dto';
import { BlocksService } from '../moderation/blocks.service';
import { likedAmong } from '../social/liked';
import { TripAccessService } from '../trips/trip-access.service';
import { lockTrip } from '../trips/trips.service';
import { photoKeys } from './photo-keys';
import {
  MAX_PHOTO_BYTES,
  MAX_PHOTOS_PER_MARKER,
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

/**
 * Photo uploads, gallery, order, cover and deletion (photo-pipeline skill).
 * Files go straight from the app to storage with pre-signed URLs; the worker
 * processes them. Trip access decides everything; uploads need edit rights.
 */
@Injectable()
export class PhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly blocks: BlocksService,
    private readonly storage: StorageService,
    private readonly jobs: PhotoJobsService,
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
    await this.access.assert(userId, photo.tripId, 'edit_content');
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
          photo.tripId,
        ),
      );
      return dto;
    }
    return toPhotoDto(current, this.storage);
  }

  /** Ready photos in order; members also see photos still processing or failed. */
  async gallery(userId: string, markerId: string): Promise<PhotoDto[]> {
    const { role } = await this.access.assertForMarker(
      userId,
      markerId,
      'view',
    );
    const photos = await this.prisma.photo.findMany({
      where: {
        markerId,
        status: role ? { in: ['processing', 'ready', 'failed'] } : 'ready',
        OR: [{ hiddenAt: null }, { uploaderId: userId }],
      },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      include: PHOTO_INCLUDE,
    });
    const [hidden, liked] = await Promise.all([
      this.blocks.blockedAmong(
        userId,
        photos.map((photo) => photo.uploaderId),
      ),
      likedAmong(this.prisma, userId, {
        type: 'photo',
        ids: photos.map((photo) => photo.id),
      }),
    ]);
    return photos
      .filter((photo) => !hidden.has(photo.uploaderId))
      .map((photo) => toPhotoDto(photo, this.storage, hidden, liked));
  }

  /** `photoIds` must be exactly the marker's processing and ready photos. */
  async reorder(
    userId: string,
    markerId: string,
    photoIds: string[],
  ): Promise<PhotoDto[]> {
    const { trip } = await this.access.assertForMarker(
      userId,
      markerId,
      'edit_content',
    );
    await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, trip.id);
      const photos = await tx.photo.findMany({
        where: { markerId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true, status: true, hiddenAt: true },
      });
      const listed = photos.filter(
        (p) =>
          (p.status === 'processing' || p.status === 'ready') && !p.hiddenAt,
      );
      const requested = new Set(photoIds);
      if (
        requested.size !== listed.length ||
        listed.some((p) => !requested.has(p.id))
      ) {
        throw AppException.validation({ photoIds: ['mustMatchMarkerPhotos'] });
      }
      // Uploads in progress, failed and moderated photos keep their order after the rest.
      const final = [
        ...photoIds,
        ...photos.filter((p) => !requested.has(p.id)).map((p) => p.id),
      ];
      for (const [position, id] of final.entries()) {
        await tx.photo.update({ where: { id }, data: { position } });
      }
    });
    this.events.emit(
      DomainEvents.PHOTOS_REORDERED,
      domainEvent(
        DomainEvents.PHOTOS_REORDERED,
        userId,
        { markerId, photoIds },
        trip.id,
      ),
    );
    return this.gallery(userId, markerId);
  }

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
    const photo = await this.prisma.photo.findFirst({
      where: { id: photoId, markerId, hiddenAt: null },
      select: { status: true },
    });
    if (!photo) throw AppException.validation({ photoId: ['notFound'] });
    if (photo.status !== 'ready')
      throw AppException.validation({ photoId: ['notReady'] });

    const marker = await this.prisma.marker.update({
      where: { id: markerId },
      data: { coverPhotoId: photoId },
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
        [marker.createdById, marker.coverPhoto?.uploaderId].filter(
          (id): id is string => !!id,
        ),
      ),
      likedAmong(this.prisma, userId, { type: 'marker', ids: [marker.id] }),
    ]);
    return toMarkerDto(marker, this.storage, hidden, liked);
  }

  /**
   * The uploader, the trip owner or an editor. A deleted cover passes to the
   * next ready photo. Files are deleted by the worker after the commit.
   */
  async delete(userId: string, photoId: string): Promise<void> {
    const photo = await this.findPhoto(photoId);
    if (photo.uploaderId !== userId) {
      await this.access.assert(userId, photo.tripId, 'edit_content');
    }
    await this.remove(userId, photo);
  }

  /**
   * Deletes a photo without an access check (moderation, account deletion,
   * and delete above). The cover passes to the next ready, visible photo.
   * Returns false when it was already gone.
   */
  async remove(
    actorId: string,
    target: string | { id: string; markerId: string; tripId: string },
  ): Promise<boolean> {
    const photo =
      typeof target === 'string'
        ? await this.prisma.photo.findUnique({
            where: { id: target },
            select: { id: true, markerId: true, tripId: true },
          })
        : target;
    if (!photo) return false;

    const coverPhotoId = await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, photo.tripId);
      const marker = await tx.marker.findUniqueOrThrow({
        where: { id: photo.markerId },
        select: { coverPhotoId: true },
      });
      const { count } = await tx.photo.deleteMany({ where: { id: photo.id } });
      if (count === 0) return undefined;
      if (marker.coverPhotoId !== photo.id) return marker.coverPhotoId;
      const next = await tx.photo.findFirst({
        where: { markerId: photo.markerId, status: 'ready', hiddenAt: null },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      await tx.marker.update({
        where: { id: photo.markerId },
        data: { coverPhotoId: next?.id ?? null },
      });
      return next?.id ?? null;
    });

    if (coverPhotoId === undefined) return false;
    await this.jobs.deleteFiles([photo.id]);
    this.events.emit(
      DomainEvents.PHOTO_DELETED,
      domainEvent(
        DomainEvents.PHOTO_DELETED,
        actorId,
        { photoId: photo.id, markerId: photo.markerId, coverPhotoId },
        photo.tripId,
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

function uploadTooLarge(): AppException {
  return new AppException(
    ErrorCode.UPLOAD_TOO_LARGE,
    HttpStatus.PAYLOAD_TOO_LARGE,
    {
      maxBytes: MAX_PHOTO_BYTES,
    },
  );
}
