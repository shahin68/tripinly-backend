import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { REDIS } from '../../src/common/redis/redis.module';
import { OsmImportModule } from '../../src/modules/osm-import/osm-import.module';
import { OsmImportService } from '../../src/modules/osm-import/osm-import.service';
import { IN_VIEW_CACHE_VERSION_KEY } from '../../src/modules/places/places-cache';
import { resetState } from '../utils/auth-helpers';
import { createTestApp } from '../utils/create-test-app';

const FIXTURE = join(__dirname, '..', 'fixtures', 'osm', 'sample.osm');
const REGION = 'europe/test';

/** Needs osmium-tool on the PATH (CI installs it; `apt install osmium-tool` locally). */
describe('OSM import (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let imports: OsmImportService;
  let workDir: string;

  beforeAll(async () => {
    app = await createTestApp({ imports: [OsmImportModule] });
    prisma = app.get(PrismaService);
    imports = app.get(OsmImportService);
    workDir = mkdtempSync(join(tmpdir(), 'osm-fixture-'));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState(app);
  });

  /** The sample with edits applied, written to a temp file. */
  const variant = (name: string, edit: (xml: string) => string): string => {
    const path = join(workDir, `${name}.osm`);
    writeFileSync(path, edit(readFileSync(FIXTURE, 'utf8')));
    return path;
  };
  const withoutNode = (xml: string, id: number) =>
    xml.replace(new RegExp(`  <node id="${id}" [^]*?</node>\\n`), '');

  const places = () =>
    prisma.place.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        category: true,
        source: true,
        osmType: true,
        osmId: true,
        osmRegion: true,
        names: true,
        tags: true,
        lat: true,
        lng: true,
        isActive: true,
        popularity: true,
        searchText: true,
      },
    });

  it('imports named, mapped features with localized names and a point per area', async () => {
    const result = await imports.runRegion(REGION, { sourceFile: FIXTURE });

    expect(result).toEqual(
      expect.objectContaining({
        region: REGION,
        status: 'succeeded',
        seen: 6,
        inserted: 6,
        updated: 0,
        deactivated: 0,
      }),
    );
    const rows = await places();
    expect(rows.map((p) => [p.name, p.category, p.osmType, p.osmId])).toEqual([
      ['Augarten', 'park', 'relation', 30n],
      ['Café Central', 'cafe', 'node', 1n],
      ['Griechenbeisl', 'restaurant', 'node', 6n],
      ['Kunsthistorisches Museum', 'museum', 'way', 10n],
      ['Stadtmauer', 'historic', 'way', 40n],
      ['Stephansdom', 'landmark', 'node', 5n],
    ]);
    const cafe = rows.find((p) => p.name === 'Café Central')!;
    expect(cafe).toEqual(
      expect.objectContaining({
        source: 'osm',
        osmRegion: REGION,
        names: { 'name:de': 'Café Central', 'name:hu': 'Central kávéház' },
        tags: {
          website: 'https://example.com',
          opening_hours: 'Mo-Su 08:00-21:00',
        },
        searchText: 'cafe central central kavehaz',
        lat: 48.2085,
        lng: 16.3731,
      }),
    );
    // The L-shaped museum's point lies inside the L, not in its notch.
    const museum = rows.find((p) => p.osmType === 'way' && p.osmId === 10n)!;
    const inWideArm = museum.lat >= 48.2 && museum.lat <= 48.201;
    const inTallArm = museum.lng >= 16.36 && museum.lng <= 16.361;
    expect(inWideArm || inTallArm).toBe(true);

    const run = await prisma.osmImportRun.findUniqueOrThrow({
      where: { id: result.runId },
    });
    expect(run).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        seen: 6,
        finishedAt: expect.any(Date),
      }),
    );
    expect(await app.get<Redis>(REDIS).get(IN_VIEW_CACHE_VERSION_KEY)).toBe(
      '1',
    );
  });

  it('changes nothing when the same extract runs again', async () => {
    await imports.runRegion(REGION, { sourceFile: FIXTURE });
    const before = await places();

    const again = await imports.runRegion(REGION, { sourceFile: FIXTURE });

    expect(again).toEqual(
      expect.objectContaining({ inserted: 0, updated: 0, deactivated: 0 }),
    );
    expect(await places()).toEqual(before);
  });

  it('updates changed places, keeping their ids and popularity', async () => {
    await imports.runRegion(REGION, { sourceFile: FIXTURE });
    const cafe = await prisma.place.findFirstOrThrow({ where: { osmId: 1n } });
    await prisma.place.update({
      where: { id: cafe.id },
      data: { popularity: 7 },
    });

    const renamed = variant('renamed', (xml) =>
      xml.replace(
        '<tag k="name" v="Café Central"/>',
        '<tag k="name" v="Café Central Wien"/>',
      ),
    );
    const result = await imports.runRegion(REGION, { sourceFile: renamed });

    expect(result).toEqual(
      expect.objectContaining({ inserted: 0, updated: 1 }),
    );
    const after = await prisma.place.findUniqueOrThrow({
      where: { id: cafe.id },
    });
    expect(after.name).toBe('Café Central Wien');
    expect(after.popularity).toBe(7);
  });

  it('leaves user places that carry the same OSM ids alone', async () => {
    const userPlace = await prisma.place.create({
      data: {
        name: 'Our café',
        normalizedName: 'our cafe',
        category: 'other',
        lat: 48.2,
        lng: 16.3,
        source: 'user',
        osmType: 'node',
        osmId: 1n,
      },
    });

    const result = await imports.runRegion(REGION, { sourceFile: FIXTURE });

    expect(result).toEqual(
      expect.objectContaining({ seen: 6, inserted: 5, updated: 0 }),
    );
    expect(
      await prisma.place.findUniqueOrThrow({ where: { id: userPlace.id } }),
    ).toEqual(userPlace);
  });

  it('deactivates places that left the region, never deleting them', async () => {
    await imports.runRegion(REGION, { sourceFile: FIXTURE });
    const result = await imports.runRegion(REGION, {
      sourceFile: variant('fewer', (xml) => withoutNode(xml, 6)),
    });

    expect(result).toEqual(
      expect.objectContaining({ status: 'succeeded', seen: 5, deactivated: 1 }),
    );
    const gone = await prisma.place.findFirstOrThrow({
      where: { osmId: 6n, osmType: 'node' },
    });
    expect(gone.isActive).toBe(false);

    // Back in the next extract: active again.
    await imports.runRegion(REGION, { sourceFile: FIXTURE });
    expect(
      (await prisma.place.findUniqueOrThrow({ where: { id: gone.id } }))
        .isActive,
    ).toBe(true);
  });

  it('skips deactivation when an extract shrinks by more than 20%', async () => {
    await imports.runRegion(REGION, { sourceFile: FIXTURE });
    const truncated = variant('truncated', (xml) =>
      [5, 6]
        .reduce(withoutNode, xml)
        .replace(/  <relation [^]*?<\/relation>\n/, ''),
    );

    const result = await imports.runRegion(REGION, { sourceFile: truncated });

    expect(result).toEqual(
      expect.objectContaining({ status: 'degraded', seen: 3, deactivated: 0 }),
    );
    expect(await prisma.place.count({ where: { isActive: false } })).toBe(0);
  });

  it('records a failed run', async () => {
    await expect(
      imports.runRegion(REGION, {
        sourceFile: join(workDir, 'missing.osm.pbf'),
      }),
    ).rejects.toThrow();
    const run = await prisma.osmImportRun.findFirstOrThrow({
      where: { region: REGION },
    });
    expect(run.status).toBe('failed');
    expect(run.error).toEqual(expect.any(String));
  });
});
