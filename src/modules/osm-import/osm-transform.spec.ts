import { categoryFor, parseFeatureId, transformFeature } from './osm-transform';

describe('categoryFor', () => {
  it.each([
    [{ amenity: 'cafe' }, 'cafe'],
    [{ amenity: 'ice_cream' }, 'cafe'],
    [{ amenity: 'fast_food' }, 'restaurant'],
    [{ amenity: 'biergarten' }, 'bar'],
    [{ tourism: 'viewpoint' }, 'attraction'],
    [{ tourism: 'gallery' }, 'museum'],
    [{ historic: 'castle' }, 'historic'],
    [{ leisure: 'nature_reserve' }, 'park'],
    [{ natural: 'waterfall' }, 'nature'],
    [{ amenity: 'place_of_worship', wikidata: 'Q1' }, 'landmark'],
    [{ amenity: 'place_of_worship', historic: 'church' }, 'historic'],
    // First match wins: a historic restaurant is a restaurant.
    [{ amenity: 'restaurant', historic: 'building' }, 'restaurant'],
  ])('maps %j to %s', (tags, category) => {
    expect(categoryFor(tags)).toBe(category);
  });

  it.each([
    [{ amenity: 'place_of_worship' }],
    [{ shop: 'bakery' }],
    [{ historic: 'no' }],
    [{ leisure: 'playground' }],
  ])('skips %j', (tags) => {
    expect(categoryFor(tags)).toBeNull();
  });
});

describe('parseFeatureId', () => {
  it('decodes osmium type_id ids, including area ids', () => {
    expect(parseFeatureId('n12')).toEqual({ osmType: 'node', osmId: 12n });
    expect(parseFeatureId('w7')).toEqual({ osmType: 'way', osmId: 7n });
    expect(parseFeatureId('a20')).toEqual({ osmType: 'way', osmId: 10n });
    expect(parseFeatureId('a61')).toEqual({ osmType: 'relation', osmId: 30n });
    expect(parseFeatureId('x1')).toBeNull();
    expect(parseFeatureId(5)).toBeNull();
  });
});

describe('transformFeature', () => {
  it('keeps names, localized names and a small tag subset', () => {
    const place = transformFeature({
      id: 'n1',
      geometry: { type: 'Point', coordinates: [16.3731, 48.2085] },
      properties: {
        amenity: 'cafe',
        name: 'Café Central',
        'name:hu': 'Central kávéház',
        'name:etymology': 'ignored',
        website: 'https://example.com',
        phone: '+43 1 000',
      },
    });
    expect(place).toEqual({
      osmType: 'node',
      osmId: 1n,
      name: 'Café Central',
      normalizedName: 'cafe central',
      searchText: 'cafe central central kavehaz',
      names: { 'name:hu': 'Central kávéház' },
      category: 'cafe',
      tags: { website: 'https://example.com' },
      lat: 48.2085,
      lng: 16.3731,
    });
  });

  it('skips unnamed and unmapped features', () => {
    const geometry = { type: 'Point', coordinates: [16, 48] };
    expect(
      transformFeature({ id: 'n1', geometry, properties: { amenity: 'cafe' } }),
    ).toBeNull();
    expect(
      transformFeature({
        id: 'n1',
        geometry,
        properties: { amenity: 'place_of_worship', name: 'Chapel' },
      }),
    ).toBeNull();
  });
});
