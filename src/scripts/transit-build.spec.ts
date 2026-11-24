import { withRetry } from './transit-build';

describe('transit builder downloads', () => {
  const url = 'https://download.example/austria-latest.osm.pbf';
  const networkError = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
      }),
    });

  beforeEach(() => jest.spyOn(process.stdout, 'write').mockReturnValue(true));
  afterEach(() => jest.restoreAllMocks());

  it('tries a failed download again and returns the try that worked', async () => {
    const download = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce('saved');

    await expect(withRetry(url, download, [0, 0])).resolves.toBe('saved');
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('gives up after the last wait and names the file and the reason', async () => {
    const download = jest
      .fn<Promise<string>, []>()
      .mockImplementation(() => Promise.reject(networkError()));

    await expect(withRetry(url, download, [0, 0])).rejects.toThrow(
      `Download of ${url} failed: fetch failed: read ECONNRESET`,
    );
    expect(download).toHaveBeenCalledTimes(3);
  });
});
