# Tripinly — Product Brief

Tripinly is a social travel-planning app. People plan trips day by day as markers on a map, attach photos and comments to places, travel together with friends, and discover popular places through what other travellers liked.

- **Clients:** Kotlin Multiplatform apps for iOS and Android, already partly built (Google Maps, Home with My Trips, Social, trip creation). The client draws the map with the **Google Maps SDK** (Google POI icons hidden); **all places, search results and routes come from the backend**, which uses OpenStreetMap data, Photon and openrouteservice. See `10-maps-places-routing.md`.
- **Scale:** small project to start. Design for correctness and simplicity; avoid premature distribution.
- **Region:** EU first. GDPR applies. Content is localized.
- **Design reference:** the "Wayspot App v3" prototype. It shows the screens but is **not** authoritative where this brief differs (copying trips, multiple photos per marker).

## Screens and what the backend must support

| Screen | Backend needs |
|---|---|
| Sign-in | Google / Apple sign-in, token issuing |
| Onboarding | Profile (name, username, birth date), age check (16+), consent capture |
| Your trips | Trips the user owns or collaborates on, including copies they made |
| Trip map | Days, markers (optional time, order), cover photo inside markers, popular spots near the trip, privacy toggle, collaborators, add day, add marker, best route |
| Marker sheet | Photo gallery (scrollable, one cover), likes on marker and photos, comments with likes, share, delete |
| Explore | Public trips from others, ranked by popularity; like; "Add to my trips" (copy) |
| Nearby | Popular places around the user's current location, from Tripinly's own data ranked by likes |
| Popular spot sheet | Place details, like, add to a trip/day |
| New trip | Name, length/dates, public/private, invite friends |
| Travel together | Add/remove collaborators by username search or invite link |
| Profile / Me | Stats, default privacy for new trips, notifications, activity, delete account |
| Delete account | Explain what is deleted and what survives (copies others made), confirm |

## Core features

1. **Sign up** with Google or Apple. Create a simple profile: display name, unique **username handle** (Instagram-style, searchable), birth date. Users must be **16 or older**.
2. **Consent** to data processing before using the app; consents are versioned.
3. **Trips** with a title, dates, days, and visibility (public by default unless the user's default is private).
4. **Markers** per day: a place on the map with a name, optional time and position in the day's order.
5. **Photos** on markers: several per marker; the user picks **one cover** shown as the thumbnail inside the map pin. Markers without photos show as plain numbered pins. Viewers scroll through all photos.
6. **Comments** on markers.
7. **Likes** on trips, markers, photos and comments.
8. **Public discovery:** public trips appear in Explore; public markers feed place popularity.
9. **Popular spots** on the trip map: unselected markers for the most-liked places in the visible area that aren't already in the trip.
10. **Nearby:** popular places around the user, based on Tripinly data and likes, topped up with OSM attractions where Tripinly data is thin.
10a. **Map browsing:** as the user pans/zooms, places in view appear: Tripinly places (liked by users) prominently, plus cafés, restaurants, attractions etc. from OpenStreetMap as smaller dots when zoomed in, so the map is never empty.
10b. **Routes and places along the way:** a route between two points or through a day's markers is drawn on the map, with attractions, cafés and restaurants along the way suggested.
10c. **Search:** a search box finds places (ours + OSM POIs) and addresses/cities.
11. **Collaboration:** owners add people to a trip; collaborators can edit markers and photos.
12. **Finding people:** by **username search** and **invite links**. No follow system in v1.
13. **Add to my trips:** a single button that copies someone else's public trip (or a single marker / popular spot) into an **independent copy owned by the copier**, fully editable, as if they made it. Shows "Copied from @handle" while the original author's account exists.
14. **Best route:** reorders a day's markers. **Free:** straight-line ordering. **Paid:** real travel times via a routing provider.
15. **Sharing:** links to a trip or marker.
16. **Reporting and blocking** of content and users, with admin review (required by App Store and Google Play for user-generated content).
17. **Account deletion** and **data export** (GDPR).

## Real time

Uploads, comments, likes and trip edits by collaborators appear live for everyone viewing the trip.

## Notifications

- **Push (FCM):** comments on your markers, being added to a trip, collaborator changes to your trips, grouped likes (never one push per like).
- **Email:** account matters only — data export ready, account deletion confirmation.

## Out of scope for now

Bookings, flights, hotels, Google Places / any Google data on the backend, public transit routing, a follow system, direct messages, a web app.
