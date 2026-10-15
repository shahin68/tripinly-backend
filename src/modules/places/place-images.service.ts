import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import type {
  PlaceImage,
  PlaceImageOrigin,
} from '../../generated/prisma/client';
import { wikidataIds } from '../osm-import/osm-transform';
import {
  type AcceptedLicense,
  buildCredit,
  checkCommonsFile,
  commonsTitleFromTag,
  filePageUrl,
} from './commons-metadata';
import { placeImageKeys, placeImagePrefix } from './place-image-keys';
import {
  type CommonsImage,
  WIKIMEDIA_BATCH,
  WikimediaClient,
} from './wikimedia.client';

/** Places looked at per sync run; the job queues itself again while more remain. */
const SYNC_PLACES_PER_RUN = 500;
/** Pending images downloaded per run (about one a second). */
const DOWNLOADS_PER_RUN = 300;
/** Images rechecked per revalidate run. */
const REVALIDATE_PER_RUN = 500;
/** Images per place, in origin order (Wikidata main image first). */
const MAX_IMAGES_PER_PLACE = 3;
const RECHECK_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** A download that failed for a passing reason is tried again a day later. */
const RETRY_DOWNLOAD_AFTER_MS = 24 * 60 * 60 * 1000;
export const PLACE_THUMB_SIZE = 256;
export const PLACE_DISPLAY_MAX_WIDTH = 1280;
const MAX_INPUT_PIXELS = 50_000_000;

export interface SyncResult {
  places: number;
  ready: number;
  rejected: number;
  removed: number;
  /** More places or downloads are waiting: run again. */
  more: boolean;
}

export interface RevalidateResult {
  checked: number;
  refreshed: number;
  removed: number;
  more: boolean;
}

interface WantedImage {
  title: string;
  origin: PlaceImageOrigin;
  wikidataId: string | null;
}

/**
 * Copies Wikimedia Commons images of places into storage (place-photos plan,
 * 10-maps-places-routing.md "Place images"). A place's images are the files
 * its OSM tags link: the Wikidata main image (P18), then `wikimedia_commons`,
 * then `image` when it points to Commons. Only freely licensed files pass
 * (commons-metadata.ts); they are resized and re-encoded with their credit
 * written into XMP. Images an admin hid stay hidden.
 */
@Injectable()
export class PlaceImagesService {
  private readonly logger = new Logger(PlaceImagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly wikimedia: WikimediaClient,
  ) {}

  /** Brings places whose image tags changed up to date, then downloads pending images. */
  async sync(now = new Date()): Promise<SyncResult> {
    const result: SyncResult = {
      places: 0,
      ready: 0,
      rejected: 0,
      removed: 0,
      more: false,
    };
    const places = await this.prisma.$queryRaw<
      {
        id: string;
        tags: Record<string, string>;
        imageTagsHash: string | null;
      }[]
    >`
      SELECT id, tags, "imageTagsHash" FROM places
      WHERE "isActive" AND (source = 'osm' OR "osmId" IS NOT NULL)
        AND "imageTagsHash" IS DISTINCT FROM "imagesSyncedHash"
      ORDER BY prominence DESC, id
      LIMIT ${SYNC_PLACES_PER_RUN}`;
    result.places = places.length;

    const wanted = await this.wantedImages(places);
    for (const place of places) {
      result.removed += await this.reconcile(place.id, wanted.get(place.id)!);
      await this.prisma.place.updateMany({
        where: { id: place.id, imageTagsHash: place.imageTagsHash },
        data: { imagesSyncedHash: place.imageTagsHash },
      });
    }

    const pending = await this.prisma.placeImage.findMany({
      where: {
        status: 'pending',
        OR: [
          { checkedAt: null },
          {
            checkedAt: {
              lt: new Date(now.getTime() - RETRY_DOWNLOAD_AFTER_MS),
            },
          },
        ],
      },
      orderBy: [{ place: { prominence: 'desc' } }, { createdAt: 'asc' }],
      take: DOWNLOADS_PER_RUN,
    });
    for (let i = 0; i < pending.length; i += WIKIMEDIA_BATCH) {
      const batch = pending.slice(i, i + WIKIMEDIA_BATCH);
      const files = await this.wikimedia.commonsImages(
        batch.map((image) => image.commonsTitle),
      );
      for (const image of batch) {
        const outcome = await this.fetchImage(
          image,
          files.get(image.commonsTitle) ?? null,
          now,
        );
        if (outcome !== 'retry') result[outcome]++;
      }
    }
    result.more =
      places.length === SYNC_PLACES_PER_RUN ||
      pending.length === DOWNLOADS_PER_RUN;
    if (result.places || pending.length) {
      this.logger.log(
        `Place images: ${result.places} places, ${result.ready} ready, ${result.rejected} rejected, ${result.removed} removed`,
      );
    }
    return result;
  }

  /**
   * Weekly: a file deleted on Commons, or no longer freely licensed, is
   * removed with its copies; a changed file is downloaded again; the credit
   * follows any change on Commons.
   */
  async revalidate(now = new Date()): Promise<RevalidateResult> {
    const due = await this.prisma.placeImage.findMany({
      where: {
        status: 'ready',
        checkedAt: { lt: new Date(now.getTime() - RECHECK_AFTER_MS) },
      },
      orderBy: { checkedAt: 'asc' },
      take: REVALIDATE_PER_RUN,
    });
    const result: RevalidateResult = {
      checked: due.length,
      refreshed: 0,
      removed: 0,
      more: due.length === REVALIDATE_PER_RUN,
    };
    for (let i = 0; i < due.length; i += WIKIMEDIA_BATCH) {
      const batch = due.slice(i, i + WIKIMEDIA_BATCH);
      const files = await this.wikimedia.commonsImages(
        batch.map((image) => image.commonsTitle),
      );
      for (const image of batch) {
        const file = files.get(image.commonsTitle) ?? null;
        const check = file ? checkCommonsFile(file) : null;
        if (!file || !check?.ok) {
          await this.remove(
            image,
            check && !check.ok ? check.reason : 'missing',
          );
          result.removed++;
        } else if (file.sha1 !== image.commonsSha1) {
          const outcome = await this.fetchImage(image, file, now);
          if (outcome === 'ready') result.refreshed++;
        } else {
          await this.prisma.placeImage.update({
            where: { id: image.id },
            data: { ...licenseData(image.commonsTitle, check), checkedAt: now },
          });
        }
      }
    }
    return result;
  }

  /** The files each place's tags link to, in origin order. */
  private async wantedImages(
    places: { id: string; tags: Record<string, string> }[],
  ): Promise<Map<string, WantedImage[]>> {
    const qidOf = new Map(
      places.map((p) => [p.id, wikidataIds(p.tags.wikidata)[0] ?? null]),
    );
    const qids = [...new Set([...qidOf.values()].filter((q) => q !== null))];
    const mainImages = new Map<string, string>();
    for (let i = 0; i < qids.length; i += WIKIMEDIA_BATCH) {
      const found = await this.wikimedia.wikidataMainImages(
        qids.slice(i, i + WIKIMEDIA_BATCH),
      );
      for (const [qid, title] of found) mainImages.set(qid, title);
    }
    const result = new Map<string, WantedImage[]>();
    for (const place of places) {
      const qid = qidOf.get(place.id) ?? null;
      const candidates: WantedImage[] = [
        {
          title: (qid && mainImages.get(qid)) ?? '',
          origin: 'wikidata_p18',
          wikidataId: qid,
        },
        {
          title: commonsTitleFromTag(place.tags.wikimedia_commons) ?? '',
          origin: 'osm_wikimedia_commons',
          wikidataId: null,
        },
        {
          title: commonsTitleFromTag(place.tags.image) ?? '',
          origin: 'osm_image',
          wikidataId: null,
        },
      ];
      const seen = new Set<string>();
      const wanted: WantedImage[] = [];
      for (const candidate of candidates) {
        const title = normalizeTitle(candidate.title);
        if (!title || seen.has(title)) continue;
        seen.add(title);
        wanted.push({ ...candidate, title });
      }
      result.set(place.id, wanted.slice(0, MAX_IMAGES_PER_PLACE));
    }
    return result;
  }

  /** Makes a place's rows match the files it links. Returns how many were removed. */
  private async reconcile(
    placeId: string,
    wanted: WantedImage[],
  ): Promise<number> {
    const existing = await this.prisma.placeImage.findMany({
      where: { placeId },
    });
    const wantedTitles = new Set(wanted.map((w) => w.title));
    let removed = 0;
    for (const image of existing) {
      if (wantedTitles.has(image.commonsTitle)) continue;
      if (image.status === 'hidden' || image.status === 'removed') continue;
      await this.remove(image, 'unlinked');
      removed++;
    }
    for (const [rank, image] of wanted.entries()) {
      const row = existing.find((e) => e.commonsTitle === image.title);
      if (!row) {
        await this.prisma.placeImage.create({
          data: {
            placeId,
            commonsTitle: image.title,
            origin: image.origin,
            wikidataId: image.wikidataId,
            rank,
            filePageUrl: filePageUrl(image.title),
          },
        });
      } else {
        await this.prisma.placeImage.update({
          where: { id: row.id },
          data: {
            origin: image.origin,
            wikidataId: image.wikidataId,
            rank,
            // Linked again after it was dropped: fetch it again.
            ...(row.status === 'removed' && {
              status: 'pending',
              checkedAt: null,
              rejectReason: null,
            }),
          },
        });
      }
    }
    return removed;
  }

  /** Checks the licence, then downloads, resizes and stores the file. */
  private async fetchImage(
    image: PlaceImage,
    file: CommonsImage | null,
    now: Date,
  ): Promise<'ready' | 'rejected' | 'removed' | 'retry'> {
    if (!file) {
      await this.remove(image, 'missing');
      return 'removed';
    }
    const check = checkCommonsFile(file);
    if (!check.ok) {
      await this.storage.deletePrefix(placeImagePrefix(image.id));
      await this.prisma.placeImage.update({
        where: { id: image.id },
        data: {
          status: 'rejected',
          rejectReason: check.reason,
          checkedAt: now,
        },
      });
      return 'rejected';
    }
    let thumb: Buffer;
    let display: Buffer;
    let size: { width: number; height: number };
    try {
      const original = await this.wikimedia.download(file.thumbUrl);
      ({ thumb, display, size } = await renderImage(
        original,
        xmpFor(buildCredit(image.commonsTitle, check)),
      ));
    } catch (error) {
      this.logger.warn(
        `Place image ${image.id} not fetched: ${(error as Error).message}`,
      );
      await this.prisma.placeImage.update({
        where: { id: image.id },
        data: { checkedAt: now },
      });
      return 'retry';
    }
    const keys = placeImageKeys(image.id);
    await this.storage.put(keys.thumb, thumb, 'image/webp');
    await this.storage.put(keys.display, display, 'image/webp');
    const { count } = await this.prisma.placeImage.updateMany({
      // An admin may have hidden it meanwhile; hidden stays hidden.
      where: { id: image.id, status: { in: ['pending', 'ready'] } },
      data: {
        ...licenseData(image.commonsTitle, check),
        status: 'ready',
        rejectReason: null,
        width: size.width,
        height: size.height,
        mime: file.mime,
        commonsSha1: file.sha1,
        fetchedAt: now,
        checkedAt: now,
      },
    });
    return count ? 'ready' : 'retry';
  }

  private async remove(image: PlaceImage, reason: string): Promise<void> {
    await this.storage.deletePrefix(placeImagePrefix(image.id));
    await this.prisma.placeImage.updateMany({
      where: { id: image.id, status: { not: 'hidden' } },
      data: { status: 'removed', rejectReason: reason },
    });
  }
}

/** Commons treats underscores as spaces and the first letter as upper case. */
export function normalizeTitle(title: string): string {
  const name = title
    .replace(/^File:/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return '';
  return `File:${name[0].toUpperCase()}${name.slice(1)}`;
}

function licenseData(commonsTitle: string, license: AcceptedLicense) {
  return {
    objectName: license.objectName,
    authorText: license.authorText,
    attributionText: license.attributionText,
    licenseCode: license.license,
    licenseShortName: license.licenseShortName,
    licenseUrl: license.licenseUrl,
    attributionRequired: license.attributionRequired,
    filePageUrl: filePageUrl(commonsTitle),
  };
}

/**
 * A 256 px square thumb and a display copy at most 1280 px wide (never
 * enlarged), both WebP. Every other metadata (GPS, camera) is dropped; the
 * credit and licence go back in as XMP so the copies keep their notices.
 */
export async function renderImage(
  original: Buffer,
  xmp: string,
): Promise<{
  thumb: Buffer;
  display: Buffer;
  size: { width: number; height: number };
}> {
  const image = sharp(original, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: 'error',
  }).rotate();
  const thumb = await image
    .clone()
    .resize(PLACE_THUMB_SIZE, PLACE_THUMB_SIZE, {
      fit: 'cover',
      position: 'attention',
    })
    .webp({ quality: 80 })
    .withXmp(xmp)
    .toBuffer();
  const display = await image
    .clone()
    .resize({ width: PLACE_DISPLAY_MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: 82 })
    .withXmp(xmp)
    .toBuffer({ resolveWithObject: true });
  return {
    thumb,
    display: display.data,
    size: { width: display.info.width, height: display.info.height },
  };
}

/** Dublin Core and Creative Commons fields for the credit (XMP). */
export function xmpFor(credit: ReturnType<typeof buildCredit>): string {
  const rights = [credit.author, credit.license, 'Wikimedia Commons']
    .filter(Boolean)
    .join(' · ');
  const li = (value: string) =>
    `<rdf:li xml:lang="x-default">${xml(value)}</rdf:li>`;
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about=""',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"',
    ' xmlns:cc="http://creativecommons.org/ns#">',
    credit.author
      ? `<dc:creator><rdf:Seq><rdf:li>${xml(credit.author)}</rdf:li></rdf:Seq></dc:creator>`
      : '',
    credit.title
      ? `<dc:title><rdf:Alt>${li(credit.title)}</rdf:Alt></dc:title>`
      : '',
    `<dc:rights><rdf:Alt>${li(rights)}</rdf:Alt></dc:rights>`,
    `<dc:source>${xml(credit.sourceUrl)}</dc:source>`,
    `<xmpRights:WebStatement>${xml(credit.sourceUrl)}</xmpRights:WebStatement>`,
    credit.licenseUrl
      ? `<cc:license rdf:resource="${xml(credit.licenseUrl)}"/>`
      : '',
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('');
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
