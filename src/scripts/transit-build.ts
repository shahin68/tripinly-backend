import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  MOTIS_LOCAL_PORT,
  PACKAGE_PREFIX,
  PackageStore,
  readTransitJobEnv,
  run,
  type TransitJobEnv,
  type TransitManifest,
} from '../modules/routing/transit/transit-package';
import {
  TRANSIT_REGIONS,
  type TransitRegion,
} from '../modules/routing/transit/transit-regions';

const OSM_MAX_AGE_DAYS = 30;

type FeedState = TransitManifest['feeds'][string] & { downloaded: boolean };

/**
 * The transit builder (Railway cron service "transit-builder", daily at any
 * hour): downloads each city's timetables, and when one changed (or the
 * cities did, or the streets are 30 days old) builds the MOTIS data,
 * uploads it to R2 and redeploys the transit service, which only downloads
 * it. Nothing changed: it stops after the downloads.
 *
 *   node dist/scripts/transit-build.js            # check, build when needed
 *   node dist/scripts/transit-build.js --force    # build anyway
 *   node dist/scripts/transit-build.js --osm vienna.osm.pbf --no-upload   # local try-out
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const force = args.includes('--force');
  const upload = !args.includes('--no-upload');
  const localOsm = option('--osm');

  const env = readTransitJobEnv();
  const store = upload ? new PackageStore(env) : null;
  const regions = env.TRANSIT_REGIONS.map((id) => TRANSIT_REGIONS[id]);
  const work = env.TRANSIT_WORK_DIR;
  await rm(work, { recursive: true, force: true });
  await mkdir(join(work, 'feeds'), { recursive: true });

  const previous = (await store?.manifest()) ?? null;
  const feeds: Record<string, FeedState> = {};
  let feedChanged = false;
  for (const region of regions) {
    for (const feed of region.feeds) {
      const id = `${region.id}:${feed.id}`;
      const result = await downloadFeed(
        feed.url,
        join(work, 'feeds', `${region.id}-${feed.id}.gtfs.zip`),
        force ? undefined : previous?.feeds[id],
      );
      feeds[id] = result.state;
      if (result.changed) feedChanged = true;
    }
  }
  const regionsChanged =
    previous?.regions.join(',') !== env.TRANSIT_REGIONS.join(',');
  const osmOld =
    !previous ||
    Date.now() - Date.parse(previous.osmAt) > OSM_MAX_AGE_DAYS * 86_400_000;
  if (!force && !feedChanged && !regionsChanged && !osmOld) {
    log('Timetables unchanged; nothing to build');
    return;
  }
  log(
    `Building ${env.TRANSIT_REGIONS.join(', ')}: ${
      force
        ? 'forced'
        : [
            feedChanged && 'timetables changed',
            regionsChanged && 'cities changed',
            osmOld && 'streets due',
          ]
            .filter(Boolean)
            .join(', ')
    }`,
  );
  // Unchanged feeds were not downloaded (304): get them now.
  for (const region of regions) {
    for (const feed of region.feeds) {
      const file = join(work, 'feeds', `${region.id}-${feed.id}.gtfs.zip`);
      if (!feeds[`${region.id}:${feed.id}`].downloaded) {
        await downloadFeed(feed.url, file, undefined);
      }
    }
  }

  const osm = localOsm ?? (await streets(env, regions, work));
  await writeFile(join(work, 'config.yml'), motisConfig(osm, regions, work));
  const data = join(work, 'data');
  const started = Date.now();
  await run('motis', ['import', '-c', join(work, 'config.yml'), '-d', data]);
  log(`MOTIS import took ${Math.round((Date.now() - started) / 1000)} s`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archive = join(work, 'package.tar.gz');
  await run('tar', ['-czf', archive, '-C', data, '.']);
  if (!store) {
    log(`Built ${archive} (not uploaded)`);
    return;
  }
  const key = `${PACKAGE_PREFIX}${stamp}.tar.gz`;
  await store.upload(key, archive);
  await store.saveManifest({
    package: key,
    builtAt: new Date().toISOString(),
    regions: env.TRANSIT_REGIONS,
    feeds: Object.fromEntries(
      Object.entries(feeds).map(([id, { sha256, etag, lastModified }]) => [
        id,
        { sha256, etag, lastModified },
      ]),
    ),
    osmAt:
      osmOld || regionsChanged || force || !previous
        ? new Date().toISOString()
        : previous.osmAt,
  });
  await store.prune([key, previous?.package].filter((k) => k !== undefined));
  log(`Uploaded ${key}`);
  await redeploy(env);
  await rm(work, { recursive: true, force: true });
}

/**
 * Downloads a feed unless the server says it is unchanged (ETag or
 * Last-Modified); a download with the same hash counts as unchanged too.
 */
async function downloadFeed(
  url: string,
  file: string,
  previous: TransitManifest['feeds'][string] | undefined,
): Promise<{ changed: boolean; state: FeedState }> {
  const headers: Record<string, string> = {};
  if (previous?.etag) headers['If-None-Match'] = previous.etag;
  if (previous?.lastModified) {
    headers['If-Modified-Since'] = previous.lastModified;
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (response.status === 304 && previous) {
    return { changed: false, state: { ...previous, downloaded: false } };
  }
  if (!response.ok || !response.body) {
    throw new Error(`Feed download answered ${response.status}: ${url}`);
  }
  await pipeline(
    Readable.fromWeb(response.body as WebReadableStream),
    createWriteStream(file),
  );
  const sha256 = await hashFile(file);
  return {
    changed: sha256 !== previous?.sha256,
    state: {
      sha256,
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
      downloaded: true,
    },
  };
}

/**
 * Each city's streets cut from its Geofabrik extract with whole ways (a
 * clipped extract has ways pointing outside it, which MOTIS refuses),
 * merged into one file.
 */
async function streets(
  env: TransitJobEnv,
  regions: TransitRegion[],
  work: string,
): Promise<string> {
  const extracts = [...new Set(regions.map((region) => region.osmExtract))];
  for (const extract of extracts) {
    const url = `${env.GEOFABRIK_BASE_URL.replace(/\/+$/, '')}/${extract}-latest.osm.pbf`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`OSM download answered ${response.status}: ${url}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream),
      createWriteStream(join(work, `${extract.replace(/\//g, '_')}.osm.pbf`)),
    );
  }
  const cut: string[] = [];
  for (const region of regions) {
    const { west, south, east, north } = region.bbox;
    const out = join(work, `${region.id}.osm.pbf`);
    await run('osmium', [
      'extract',
      '--overwrite',
      '--strategy',
      'complete_ways',
      '-b',
      `${west},${south},${east},${north}`,
      '-o',
      out,
      join(work, `${region.osmExtract.replace(/\//g, '_')}.osm.pbf`),
    ]);
    cut.push(out);
  }
  if (cut.length === 1) return cut[0];
  const merged = join(work, 'streets.osm.pbf');
  await run('osmium', ['merge', '--overwrite', '-o', merged, ...cut]);
  return merged;
}

/** Street routing and footpaths on; map tiles and geocoding off (we don't use them). */
export function motisConfig(
  osm: string,
  regions: TransitRegion[],
  work: string,
): string {
  const datasets = regions
    .flatMap((region) =>
      region.feeds.map(
        (feed) =>
          `    ${region.id}${feed.id}:\n      path: ${join(work, 'feeds', `${region.id}-${feed.id}.gtfs.zip`)}`,
      ),
    )
    .join('\n');
  return [
    'server:',
    '  host: 127.0.0.1',
    `  port: "${MOTIS_LOCAL_PORT}"`,
    `osm: ${osm}`,
    'timetable:',
    '  first_day: TODAY',
    '  num_days: 365',
    '  with_shapes: true',
    '  datasets:',
    datasets,
    'street_routing: true',
    'osr_footpath: true',
    'elevators: false',
    'geocoding: false',
    'reverse_geocoding: false',
    '',
  ].join('\n');
}

/** Railway public API: the transit service redeploys and picks up the new package. */
async function redeploy(env: TransitJobEnv): Promise<void> {
  if (
    !env.RAILWAY_API_TOKEN ||
    !env.RAILWAY_ENVIRONMENT_ID ||
    !env.TRANSIT_SERVICE_ID
  ) {
    log(
      'RAILWAY_API_TOKEN or TRANSIT_SERVICE_ID not set: redeploy the transit service by hand to serve the new package',
    );
    return;
  }
  const response = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Project-Access-Token': env.RAILWAY_API_TOKEN,
    },
    body: JSON.stringify({
      query:
        'mutation ($environmentId: String!, $serviceId: String!) { serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId) }',
      variables: {
        environmentId: env.RAILWAY_ENVIRONMENT_ID,
        serviceId: env.TRANSIT_SERVICE_ID,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    errors?: { message: string }[];
  };
  if (!response.ok || body.errors?.length) {
    throw new Error(
      `Railway redeploy failed (${response.status}): ${body.errors?.map((e) => e.message).join('; ') ?? ''}`,
    );
  }
  log('Transit service redeploy started');
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function log(message: string): void {
  process.stdout.write(`[transit-build] ${message}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `[transit-build] failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
