---
name: osm-import
description: Use when importing or refreshing OpenStreetMap POIs (cafés, restaurants, attractions, museums, historic sites, parks) from Geofabrik extracts into the Tripinly places table, or changing which categories are imported.
---

# OSM POI import

Category mapping and legal rules are in `docs/knowledge/10-maps-places-routing.md`. Keep them in sync.

## Source

- Geofabrik country extracts (`https://download.geofabrik.de/<region>-latest.osm.pbf`), regions from `OSM_IMPORT_REGIONS` (default `europe/austria,europe/hungary`).
- Download over HTTPS in the worker, verify the `.md5`, record the extract timestamp.
- Never use Overpass or Nominatim for bulk import.

## Pipeline (BullMQ job `osm.import`, one run per region, monthly schedule + manual trigger)

1. **Download** the `.pbf` to a temp volume.
2. **Filter** with osmium-tool to the tags we import, e.g.
   `osmium tags-filter in.pbf nwr/amenity=cafe,restaurant,fast_food,food_court,bar,pub,biergarten,ice_cream,place_of_worship nwr/tourism=attraction,artwork,viewpoint,zoo,theme_park,aquarium,museum,gallery nwr/historic nwr/leisure=park,garden,nature_reserve nwr/natural=peak,beach,waterfall -o poi.pbf`
3. **Export** to GeoJSON sequence: `osmium export poi.pbf -f geojsonseq --add-unique-id=type_id` (areas become polygons).
4. **Transform** in a streaming Node script: keep only features with `name`; compute a point (node → itself; area → `ST_PointOnSurface` later or centroid in script); map tags → `category` (first match wins in the priority order of the mapping table); collect `name:*` into `names`; keep a small `tags` subset (website, opening_hours, cuisine, wikidata); drop `place_of_worship` unless it has `tourism`, `historic` or `wikidata`.
5. **Load** with `COPY` into `places_import_staging` (unlogged table).
6. **Upsert** into `places` in batches of 10k by (`osmType`, `osmId`): update name/names/category/location/tags/`importedAt`, set `isActive = true`. Never touch `popularity`, `source = 'user'` rows, or rows' IDs.
7. **Deactivate** OSM places of this region not seen in this run (`isActive = false`). Never delete — markers may reference them. (Track region per row or use the region's bounding polygon.)
8. Record an `osm_import_runs` row with counts; alert (log error) if inserted+updated drops more than 20% vs the previous run — abort step 7 in that case.
9. `ANALYZE places;` and clear in-view caches.

## Notes

- Idempotent: rerunning the same extract changes nothing.
- Run in the worker only; needs a temp disk of a few GB per region. Don't import large regions (all of Europe) without checking Railway disk/memory first and telling the product owner.
- Localized names (`name:de`, `name:hu`, `name:en`) matter — keep them.
- Attribution "© OpenStreetMap contributors" must stay in API responses and the app.

## Tests

Tag → category mapping table test, unnamed features skipped, area → point, upsert idempotency, deactivation with safety threshold, user places untouched, popularity untouched.
