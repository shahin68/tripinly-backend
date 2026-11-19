import type { SearchResultDto } from './places.dto';
import {
  hasHouseNumber,
  mergeSearchResults,
  photonScore,
  searchWords,
} from './search-ranking';

const result = (
  name: string,
  type: string | null,
  extra: Partial<SearchResultDto> = {},
): SearchResultDto => ({
  source: 'photon',
  id: null,
  name,
  category: null,
  location: { lat: 48.2083, lng: 16.3725 },
  isTripinly: false,
  hotCount: 0,
  prominence: 0,
  type,
  address: null,
  osmType: null,
  osmId: null,
  ...extra,
});

describe('search ranking', () => {
  it('splits names into plain words', () => {
    expect(searchWords("  St. Stephan's-Dom ")).toBe('st stephan s dom');
    expect(searchWords('Szépművészeti Múzeum')).toBe('szepmuveszeti muzeum');
  });

  it('sees a house number only as its own word', () => {
    expect(hasHouseNumber('Graben 12')).toBe(true);
    expect(hasHouseNumber('12 Main Street')).toBe(true);
    expect(hasHouseNumber('Mariahilfer Str 3a')).toBe(true);
    expect(hasHouseNumber('Stephansdom')).toBe(false);
    expect(hasHouseNumber('U2 Station')).toBe(false);
  });

  it('lifts an area only when its name matches', () => {
    const city = result('Wien', 'city');
    const street = result('Wiener Straße', 'street');
    expect(photonScore(city, 'wien', undefined)).toBeGreaterThan(
      photonScore(street, 'wien', undefined),
    );
    expect(photonScore(city, 'museum of art', undefined)).toBeLessThan(0.75);
  });

  it('puts addresses first for a house number', () => {
    const house = result('Graben 12', 'house');
    expect(photonScore(house, 'graben 12', undefined)).toBeGreaterThan(2);
    expect(photonScore(house, 'graben', undefined)).toBe(1);
  });

  it('adds a gentle nearness', () => {
    const near = { lat: 48.2083, lng: 16.3725 };
    const far = { lat: 47.0707, lng: 15.4395 };
    const street = result('Herrengasse', 'street');
    expect(photonScore(street, 'herreng', near)).toBeCloseTo(1.1 + 0.3);
    expect(photonScore(street, 'herreng', far)).toBeLessThan(1.12);
  });

  it('merges by score, ours first on ties, without Photon copies, capped', () => {
    const ours = [
      {
        item: result('A', null, {
          source: 'place',
          osmType: 'node',
          osmId: '1',
        }),
        score: 1,
      },
      { item: result('B', null, { source: 'place' }), score: 0.5 },
    ];
    const photon = [
      {
        item: result('A copy', 'other', { osmType: 'node', osmId: '1' }),
        score: 5,
      },
      { item: result('C', 'city'), score: 1 },
      { item: result('D', 'street'), score: 0.7 },
    ];
    expect(
      mergeSearchResults(ours, photon, 3).map((item) => item.name),
    ).toEqual(['A', 'C', 'D']);
  });
});
