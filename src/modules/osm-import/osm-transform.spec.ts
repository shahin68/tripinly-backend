import {
  categoryFor,
  imageTagsHash,
  parseFeatureId,
  tagProminence,
  transformFeature,
  wikidataIds,
} from './osm-transform';

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
      tagProminence: 2,
      wikidataIds: [],
      imageTagsHash: null,
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

describe('tagProminence', () => {
  it.each([
    [{ heritage: '1', wikipedia: 'de:Schönbrunn', historic: 'palace' }, 0.5],
    [{ tourism: 'attraction', wikipedia: 'en:Prater' }, 0.3],
    [{ historic: 'castle' }, 0.2],
    // A Wikidata entry alone isn't fame: every listed monument has one.
    [{ historic: 'monument', wikidata: 'Q1' }, 0],
    [{ historic: 'wayside_shrine', wikipedia: 'de:Marterl' }, 0],
    [{ historic: 'memorial', memorial: 'stolperstein' }, 0],
  ])('rates %j as %d', (tags, score) => {
    expect(tagProminence(tags, {})).toBeCloseTo(score);
  });

  it('counts names in other languages a little, up to 0.1', () => {
    const names = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`name:l${i}`, 'x']),
      );
    expect(tagProminence({}, names(2))).toBeCloseTo(0.04);
    expect(tagProminence({}, names(9))).toBeCloseTo(0.1);
  });
});

describe('wikidataIds', () => {
  it('reads one item or several, skipping anything else', () => {
    expect(wikidataIds('Q167679')).toEqual(['Q167679']);
    expect(wikidataIds('Q1; Q2')).toEqual(['Q1', 'Q2']);
    expect(wikidataIds('foo;Q0;Q7')).toEqual(['Q7']);
    expect(wikidataIds(undefined)).toEqual([]);
  });
});

describe('imageTagsHash', () => {
  it('changes with any image tag and is null without them', () => {
    const base = imageTagsHash({ wikidata: 'Q1' });
    expect(base).toEqual(expect.any(String));
    expect(imageTagsHash({ wikidata: 'Q1', website: 'x' })).toBe(base);
    expect(imageTagsHash({ wikidata: 'Q1', image: 'File:A.jpg' })).not.toBe(
      base,
    );
    expect(imageTagsHash({ website: 'x' })).toBeNull();
  });
});
