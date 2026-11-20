import { fetchExpectedMd5 } from './osm-import.service';

const LATEST = 'https://download.geofabrik.de/europe/austria-latest.osm.pbf';
const DATED = 'https://download.geofabrik.de/europe/austria-251119.osm.pbf';

function serve(files: Record<string, string>, status = 404) {
  const asked: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = input instanceof Request ? input.url : input.toString();
    asked.push(url);
    const body = files[url];
    return Promise.resolve(
      body === undefined
        ? new Response('missing', { status })
        : new Response(body, { status: 200 }),
    );
  });
  return asked;
}

describe('fetchExpectedMd5', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads the checksum next to the file actually served', async () => {
    const asked = serve({
      [`${DATED}.md5`]: 'abc123  austria-251119.osm.pbf\n',
    });
    await expect(fetchExpectedMd5(LATEST, DATED, {})).resolves.toBe('abc123');
    expect(asked).toEqual([`${DATED}.md5`]);
  });

  it('falls back to the name asked for', async () => {
    const asked = serve({
      [`${LATEST}.md5`]: 'def456  austria-latest.osm.pbf',
    });
    await expect(fetchExpectedMd5(LATEST, DATED, {})).resolves.toBe('def456');
    expect(asked).toEqual([`${DATED}.md5`, `${LATEST}.md5`]);
  });

  it('asks once when nothing redirected, and answers null when no checksum exists', async () => {
    const asked = serve({});
    await expect(fetchExpectedMd5(LATEST, LATEST, {})).resolves.toBeNull();
    expect(asked).toEqual([`${LATEST}.md5`]);
  });

  it('throws on other errors', async () => {
    serve({}, 503);
    await expect(fetchExpectedMd5(LATEST, LATEST, {})).rejects.toThrow(
      'checksum download failed with HTTP 503',
    );
  });
});
