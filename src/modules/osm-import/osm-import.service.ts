import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { Client } from 'pg';
import type { Env } from '../../common/config/env';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';
import { OsmImportStatus } from '../../generated/prisma/client';
import { IN_VIEW_CACHE_VERSION_KEY } from '../places/places-cache';
import {
  OSMIUM_TAG_FILTERS,
  type StagedPlace,
  transformFeature,
} from './osm-transform';

const run = promisify(execFile);

/** Deactivation is skipped when a run sees this much less than the previous one. */
export const MAX_SEEN_DROP = 0.2;
const STAGING_BATCH = 5_000;
const UPSERT_BATCH = 10_000;
const OSMIUM_TIMEOUT_MS = 60 * 60 * 1000;
/** Any value works as long as every import uses it; pg advisory locks are per database. */
const IMPORT_LOCK_KEY = 72_310_001;

export interface OsmImportResult {
  runId: string;
  region: string;
  status: OsmImportStatus;
  seen: number;
  inserted: number;
  updated: number;
  deactivated: number;
}

export interface OsmImportOptions {
  /** A local .osm.pbf (or .osm) to import instead of downloading the region. */
  sourceFile?: string;
}

/**
 * Imports one Geofabrik region into `places` (osm-import skill): download,
 * filter and export with osmium, stream-transform into a temp staging table,
 * upsert by (osmType, osmId), then deactivate what the region no longer has.
 * Idempotent; never touches user places, popularity or place IDs.
 */
@Injectable()
export class OsmImportService {
  private readonly logger = new Logger(OsmImportService.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async runRegion(
    region: string,
    options: OsmImportOptions = {},
  ): Promise<OsmImportResult> {
    const importRun = await this.prisma.osmImportRun.create({
      data: { region },
    });
    const db = new Client({
      connectionString: this.config.get('DATABASE_URL', { infer: true }),
    });
    let workDir: string | undefined;
    let locked = false;
    try {
      await db.connect();
      const lock = await db.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [IMPORT_LOCK_KEY],
      );
      locked = lock.rows[0].locked;
      if (!locked) throw new Error('another OSM import is running');

      workDir = await mkdtemp(
        join(
          this.config.get('OSM_IMPORT_TMP_DIR', { infer: true }) ?? tmpdir(),
          'osm-',
        ),
      );
      let source = options.sourceFile;
      let extractAt: Date | null = null;
      if (!source) {
        this.logger.log(`OSM import of ${region}: downloading`);
        ({ path: source, extractAt } = await this.download(region, workDir));
      }
      this.logger.log(`OSM import of ${region}: filtering with osmium`);
      const features = await this.extract(source, workDir);

      await createStaging(db);
      const seen = await this.stage(db, features);
      if (seen === 0) throw new Error('the extract contained no places');
      this.logger.log(`OSM import of ${region}: ${seen} places staged, saving`);

      const { inserted, updated } = await upsert(db, region);

      const previous = await this.prisma.osmImportRun.findFirst({
        where: {
          region,
          id: { not: importRun.id },
          status: { in: ['succeeded', 'degraded'] },
        },
        orderBy: { startedAt: 'desc' },
        select: { seen: true },
      });
      let status: OsmImportStatus = OsmImportStatus.succeeded;
      let deactivated = 0;
      if (previous && seen < previous.seen * (1 - MAX_SEEN_DROP)) {
        status = OsmImportStatus.degraded;
        this.logger.error(
          `OSM import of ${region} saw ${seen} places, previous run ${previous.seen}; ` +
            'skipped deactivation. Check the extract before the next run.',
        );
      } else {
        deactivated = await deactivateMissing(db, region);
      }

      await db.query('ANALYZE places');
      await this.clearInViewCache();

      await this.prisma.osmImportRun.update({
        where: { id: importRun.id },
        data: {
          status,
          extractAt,
          seen,
          inserted,
          updated,
          deactivated,
          finishedAt: new Date(),
        },
      });
      this.logger.log(
        `OSM import of ${region} ${status}: seen ${seen}, inserted ${inserted}, ` +
          `updated ${updated}, deactivated ${deactivated}`,
      );
      return {
        runId: importRun.id,
        region,
        status,
        seen,
        inserted,
        updated,
        deactivated,
      };
    } catch (error) {
      const message = describeError(error);
      // The run row keeps the error too, but the logs are what people look at first.
      this.logger.error(`OSM import of ${region} failed: ${message}`);
      await this.prisma.osmImportRun.update({
        where: { id: importRun.id },
        data: {
          status: 'failed',
          error: message.slice(0, 500),
          finishedAt: new Date(),
        },
      });
      throw error;
    } finally {
      if (locked) {
        await db
          .query('SELECT pg_advisory_unlock($1)', [IMPORT_LOCK_KEY])
          .catch(() => undefined);
      }
      await db.end().catch(() => undefined);
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Downloads `<region>-latest.osm.pbf` and checks it against Geofabrik's .md5. */
  private async download(
    region: string,
    workDir: string,
  ): Promise<{ path: string; extractAt: Date | null }> {
    const url = `${this.config.get('GEOFABRIK_BASE_URL', { infer: true })}/${region}-latest.osm.pbf`;
    const headers = { 'User-Agent': 'Tripinly-OSM-import/1.0' };
    const path = join(workDir, 'extract.osm.pbf');

    const response = await fetch(url, { headers });
    if (!response.ok || !response.body) {
      throw new Error(
        `download of ${region} failed with HTTP ${response.status}`,
      );
    }
    const size = Number(response.headers.get('content-length'));
    if (size) {
      this.logger.log(
        `OSM import of ${region}: ${Math.round(size / 1_048_576)} MB to download`,
      );
    }
    const md5 = createHash('md5');
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          md5.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(path),
    );

    const checksum = await fetch(`${url}.md5`, { headers });
    if (!checksum.ok) {
      throw new Error(
        `checksum of ${region} failed with HTTP ${checksum.status}`,
      );
    }
    const expected = (await checksum.text()).trim().split(/\s+/)[0];
    if (expected !== md5.digest('hex')) {
      throw new Error(`checksum mismatch for ${region}`);
    }

    const lastModified = response.headers.get('last-modified');
    const extractAt = lastModified ? new Date(lastModified) : null;
    return {
      path,
      extractAt:
        extractAt && !Number.isNaN(extractAt.getTime()) ? extractAt : null,
    };
  }

  /** osmium: keep the tags we import, then export as a GeoJSON sequence (areas as polygons). */
  private async extract(source: string, workDir: string): Promise<string> {
    const filtered = join(workDir, 'poi.osm.pbf');
    const exported = join(workDir, 'poi.geojsonseq');
    await run(
      'osmium',
      [
        'tags-filter',
        source,
        ...OSMIUM_TAG_FILTERS,
        '-o',
        filtered,
        '--overwrite',
      ],
      { timeout: OSMIUM_TIMEOUT_MS },
    );
    await run(
      'osmium',
      [
        'export',
        filtered,
        '-f',
        'geojsonseq',
        '--add-unique-id=type_id',
        '-o',
        exported,
        '--overwrite',
      ],
      { timeout: OSMIUM_TIMEOUT_MS },
    );
    return exported;
  }

  /** Streams the export into staging. Returns the number of distinct places staged. */
  private async stage(db: Client, file: string): Promise<number> {
    const lines = createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    // A closed way comes out as a line and again (later) as an area; the area wins.
    let batch = new Map<string, StagedPlace>();
    for await (const raw of lines) {
      // geojsonseq records start with an ASCII record separator (0x1e).
      const line = (raw.charCodeAt(0) === 0x1e ? raw.slice(1) : raw).trim();
      if (!line) continue;
      const place = transformFeature(JSON.parse(line));
      if (!place) continue;
      batch.set(`${place.osmType}:${place.osmId}`, place);
      if (batch.size >= STAGING_BATCH) {
        await insertStaging(db, [...batch.values()]);
        batch = new Map();
      }
    }
    if (batch.size) await insertStaging(db, [...batch.values()]);
    const { rows } = await db.query<{ count: string }>(
      'SELECT count(*) FROM osm_staging',
    );
    return Number(rows[0].count);
  }

  private async clearInViewCache(): Promise<void> {
    try {
      await this.redis.incr(IN_VIEW_CACHE_VERSION_KEY);
    } catch {
      // The 60 s TTL clears the cache anyway.
    }
  }
}

async function createStaging(db: Client): Promise<void> {
  await db.query(`
    CREATE TEMP TABLE IF NOT EXISTS osm_staging (
      seq bigserial,
      osm_type text NOT NULL,
      osm_id bigint NOT NULL,
      name text NOT NULL,
      normalized_name text NOT NULL,
      search_text text NOT NULL,
      names jsonb NOT NULL,
      category text NOT NULL,
      tags jsonb NOT NULL,
      lat double precision NOT NULL,
      lng double precision NOT NULL,
      PRIMARY KEY (osm_type, osm_id)
    )`);
  await db.query('TRUNCATE osm_staging');
}

async function insertStaging(db: Client, places: StagedPlace[]): Promise<void> {
  await db.query(
    `INSERT INTO osm_staging (osm_type, osm_id, name, normalized_name, search_text, names, category, tags, lat, lng)
     SELECT * FROM unnest($1::text[], $2::bigint[], $3::text[], $4::text[], $5::text[],
                          $6::jsonb[], $7::text[], $8::jsonb[], $9::float8[], $10::float8[])
     ON CONFLICT (osm_type, osm_id) DO UPDATE SET
       name = EXCLUDED.name, normalized_name = EXCLUDED.normalized_name,
       search_text = EXCLUDED.search_text, names = EXCLUDED.names,
       category = EXCLUDED.category, tags = EXCLUDED.tags,
       lat = EXCLUDED.lat, lng = EXCLUDED.lng`,
    [
      places.map((p) => p.osmType),
      places.map((p) => p.osmId.toString()),
      places.map((p) => p.name),
      places.map((p) => p.normalizedName),
      places.map((p) => p.searchText),
      places.map((p) => JSON.stringify(p.names)),
      places.map((p) => p.category),
      places.map((p) => JSON.stringify(p.tags)),
      places.map((p) => p.lat),
      places.map((p) => p.lng),
    ],
  );
}

/**
 * Inserts new places and updates changed ones, in batches. Unchanged rows are
 * not written (so a rerun changes nothing); user places that carry the same
 * OSM ids are left alone; popularity and IDs are never touched.
 */
async function upsert(
  db: Client,
  region: string,
): Promise<{ inserted: number; updated: number }> {
  const { rows } = await db.query<{ max: string | null }>(
    'SELECT max(seq) AS max FROM osm_staging',
  );
  const maxSeq = Number(rows[0].max ?? 0);
  let inserted = 0;
  let updated = 0;
  for (let from = 0; from < maxSeq; from += UPSERT_BATCH) {
    const result = await db.query<{ inserted: string; updated: string }>(
      `WITH changed AS (
         INSERT INTO places (id, name, "normalizedName", "searchText", names, category, lat, lng,
                             source, "osmType", "osmId", "osmRegion", tags, "isActive", "importedAt", "updatedAt")
         SELECT gen_random_uuid(), s.name, s.normalized_name, s.search_text, s.names,
                s.category::"PlaceCategory", s.lat, s.lng, 'osm', s.osm_type::"OsmType", s.osm_id,
                $3, s.tags, true, now(), now()
         FROM osm_staging s
         WHERE s.seq > $1 AND s.seq <= $2
         ON CONFLICT ("osmType", "osmId") DO UPDATE SET
           name = EXCLUDED.name, "normalizedName" = EXCLUDED."normalizedName",
           "searchText" = EXCLUDED."searchText", names = EXCLUDED.names,
           category = EXCLUDED.category, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
           "osmRegion" = EXCLUDED."osmRegion", tags = EXCLUDED.tags, "isActive" = true,
           "importedAt" = now(), "updatedAt" = now()
         WHERE places.source = 'osm'
           AND (places.name, places."searchText", places.names, places.category, places.lat,
                places.lng, places."osmRegion", places.tags, places."isActive")
               IS DISTINCT FROM
               (EXCLUDED.name, EXCLUDED."searchText", EXCLUDED.names, EXCLUDED.category, EXCLUDED.lat,
                EXCLUDED.lng, EXCLUDED."osmRegion", EXCLUDED.tags, true)
         RETURNING (xmax = 0) AS is_new
       )
       SELECT count(*) FILTER (WHERE is_new) AS inserted,
              count(*) FILTER (WHERE NOT is_new) AS updated
       FROM changed`,
      [from, from + UPSERT_BATCH, region],
    );
    inserted += Number(result.rows[0].inserted);
    updated += Number(result.rows[0].updated);
  }
  return { inserted, updated };
}

/** OSM places of this region missing from the extract stop showing; markers keep them. */
async function deactivateMissing(db: Client, region: string): Promise<number> {
  const result = await db.query(
    `UPDATE places p SET "isActive" = false, "updatedAt" = now()
     WHERE p.source = 'osm' AND p."osmRegion" = $1 AND p."isActive"
       AND NOT EXISTS (
         SELECT 1 FROM osm_staging s
         WHERE s.osm_type = p."osmType"::text AND s.osm_id = p."osmId"
       )`,
    [region],
  );
  return result.rowCount ?? 0;
}

/**
 * A failed osmium run's message is mostly the command line, which pushes its
 * stderr past what the run row keeps. Name the tool, how it ended (exit code
 * or the signal that killed it, e.g. SIGKILL when out of memory) and stderr.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const failed = error as Error & {
    cmd?: string;
    code?: number | string;
    signal?: string | null;
    killed?: boolean;
    stderr?: string;
  };
  if (!failed.cmd) return error.message;
  const tool = failed.cmd.split(' ').slice(0, 2).join(' ');
  const ending = failed.signal
    ? `killed by ${failed.signal}`
    : `exit code ${failed.code}`;
  const stderr = failed.stderr?.trim();
  return `${tool} failed (${ending})${stderr ? `: ${stderr}` : ''}`;
}
