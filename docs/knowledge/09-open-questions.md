# Tripinly — Open Questions

Ask the product owner before building anything that depends on these. When one is answered, move the answer into the relevant knowledge file, add it to `08-decision-log.md`, and delete it here.

## Blocking a feature

1. **How premium is bought and verified.** App Store / Google Play in-app purchases are required for digital features. Recommended: **RevenueCat** (free up to $2.5k monthly revenue, then 1%) with its webhook feeding the `entitlements` table; monthly + yearly subscription; Apple Small Business Program. Not yet confirmed. *Blocks:* `billing` module, premium best route going live (build it behind `EntitlementService` with a stub until then).
2. **Proof-of-consent retention after account deletion.** Proposed: minimal pseudonymous record for 5 years (Hungarian general limitation period). Needs legal confirmation. *Blocks:* final deletion step 8.

## Needs a decision, has a working default

3. **Launch region for the OSM import.** Default: Austria + Hungary.
4. **Can users change their username?** Default: yes, once every 30 days, old handle held 30 days.
5. **Comments on trips and photos,** or markers only? Default: markers only.
6. **Comment replies (threads)?** Default: flat list.
7. **What does the "Activity" screen show?** Default: the in-app notification list.
8. **Can editors invite other people?** Default: owner only.
9. **Viewer role** (see a private trip without editing)? Default: no.
10. **Explore ranking filters** (region, season, length)? Default: none in v1.
11. **Moderation auto-hide threshold?** Default: no auto-hide.
12. **Share links:** deep links only, or a public web preview page? Default: deep links with minimal preview JSON.
13. **Limits:** 30 photos per marker, 15 MB each; markers per day, days per trip, trips per user — confirm.
14. **Supported languages at launch.** Default: English, German, Hungarian.
15. **Days and dates:** Default: a day shows a date when the trip has a start date, otherwise "Day n".
16. **Transit routing.** ORS has no public transport. Default: walking, cycling, driving only.
17. **Place categories shown on the map** and their default filter. Default: all categories in `10-maps-places-routing.md`; attractions/museums/historic prioritized.
