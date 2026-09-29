# Tripinly — Open Questions

Ask the product owner before building anything that depends on these. When one is answered, move the answer into the relevant knowledge file, add it to `08-decision-log.md`, and delete it here.

## Blocking a feature

None right now.

## Needs a decision, has a working default

1. **Launch region for the OSM import.** Default: Austria + Hungary.
2. **Comments on trips and photos,** or markers only? Default: markers only.
3. **Comment replies (threads)?** Default: flat list.
4. **What does the "Activity" screen show?** Default: the in-app notification list.
5. **Can editors invite other people?** Default: owner only.
6. **Viewer role** (see a private trip without editing)? Default: no.
7. **Explore ranking filters** (region, season, length)? Default: none in v1.
8. **Moderation auto-hide threshold?** Default: no auto-hide.
9. **Share links:** deep links only, or a public web preview page? Default: deep links with minimal preview JSON.
10. **Limits:** 30 photos per marker, 15 MB each; markers per day, days per trip, trips per user — confirm.
11. **Supported languages at launch.** Default: English, German, Hungarian.
12. **Days and dates:** Default: a day shows a date when the trip has a start date, otherwise "Day n".
13. **Transit routing.** ORS has no public transport. Default: walking, cycling, driving only.
14. **Place categories shown on the map** and their default filter. Default: all categories in `10-maps-places-routing.md`; attractions/museums/historic prioritized.
