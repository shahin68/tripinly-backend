---
name: photo-pipeline
description: Use for Tripinly photo work — pre-signed uploads, upload confirmation, thumbnail/display generation, EXIF stripping, gallery order, cover photo rules and storage cleanup.
---

# Photo pipeline

## Flow

1. **Request upload** — `POST /markers/{id}/photos/upload-url` with `{ mimeType, bytes }`.
   - Check `edit_content` on the marker's trip.
   - Enforce limits: allowed types (JPEG, PNG, HEIC, WebP), max size (15 MB), max photos per marker (30) → `UNSUPPORTED_MEDIA_TYPE`, `UPLOAD_TOO_LARGE`, `PHOTO_LIMIT_REACHED`.
   - Create `photos` row with `status = pending_upload`, `position = last + 1`, server-generated key `photos/{photoId}/original` (never derived from user input).
   - Return a pre-signed PUT URL (10 min) with `Content-Type` and `Content-Length` bound.
2. **Client uploads** directly to R2.
3. **Confirm** — `POST /photos/{id}/complete`. Verify the object exists (HEAD) and size matches; set `status = processing`; emit `photo.processing`; enqueue `photo.process`.
4. **Worker `photo.process`** (idempotent, retries with backoff):
   - Download original; detect real type by magic bytes; reject mismatches → `failed`.
   - Auto-rotate by EXIF orientation, then **strip all metadata** (GPS included).
   - Produce `thumb` (256 px square crop, for the map pin and lists) and `display` (max 1600 px long edge). Store as `photos/{id}/thumb.webp`, `photos/{id}/display.webp`. Replace the original with the stripped version.
   - Save width/height; `status = ready`.
   - **If the marker has no cover, set this photo as cover.**
   - Emit `photo.ready` (and `marker.cover_changed` if the cover was set).
5. Photos stuck in `pending_upload` for 24 h are cleaned up by a scheduled job (row + any object).

## Cover rules

- `PUT /markers/{id}/cover` requires `edit_content`; photo must belong to the marker and be `ready`.
- Deleting the cover photo → the next `ready` photo by `position` becomes cover; none → `coverPhotoId = null`. Emit `marker.cover_changed`.
- Trip and marker responses include the cover's signed thumb URL so the map can render pins without extra calls.

## Deletion

- `DELETE /photos/{id}`: uploader, trip owner or editor. Delete the row in a transaction (and likes on it), then enqueue `storage.delete` for all its keys. Storage deletion must be idempotent and retried.
- Deleting a marker, trip or account enqueues storage deletion for every affected photo **after** the DB transaction commits.

## URLs

- Bucket is private. Return signed GET URLs (1 h) for `thumb` and `display`; the original is only exposed in GDPR exports.
- Never log signed URLs.

## Tests

Limits and type checks, confirm without upload, worker idempotency (running twice), EXIF GPS removed, cover auto-assign and reassignment on delete, storage delete enqueued after commit, editor vs stranger permissions.
