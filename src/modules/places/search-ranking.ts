import { haversineMeters } from '../routing/geo';
import type { Bbox } from './bbox';
import { normalizePlaceName } from './normalize-name';
import type { SearchResultDto } from './places.dto';

/**
 * One score for every search result, ours and Photon's, so the list is one
 * order (2026-11-19). How well the name matches comes first, then how well
 * known the place is, then a gentle nearness to the map centre:
 * - text: the name starts with the query 1.0, a word in it starts with the
 *   query 0.75 (Photon found an area or address some other way: 0.3); exactly
 *   the name adds 0.25. A place matches only so: no look-alike names
 *   ("Zara" doesn't find Dr Zarza or Café Zartl; Shahin, 2026-11-20).
 * - known: ours `0.6 × prominence / 100 + 0.15 × ln(1 + hot count)`; Photon's
 *   areas by type (`PHOTON_TYPE_WEIGHT`) times the text score, so an area
 *   only rises when its name matches.
 * - near: `0.3 / (1 + km / 5)`, nothing without a map centre.
 * A query with a house number ("Graben 12") puts addresses and streets first.
 * Places, streets and addresses come from the city the map is in only; cities,
 * regions and countries from anywhere (`keepPhotonResult`).
 * The SQL in `PlacesService.searchOurs` uses the same numbers.
 */
export const SEARCH_WEIGHTS = {
  nameStart: 1,
  wordStart: 0.75,
  photonOther: 0.3,
  exact: 0.25,
  prominence: 0.6,
  hot: 0.15,
  near: 0.3,
  nearMeters: 5000,
  houseNumber: 1,
} as const;

/** Photon's types: areas are well known, streets and houses are not. */
const PHOTON_TYPE_WEIGHT: Record<string, number> = {
  country: 0.8,
  state: 0.7,
  city: 0.8,
  county: 0.4,
  district: 0.4,
  locality: 0.3,
  street: 0.1,
  other: 0.1,
};
const ADDRESS_TYPES = new Set(['house', 'street']);
/** Photon's areas: found anywhere, so the map can go to another city. */
const AREA_TYPES = new Set([
  'country',
  'state',
  'county',
  'city',
  'district',
  'locality',
]);

/** Punctuation that splits words, the same set as `SQL_WORD_SEPARATORS`. */
const WORD_SEPARATORS = /[-\s'’.,/&()+:;!?"]+/g;
/** Postgres regex for `WORD_SEPARATORS`. */
export const SQL_WORD_SEPARATORS = `[-[:space:]'’.,/&()+:;!?"]+`;

/** Lower case, no accents, punctuation as single spaces: "St. Stephan's" → "st stephan s". */
export function searchWords(text: string): string {
  return normalizePlaceName(text).replace(WORD_SEPARATORS, ' ').trim();
}

/** "Graben 12", "12 Main St", "Mariahilfer Str. 3a". */
export function hasHouseNumber(query: string): boolean {
  return /(^|\s)\d+[a-z]?(\s|$)/i.test(query.trim());
}

/** How a Photon result's name matches the query (it has no prominence or hot count). */
function photonText(words: string, name: string): number {
  const candidate = searchWords(name);
  if (!words) return SEARCH_WEIGHTS.photonOther;
  if (candidate === words)
    return SEARCH_WEIGHTS.nameStart + SEARCH_WEIGHTS.exact;
  if (candidate.startsWith(words)) return SEARCH_WEIGHTS.nameStart;
  if (` ${candidate}`.includes(` ${words}`)) return SEARCH_WEIGHTS.wordStart;
  return SEARCH_WEIGHTS.photonOther;
}

/** The query's words start the name or a word in it ("zara" in "Zara Home", not in "Zarza"). */
export function wordsMatch(words: string, name: string): boolean {
  return Boolean(words) && ` ${searchWords(name)}`.includes(` ${words}`);
}

export function inBox(
  location: { lat: number; lng: number },
  box: Bbox,
): boolean {
  return (
    location.lat >= box.minLat &&
    location.lat <= box.maxLat &&
    location.lng >= box.minLng &&
    location.lng <= box.maxLng
  );
}

/**
 * A Photon result stays when it's an area (anywhere), or lies in the map's
 * `city` (when known) and is an address or a place whose name matches.
 */
/** A city, region or country: kept from anywhere. */
export function isArea(result: SearchResultDto): boolean {
  return AREA_TYPES.has(result.type ?? '');
}

export function keepPhotonResult(
  result: SearchResultDto,
  query: string,
  city: Bbox | null,
): boolean {
  const type = result.type ?? '';
  if (isArea(result)) return true;
  if (city && !inBox(result.location, city)) return false;
  return ADDRESS_TYPES.has(type) || wordsMatch(searchWords(query), result.name);
}

export function nearScore(
  near: { lat: number; lng: number } | undefined,
  location: { lat: number; lng: number },
): number {
  if (!near) return 0;
  return (
    SEARCH_WEIGHTS.near /
    (1 + haversineMeters(near, location) / SEARCH_WEIGHTS.nearMeters)
  );
}

export function photonScore(
  result: SearchResultDto,
  query: string,
  near: { lat: number; lng: number } | undefined,
): number {
  const text = photonText(searchWords(query), result.name);
  const known = (PHOTON_TYPE_WEIGHT[result.type ?? ''] ?? 0) * text;
  const address =
    hasHouseNumber(query) && ADDRESS_TYPES.has(result.type ?? '')
      ? SEARCH_WEIGHTS.houseNumber
      : 0;
  return text + known + address + nearScore(near, result.location);
}

export interface Scored {
  item: SearchResultDto;
  score: number;
}

/**
 * Ours and Photon's in one order, best score first (ours first on a tie),
 * without Photon's copies of our places, at most `limit`.
 */
export function mergeSearchResults(
  ours: Scored[],
  photon: Scored[],
  limit: number,
): SearchResultDto[] {
  const known = new Set(
    ours
      .filter(({ item }) => item.osmType)
      .map(({ item }) => `${item.osmType}:${item.osmId}`),
  );
  const extra = photon.filter(
    ({ item }) => !item.osmType || !known.has(`${item.osmType}:${item.osmId}`),
  );
  return [...ours, ...extra]
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => item);
}
