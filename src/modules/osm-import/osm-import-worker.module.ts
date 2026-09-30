import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { OsmImportModule } from './osm-import.module';
import { OSM_IMPORT_QUEUE } from './osm-import.queue';
import { OsmImportProcessor } from './osm-import.processor';
import { OsmImportScheduler } from './osm-import.scheduler';

/** Worker side: the queue, its processor and the monthly schedule. */
@Module({
  imports: [
    OsmImportModule,
    BullModule.registerQueue({ name: OSM_IMPORT_QUEUE }),
  ],
  providers: [OsmImportProcessor, OsmImportScheduler],
})
export class OsmImportWorkerModule {}
