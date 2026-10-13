# How Tripinly's places database is made

Tripinly's map shows places from OpenStreetMap, © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0). Tripinly adds a popularity rank to them, which makes its places table a Derivative Database under the ODbL. As section 4.6(b) of the licence allows, this page describes the method we use to make it from the original data, so anyone can make the same database.

## Sources

- **OpenStreetMap:** the country extracts for Austria and Hungary from Geofabrik (`https://download.geofabrik.de/europe/austria-latest.osm.pbf`, `…/hungary-latest.osm.pbf`), refreshed monthly.
- **QRank:** `https://qrank.toolforge.org/download/qrank.csv.gz`. It ranks Wikidata items by Wikimedia page views over 52 weeks. It is released under CC0.

## Steps

1. **Filter** each extract with osmium-tool to these tags: `amenity=cafe,restaurant,fast_food,food_court,bar,pub,biergarten,ice_cream,place_of_worship`, `tourism=attraction,artwork,viewpoint,zoo,theme_park,aquarium,museum,gallery`, `historic=*`, `leisure=park,garden,nature_reserve`, `natural=peak,beach,waterfall`.
2. **Export** to GeoJSON with `osmium export -f geojsonseq --add-unique-id=type_id`.
3. **Keep** named features only. Use a node's position, or for a way or area a point on its surface.
4. **Map tags to a category**, first match wins:
   - `amenity=cafe|ice_cream` → cafe
   - `amenity=restaurant|fast_food|food_court` → restaurant
   - `amenity=bar|pub|biergarten` → bar
   - `tourism=attraction|artwork|viewpoint|zoo|theme_park|aquarium` → attraction
   - `tourism=museum|gallery` → museum
   - `historic=*` → historic
   - `leisure=park|garden|nature_reserve` → park
   - `natural=peak|beach|waterfall` → nature
   - `amenity=place_of_worship` with `tourism`, `historic` or `wikidata` → landmark
5. **Keep** the name, the `name:<lang>` variants and the tags `website`, `opening_hours`, `cuisine`, `wikidata`, `wikipedia`, `wikimedia_commons` and `image`.
6. **Rank** each place: prominence = round(100 × max(Pq, Pt)), from 0 to 100.
   - Pq = min(1, log10(1 + QRank) / 6), using the QRank of the place's `wikidata` item. With several items, the highest rank counts. Without one, Pq is 0.
   - Pt comes from the OSM tags and is at most 0.5. It adds up:
     - `heritage=1`: 0.4
     - a `wikipedia` tag: 0.2
     - `tourism=attraction`: 0.1
     - `historic=castle|palace|monastery|cathedral` or `building=cathedral`: 0.2
     - each `name:<lang>`: 0.02, up to 0.1
   - Pt is 0 for `historic=wayside_shrine|wayside_cross|boundary_stone|milestone|stolperstein` and for `memorial=stolperstein|plaque`.

The map lists places within a view by category (sights, then parks, then food and drink), and by prominence within each. Below zoom 14 it lists only places with prominence 60 or more.

Places that Tripinly users like on public trips rank by those likes as well. Likes are user activity, not part of the derived data.
