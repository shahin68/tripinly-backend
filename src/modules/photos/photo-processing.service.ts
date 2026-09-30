import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UnrecoverableError } from 'bullmq';
import sharp from 'sharp';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { sniffImageType } from './image-type';
import { photoKeys, photoPrefix } from './photo-keys';
import { PHOTO_INCLUDE, toPhotoDto } from './photos.dto';

export const THUMB_SIZE = 256;
export const DISPLAY_MAX_EDGE = 1600;
/** Refuses decompression bombs: 50 megapixels is far above any phone camera. */
const MAX_INPUT_PIXELS = 50_000_000;

export type ProcessOutcome = 'ready' | 'skipped' | 'deleted';

/**
 * Turns an upload into safe images (photo-pipeline skill): checks the real
 * type, applies the EXIF rotation, drops all metadata (GPS included), writes
 * thumb and display WebPs and a clean original, then marks the photo ready
 * and makes it the cover if the marker has none. Safe to run twice.
 */
@Injectable()
export class PhotoProcessingService {
  private readonly logger = new Logger(PhotoProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly events: EventEmitter2,
  ) {}

  async process(photoId: string): Promise<ProcessOutcome> {
    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
    });
    if (!photo || photo.status !== 'processing') return 'skipped';

    const keys = photoKeys(photoId);
    const original = await this.storage.get(keys.original);
    const type = sniffImageType(original);
    if (!type || type !== photo.mimeType) {
      throw new UnrecoverableError(
        'file content does not match the declared image type',
      );
    }

    let clean: Buffer;
    let width: number;
    let height: number;
    let thumb: Buffer;
    let display: Buffer;
    try {
      // rotate() applies the EXIF orientation; sharp writes no metadata unless asked.
      const oriented = sharp(original, {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: 'error',
      }).rotate();
      const encoded = await reencode(oriented.clone(), type).toBuffer({
        resolveWithObject: true,
      });
      clean = encoded.data;
      width = encoded.info.width;
      height = encoded.info.height;
      thumb = await oriented
        .clone()
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'attention' })
        .webp({ quality: 80 })
        .toBuffer();
      display = await oriented
        .clone()
        .resize(DISPLAY_MAX_EDGE, DISPLAY_MAX_EDGE, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toBuffer();
    } catch (error) {
      throw new UnrecoverableError(
        `image could not be decoded: ${(error as Error).message}`,
      );
    }

    await this.storage.put(keys.thumb, thumb, 'image/webp');
    await this.storage.put(keys.display, display, 'image/webp');
    await this.storage.put(keys.original, clean, type);

    const result = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.photo.updateMany({
        where: { id: photoId, status: 'processing' },
        data: { status: 'ready', width, height },
      });
      if (count === 0) return null;
      const cover = await tx.marker.updateMany({
        where: { id: photo.markerId, coverPhotoId: null },
        data: { coverPhotoId: photoId },
      });
      return { coverSet: cover.count === 1 };
    });

    if (!result) {
      // Processed twice at once (a retried or stalled job): the other run won.
      if (await this.prisma.photo.count({ where: { id: photoId } })) {
        return 'skipped';
      }
      // Deleted while we worked; its file cleanup may already have run.
      await this.storage.deletePrefix(photoPrefix(photoId));
      return 'deleted';
    }

    const ready = await this.prisma.photo.findUniqueOrThrow({
      where: { id: photoId },
      include: PHOTO_INCLUDE,
    });
    this.events.emit(
      DomainEvents.PHOTO_READY,
      domainEvent(
        DomainEvents.PHOTO_READY,
        photo.uploaderId,
        { photo: toPhotoDto(ready, this.storage) },
        photo.tripId,
      ),
    );
    if (result.coverSet) {
      this.events.emit(
        DomainEvents.MARKER_COVER_CHANGED,
        domainEvent(
          DomainEvents.MARKER_COVER_CHANGED,
          photo.uploaderId,
          { markerId: photo.markerId, photoId },
          photo.tripId,
        ),
      );
    }
    return 'ready';
  }

  /** After the last attempt: the photo shows as failed to its trip's members. */
  async markFailed(photoId: string, reason: string): Promise<void> {
    const { count } = await this.prisma.photo.updateMany({
      where: { id: photoId, status: 'processing' },
      data: { status: 'failed' },
    });
    if (count === 0) return;
    this.logger.warn(`Photo ${photoId} failed: ${reason}`);
    const photo = await this.prisma.photo.findUniqueOrThrow({
      where: { id: photoId },
    });
    this.events.emit(
      DomainEvents.PHOTO_FAILED,
      domainEvent(
        DomainEvents.PHOTO_FAILED,
        photo.uploaderId,
        { photoId, markerId: photo.markerId },
        photo.tripId,
      ),
    );
  }
}

function reencode(image: sharp.Sharp, type: string): sharp.Sharp {
  switch (type) {
    case 'image/png':
      return image.png();
    case 'image/webp':
      return image.webp({ quality: 90 });
    default:
      return image.jpeg({ quality: 90, mozjpeg: true });
  }
}
