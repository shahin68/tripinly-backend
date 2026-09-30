import type { OsmType, PlaceCategory } from '../../generated/prisma/client';
import { normalizePlaceName } from '../places/normalize-name';
import { representativePoint, type Geometry } from './geometry';

/**
 * Tag filter handed to `osmium tags-filter`. Keep in sync with CATEGORY_RULES
 * and docs/knowledge/10-maps-places-routing.md.
 */
export const OSMIUM_TAG_FILTERS = [
  'nwr/amenity=cafe,restaurant,fast_food,food_court,bar,pub,biergarten,ice_cream,place_of_worship',
  'nwr/tourism=attraction,artwork,viewpoint,zoo,theme_park,aquarium,museum,gallery',
  'nwr/historic',
  'nwr/leisure=park,garden,nature_reserve',
  'nwr/natural=peak,beach,waterfall',
];

type Tags = Record<string, string>;

interface CategoryRule {
  key: string;
  /** `null` matches any value. */
  values: readonly string[] | null;
  category: PlaceCategory;
  when?: (tags: Tags) => boolean;
}

/** First match wins, in the order of the mapping table in 10-maps-places-routing.md. */
export const CATEGORY_RULES: readonly CategoryRule[] = [
  { key: 'amenity', values: ['cafe', 'ice_cream'], category: 'cafe' },
  {
    key: 'amenity',
    values: ['restaurant', 'fast_food', 'food_court'],
    category: 'restaurant',
  },
  { key: 'amenity', values: ['bar', 'pub', 'biergarten'], category: 'bar' },
  {
    key: 'tourism',
    values: [
      'attraction',
      'artwork',
      'viewpoint',
      'zoo',
      'theme_park',
      'aquarium',
    ],
    category: 'attraction',
  },
  { key: 'tourism', values: ['museum', 'gallery'], category: 'museum' },
  { key: 'historic', values: null, category: 'historic' },
  {
    key: 'leisure',
    values: ['park', 'garden', 'nature_reserve'],
    category: 'park',
  },
  {
    key: 'natural',
    values: ['peak', 'beach', 'waterfall'],
    category: 'nature',
  },
  {
    key: 'amenity',
    values: ['place_of_worship'],
    category: 'landmark',
    // Only notable places of worship; every village chapel would flood the map.
    when: (tags) => Boolean(tags.tourism || tags.historic || tags.wikidata),
  },
];

export function categoryFor(tags: Tags): PlaceCategory | null {
  for (const rule of CATEGORY_RULES) {
    const value = tags[rule.key];
    if (value === undefined || value === 'no') continue;
    if (rule.values && !rule.values.includes(value)) continue;
    if (rule.when && !rule.when(tags)) continue;
    return rule.category;
  }
  return null;
}

/** Tags kept on the place; everything else (phone, addresses, notes) is dropped. */
const KEPT_TAGS = ['website', 'opening_hours', 'cuisine', 'wikidata'] as const;
/** `name:de`, `name:en`, `name:zh-Hant`, but not `name:etymology` or `name:left`. */
const LOCALIZED_NAME = /^name:[a-z]{2,3}(-[A-Za-z]{2,8})?$/;
const MAX_NAME_LENGTH = 200;
const MAX_SEARCH_TEXT_LENGTH = 1000;

export interface StagedPlace {
  osmType: OsmType;
  osmId: bigint;
  name: string;
  normalizedName: string;
  searchText: string;
  names: Record<string, string>;
  category: PlaceCategory;
  tags: Record<string, string>;
  lat: number;
  lng: number;
}

interface Feature {
  id?: unknown;
  geometry?: Geometry | null;
  properties?: Record<string, unknown> | null;
}

/**
 * Feature ids from `osmium export --add-unique-id=type_id`: `n<id>` nodes,
 * `w<id>` ways as lines, and `a<id>` areas, where an area id is `2 × way id`
 * or `2 × relation id + 1`.
 */
export function parseFeatureId(
  id: unknown,
): { osmType: OsmType; osmId: bigint } | null {
  if (typeof id !== 'string') return null;
  const match = /^([nwa])(\d+)$/.exec(id);
  if (!match) return null;
  const numeric = BigInt(match[2]);
  switch (match[1]) {
    case 'n':
      return { osmType: 'node', osmId: numeric };
    case 'w':
      return { osmType: 'way', osmId: numeric };
    default:
      return numeric % 2n === 0n
        ? { osmType: 'way', osmId: numeric / 2n }
        : { osmType: 'relation', osmId: (numeric - 1n) / 2n };
  }
}

/** One exported feature → a place row, or null when we don't import it. */
export function transformFeature(feature: Feature): StagedPlace | null {
  const ids = parseFeatureId(feature.id);
  if (!ids || !feature.geometry || !feature.properties) return null;

  const tags: Tags = {};
  for (const [key, value] of Object.entries(feature.properties)) {
    if (typeof value === 'string') tags[key] = value.trim();
  }
  const name = tags.name?.slice(0, MAX_NAME_LENGTH);
  if (!name) return null;
  const category = categoryFor(tags);
  if (!category) return null;
  const point = representativePoint(feature.geometry);
  if (!point) return null;

  const names: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (LOCALIZED_NAME.test(key) && value) {
      names[key] = value.slice(0, MAX_NAME_LENGTH);
    }
  }
  const kept: Record<string, string> = {};
  for (const key of KEPT_TAGS) {
    if (tags[key]) kept[key] = tags[key];
  }

  const normalizedName = normalizePlaceName(name);
  const variants = new Set([normalizedName]);
  for (const value of Object.values(names)) {
    variants.add(normalizePlaceName(value));
  }

  return {
    ...ids,
    name,
    normalizedName,
    searchText: [...variants].join(' ').slice(0, MAX_SEARCH_TEXT_LENGTH),
    names,
    category,
    tags: kept,
    lat: point.lat,
    lng: point.lng,
  };
}
