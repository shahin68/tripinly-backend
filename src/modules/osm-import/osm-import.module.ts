import { Module } from '@nestjs/common';
import { OsmImportService } from './osm-import.service';

/** The import itself, for the worker and the `osm:import` script. */
@Module({
  providers: [OsmImportService],
  exports: [OsmImportService],
})
export class OsmImportModule {}
