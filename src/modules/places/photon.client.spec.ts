import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env';
import { PhotonClient, toResult } from './photon.client';

describe('Photon result mapping', () => {
  it('maps a city with OSM ids', () => {
    expect(
      toResult({
        geometry: { type: 'Point', coordinates: [16.3725, 48.2083] },
        properties: {
          osm_type: 'R',
          osm_id: 109166,
          name: 'Wien',
          type: 'city',
          country: 'Österreich',
        },
      }),
    ).toEqual({
      source: 'photon',
      id: null,
      name: 'Wien',
      category: null,
      location: { lat: 48.2083, lng: 16.3725 },
      isTripinly: false,
      hotCount: 0,
      type: 'city',
      address: 'Österreich',
      osmType: 'relation',
      osmId: '109166',
    });
  });

  it('names an address by street and number', () => {
    const result = toResult({
      geometry: { type: 'Point', coordinates: [16.37, 48.2] },
      properties: {
        osm_type: 'N',
        osm_id: 5,
        street: 'Stephansplatz',
        housenumber: '1',
        city: 'Wien',
        country: 'Österreich',
        type: 'house',
      },
    });
    expect(result?.name).toBe('Stephansplatz 1');
    expect(result?.address).toBe('Wien, Österreich');
  });

  it('drops unusable features', () => {
    expect(
      toResult({
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: {},
      }),
    ).toBeNull();
    expect(
      toResult({
        geometry: { type: 'LineString', coordinates: [] },
        properties: { name: 'x' },
      }),
    ).toBeNull();
  });
});

describe('Photon requests', () => {
  const client = new PhotonClient({
    get: () => 'https://photon.test',
  } as unknown as ConfigService<Env, true>);
  const vienna = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [16.3725, 48.2083] },
    properties: { name: 'Wien', type: 'city' },
  };
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('tries once more after a quick failure', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(Response.json({ features: [vienna] }));

    const results = await client.search({ q: 'Wien', lang: 'en' });

    expect(results.map((result) => result.name)).toEqual(['Wien']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after a second failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(client.search({ q: 'Wien', lang: 'en' })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't retry a rate limit or a timeout", async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429 }));
    await expect(client.search({ q: 'Wien', lang: 'en' })).resolves.toEqual([]);

    fetchMock.mockRejectedValueOnce(
      new DOMException('The operation timed out.', 'TimeoutError'),
    );
    await expect(
      client.reverse({ lat: 48.2, lng: 16.37, lang: 'en' }),
    ).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
