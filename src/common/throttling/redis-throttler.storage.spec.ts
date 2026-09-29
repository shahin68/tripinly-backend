import type { Redis } from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler.storage';

describe('RedisThrottlerStorage', () => {
  it('converts Redis milliseconds to the seconds the guard expects', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValue([21, 59_001, 1, 60_000]),
    };
    const storage = new RedisThrottlerStorage(redis as unknown as Redis);
    await expect(
      storage.increment('k', 60_000, 20, 60_000, 'default'),
    ).resolves.toEqual({
      totalHits: 21,
      timeToExpire: 60,
      isBlocked: true,
      timeToBlockExpire: 60,
    });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      2,
      'throttle:default:k:hits',
      'throttle:default:k:block',
      60_000,
      20,
      60_000,
    );
  });

  it('lets requests through when Redis is unavailable', async () => {
    const redis = {
      eval: jest.fn().mockRejectedValue(new Error('Connection is closed')),
    };
    const storage = new RedisThrottlerStorage(redis as unknown as Redis);
    await expect(
      storage.increment('k', 60_000, 20, 60_000, 'default'),
    ).resolves.toMatchObject({
      isBlocked: false,
    });
  });
});
