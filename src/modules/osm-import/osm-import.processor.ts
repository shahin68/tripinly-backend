import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { OSM_IMPORT_QUEUE, type OsmImportJob } from './osm-import.queue';
import { type OsmImportResult, OsmImportService } from './osm-import.service';

/** One import at a time; a country takes minutes, and the lock is renewed while it runs. */
@Processor(OSM_IMPORT_QUEUE, { concurrency: 1, lockDuration: 5 * 60_000 })
export class OsmImportProcessor extends WorkerHost {
  constructor(private readonly imports: OsmImportService) {
    super();
  }

  process(job: Job<OsmImportJob>): Promise<OsmImportResult> {
    return this.imports.runRegion(job.data.region);
  }
}
