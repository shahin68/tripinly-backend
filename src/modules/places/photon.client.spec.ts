import { toResult } from './photon.client';

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
      likeCount: 0,
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
