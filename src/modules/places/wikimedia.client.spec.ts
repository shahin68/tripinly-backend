import {
  retryAfterSeconds,
  WikimediaClient,
  WikimediaError,
} from './wikimedia.client';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

const p18 = (value: string, rank = 'normal') => ({
  rank,
  mainsnak: { snaktype: 'value', datavalue: { value } },
});

describe('WikimediaClient', () => {
  let fetchMock: jest.SpyInstance;
  const client = new WikimediaClient();

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    jest.useRealTimers();
  });

  it('reads main images from Wikidata, preferring a preferred statement', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        entities: {
          Q1: {
            claims: { P18: [p18('Old.jpg', 'deprecated'), p18('A b.jpg')] },
          },
          Q2: {
            claims: { P18: [p18('Normal.jpg'), p18('Best.jpg', 'preferred')] },
          },
          Q3: { claims: {} },
          Q4: {
            claims: {
              P18: [{ rank: 'normal', mainsnak: { snaktype: 'novalue' } }],
            },
          },
        },
      }),
    );
    const images = await client.wikidataMainImages(['Q1', 'Q2', 'Q3', 'Q4']);
    expect(images).toEqual(
      new Map([
        ['Q1', 'File:A b.jpg'],
        ['Q2', 'File:Best.jpg'],
      ]),
    );
    const url = new URL(fetchMock.mock.calls[0][0] as URL);
    expect(url.origin + url.pathname).toBe(
      'https://www.wikidata.org/w/api.php',
    );
    expect(url.searchParams.get('ids')).toBe('Q1|Q2|Q3|Q4');
    expect(url.searchParams.get('maxlag')).toBe('5');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toContain(
      'tripinly@gmail.com',
    );
  });

  it('reads Commons file details under the titles it was given', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        query: {
          normalized: [{ from: 'File:A_b.jpg', to: 'File:A b.jpg' }],
          pages: [
            {
              title: 'File:A b.jpg',
              imageinfo: [
                {
                  thumburl: 'https://upload.wikimedia.org/thumb/1280px-A_b.jpg',
                  width: 3000,
                  height: 2000,
                  mime: 'image/jpeg',
                  sha1: 'abc',
                  extmetadata: { License: { value: 'cc0' } },
                },
              ],
            },
            { title: 'File:Gone.jpg', missing: true },
          ],
        },
      }),
    );
    const images = await client.commonsImages([
      'File:A_b.jpg',
      'File:Gone.jpg',
    ]);
    expect(images.get('File:Gone.jpg')).toBeNull();
    expect(images.get('File:A_b.jpg')).toEqual({
      title: 'File:A b.jpg',
      mime: 'image/jpeg',
      width: 3000,
      height: 2000,
      extmetadata: { License: { value: 'cc0' } },
      thumbUrl: 'https://upload.wikimedia.org/thumb/1280px-A_b.jpg',
      sha1: 'abc',
    });
    const url = new URL(fetchMock.mock.calls[0][0] as URL);
    expect(url.searchParams.get('iiurlwidth')).toBe('1280');
  });

  it('waits for Retry-After after a 429 and tries again', async () => {
    jest.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'Retry-After': '7' } }),
      )
      .mockResolvedValueOnce(json({ entities: {} }));
    const pending = client.wikidataMainImages(['Q1']);
    await jest.advanceTimersByTimeAsync(6_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(new Map());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a maxlag error like a 429 and gives up after three tries', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        json(
          { error: { code: 'maxlag' } },
          { headers: { 'Retry-After': '1' } },
        ),
      ),
    );
    const pending = client.wikidataMainImages(['Q1']);
    const assertion = expect(pending).rejects.toThrow(
      new WikimediaError('maxlag'),
    );
    await jest.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails on other HTTP and API errors without retrying', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>busy</html>', { status: 503 }),
    );
    await expect(client.commonsImages(['File:A.jpg'])).rejects.toThrow(
      'HTTP 503',
    );
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'badvalue' } }));
    await expect(client.commonsImages(['File:A.jpg'])).rejects.toThrow(
      'API error badvalue',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses more than 50 items and skips empty requests', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `Q${i}`);
    await expect(client.wikidataMainImages(many)).rejects.toThrow(RangeError);
    await expect(client.commonsImages([])).resolves.toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('retryAfterSeconds', () => {
  it('reads seconds and dates, within 1 and 120 s', () => {
    expect(retryAfterSeconds(null)).toBe(5);
    expect(retryAfterSeconds('30')).toBe(30);
    expect(retryAfterSeconds('0')).toBe(1);
    expect(retryAfterSeconds('9999')).toBe(120);
    expect(
      retryAfterSeconds(new Date(Date.now() + 10_500).toUTCString()),
    ).toBeGreaterThanOrEqual(10);
    expect(retryAfterSeconds('soon')).toBe(5);
  });
});
