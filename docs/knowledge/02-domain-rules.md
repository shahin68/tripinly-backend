# Tripinly — Domain Rules

These rules are product decisions. Implement them exactly; ask the user before changing any of them.

## Users and onboarding

- Sign-in only via **Google** or **Apple**. One user can link both.
- Required profile: **display name**, **username**, **birth date**.
- **Minimum age: 16.** Compute age from birth date at signup; reject under-16 with error code `AGE_REQUIREMENT_NOT_MET` and do not create the user (discard the birth date).
- Until profile and required consents are complete, the user can only call onboarding endpoints (`/auth/*`, `/me` profile completion, `/me/consents`, `/legal/*`). Everything else returns `ONBOARDING_INCOMPLETE`.

## Usernames

- 3–30 chars, lowercase `a-z`, `0-9`, `.` and `_`; cannot start/end with `.`; no consecutive `..`.
- Unique, case-insensitive. Stored lowercase.
- Reserved list (e.g. `admin`, `tripinly`, `support`, `api`, `help`) cannot be taken.
- Searchable by prefix; search results exclude users who blocked you or whom you blocked.
- A freed username (account deleted) is held for 30 days before reuse.
- Users may change their username once every 30 days after onboarding; the old handle is held for 30 days so nobody can impersonate them right away.

## Consent

- Required before use: **Terms of Service** and **Privacy Policy** (processing necessary for the service).
- Optional, separately recorded: marketing email (not used in v1, but model it).
- Every consent row stores document type, **version**, granted/withdrawn timestamps and locale shown.
- When a required document's version changes, affected users get `CONSENT_REQUIRED` until they accept the new version.

## Trips and visibility

- A trip has one **owner**, optional **editors** (collaborators), title, start/end dates, ordered **days**, and **visibility**: `public` or `private`. There is no viewer role.
- Days: with a start date, a trip has one day per date and each day shows its date; without dates, days show "Day n". A trip always has at least one day.
- Limits: 20 days per trip, 50 markers per day, 200 owned trips per user, 50 members per trip, 20 active invite links per trip (`LIMIT_REACHED`).
- New trips default to the user's `defaultTripVisibility` setting.
- **Public:** visible to anyone (not blocked), listed in Explore, its markers count toward place popularity, copyable.
- **Private:** visible only to owner and editors. Never in Explore, search, Nearby, Popular spots or popularity counts. Not copyable. Share links to private trips only work for members.
- Only the owner can change visibility, rename, delete the trip, and manage members. Editors can add/edit/delete/reorder markers and days, upload and remove photos, and set covers.
- Switching public → private removes the trip's markers from popularity aggregates (recompute).

## Collaboration and invites

- Owners add editors by **username** or by an **invite link**. Only the owner can invite.
- Invite links: random token, tied to one trip, expire after 7 days, revocable by the owner, can be used multiple times until expiry. Accepting requires being signed in and onboarded.
- Blocked users cannot be added and cannot accept invites to the blocker's trips.
- An editor can leave a trip. Removing an editor keeps the markers and photos they added (they belong to the trip), but see account deletion below.

## Markers, places and photos

- Markers belong to a trip day, have a name, a location (lat/lng), optional time, and a position for ordering.
- Each marker is linked to a **place**. The client sends either a `placeId` (a place from our in-view/search/along-the-way results) or a name + location (custom pin, or a Photon address/city result with optional OSM ids). Matching for the latter: OSM ids → existing place; else an existing place within ~30 m with a normalized-equal name; else create a `user` place. **Google place IDs are never accepted.**
- A marker can have **many photos** in an order. One of them can be the **cover**; the cover is the thumbnail in the map pin. If the cover is deleted, the next photo in order becomes the cover; no photos → no cover.
- Limits (defaults, configurable): 30 photos per marker, 15 MB per original, JPEG/PNG/WebP. The app converts HEIC (iPhone) photos to JPEG before uploading; the server cannot decode HEIC.
- Viewers see ready photos only; trip members also see photos still processing or failed. Photos uploaded by someone with a block with the viewer are left out, and a cover they uploaded is not shown.
- An uploader can delete their photo even after leaving the trip.

## Likes and popularity

- One like per user per target (trip, marker, photo, comment). Liking twice is idempotent.
- **Place popularity** = number of likes on **public** markers linked to that place (plus direct likes on the place from the place sheets). A place with popularity > 0 is a "Tripinly place"; OSM places with popularity 0 are background suggestions. Blocked relationships don't change global counts but blocked users' content is hidden from the viewer.
- Explore ranks public trips by likes and copies, with recency decay.

## Comments

- On markers only in v1. Plain text, 1–1000 chars. Flat list (no threads).
- The comment author and the trip owner can delete a comment.

## Copying ("Add to my trips")

- Only **public** trips/markers can be copied, and not your own.
- A copy is a **new, independent** trip (or marker) owned by the copier: new IDs, title, days, marker names, locations, times, order and place links.
- A copy does **not** include photos, comments, likes, members or the original's visibility (it uses the copier's default visibility).
- The copy stores `copiedFromTripId` / `copiedFromMarkerId`; when the original is deleted, these become `null`. The client shows "Copied from @handle" only while the source exists.
- Copying a popular spot or marker into a trip creates a new marker on the chosen day, linked to the same place.
- Each copy increments the source's `copyCount` (used for ranking and "Saved by N people").

## Blocking and reporting

- Blocking is mutual in effect: neither side sees the other's profile, trips, markers, photos, comments or likes in lists; they can't comment on each other's content, add each other to trips or accept each other's invites. Blocking removes the blocked user from the blocker's trips as editor and vice versa.
- Users can report a user, trip, marker, photo or comment with a reason. Admins review reports and can hide content, dismiss, or suspend a user.

## Account deletion

When a user deletes their account, **everything about them is deleted**:

- Profile, auth identities (revoke Apple tokens), refresh tokens, devices, consents record kept only as required by law (see `07-security-and-gdpr.md`), notifications, blocks, invite links.
- **All trips they own** — including every day, marker, photo and comment in them, **even if other people are editors**.
- **All their photos and comments everywhere**, including in other people's trips, and the stored image files.
- **All their likes** (popularity counts are recomputed).
- Their membership in other people's trips. Markers they added to someone else's trip stay (they belong to that trip) but have `createdBy` set to `null`.
- **Copies other people made** of their trips or markers are **not** deleted — those belong to the copier and contain none of the author's photos or comments. Their `copiedFrom…` link is cleared.
- The username is held for 30 days, then released.

## Premium

- **Best route with real travel times** is a paid feature. Free users get straight-line ordering (nearest-neighbour from the first marker).
- Entitlements are checked server-side through `EntitlementService`. Purchases go through **RevenueCat** (entitlement `tripinly_pro`; products monthly, yearly, lifetime); its webhook keeps the `entitlements` table current. See the `premium-feature` skill.
