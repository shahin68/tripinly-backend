import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Env } from '../../common/config/env';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { OsmImportJob } from './osm-import.queue';
import { OsmImportScheduler } from './osm-import.scheduler';

const REGION = 'europe/austria';

function setup(previous: 'none' | 'failed' | 'delayed' | 'waiting') {
  const job =
    previous === 'none'
      ? undefined
      : {
          isFailed: jest.fn().mockResolvedValue(previous === 'failed'),
          isDelayed: jest.fn().mockResolvedValue(previous === 'delayed'),
          remove: jest.fn().mockResolvedValue(undefined),
        };
  const queue = {
    getJobSchedulers: jest.fn().mockResolvedValue([]),
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    getJob: jest.fn().mockResolvedValue(job),
    add: jest.fn().mockResolvedValue(undefined),
  };
  const values: Partial<Env> = {
    OSM_IMPORT_ENABLED: true,
    OSM_IMPORT_REGIONS: [REGION],
    OSM_IMPORT_CRON: '0 3 1 * *',
  };
  const config = { get: (key: keyof Env) => values[key] };
  const prisma = { osmImportRun: { count: jest.fn().mockResolvedValue(0) } };
  const scheduler = new OsmImportScheduler(
    queue as unknown as Queue<OsmImportJob>,
    config as unknown as ConfigService<Env, true>,
    prisma as unknown as PrismaService,
  );
  return { scheduler, queue, job };
}

describe('OsmImportScheduler', () => {
  it.each(['failed', 'delayed'] as const)(
    'starts a %s initial import over',
    async (state) => {
      const { scheduler, queue, job } = setup(state);

      await scheduler.onApplicationBootstrap();

      expect(job?.remove).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        'import',
        { region: REGION },
        expect.objectContaining({ jobId: 'initial-europe-austria' }),
      );
    },
  );

  it('leaves a waiting or running initial import alone', async () => {
    const { scheduler, job } = setup('waiting');

    await scheduler.onApplicationBootstrap();

    expect(job?.remove).not.toHaveBeenCalled();
  });
});
