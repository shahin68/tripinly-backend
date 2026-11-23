import type { ExplorePeriod } from '../discovery/explore.dto';
import { PLACE_CATEGORIES } from '../markers/markers.dto';

type PlaceCategoryKey = (typeof PLACE_CATEGORIES)[number];

/**
 * The place kinds the apps show, in display order (spot card, filter chips). `icon` is an ID in the apps' own icon
 * table: an ID never changes meaning and is never reused, so a kind can switch to any icon the apps already have
 * without an app update. 1 is the plain Spot icon, which the apps also show for an ID they don't know.
 * `forSpots`: people can pick it for a spot they make; `forFilters`: offered as a filter chip.
 */
export const PLACE_KINDS: readonly {
  key: PlaceCategoryKey;
  icon: number;
  forSpots: boolean;
  forFilters: boolean;
}[] = [
  { key: 'other', icon: 1, forSpots: true, forFilters: false },
  { key: 'photo_spot', icon: 2, forSpots: true, forFilters: true },
  { key: 'romantic', icon: 3, forSpots: true, forFilters: true },
  { key: 'cafe', icon: 4, forSpots: true, forFilters: true },
  { key: 'restaurant', icon: 5, forSpots: true, forFilters: true },
  { key: 'bar', icon: 6, forSpots: true, forFilters: true },
  { key: 'bakery', icon: 7, forSpots: true, forFilters: true },
  { key: 'fast_food', icon: 8, forSpots: true, forFilters: true },
  { key: 'nightlife', icon: 9, forSpots: true, forFilters: true },
  { key: 'winery', icon: 10, forSpots: true, forFilters: true },
  { key: 'attraction', icon: 11, forSpots: true, forFilters: true },
  { key: 'viewpoint', icon: 12, forSpots: true, forFilters: true },
  { key: 'museum', icon: 13, forSpots: true, forFilters: true },
  { key: 'historic', icon: 14, forSpots: true, forFilters: true },
  { key: 'landmark', icon: 15, forSpots: true, forFilters: true },
  { key: 'zoo', icon: 16, forSpots: true, forFilters: true },
  { key: 'park', icon: 17, forSpots: true, forFilters: true },
  { key: 'nature', icon: 18, forSpots: true, forFilters: true },
  { key: 'beach', icon: 19, forSpots: true, forFilters: true },
  { key: 'entertainment', icon: 20, forSpots: true, forFilters: true },
  { key: 'cinema', icon: 21, forSpots: true, forFilters: true },
  { key: 'sports', icon: 22, forSpots: true, forFilters: true },
  { key: 'spa', icon: 23, forSpots: true, forFilters: true },
  { key: 'kids', icon: 24, forSpots: true, forFilters: true },
  { key: 'library', icon: 25, forSpots: true, forFilters: true },
  { key: 'shopping', icon: 26, forSpots: true, forFilters: true },
  { key: 'market', icon: 27, forSpots: true, forFilters: true },
  { key: 'groceries', icon: 28, forSpots: true, forFilters: true },
  { key: 'stay', icon: 29, forSpots: true, forFilters: true },
  { key: 'camping', icon: 30, forSpots: true, forFilters: true },
  { key: 'transport', icon: 31, forSpots: true, forFilters: true },
  { key: 'rental', icon: 32, forSpots: true, forFilters: true },
  { key: 'fuel', icon: 33, forSpots: true, forFilters: true },
  { key: 'parking', icon: 34, forSpots: true, forFilters: true },
  { key: 'money', icon: 35, forSpots: true, forFilters: true },
  { key: 'health', icon: 36, forSpots: true, forFilters: true },
  { key: 'pharmacy', icon: 37, forSpots: true, forFilters: true },
  { key: 'toilets', icon: 38, forSpots: true, forFilters: true },
];

/** Explore's periods, in menu order; `icon` as in PLACE_KINDS. Near me is the apps' own toggle, combined with any. */
export const EXPLORE_PERIOD_ITEMS: readonly {
  key: ExplorePeriod;
  icon: number;
  isDefault: boolean;
}[] = [
  { key: 'week', icon: 60, isDefault: false },
  { key: 'month', icon: 60, isDefault: true },
  { key: 'year', icon: 60, isDefault: false },
  { key: 'all', icon: 61, isDefault: false },
];
