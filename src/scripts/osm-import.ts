import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { CoreModule } from '../common/core.module';
import type { Env } from '../common/config/env';
import { OsmImportModule } from '../modules/osm-import/osm-import.module';
import { OsmImportService } from '../modules/osm-import/osm-import.service';

@Module({ imports: [CoreModule, OsmImportModule] })
class OsmImportScriptModule {}

/**
 * Runs OSM imports now, outside the queue (first load on a new environment,
 * or local development):
 *
 *   npm run osm:import                        # every OSM_IMPORT_REGIONS region
 *   npm run osm:import -- europe/austria      # one region
 *   npm run osm:import -- --file vienna.osm.pbf europe/austria   # a local extract
 *   npm run osm:import -- --file vienna.osm.pbf --qrank qrank.csv.gz europe/austria
 *
 * A local extract downloads nothing, so its places keep their QRank unless
 * `--qrank` names a local qrank.csv.gz.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    return args.splice(index, 2)[1];
  };
  const sourceFile = option('--file');
  const qrankFile = option('--qrank');
  const regionArgs = args;

  const app = await NestFactory.createApplicationContext(
    OsmImportScriptModule,
    {
      bufferLogs: true,
    },
  );
  app.useLogger(app.get(Logger));
  await app.init();
  const regions = regionArgs.length
    ? regionArgs
    : app
        .get(ConfigService<Env, true>)
        .get('OSM_IMPORT_REGIONS', { infer: true });
  if (sourceFile && regions.length !== 1) {
    throw new Error('--file needs exactly one region');
  }

  const imports = app.get(OsmImportService);
  try {
    for (const region of regions) {
      const result = await imports.runRegion(region, {
        sourceFile,
        qrankFile,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
