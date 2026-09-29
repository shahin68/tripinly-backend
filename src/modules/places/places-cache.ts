/** Bumped after each OSM import; part of every in-view cache key, so old entries are skipped. */
export const IN_VIEW_CACHE_VERSION_KEY = 'places:in-view:version';
/** In-view results are cached per rounded bbox, zoom, categories, limit and language. */
export const IN_VIEW_CACHE_TTL_SECONDS = 60;
