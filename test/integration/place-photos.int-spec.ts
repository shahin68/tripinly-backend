import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PhotoProcessingModule } from '../../src/modules/photos/photo-processing.module';
import { PhotoJobs, PHOTOS_QUEUE } from '../../src/modules/photos/photos.queue';
import {
  onboardedUser,
  publishLegalDocuments,
  resetState,
  type Session,
} from '../utils/auth-helpers';
import { api, type TripBody } from '../utils/api';
import { createTestApp } from '../utils/create-test-app';
import { readyPhoto, readyPlacePhoto } from '../utils/photos';
import { insertPlace } from '../utils/places';

interface PhotoBody {
  id: string;
  markerId: string | null;
  placeId: string | null;
  status: string;
  likeCount: number;
  likedByMe: boolean;
  uploader: { username: string } | null;
  source: string;
  credit: { author: string | null; license: string } | null;
}

const SPOT = { lat: 48.2085, lng: 16.3721 };

describe('Place photos and stop deletion (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queue: Queue;
  let as: ReturnType<typeof api>['as'];
  let owner: Session;
  let editor: Session;
  let stranger: Session;
  let trip: TripBody;
  let placeId: string;

  beforeAll(async () => {
    app = await createTestApp({ imports: [PhotoProcessingModule] });
    prisma = app.get(PrismaService);
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
    placeId = await insertPlace(app, { name: 'Stephansdom', ...SPOT });
    trip = (
      await as(owner)
        .post('/v1/trips')
        .send({
          title: 'Vienna',
          startDate: '2026-10-09',
          endDate: '2026-10-10',
          visibility: 'public',
          memberUsernames: ['editor'],
        })
        .expect(201)
    ).body as TripBody;
  });

  const placeGallery = async (session: Session, id = placeId) =>
    (await as(session).get(`/v1/places/${id}/photos`).expect(200))
      .body as PhotoBody[];

  const addStop = async (
    session: Session,
    body: Record<string, unknown>,
    day = trip.days[0].id,
  ) =>
    (await as(session).post(`/v1/days/${day}/markers`).send(body).expect(201))
      .body as { id: string; placeId: string };

  const queuedDeletes = async () =>
    (await queue.getJobs(['waiting', 'delayed', 'prioritized']))
      .filter((job) => job.name === PhotoJobs.DELETE_FILES)
      .flatMap((job) => (job.data as { photoIds: string[] }).photoIds);

  describe('place photos', () => {
    it('lets anyone add a photo to a place, most liked first', async () => {
      const first = await readyPlacePhoto(app, stranger, placeId);
      const second = await readyPlacePhoto(app, editor, placeId);
      expect(
        await prisma.photo.findUniqueOrThrow({ where: { id: first } }),
      ).toMatchObject({ placeId, markerId: null, tripId: null });

      // Newest first while nobody liked them.
      expect((await placeGallery(owner)).map((p) => p.id)).toEqual([
        second,
        first,
      ]);
      await as(owner).put(`/v1/likes/photo/${first}`).expect(200);
      const gallery = await placeGallery(owner);
      expect(gallery.map((p) => p.id)).toEqual([first, second]);
      expect(gallery[0]).toMatchObject({
        placeId,
        markerId: null,
        status: 'ready',
        likeCount: 1,
        likedByMe: true,
        uploader: expect.objectContaining({ username: 'stranger' }),
      });
    });

    it('also shows the liked public trip photos taken there, once each', async () => {
      const fan = await onboardedUser(app, 'fan');
      const stop = await addStop(owner, { placeId });
      const tripPhoto = await readyPhoto(app, owner, stop.id);
      const placePhoto = await readyPlacePhoto(app, editor, placeId);
      const likeBoth = async (session: Session) => {
        await as(session).put(`/v1/likes/photo/${tripPhoto}`).expect(200);
        await as(session).put(`/v1/likes/photo/${placePhoto}`).expect(200);
      };

      // The uploader's own like doesn't count; two others aren't enough yet.
      await as(owner).put(`/v1/likes/photo/${tripPhoto}`).expect(200);
      await likeBoth(stranger);
      await likeBoth(fan);
      expect((await placeGallery(stranger)).map((p) => p.id)).toEqual([
        placePhoto,
      ]);

      await as(editor).put(`/v1/likes/photo/${tripPhoto}`).expect(200);
      await as(owner).put(`/v1/likes/photo/${placePhoto}`).expect(200);
      const gallery = await placeGallery(stranger);
      expect(gallery.map((p) => p.id)).toEqual([tripPhoto, placePhoto]);
      expect(gallery[0]).toMatchObject({ markerId: stop.id, placeId: null });
    });

    it('never shows trip photos from private trips', async () => {
      const privateTrip = (
        await as(owner)
          .post('/v1/trips')
          .send({ title: 'Secret', visibility: 'private' })
          .expect(201)
      ).body as TripBody;
      const stop = await addStop(owner, { placeId }, privateTrip.days[0].id);
      const photo = await readyPhoto(app, owner, stop.id);
      const fan = await onboardedUser(app, 'fan');
      for (const session of [editor, stranger, fan]) {
        await prisma.like.create({
          data: {
            userId: session.userId,
            targetType: 'photo',
            targetId: photo,
          },
        });
      }
      await prisma.photo.update({
        where: { id: photo },
        data: { likeCount: 3 },
      });
      expect(await placeGallery(stranger)).toEqual([]);
    });

    it("shows the place's Commons images after people's photos, and lets people like them", async () => {
      const commonsImage = (commonsTitle: string, rank: number) =>
        prisma.placeImage.create({
          data: {
            placeId,
            origin: 'wikidata_p18',
            commonsTitle,
            rank,
            status: 'ready',
            authorText: 'Jane Doe',
            licenseCode: 'cc-by-sa-4.0',
            licenseShortName: 'CC BY-SA 4.0',
          },
        });
      const first = await commonsImage('File:Stephansdom.jpg', 0);
      const second = await commonsImage('File:Stephansdom innen.jpg', 1);
      const pending = await prisma.placeImage.create({
        data: { placeId, origin: 'osm_image', commonsTitle: 'File:Later.jpg' },
      });
      const photo = await readyPlacePhoto(app, stranger, placeId);

      expect((await placeGallery(owner)).map((p) => p.id)).toEqual([
        photo,
        first.id,
        second.id,
      ]);
      await as(owner).put(`/v1/likes/place_image/${second.id}`).expect(200);
      await as(editor).put(`/v1/likes/place_image/${second.id}`).expect(200);
      // Liking twice changes nothing.
      const liked = await as(editor)
        .put(`/v1/likes/place_image/${second.id}`)
        .expect(200);
      expect(liked.body).toMatchObject({ liked: true, likeCount: 2 });

      // People's photos stay on top, however liked the Commons images are.
      const gallery = await placeGallery(owner);
      expect(gallery.map((p) => p.id)).toEqual([photo, second.id, first.id]);
      expect(gallery[0]).toMatchObject({ source: 'user', credit: null });
      expect(gallery[1]).toEqual({
        id: second.id,
        markerId: null,
        placeId,
        status: 'ready',
        thumbUrl: expect.stringContaining(
          `place-images/${second.id}/thumb.webp`,
        ),
        displayUrl: expect.stringContaining(
          `place-images/${second.id}/display.webp`,
        ),
        width: null,
        height: null,
        position: 0,
        likeCount: 2,
        likedByMe: true,
        uploader: null,
        createdAt: expect.any(String),
        source: 'commons',
        credit: expect.objectContaining({
          author: 'Jane Doe',
          license: 'CC BY-SA 4.0',
        }),
      });
      // The most liked Commons image becomes the cover while no photo qualifies.
      const place = await as(stranger).get(`/v1/places/${placeId}`).expect(200);
      expect(place.body).toMatchObject({
        coverImageId: second.id,
        coverSource: 'commons',
      });

      await as(owner).delete(`/v1/likes/place_image/${second.id}`).expect(200);
      expect(
        await prisma.placeImage.findUniqueOrThrow({ where: { id: second.id } }),
      ).toMatchObject({ likeCount: 1 });
      // Images not shown can't be liked.
      await as(owner).put(`/v1/likes/place_image/${pending.id}`).expect(404);
      // Their likes go with them.
      await prisma.placeImage.delete({ where: { id: second.id } });
      expect(
        await prisma.like.count({ where: { targetType: 'place_image' } }),
      ).toBe(0);
    });

    it("puts the place's popular photos and Commons images in a stop's ranked grid, and its pin shows the place's image until a cover is picked", async () => {
      const fan = await onboardedUser(app, 'fan');
      const commons = await prisma.placeImage.create({
        data: {
          placeId,
          origin: 'wikidata_p18',
          commonsTitle: 'File:Stephansdom.jpg',
          status: 'ready',
          licenseShortName: 'CC BY-SA 4.0',
        },
      });
      const theirs = (
        await as(stranger)
          .post('/v1/trips')
          .send({ title: 'Theirs', visibility: 'public' })
          .expect(201)
      ).body as TripBody;
      const theirStop = await addStop(stranger, { placeId }, theirs.days[0].id);
      const popular = await readyPhoto(app, stranger, theirStop.id);
      for (const session of [owner, editor, fan]) {
        await as(session).put(`/v1/likes/photo/${popular}`).expect(200);
      }

      const stop = await addStop(owner, { placeId });
      const mine = await readyPhoto(app, owner, stop.id);
      const markerCover = async () =>
        (await as(owner).get(`/v1/markers/${stop.id}`).expect(200)).body as {
          coverPhotoId: string | null;
          coverThumbUrl: string | null;
        };
      // No cover picked: the pin shows the place's image, its popular photo.
      expect(await markerCover()).toMatchObject({ coverPhotoId: popular });
      const trip_ = await as(owner).get(`/v1/trips/${trip.id}`).expect(200);
      expect(trip_.body.days[0].markers[0].coverPhotoId).toBe(popular);

      const grid = (
        await as(owner).get(`/v1/markers/${stop.id}/photos`).expect(200)
      ).body as PhotoBody[];
      // Most liked first; on a tie the stop's own photo goes before Commons.
      expect(grid.map((p) => p.id)).toEqual([popular, mine, commons.id]);
      expect(grid[0]).toMatchObject({
        markerId: theirStop.id,
        likeCount: 3,
        likedByMe: true,
      });
      expect(grid[2]).toMatchObject({ source: 'commons', markerId: null });

      await as(editor)
        .put(`/v1/markers/${stop.id}/cover`)
        .send({ photoId: commons.id })
        .expect(200);
      expect((await markerCover()).coverThumbUrl).toEqual(
        expect.stringContaining(`place-images/${commons.id}/thumb.webp`),
      );
      // Another trip may pick the same popular photo.
      await as(owner)
        .put(`/v1/markers/${stop.id}/cover`)
        .send({ photoId: popular })
        .expect(200);
      expect(await markerCover()).toMatchObject({ coverPhotoId: popular });
      await as(stranger)
        .put(`/v1/markers/${theirStop.id}/cover`)
        .send({ photoId: popular })
        .expect(200);

      // Their trip turns private: its photo leaves my grid and my pin.
      await as(stranger)
        .patch(`/v1/trips/${theirs.id}`)
        .send({ visibility: 'private' })
        .expect(200);
      expect(await markerCover()).toMatchObject({ coverPhotoId: commons.id });
      expect(
        (
          (await as(owner).get(`/v1/markers/${stop.id}/photos`).expect(200))
            .body as PhotoBody[]
        ).map((p) => p.id),
      ).toEqual([mine, commons.id]);
    });

    it('enforces the daily limit per person', async () => {
      const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const today = new Date();
      for (let i = 0; i < 20; i++) {
        await prisma.photo.create({
          data: {
            placeId,
            uploaderId: stranger.userId,
            mimeType: 'image/jpeg',
            bytes: 10,
            position: 0,
            status: 'ready',
            createdAt: i === 0 ? yesterday : today,
          },
        });
      }
      // 19 today: one more fits.
      await readyPlacePhoto(app, stranger, placeId);
      const refused = await as(stranger)
        .post(`/v1/places/${placeId}/photos/upload-url`)
        .send({ mimeType: 'image/jpeg', bytes: 1000 })
        .expect(422);
      expect(refused.body.error).toMatchObject({
        code: 'DAILY_PHOTO_LIMIT_REACHED',
        details: { max: 20 },
      });
      // Someone else is unaffected.
      await readyPlacePhoto(app, editor, placeId);
    });

    it('is deleted only by its uploader and stays when stops go', async () => {
      const stop = await addStop(owner, { placeId });
      const photo = await readyPlacePhoto(app, editor, placeId);
      await as(owner).delete(`/v1/photos/${photo}`).expect(403);
      await as(owner).delete(`/v1/markers/${stop.id}`).expect(204);
      expect(await prisma.photo.count({ where: { id: photo } })).toBe(1);

      await as(editor).delete(`/v1/photos/${photo}`).expect(204);
      expect(await placeGallery(editor)).toEqual([]);
      expect(await queuedDeletes()).toContain(photo);
    });

    it('hides user places nobody may see, and shows blocked uploaders without a name', async () => {
      const privateTrip = (
        await as(owner)
          .post('/v1/trips')
          .send({ title: 'Secret', visibility: 'private' })
          .expect(201)
      ).body as TripBody;
      const secret = await addStop(
        owner,
        { name: 'Our bench', location: { lat: 48.21, lng: 16.37 } },
        privateTrip.days[0].id,
      );
      await as(stranger).get(`/v1/places/${secret.placeId}/photos`).expect(404);
      await as(stranger)
        .post(`/v1/places/${secret.placeId}/photos/upload-url`)
        .send({ mimeType: 'image/jpeg', bytes: 1000 })
        .expect(404);

      const photo = await readyPlacePhoto(app, editor, placeId);
      await as(stranger).post(`/v1/users/${editor.userId}/block`).expect(204);
      const [seen] = await placeGallery(stranger);
      expect(seen).toMatchObject({ id: photo, uploader: null });
      await as(stranger).put(`/v1/likes/photo/${photo}`).expect(404);
    });

    it('goes with a user place when its last stop goes', async () => {
      const spot = { name: 'Hot bench', location: { lat: 48.2, lng: 16.36 } };
      const mine = await addStop(owner, spot);
      const other = (
        await as(stranger)
          .post('/v1/trips')
          .send({ title: 'Mine', visibility: 'public' })
          .expect(201)
      ).body as TripBody;
      const theirs = await addStop(stranger, spot, other.days[0].id);
      expect(theirs.placeId).toBe(mine.placeId);
      const photo = await readyPlacePhoto(app, editor, mine.placeId);

      await as(owner).delete(`/v1/markers/${mine.id}`).expect(204);
      expect(await prisma.place.count({ where: { id: mine.placeId } })).toBe(1);

      await as(stranger).delete(`/v1/trips/${other.id}`).expect(204);
      expect(await prisma.place.count({ where: { id: mine.placeId } })).toBe(0);
      expect(await prisma.photo.count({ where: { id: photo } })).toBe(0);
      expect(await queuedDeletes()).toContain(photo);
      // OSM places stay without stops.
      expect(await prisma.place.count({ where: { id: placeId } })).toBe(1);
    });
  });

  describe('stop deletion', () => {
    it("lets only the stop's creator or the trip owner delete it", async () => {
      const ownersStop = await addStop(owner, { placeId });
      const editorsStop = await addStop(editor, {
        name: 'Gelato',
        location: { lat: 48.209, lng: 16.373 },
      });
      await as(editor).delete(`/v1/markers/${ownersStop.id}`).expect(403);
      await as(editor).delete(`/v1/markers/${editorsStop.id}`).expect(204);

      const another = await addStop(editor, { placeId });
      await as(owner).delete(`/v1/markers/${another.id}`).expect(204);
    });

    it("warns before deleting other people's photos, comments and likes", async () => {
      const stop = await addStop(owner, { placeId });
      await readyPhoto(app, editor, stop.id);
      await as(editor)
        .post(`/v1/markers/${stop.id}/comments`)
        .send({ body: 'Lovely' })
        .expect(201);
      const photoId = await readyPhoto(app, owner, stop.id);
      await as(stranger).put(`/v1/likes/photo/${photoId}`).expect(200);
      // A like on the stop's place isn't on the stop: it stays.
      await as(stranger).put(`/v1/places/${placeId}/hot`).expect(200);

      const warned = await as(owner)
        .delete(`/v1/markers/${stop.id}`)
        .expect(409);
      expect(warned.body.error).toMatchObject({
        code: 'STOP_HAS_OTHERS_CONTENT',
        details: { photos: 1, comments: 1, likes: 1 },
      });
      await as(owner)
        .delete(`/v1/markers/${stop.id}?confirm=maybe`)
        .expect(400);
      await as(owner).delete(`/v1/markers/${stop.id}?confirm=true`).expect(204);
      expect(await prisma.marker.count({ where: { id: stop.id } })).toBe(0);
    });

    it('applies the same rules to clearing and deleting a day', async () => {
      const day = trip.days[1].id;
      const stop = await addStop(owner, { placeId }, day);
      await as(editor).delete(`/v1/days/${day}/markers`).expect(403);
      await as(editor).delete(`/v1/days/${day}`).expect(403);
      await as(editor)
        .post(`/v1/markers/${stop.id}/comments`)
        .send({ body: 'Hi' })
        .expect(201);
      await as(owner).delete(`/v1/days/${day}`).expect(409);
      await as(owner).delete(`/v1/days/${day}/markers`).expect(409);
      await as(owner)
        .delete(`/v1/days/${day}/markers?confirm=true`)
        .expect(204);

      await addStop(editor, { placeId }, day);
      await as(editor).delete(`/v1/days/${day}`).expect(204);
    });

    it('lets anyone else remove only their own content', async () => {
      const stop = await addStop(owner, { placeId });
      const ownersPhoto = await readyPhoto(app, owner, stop.id);
      const editorsPhoto = await readyPhoto(app, editor, stop.id);
      await as(owner)
        .put(`/v1/markers/${stop.id}/cover`)
        .send({ photoId: editorsPhoto })
        .expect(200);
      const ownersComment = (
        await as(owner)
          .post(`/v1/markers/${stop.id}/comments`)
          .send({ body: 'Mine' })
          .expect(201)
      ).body.id as string;
      await as(editor)
        .post(`/v1/markers/${stop.id}/comments`)
        .send({ body: 'Theirs' })
        .expect(201);
      await as(editor).put(`/v1/likes/photo/${ownersPhoto}`).expect(200);
      await as(editor).put(`/v1/likes/comment/${ownersComment}`).expect(200);
      await as(editor).put(`/v1/places/${placeId}/hot`).expect(200);

      await as(editor).delete(`/v1/markers/${stop.id}/mine`).expect(204);

      const marker = await prisma.marker.findUniqueOrThrow({
        where: { id: stop.id },
      });
      // The editor's photo was the cover; the pin goes back to the place's image.
      expect(marker).toMatchObject({ commentCount: 1, coverPhotoId: null });
      expect(
        (await prisma.photo.findMany({ where: { markerId: stop.id } })).map(
          (p) => [p.id, p.likeCount],
        ),
      ).toEqual([[ownersPhoto, 0]]);
      expect(
        await prisma.comment.findUniqueOrThrow({
          where: { id: ownersComment },
        }),
      ).toMatchObject({ likeCount: 0 });
      // Only the like on the place is left: it's the place's, not the stop's.
      expect(
        await prisma.like.findMany({
          where: { userId: editor.userId },
          select: { targetType: true },
        }),
      ).toEqual([{ targetType: 'place' }]);
      expect(await queuedDeletes()).toContain(editorsPhoto);
    });
  });
});
