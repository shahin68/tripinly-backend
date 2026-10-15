import type { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { StorageService } from '../../src/common/storage/storage.service';
import { imageTagsHash } from '../../src/modules/osm-import/osm-transform';
import { placeImageKeys } from '../../src/modules/places/place-image-keys';
import { PlaceImagesWorkerModule } from '../../src/modules/places/place-images-worker.module';
import { PlaceImagesService } from '../../src/modules/places/place-images.service';
import {
  type CommonsImage,
  WikimediaClient,
  WikimediaError,
} from '../../src/modules/places/wikimedia.client';
import { resetState } from '../utils/auth-helpers';
import { createTestApp } from '../utils/create-test-app';
import { insertPlace } from '../utils/places';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stands in for Wikidata and Commons. */
class FakeWikimedia {
  mainImages = new Map<string, string>();
  files = new Map<string, CommonsImage>();
  failDownloads = false;
  downloads: string[] = [];

  wikidataMainImages(qids: string[]): Promise<Map<string, string>> {
    return Promise.resolve(
      new Map(
        qids.flatMap((q) =>
          this.mainImages.has(q) ? [[q, this.mainImages.get(q)!]] : [],
        ),
      ),
    );
  }

  commonsImages(titles: string[]): Promise<Map<string, CommonsImage | null>> {
    return Promise.resolve(
      new Map(titles.map((t) => [t, this.files.get(t) ?? null])),
    );
  }

  async download(url: string): Promise<Buffer> {
    this.downloads.push(url);
    if (this.failDownloads) throw new WikimediaError('HTTP 503');
    return sharp({
      create: {
        width: 1600,
        height: 1200,
        channels: 3,
        background: { r: 200, g: 120, b: 40 },
      },
    })
      .jpeg()
      .withExif({ IFD0: { Artist: 'camera-owner' } })
      .toBuffer();
  }
}

function commonsFile(
  title: string,
  license: Record<string, string>,
  sha1 = 'sha-1',
): CommonsImage {
  const extmetadata = Object.fromEntries(
    Object.entries(license).map(([k, value]) => [k, { value }]),
  );
  return {
    title,
    mime: 'image/jpeg',
    width: 4000,
    height: 3000,
    extmetadata,
    thumbUrl: `https://upload.wikimedia.org/thumb/${encodeURIComponent(title)}`,
    sha1,
  };
}

const CC_BY_SA_4 = {
  License: 'cc-by-sa-4.0',
  LicenseShortName: 'CC BY-SA 4.0',
  LicenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
  Artist: '<a href="//commons.wikimedia.org/wiki/User:Jane">Jane Doe</a>',
};

describe('Place images (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let images: PlaceImagesService;
  let wikimedia: FakeWikimedia;

  beforeAll(async () => {
    wikimedia = new FakeWikimedia();
    app = await createTestApp({
      imports: [PlaceImagesWorkerModule],
      override: (builder) =>
        builder.overrideProvider(WikimediaClient).useValue(wikimedia),
    });
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
    images = app.get(PlaceImagesService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState(app);
    wikimedia.mainImages.clear();
    wikimedia.files.clear();
    wikimedia.failDownloads = false;
    wikimedia.downloads = [];
  });

  async function placeWithTags(tags: Record<string, string>): Promise<string> {
    const id = await insertPlace(app, {
      name: 'Stephansdom',
      lat: 48.2085,
      lng: 16.3731,
      tags,
    });
    await setTags(id, tags);
    return id;
  }

  async function setTags(id: string, tags: Record<string, string>) {
    await prisma.place.update({
      where: { id },
      data: { tags, imageTagsHash: imageTagsHash(tags) },
    });
  }

  const rows = (placeId: string) =>
    prisma.placeImage.findMany({
      where: { placeId },
      orderBy: { rank: 'asc' },
    });

  it('copies freely licensed images linked from the tags, in origin order, with the credit', async () => {
    wikimedia.mainImages.set('Q1', 'File:Stephansdom Wien.jpg');
    wikimedia.files.set(
      'File:Stephansdom Wien.jpg',
      commonsFile('File:Stephansdom Wien.jpg', CC_BY_SA_4),
    );
    wikimedia.files.set(
      'File:Dom innen.jpg',
      commonsFile('File:Dom innen.jpg', {
        License: 'cc-by-nc-4.0',
        LicenseShortName: 'CC BY-NC 4.0',
      }),
    );
    const placeId = await placeWithTags({
      wikidata: 'Q1',
      // The same file as P18, spelled the OSM way: kept once.
      wikimedia_commons: 'File:Stephansdom_Wien.jpg',
      image: 'https://commons.wikimedia.org/wiki/File:Dom_innen.jpg',
    });

    const result = await images.sync();
    expect(result).toMatchObject({
      places: 1,
      ready: 1,
      rejected: 1,
      more: false,
    });

    const [main, inside] = await rows(placeId);
    expect(main).toMatchObject({
      commonsTitle: 'File:Stephansdom Wien.jpg',
      origin: 'wikidata_p18',
      wikidataId: 'Q1',
      rank: 0,
      status: 'ready',
      authorText: 'Jane Doe',
      licenseShortName: 'CC BY-SA 4.0',
      width: 1280,
      height: 960,
      commonsSha1: 'sha-1',
      filePageUrl:
        'https://commons.wikimedia.org/wiki/File:Stephansdom_Wien.jpg',
    });
    expect(inside).toMatchObject({
      origin: 'osm_image',
      rank: 1,
      status: 'rejected',
      rejectReason: 'license',
    });
    expect(wikimedia.downloads).toHaveLength(1);

    const keys = placeImageKeys(main.id);
    const thumb = await sharp(await storage.get(keys.thumb)).metadata();
    expect(thumb).toMatchObject({ format: 'webp', width: 256, height: 256 });
    const display = await sharp(await storage.get(keys.display)).metadata();
    expect(display).toMatchObject({ format: 'webp', width: 1280 });
    expect(display.exif).toBeUndefined();
    const xmp = display.xmp!.toString();
    expect(xmp).toContain('Jane Doe');
    expect(xmp).toContain('https://creativecommons.org/licenses/by-sa/4.0');

    // Nothing changed: the next run touches nothing.
    expect(await images.sync()).toMatchObject({ places: 0, ready: 0 });
    expect(wikimedia.downloads).toHaveLength(1);
    expect(
      (await prisma.place.findUniqueOrThrow({ where: { id: placeId } }))
        .imagesSyncedHash,
    ).toBe(
      imageTagsHash({
        wikidata: 'Q1',
        wikimedia_commons: 'File:Stephansdom_Wien.jpg',
        image: 'https://commons.wikimedia.org/wiki/File:Dom_innen.jpg',
      }),
    );
  });

  it('removes images a place no longer links, with their files, but keeps hidden ones hidden', async () => {
    wikimedia.files.set('File:A.jpg', commonsFile('File:A.jpg', CC_BY_SA_4));
    wikimedia.files.set('File:B.jpg', commonsFile('File:B.jpg', CC_BY_SA_4));
    const placeId = await placeWithTags({ wikimedia_commons: 'File:A.jpg' });
    await images.sync();
    const [a] = await rows(placeId);
    expect(a.status).toBe('ready');

    await setTags(placeId, { wikimedia_commons: 'File:B.jpg' });
    expect(await images.sync()).toMatchObject({
      places: 1,
      ready: 1,
      removed: 1,
    });
    const after = await rows(placeId);
    expect(after.map((r) => [r.commonsTitle, r.status])).toEqual(
      expect.arrayContaining([
        ['File:A.jpg', 'removed'],
        ['File:B.jpg', 'ready'],
      ]),
    );
    await expect(storage.head(placeImageKeys(a.id).thumb)).resolves.toBeNull();

    const b = after.find((r) => r.commonsTitle === 'File:B.jpg')!;
    await prisma.placeImage.update({
      where: { id: b.id },
      data: { status: 'hidden' },
    });
    await setTags(placeId, {
      wikimedia_commons: 'File:A.jpg',
      image: 'File:B.jpg',
    });
    await images.sync();
    const relinked = await rows(placeId);
    expect(relinked.map((r) => [r.commonsTitle, r.status])).toEqual([
      ['File:A.jpg', 'ready'],
      ['File:B.jpg', 'hidden'],
    ]);
  });

  it('marks files Commons does not have as removed, and retries a failed download a day later', async () => {
    const gone = await placeWithTags({ wikimedia_commons: 'File:Gone.jpg' });
    wikimedia.files.set('File:C.jpg', commonsFile('File:C.jpg', CC_BY_SA_4));
    const flaky = await insertPlace(app, {
      name: 'Karlskirche',
      lat: 48.198,
      lng: 16.371,
    });
    await setTags(flaky, { image: 'File:C.jpg' });
    wikimedia.failDownloads = true;

    const now = new Date();
    await images.sync(now);
    expect((await rows(gone))[0]).toMatchObject({
      status: 'removed',
      rejectReason: 'missing',
    });
    expect((await rows(flaky))[0].status).toBe('pending');

    wikimedia.failDownloads = false;
    expect(
      await images.sync(new Date(now.getTime() + DAY_MS / 2)),
    ).toMatchObject({ ready: 0 });
    expect(
      await images.sync(new Date(now.getTime() + DAY_MS + 1000)),
    ).toMatchObject({ ready: 1 });
    expect((await rows(flaky))[0].status).toBe('ready');
  });

  it('rechecks stored images weekly: drops deleted ones, downloads changed ones, follows credit changes', async () => {
    for (const title of [
      'File:Keep.jpg',
      'File:Changed.jpg',
      'File:Deleted.jpg',
    ]) {
      wikimedia.files.set(title, commonsFile(title, CC_BY_SA_4));
    }
    const keep = await placeWithTags({ wikimedia_commons: 'File:Keep.jpg' });
    const changed = await insertPlace(app, {
      name: 'Oper',
      lat: 48.203,
      lng: 16.369,
    });
    await setTags(changed, { wikimedia_commons: 'File:Changed.jpg' });
    const deleted = await insertPlace(app, {
      name: 'Albertina',
      lat: 48.204,
      lng: 16.368,
    });
    await setTags(deleted, { wikimedia_commons: 'File:Deleted.jpg' });
    await images.sync();
    expect(wikimedia.downloads).toHaveLength(3);

    const now = new Date();
    expect(await images.revalidate(now)).toMatchObject({ checked: 0 });

    wikimedia.files.set(
      'File:Keep.jpg',
      commonsFile('File:Keep.jpg', { ...CC_BY_SA_4, Artist: 'Jane D.' }),
    );
    wikimedia.files.set(
      'File:Changed.jpg',
      commonsFile('File:Changed.jpg', CC_BY_SA_4, 'sha-2'),
    );
    wikimedia.files.set(
      'File:Deleted.jpg',
      commonsFile('File:Deleted.jpg', {
        ...CC_BY_SA_4,
        DeletionReason: 'Copyvio',
      }),
    );
    const later = new Date(now.getTime() + 8 * DAY_MS);
    expect(await images.revalidate(later)).toMatchObject({
      checked: 3,
      refreshed: 1,
      removed: 1,
    });
    expect(wikimedia.downloads).toHaveLength(4);
    expect((await rows(keep))[0]).toMatchObject({
      status: 'ready',
      authorText: 'Jane D.',
      checkedAt: later,
    });
    expect((await rows(changed))[0]).toMatchObject({
      status: 'ready',
      commonsSha1: 'sha-2',
    });
    const [removed] = await rows(deleted);
    expect(removed).toMatchObject({
      status: 'removed',
      rejectReason: 'deletion',
    });
    await expect(
      storage.head(placeImageKeys(removed.id).display),
    ).resolves.toBeNull();
  });
});
