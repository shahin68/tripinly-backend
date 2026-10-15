import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Env } from '../../common/config/env';
import type { StorageService } from '../../common/storage/storage.service';
import {
  PlaceImagesScheduler,
  STARTUP_SYNC_JOB_ID,
} from './place-images.scheduler';

function setup(enabled: boolean, storageEnabled = true) {
  const queue = {
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    removeJobScheduler: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
  };
  const values: Partial<Env> = { PLACE_IMAGES_SYNC_ENABLED: enabled };
  const config = { get: (key: keyof Env) => values[key] };
  const scheduler = new PlaceImagesScheduler(
    queue as unknown as Queue,
    config as unknown as ConfigService<Env, true>,
    { enabled: storageEnabled } as StorageService,
  );
  return { scheduler, queue };
}

describe('PlaceImagesScheduler', () => {
  it('schedules the daily sync and weekly recheck, and syncs once on start', async () => {
    const { scheduler, queue } = setup(true);

    await scheduler.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      'sync',
      {},
      expect.objectContaining({ jobId: STARTUP_SYNC_JOB_ID }),
    );
  });

  it.each([
    ['switched off', false, true],
    ['without storage', true, false],
  ])('does nothing %s', async (_, enabled, storageEnabled) => {
    const { scheduler, queue } = setup(enabled, storageEnabled);

    await scheduler.onApplicationBootstrap();

    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(2);
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
