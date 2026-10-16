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
- A freed username (account deleted) is held for 30 days before reuse. Exception: test accounts deleted through the developer endpoint (`DELETE /auth/dev/accounts`, local and staging only) free their username at once.
- Users may change their username once every 30 days after onboarding; the old handle is held for 30 days so nobody can impersonate them right away.

## Consent

- Required before use: **Terms of Service** and **Privacy Policy** (processing necessary for the service).
- Optional, separately recorded: marketing email (not used in v1, but model it).
- Every consent row stores document type, **version**, granted/withdrawn timestamps and locale shown.
- When a required document's version changes, affected users get `CONSENT_REQUIRED` until they accept the new version.

## Trips and visibility

- A trip has one **owner**, optional **editors** (collaborators), title, start/end dates, ordered **days**, and **visibility**: `public` or `private`. There is no viewer role.
- Days: with a start date, a trip has one day per date and each day shows its date; without dates, days show "Day n". A trip always has at least one day.
- Limits: 20 days per trip, 50 markers per day, 200 owned trips per user, `APP_TRIP_MAX_MEMBERS` members per trip (default 50, set on Railway), 20 active invite links per trip (`LIMIT_REACHED`).
- New trips default to the user's `defaultTripVisibility` setting.
- **Public:** visible to anyone (not blocked), listed in Explore, its markers count toward place popularity; others can save it, ask to join it and copy its markers.
- **Private:** visible only to owner and editors. Never in Explore, search, Nearby, Popular spots or popularity counts. Can't be saved, joined from outside or copied from. Share links to private trips only work for members.
- Only the owner can change visibility, rename, delete the trip, and manage members. Editors can add, edit and reorder markers and days, upload and remove photos, and set covers; deleting a stop follows "Deleting a stop" below.
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

### Place photos (decided 2026-10-16, B1–B3, C7)

- Anyone who can see a place (any active OSM place; a user place in a trip they can see) can add a photo **to the place**, without a trip. It belongs to the place, not to a trip or stop, and stays until its uploader deletes it (nobody else can, apart from moderation), the uploader's account goes, or the user place goes (below).
- Limit: `APP_PLACE_PHOTO_DAILY_LIMIT` place photos per person in 24 hours (default 20, Railway) → `DAILY_PHOTO_LIMIT_REACHED`. Failed uploads don't count.
- The place's gallery lists them most liked first, then newest. People with a block either way **still see each other's place photos**, without the uploader's name; they still can't like them (or anything else of each other's).
- Same pipeline as trip photos (metadata stripped, thumb and display), same likes, reports, moderation, export and account deletion.

### Deleting a stop (decided 2026-10-16, B4–B6)

- A stop's **owner** is whoever added it; the **trip owner** also counts. Only they delete the stop, and with it everything on it: photos, comments and likes, other people's included. When other people's photos, comments or likes are on it, the server answers `STOP_HAS_OTHERS_CONTENT` (409) until the app has shown a warning and repeats with `confirm=true`.
- Anyone else (another editor, a commenter on a public trip) can only **remove their own** photos, comments and likes from it (`DELETE /markers/{id}/mine`); the stop stays.
- Clearing or deleting a day deletes its stops, so it needs the same right for every stop on it (all or nothing) and the same confirmation.
- A **user-made place** used by stops in several trips stays while any stop uses it; with the last stop (deleted, moved to another place, or its trip or day deleted) it goes, with its place photos and likes. OSM places always stay.

## Likes and popularity

- One like per user per target (trip, marker, photo, comment, place). Liking and unliking twice are idempotent. Anyone who can see the target can like it (members, or anyone for a public trip); photos only once ready. Content hidden by moderation or posted by someone with a block with me can't be liked (404).
- A like doesn't count as a change to the trip (`updatedAt` stays), so it doesn't reorder My Trips.
- Deleting a trip, marker, photo or comment deletes its likes (database triggers, including rows removed by cascade).
- **Place popularity** = number of likes on **public** markers linked to that place (plus direct likes on the place from the place sheets). A place with popularity > 0 is a "Tripinly place"; OSM places with popularity 0 are background suggestions. Blocked relationships don't change global counts but blocked users' content is hidden from the viewer.
- **A trip photo may represent a place** (the place's card image `coverThumbUrl` / `coverPhotoId`, and the up to 10 photos on the place detail) only when at least **N distinct people outside its trip** have liked it: the uploader, the trip owner and the trip's members never count. N is `APP_PLACE_PHOTO_MIN_OUTSIDE_LIKES` (Shahin chose 2). So nobody can make their own photo a place's image with their own or their friends-in-the-trip likes. The cover is the qualifying photo with the most outside likes (then total likes, then newest), not the cover of the most liked marker; the detail lists qualifying photos in the same order. Photos must be ready, in a public, unhidden trip with an active owner, on an unhidden marker, and not hidden; photos uploaded by or in trips owned by someone with a block with the viewer are left out. Place `popularity` and like counts don't change with this rule.
- Counters (`likeCount`, `commentCount`, `popularity`) move in the same transaction as the like or comment; a nightly job rebuilds them from source rows.
- Explore ranks public trips by likes and saves (the viewer's own included, with `role: owner`, so the app shows no Save on them; Shahin 2026-10-16), with recency decay: `(likes + 2 × saves) / (age in days + 2)^1.5`. Only trips with at least one marker are listed; owners with a block either way are left out.

## Comments

- On markers only in v1. Plain text, 1–1000 chars. Flat list (no threads).
- Members comment on any trip they're in; anyone can comment on a public trip they can see. Nobody can comment on a marker created by someone they have a block with (403), and comments from people with a block with me are left out of the list.
- The comment author (even after leaving the trip) and the trip owner can delete a comment. Deleting removes it for good.
- 30 new comments per minute per user.

## Saving and joining other people's trips (decided 2026-10-16)

A trip has **one owner forever** and is **never duplicated**. "Add to my trips" has two forms:

- **Save:** the trip appears in my trips marked "by @owner", **read-only**, always the live original (`PUT/DELETE /trips/{id}/save`, idempotent). It is listed only while it is public, not hidden and the owner has no block with me; the save itself is kept, so the trip comes back if it turns public again. When the owner deletes the trip, it is gone for savers too. Saves rank Explore and show as "Saved by N people" (`saveCount`).
- **Join:** I ask the owner to let me edit (`POST /trips/{id}/join-request`). The owner gets a `join_requested` notification and **accepts** (I become an **editor**, a member of the same trip, like an invite; `APP_TRIP_MAX_MEMBERS` applies) or **declines**. A declined request stays declined and can't be sent again; a pending one can be withdrawn. As a member I keep access if the trip later turns private; I can leave, and the owner can remove me. Accepting removes my save of that trip.
- Only for other people's **public** trips: own trips and trips I'm already a member of answer 403 `FORBIDDEN`; private trips I'm not in answer 404. A declined request answers 409 `JOIN_REQUEST_DECLINED`.
- Blocking deletes each side's saves of and join requests to the other's trips; a request from someone who is gone or blocked can't be accepted (404).
- Deleting a trip with joined members shows the owner a warning first (client).

## Copying a marker

- Copying a popular spot or marker into a trip creates a new marker on the chosen day (of a trip I own or edit), linked to the same place, with the source's name, location and time. Hidden markers are not copied. The new marker stores `copiedFromMarkerId` (null once the source is deleted).
- Only markers of **public** trips, and not from my own trip: 403 `TRIP_NOT_COPYABLE`; a private trip I'm not in answers 404.
- Whole trips are never copied (replaced by Save and Join, 2026-10-16).

## Profiles

- `GET /users/{username}` shows a user's public, visible trips, their follower and following counts, and whether the viewer follows them, they follow the viewer, and whether they are friends. Unknown, not onboarded or suspended users, and users with a block either way, answer 404.
- The follower and following counts leave out suspended or deleting users and anyone with a block with the viewer.

## Follows and friends

- Anyone can follow anyone, without approval (one-way). Following yourself is not allowed. Unknown, suspended or deleting users and users with a block either way can't be followed (404, the block is not revealed).
- Two users who follow each other are **friends**. The trip member picker lists friends (`GET /me/friends`); adding a member still works by username for anyone.
- **Following never grants access.** Private trips stay members-only; a follower sees exactly what any other signed-in user sees.
- Blocking removes follows in both directions; unblocking doesn't restore them.
- Lists of friends, following and followers leave out suspended users and anyone with a block with me.
- Account deletion removes the user's follows in both directions; the data export lists who they follow and who follows them.

## Blocking and reporting

- Blocking is mutual in effect: neither side sees the other's profile, trips, markers, photos, comments or likes in lists; they can't comment on each other's content, add each other to trips or accept each other's invites. Blocking removes the blocked user from the blocker's trips as editor and vice versa, and removes follows in both directions.
- Users can report a user, trip, marker, photo, comment or a place's Wikimedia Commons image with a reason; `copyright` is the reason for someone else's photo. Admins review reports and can hide content, dismiss, or suspend a user. A Commons image can only be hidden (it has no Tripinly author).
- **Photo licence:** the Terms of Service grant Tripinly a licence to show a user's public trip photos, including as a place's image once other people like them (rule above); the privacy policy says so. Draft wording for legal review: `docs/legal/photo-licence-clauses.md` (Shahin, 2026-10-15).

## Account deletion

When a user deletes their account, **everything about them is deleted**:

- Profile, auth identities (revoke Apple tokens), refresh tokens, devices, consents record kept only as required by law (see `07-security-and-gdpr.md`), notifications, blocks, follows (both directions), invite links.
- **All trips they own** — including every day, marker, photo and comment in them, **even if other people are editors**.
- **All their photos and comments everywhere**, including in other people's trips, and the stored image files.
- **All their likes** (popularity counts are recomputed).
- Their membership in other people's trips. Markers they added to someone else's trip stay (they belong to that trip) but have `createdBy` set to `null`.
- Their saves and join requests. Other people's saves of and requests to join the user's trips go with those trips.
- **Markers other people copied** from their trips are **not** deleted — those belong to the copier and contain none of the author's photos or comments. Their `copiedFromMarkerId` link is cleared.
- The username is held for 30 days, then released.

## Premium

- **Best route with real travel times** is a paid feature. Free users get straight-line ordering (nearest-neighbour from the first marker).
- Entitlements are checked server-side through `EntitlementService`. Purchases go through **RevenueCat** (entitlement `tripinly_pro`; products monthly, yearly, lifetime); its webhook keeps the `entitlements` table current. See the `premium-feature` skill.
