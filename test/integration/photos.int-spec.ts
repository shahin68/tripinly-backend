import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import sharp from 'sharp';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { StorageService } from '../../src/common/storage/storage.service';
import { PhotoCleanupService } from '../../src/modules/photos/photo-cleanup.service';
import { photoKeys } from '../../src/modules/photos/photo-keys';
import { PhotoProcessingModule } from '../../src/modules/photos/photo-processing.module';
import { PhotoProcessingService } from '../../src/modules/photos/photo-processing.service';
import { PhotoJobs, PHOTOS_QUEUE } from '../../src/modules/photos/photos.queue';
import {
  onboardedUser,
  publishLegalDocuments,
  resetState,
  type Session,
} from '../utils/auth-helpers';
import { api, type TripBody } from '../utils/api';
import { createTestApp } from '../utils/create-test-app';
import { jpegWithGps, png, readyPhoto, upload } from '../utils/photos';

interface PhotoBody {
  id: string;
  status: string;
  thumbUrl: string | null;
  displayUrl: string | null;
  width: number | null;
  height: number | null;
  position: number;
  uploader: { username: string } | null;
}

describe('Photos (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let processing: PhotoProcessingService;
  let queue: Queue;
  let as: ReturnType<typeof api>['as'];
  let owner: Session;
  let editor: Session;
  let stranger: Session;
  let trip: TripBody;
  let markerId: string;

  beforeAll(async () => {
    app = await createTestApp({ imports: [PhotoProcessingModule] });
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
    processing = app.get(PhotoProcessingService);
    queue = app.get<Queue>(getQueueToken(PHOTOS_QUEUE));
    as = api(app).as;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState(app);
    await publishLegalDocuments(app);
    owner = await onboardedUser(app, 'owner');
    editor = await onboardedUser(app, 'editor');
    stranger = await onboardedUser(app, 'stranger');
    trip = (
      await as(owner)
        .post('/v1/trips')
        .send({
          title: 'Vienna',
          startDate: '2026-10-09',
          endDate: '2026-10-09',
          visibility: 'private',
          memberUsernames: ['editor'],
        })
        .expect(201)
    ).body as TripBody;
    markerId = (
      await as(owner)
        .post(`/v1/days/${trip.days[0].id}/markers`)
        .send({ name: 'Albertina', location: { lat: 48.2046, lng: 16.3683 } })
        .expect(201)
    ).body.id as string;
  });

  const gallery = async (session: Session, id = markerId) =>
    (await as(session).get(`/v1/markers/${id}/photos`).expect(200))
      .body as PhotoBody[];

  const queuedJobs = async (name: string) =>
    (await queue.getJobs(['waiting', 'delayed', 'prioritized'])).filter(
      (job) => job.name === name,
    );

  const makePublic = () =>
    as(owner)
      .patch(`/v1/trips/${trip.id}`)
      .send({ visibility: 'public' })
      .expect(200);

  describe('upload and processing', () => {
    it('uploads, strips metadata, makes thumb and display, and sets the cover', async () => {
      const file = await jpegWithGps();
      const start = await upload(app, editor, markerId, file);
      expect(start.photo).toEqual(
        expect.objectContaining({ status: 'pending_upload', position: 0 }),
      );
      expect(start.uploadHeaders).toEqual({
        'Content-Type': 'image/jpeg',
        'Content-Length': String(file.length),
      });

      const completed = await as(editor)
        .post(`/v1/photos/${start.photo.id}/complete`)
        .expect(202);
      expect(completed.body.status).toBe('processing');
      expect(await queuedJobs(PhotoJobs.PROCESS)).toHaveLength(1);

      await expect(processing.process(start.photo.id)).resolves.toBe('ready');
      // Running the job again changes nothing.
      await expect(processing.process(start.photo.id)).resolves.toBe('skipped');

      const [photo] = await gallery(owner);
      // Stored sideways with orientation 6: upright it is 200 × 400.
      expect(photo).toEqual(
        expect.objectContaining({
          id: start.photo.id,
          status: 'ready',
          width: 200,
          height: 400,
          uploader: expect.objectContaining({ username: 'editor' }),
        }),
      );
      const thumb = await fetch(photo.thumbUrl!);
      expect(thumb.status).toBe(200);
      const thumbMeta = await sharp(
        Buffer.from(await thumb.arrayBuffer()),
      ).metadata();
      expect([thumbMeta.format, thumbMeta.width, thumbMeta.height]).toEqual([
        'webp',
        256,
        256,
      ]);
      expect((await fetch(photo.displayUrl!)).status).toBe(200);

      // The kept original has no EXIF (no GPS) and is upright.
      const original = await storage.get(photoKeys(photo.id).original);
      const meta = await sharp(original).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect([meta.width, meta.height]).toEqual([200, 400]);

      // First ready photo becomes the cover, visible on the marker, trip and trip list.
      const marker = await as(owner).get(`/v1/markers/${markerId}`).expect(200);
      expect(marker.body).toEqual(
        expect.objectContaining({ coverPhotoId: photo.id, photoCount: 1 }),
      );
      expect(marker.body.coverThumbUrl).toEqual(
        expect.stringContaining(`photos/${photo.id}/thumb.webp`),
      );
      const detail = await as(owner).get(`/v1/trips/${trip.id}`).expect(200);
      expect(detail.body.days[0].markers[0].coverPhotoId).toBe(photo.id);
      const list = await as(owner).get('/v1/me/trips').expect(200);
      expect(list.body.items[0].coverThumbUrl).toEqual(
        expect.stringContaining(photo.id),
      );
      const stats = await as(editor).get('/v1/me/stats').expect(200);
      expect(stats.body.photoCount).toBe(1);
    });

    it('keeps signed URLs stable within the hour so images cache', async () => {
      const id = await readyPhoto(app, owner, markerId);
      const [first] = await gallery(owner);
      const [second] = await gallery(owner);
      expect(first.thumbUrl).toBe(second.thumbUrl);
      expect(first.id).toBe(id);
    });

    it('checks type, size, the photo limit and edit rights', async () => {
      const unsupported = await as(owner)
        .post(`/v1/markers/${markerId}/photos/upload-url`)
        .send({ mimeType: 'image/heic', bytes: 1000 })
        .expect(415);
      expect(unsupported.body.error).toEqual(
        expect.objectContaining({
          code: 'UNSUPPORTED_MEDIA_TYPE',
          details: { allowed: ['image/jpeg', 'image/png', 'image/webp'] },
        }),
      );
      const large = await as(owner)
        .post(`/v1/markers/${markerId}/photos/upload-url`)
        .send({ mimeType: 'image/jpeg', bytes: 15 * 1024 * 1024 + 1 })
        .expect(413);
      expect(large.body.error.code).toBe('UPLOAD_TOO_LARGE');

      await as(stranger)
        .post(`/v1/markers/${markerId}/photos/upload-url`)
        .send({ mimeType: 'image/jpeg', bytes: 1000 })
        .expect(404);
      await makePublic();
      await as(stranger)
        .post(`/v1/markers/${markerId}/photos/upload-url`)
        .send({ mimeType: 'image/jpeg', bytes: 1000 })
        .expect(403);

      const uploaderId = owner.userId;
      await prisma.photo.createMany({
        data: Array.from({ length: 30 }, (_, position) => ({
          markerId,
          tripId: trip.id,
          uploaderId,
          mimeType: 'image/jpeg',
          bytes: 1000,
          position,
          status: 'ready' as const,
        })),
      });
      const limit = await as(owner)
        .post(`/v1/markers/${markerId}/photos/upload-url`)
        .send({ mimeType: 'image/jpeg', bytes: 1000 })
        .expect(422);
      expect(limit.body.error).toEqual(
        expect.objectContaining({
          code: 'PHOTO_LIMIT_REACHED',
          details: { max: 30 },
        }),
      );
    });

    it('completes only uploaded files of the right size, by the uploader, once', async () => {
      const file = await jpegWithGps();
      const { body: start } = await as(owner)
        .post(`/v1/markers/${markerId}/photos/upload-url`)
        .send({ mimeType: 'image/jpeg', bytes: file.length })
        .expect(201);
      const notUploaded = await as(owner)
        .post(`/v1/photos/${start.photo.id}/complete`)
        .expect(400);
      expect(notUploaded.body.error.details.fields).toEqual({
        upload: ['notUploaded'],
      });

      await storage.put(
        photoKeys(start.photo.id).original,
        file.subarray(0, 100),
        'image/jpeg',
      );
      const mismatch = await as(owner)
        .post(`/v1/photos/${start.photo.id}/complete`)
        .expect(400);
      expect(mismatch.body.error.details.fields).toEqual({
        upload: ['sizeMismatch'],
      });

      await storage.put(photoKeys(start.photo.id).original, file, 'image/jpeg');
      await as(editor)
        .post(`/v1/photos/${start.photo.id}/complete`)
        .expect(403);
      await as(stranger)
        .post(`/v1/photos/${start.photo.id}/complete`)
        .expect(404);
      await as(owner).post(`/v1/photos/${start.photo.id}/complete`).expect(202);
      const again = await as(owner)
        .post(`/v1/photos/${start.photo.id}/complete`)
        .expect(202);
      expect(again.body.status).toBe('processing');
      expect(await queuedJobs(PhotoJobs.PROCESS)).toHaveLength(1);
    });

    it('fails a file whose content is not the declared type', async () => {
      const { photo } = await upload(
        app,
        owner,
        markerId,
        await png(),
        'image/jpeg',
      );
      await as(owner).post(`/v1/photos/${photo.id}/complete`).expect(202);

      await expect(processing.process(photo.id)).rejects.toThrow(
        'does not match',
      );
      await processing.markFailed(photo.id, 'test');

      expect((await gallery(editor)).map((p) => p.status)).toEqual(['failed']);
      await makePublic();
      expect(await gallery(stranger)).toEqual([]);
      const marker = await as(owner).get(`/v1/markers/${markerId}`).expect(200);
      expect(marker.body).toEqual(
        expect.objectContaining({ coverPhotoId: null, photoCount: 0 }),
      );
    });

    it('shows photos to public viewers only when ready', async () => {
      await readyPhoto(
        app,
        owner,
        markerId,
        await png().then((b) => sharp(b).jpeg().toBuffer()),
      );
      const pending = await upload(app, owner, markerId, await jpegWithGps());
      await makePublic();

      expect((await gallery(stranger)).map((p) => p.status)).toEqual(['ready']);
      expect((await gallery(owner)).map((p) => p.id)).not.toContain(
        pending.photo.id,
      );
    });
  });

  describe('gallery order, cover and deletion', () => {
    it('reorders and moves the cover', async () => {
      const first = await readyPhoto(app, owner, markerId);
      const second = await readyPhoto(app, editor, markerId);

      const bad = await as(owner)
        .put(`/v1/markers/${markerId}/photo-order`)
        .send({ photoIds: [second] })
        .expect(400);
      expect(bad.body.error.details.fields).toEqual({
        photoIds: ['mustMatchMarkerPhotos'],
      });
      const reordered = await as(editor)
        .put(`/v1/markers/${markerId}/photo-order`)
        .send({ photoIds: [second, first] })
        .expect(200);
      expect(reordered.body.map((p: PhotoBody) => p.id)).toEqual([
        second,
        first,
      ]);

      const cover = await as(editor)
        .put(`/v1/markers/${markerId}/cover`)
        .send({ photoId: second })
        .expect(200);
      expect(cover.body.coverPhotoId).toBe(second);

      const pending = await upload(app, owner, markerId, await jpegWithGps());
      const notReady = await as(owner)
        .put(`/v1/markers/${markerId}/cover`)
        .send({ photoId: pending.photo.id })
        .expect(400);
      expect(notReady.body.error.details.fields).toEqual({
        photoId: ['notReady'],
      });
      await as(stranger)
        .put(`/v1/markers/${markerId}/cover`)
        .send({ photoId: second })
        .expect(404);
    });

    it('passes the cover on when it is deleted and deletes the files', async () => {
      const first = await readyPhoto(app, owner, markerId);
      const second = await readyPhoto(app, owner, markerId);

      await as(editor).delete(`/v1/photos/${first}`).expect(204);
      let marker = await as(owner).get(`/v1/markers/${markerId}`).expect(200);
      expect(marker.body).toEqual(
        expect.objectContaining({ coverPhotoId: second, photoCount: 1 }),
      );
      const [job] = await queuedJobs(PhotoJobs.DELETE_FILES);
      expect(job.data).toEqual({ photoIds: [first] });

      await app.get(PhotoCleanupService).deleteFiles([first]);
      expect(await storage.head(photoKeys(first).thumb)).toBeNull();
      expect(await storage.head(photoKeys(first).original)).toBeNull();
      expect(await storage.head(photoKeys(second).thumb)).not.toBeNull();

      await as(owner).delete(`/v1/photos/${second}`).expect(204);
      marker = await as(owner).get(`/v1/markers/${markerId}`).expect(200);
      expect(marker.body).toEqual(
        expect.objectContaining({ coverPhotoId: null, coverThumbUrl: null }),
      );
    });

    it('lets the uploader delete after leaving; others need edit rights', async () => {
      const photo = await readyPhoto(app, editor, markerId);
      await as(stranger).delete(`/v1/photos/${photo}`).expect(404);
      await makePublic();
      await as(stranger).delete(`/v1/photos/${photo}`).expect(403);

      await as(editor)
        .delete(`/v1/trips/${trip.id}/members/${editor.userId}`)
        .expect(204);
      await as(editor).delete(`/v1/photos/${photo}`).expect(204);
    });

    it('queues file deletion when a marker, day or trip goes', async () => {
      const onMarker = await readyPhoto(app, owner, markerId);
      await as(owner).delete(`/v1/markers/${markerId}`).expect(204);
      expect(
        (await queuedJobs(PhotoJobs.DELETE_FILES)).map((j) => j.data),
      ).toEqual([{ photoIds: [onMarker] }]);
      await queue.drain();

      const day = await as(owner)
        .post(`/v1/trips/${trip.id}/days`)
        .send({})
        .expect(201);
      const dayMarker = await as(owner)
        .post(`/v1/days/${day.body.id}/markers`)
        .send({ name: 'Prater', location: { lat: 48.2166, lng: 16.3958 } })
        .expect(201);
      const onDay = await readyPhoto(app, owner, dayMarker.body.id);
      await as(owner).delete(`/v1/days/${day.body.id}`).expect(204);
      expect(
        (await queuedJobs(PhotoJobs.DELETE_FILES)).map((j) => j.data),
      ).toEqual([{ photoIds: [onDay] }]);
      await queue.drain();

      const lastMarker = await as(owner)
        .post(`/v1/days/${trip.days[0].id}/markers`)
        .send({ name: 'Hofburg', location: { lat: 48.2065, lng: 16.3654 } })
        .expect(201);
      const onTrip = await readyPhoto(app, owner, lastMarker.body.id);
      await as(owner).delete(`/v1/trips/${trip.id}`).expect(204);
      expect(
        (await queuedJobs(PhotoJobs.DELETE_FILES)).map((j) => j.data),
      ).toEqual([{ photoIds: [onTrip] }]);
      expect(await prisma.photo.count()).toBe(0);
    });

    it('removes stale uploads and failed photos after a day', async () => {
      const stale = await upload(app, owner, markerId, await jpegWithGps());
      const fresh = await upload(app, owner, markerId, await jpegWithGps());
      const ready = await readyPhoto(app, owner, markerId);
      await prisma.$executeRaw`UPDATE photos SET "updatedAt" = now() - interval '25 hours' WHERE id IN (${stale.photo.id}::uuid, ${ready}::uuid)`;

      await expect(app.get(PhotoCleanupService).removeStale()).resolves.toBe(1);

      const left = (await prisma.photo.findMany({ select: { id: true } }))
        .map((p) => p.id)
        .sort();
      expect(left).toEqual([fresh.photo.id, ready].sort());
      expect(await storage.head(photoKeys(stale.photo.id).original)).toBeNull();
    });
  });

  describe('blocking', () => {
    it("hides a blocked uploader's photos and cover", async () => {
      await readyPhoto(app, editor, markerId);
      await makePublic();
      await as(stranger).post(`/v1/users/${editor.userId}/block`).expect(204);

      expect(await gallery(stranger)).toEqual([]);
      const marker = await as(stranger)
        .get(`/v1/markers/${markerId}`)
        .expect(200);
      expect(marker.body).toEqual(
        expect.objectContaining({ coverPhotoId: null, coverThumbUrl: null }),
      );
      const detail = await as(stranger).get(`/v1/trips/${trip.id}`).expect(200);
      expect(detail.body.days[0].markers[0].coverThumbUrl).toBeNull();
    });
  });
});
