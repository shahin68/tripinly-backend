# Tripinly — Decision Log

Append-only. Newest at the bottom. Format: date · decision · why · who decided.

| Date | Decision | Why | By |
|---|---|---|---|
| 2026-09-24 | Backend stack: NestJS + PostgreSQL/PostGIS + Prisma + Redis + Socket.IO, hosted on Railway | Small project, strong TypeScript ecosystem, geo queries | Product owner + agent |
| 2026-09-24 | REST + JSON, `/v1`, OpenAPI for KMP client generation | Client team generates API layer | Product owner |
| 2026-09-24 | Sign-in only with Google and Apple; JWT access + rotating refresh tokens | Product requirement | Product owner |
| 2026-09-24 | Minimum age 16 | Safe single EU threshold | Product owner |
| 2026-09-24 | Map data from Google Maps / OSM on the client; no external attraction feeds; Nearby and Popular spots use only Tripinly data ranked by likes | Product requirement, cost | Product owner |
| 2026-09-24 | "Add to my trips" creates an independent, editable copy owned by the copier; no photos/comments copied; "Copied from @handle" while source exists | Copies must survive the author's account deletion | Product owner |
| 2026-09-24 | Account deletion deletes everything the user created, including owned trips shared with collaborators; copies made by others survive | Product requirement | Product owner |
| 2026-09-24 | Multiple photos per marker, one user-chosen cover shown in the pin; gallery is scrollable | Product requirement (design prototype shows only one) | Product owner |
| 2026-09-24 | People find each other by username handle search and invite links; no follow system in v1 | Keep v1 small | Product owner |
| 2026-09-24 | Best route: straight-line ordering free; real travel times paid | Routing APIs cost money | Product owner |
| 2026-09-24 | Push: comments on your markers, added to trip, collaborator changes (batched), likes (grouped). Email only for export and deletion | Product requirement | Product owner |
| 2026-09-24 | Reporting and blocking with admin review in v1 | App Store / Google Play UGC requirements | Product owner |
| 2026-09-24 | Content localized; i18n for push, email and API errors | Product requirement | Product owner |
| 2026-09-24 | Photos stored in a private R2 bucket, served via signed URLs; EXIF stripped | Privacy (visibility changes, GPS in photos) | Agent (engineering) |
| 2026-09-24 | Defaults set by agent, changeable: invite links valid 7 days; usernames held 30 days after deletion; 30 photos/marker, 15 MB each; comments flat, markers only; place matching within ~30 m | Needed concrete values to build | Agent — confirm with product owner |
| 2026-09-27 | Client draws the map with the Google Maps SDK (free on mobile) with Google POI icons hidden; backend never stores Google data | Product owner knows Google Maps; MapLibre Compose not stable yet; Google terms forbid storing Places data | Product owner + agent |
| 2026-09-27 | Places come from our own DB: user-created places + OpenStreetMap POIs imported monthly (default launch region Austria + Hungary) | Free, storable (ODbL with attribution), map never empty | Product owner + agent |
| 2026-09-27 | Search: our places + Photon for addresses/cities, proxied by the backend | Free, storable | Agent, accepted by product owner |
| 2026-09-27 | Routing via openrouteservice; route lines and along-the-way places free for everyone; premium best route uses ORS matrix + own ordering | Low cost; Google Routes would cost ~10× | Product owner + agent |
| 2026-09-27 | New feature: places along a route (attractions, cafés, restaurants) via PostGIS buffer query on the route line | Product requirement | Product owner |
