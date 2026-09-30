import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { photoPrefix } from './photo-keys';

/** Uploads not completed, and failed photos, are removed after this long. */
export const STALE_PHOTO_HOURS = 24;
const BATCH = 200;

@Injectable()
export class PhotoCleanupService {
  private readonly logger = new Logger(PhotoCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Deletes the files of photos whose rows are gone. Idempotent. */
  async deleteFiles(photoIds: string[]): Promise<void> {
    for (const id of photoIds) {
      await this.storage.deletePrefix(photoPrefix(id));
    }
  }

  /** Removes stale pending and failed photos (rows first, then files). */
  async removeStale(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - STALE_PHOTO_HOURS * 60 * 60 * 1000);
    let removed = 0;
    for (;;) {
      const stale = await this.prisma.photo.findMany({
        where: {
          status: { in: ['pending_upload', 'failed'] },
          updatedAt: { lt: before },
        },
        select: { id: true },
        take: BATCH,
      });
      if (!stale.length) break;
      const ids = stale.map((photo) => photo.id);
      // Re-check the status: an upload completed a moment ago must survive.
      await this.prisma.photo.deleteMany({
        where: {
          id: { in: ids },
          status: { in: ['pending_upload', 'failed'] },
          updatedAt: { lt: before },
        },
      });
      await this.deleteFiles(ids);
      removed += ids.length;
      if (stale.length < BATCH) break;
    }
    if (removed) this.logger.log(`Removed ${removed} stale photos`);
    return removed;
  }
}
