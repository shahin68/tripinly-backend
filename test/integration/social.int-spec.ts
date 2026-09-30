import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PhotoProcessingModule } from '../../src/modules/photos/photo-processing.module';
import { CountersService } from '../../src/modules/social/counters.service';
import {
  onboardedUser,
  publishLegalDocuments,
  resetState,
  type Session,
} from '../utils/auth-helpers';
import { api, type TripBody } from '../utils/api';
import { createTestApp } from '../utils/create-test-app';
import { readyPhoto } from '../utils/photos';
import { insertPlace } from '../utils/places';

interface CommentBody {
  id: string;
  body: string;
  author: { username: string };
  likeCount: number;
  likedByMe: boolean;
  canDelete: boolean;
}

const ALBERTINA = { lat: 48.2046, lng: 16.3683 };

describe('Social (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: ReturnType<typeof api>['as'];
  let owner: Session;
  let editor: Session;
  let stranger: Session;
  let trip: TripBody;
  let markerId: string;
  let placeId: string;

  beforeAll(async () => {
    app = await createTestApp({ imports: [PhotoProcessingModule] });
    prisma = app.get(PrismaService);
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
    placeId = await insertPlace(app, { name: 'Albertina', ...ALBERTINA });
    trip = await createTrip(owner, 'Vienna', 'public', ['editor']);
    markerId = await addMarker(owner, trip.days[0].id, placeId);
  });

  async function createTrip(
    session: Session,
    title: string,
    visibility: 'public' | 'private',
    memberUsernames: string[] = [],
  ): Promise<TripBody> {
    return (
      await as(session)
        .post('/v1/trips')
        .send({
          title,
          startDate: '2026-10-09',
          endDate: '2026-10-10',
          visibility,
          memberUsernames,
        })
        .expect(201)
    ).body as TripBody;
  }

  async function addMarker(
    session: Session,
    dayId: string,
    place: string,
  ): Promise<string> {
    const { body } = await as(session)
      .post(`/v1/days/${dayId}/markers`)
      .send({ placeId: place, time: '10:00' })
      .expect(201);
    return (body as { id: string }).id;
  }

  const popularity = async (id = placeId) =>
    (await prisma.place.findUniqueOrThrow({ where: { id } })).popularity;

  describe('likes', () => {
    it('likes a marker once, counts it toward the place, and unlikes', async () => {
      const first = await as(stranger)
        .put(`/v1/likes/marker/${markerId}`)
        .expect(200);
      expect(first.body).toEqual({
        targetType: 'marker',
        targetId: markerId,
        liked: true,
        likeCount: 1,
      });
      // Idempotent.
      await as(stranger).put(`/v1/likes/marker/${markerId}`).expect(200);
      const marker = await as(stranger).get(`/v1/markers/${markerId}`);
      expect(marker.body).toMatchObject({ likeCount: 1, likedByMe: true });
      const forOwner = await as(owner).get(`/v1/trips/${trip.id}`);
      expect(forOwner.body.days[0].markers[0]).toMatchObject({
        likeCount: 1,
        likedByMe: false,
      });
      expect(await popularity()).toBe(1);

      const place = await as(stranger).get(`/v1/places/${placeId}`);
      expect(place.body).toMatchObject({ isTripinly: true, likeCount: 1 });

      const removed = await as(stranger)
        .delete(`/v1/likes/marker/${markerId}`)
        .expect(200);
      expect(removed.body).toMatchObject({ liked: false, likeCount: 0 });
      await as(stranger).delete(`/v1/likes/marker/${markerId}`).expect(200);
      expect(await popularity()).toBe(0);
    });

    it('likes trips and fills likedByMe on the trip and in lists', async () => {
      await as(stranger).put(`/v1/likes/trip/${trip.id}`).expect(200);
      await as(editor).put(`/v1/likes/trip/${trip.id}`).expect(200);
      const detail = await as(stranger).get(`/v1/trips/${trip.id}`);
      expect(detail.body).toMatchObject({ likeCount: 2, likedByMe: true });
      const mine = await as(editor).get('/v1/me/trips');
      expect(mine.body.items[0]).toMatchObject({
        id: trip.id,
        likeCount: 2,
        likedByMe: true,
      });
      // A like doesn't count as a change to the trip.
      expect(mine.body.items[0].updatedAt).toBe(detail.body.updatedAt);
    });

    it('keeps private trips to members, and their likes out of popularity', async () => {
      const secret = await createTrip(owner, 'Secret', 'private', ['editor']);
      const secretMarker = await addMarker(owner, secret.days[0].id, placeId);
      await as(stranger).put(`/v1/likes/trip/${secret.id}`).expect(404);
      await as(stranger).put(`/v1/likes/marker/${secretMarker}`).expect(404);

      await as(editor).put(`/v1/likes/marker/${secretMarker}`).expect(200);
      expect(await popularity()).toBe(0);

      // Going public brings the like into the count; private again takes it out.
      await as(owner)
        .patch(`/v1/trips/${secret.id}`)
        .send({ visibility: 'public' })
        .expect(200);
      expect(await popularity()).toBe(1);
      await as(owner)
        .patch(`/v1/trips/${secret.id}`)
        .send({ visibility: 'private' })
        .expect(200);
      expect(await popularity()).toBe(0);
    });

    it('likes places directly, only places the caller may see', async () => {
      const liked = await as(stranger)
        .put(`/v1/likes/place/${placeId}`)
        .expect(200);
      expect(liked.body).toMatchObject({ liked: true, likeCount: 1 });
      const detail = await as(stranger).get(`/v1/places/${placeId}`);
      expect(detail.body).toMatchObject({ likedByMe: true, likeCount: 1 });

      // A custom pin in a private trip isn't visible to others.
      const secret = await createTrip(owner, 'Secret', 'private');
      const pin = await as(owner)
        .post(`/v1/days/${secret.days[0].id}/markers`)
        .send({ name: 'Our flat', location: { lat: 48.19, lng: 16.35 } })
        .expect(201);
      await as(stranger).put(`/v1/likes/place/${pin.body.placeId}`).expect(404);
    });

    it('moves popularity when a liked marker moves or is deleted', async () => {
      await as(stranger).put(`/v1/likes/marker/${markerId}`).expect(200);
      const other = await insertPlace(app, {
        name: 'Hofburg',
        lat: 48.2065,
        lng: 16.3654,
      });
      await as(owner)
        .patch(`/v1/markers/${markerId}`)
        .send({ placeId: other })
        .expect(200);
      expect(await popularity()).toBe(0);
      expect(await popularity(other)).toBe(1);

      await as(owner).delete(`/v1/markers/${markerId}`).expect(204);
      expect(await popularity(other)).toBe(0);
      expect(await prisma.like.count()).toBe(0);
    });

    it('removes every like with a deleted trip', async () => {
      await as(stranger).put(`/v1/likes/trip/${trip.id}`).expect(200);
      await as(stranger).put(`/v1/likes/marker/${markerId}`).expect(200);
      const comment = await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Lovely' })
        .expect(201);
      await as(owner).put(`/v1/likes/comment/${comment.body.id}`).expect(200);
      expect(await prisma.like.count()).toBe(3);

      await as(owner).delete(`/v1/trips/${trip.id}`).expect(204);
      expect(await prisma.like.count()).toBe(0);
      expect(await popularity()).toBe(0);
    });

    it('likes ready photos only and removes their likes with them', async () => {
      const photoId = await readyPhoto(app, owner, markerId);
      await as(stranger).put(`/v1/likes/photo/${photoId}`).expect(200);
      const gallery = await as(stranger).get(`/v1/markers/${markerId}/photos`);
      expect(gallery.body[0]).toMatchObject({ likeCount: 1, likedByMe: true });

      const pending = await as(owner)
        .post(`/v1/markers/${markerId}/photos/upload-url`)
        .send({ mimeType: 'image/jpeg', bytes: 1000 })
        .expect(201);
      await as(owner)
        .put(`/v1/likes/photo/${pending.body.photo.id}`)
        .expect(404);

      await as(owner).delete(`/v1/photos/${photoId}`).expect(204);
      expect(await prisma.like.count()).toBe(0);
    });

    it('hides content across a block', async () => {
      const comment = await as(editor)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Go early' })
        .expect(201);
      await as(stranger).post(`/v1/users/${editor.userId}/block`).expect(204);
      await as(stranger)
        .put(`/v1/likes/comment/${comment.body.id}`)
        .expect(404);
    });

    it('validates the target', async () => {
      const bad = await as(stranger)
        .put(`/v1/likes/user/${stranger.userId}`)
        .expect(400);
      expect(bad.body.error.details.fields.targetType).toBeDefined();
      await as(stranger)
        .put('/v1/likes/marker/00000000-0000-4000-8000-000000000000')
        .expect(404);
    });
  });

  describe('comments', () => {
    it('lists comments oldest first with pagination', async () => {
      for (const body of ['First', 'Second', 'Third']) {
        await as(stranger)
          .post(`/v1/markers/${markerId}/comments`)
          .send({ body: `  ${body}  ` })
          .expect(201);
      }
      const page1 = await as(owner)
        .get(`/v1/markers/${markerId}/comments?limit=2`)
        .expect(200);
      expect(page1.body.items.map((c: CommentBody) => c.body)).toEqual([
        'First',
        'Second',
      ]);
      expect(page1.body.items[0]).toMatchObject({
        author: { username: 'stranger' },
        canDelete: true,
        likedByMe: false,
      });
      const page2 = await as(owner)
        .get(
          `/v1/markers/${markerId}/comments?limit=2&cursor=${page1.body.nextCursor}`,
        )
        .expect(200);
      expect(page2.body.items.map((c: CommentBody) => c.body)).toEqual([
        'Third',
      ]);
      expect(page2.body.nextCursor).toBeNull();

      const asEditor = await as(editor).get(`/v1/markers/${markerId}/comments`);
      expect(asEditor.body.items[0].canDelete).toBe(false);
      const marker = await as(owner).get(`/v1/markers/${markerId}`);
      expect(marker.body.commentCount).toBe(3);
    });

    it('validates the body', async () => {
      for (const body of ['', '   ', 'x'.repeat(1001)]) {
        const response = await as(stranger)
          .post(`/v1/markers/${markerId}/comments`)
          .send({ body })
          .expect(400);
        expect(response.body.error.details.fields.body).toBeDefined();
      }
    });

    it('keeps comments on private trips to members', async () => {
      const secret = await createTrip(owner, 'Secret', 'private', ['editor']);
      const secretMarker = await addMarker(owner, secret.days[0].id, placeId);
      await as(stranger)
        .post(`/v1/markers/${secretMarker}/comments`)
        .send({ body: 'Hi' })
        .expect(404);
      await as(stranger)
        .get(`/v1/markers/${secretMarker}/comments`)
        .expect(404);
      await as(editor)
        .post(`/v1/markers/${secretMarker}/comments`)
        .send({ body: 'Booked' })
        .expect(201);
    });

    it('filters and refuses comments across a block', async () => {
      await as(editor)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'From the editor' })
        .expect(201);
      await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'From a stranger' })
        .expect(201);
      await as(stranger).post(`/v1/users/${editor.userId}/block`).expect(204);

      const list = await as(stranger).get(`/v1/markers/${markerId}/comments`);
      expect(list.body.items.map((c: CommentBody) => c.body)).toEqual([
        'From a stranger',
      ]);

      // The editor's own marker: the stranger can't comment on it.
      const editorsMarker = await addMarker(editor, trip.days[1].id, placeId);
      await as(stranger)
        .post(`/v1/markers/${editorsMarker}/comments`)
        .send({ body: 'Hm' })
        .expect(403);
    });

    it('lets the author and the trip owner delete', async () => {
      const make = async (session: Session) =>
        (
          await as(session)
            .post(`/v1/markers/${markerId}/comments`)
            .send({ body: 'x' })
            .expect(201)
        ).body as CommentBody;
      const byStranger = await make(stranger);
      const byEditor = await make(editor);

      await as(editor).delete(`/v1/comments/${byStranger.id}`).expect(403);
      await as(owner).delete(`/v1/comments/${byStranger.id}`).expect(204);
      await as(editor).delete(`/v1/comments/${byEditor.id}`).expect(204);
      await as(owner).delete(`/v1/comments/${byEditor.id}`).expect(404);

      const marker = await as(owner).get(`/v1/markers/${markerId}`);
      expect(marker.body.commentCount).toBe(0);
    });
  });

  describe('copying', () => {
    it('copies a public trip as a new, independent trip', async () => {
      await as(owner)
        .post(`/v1/days/${trip.days[1].id}/markers`)
        .send({
          name: 'Naschmarkt',
          location: { lat: 48.1985, lng: 16.3634 },
        });
      await readyPhoto(app, owner, markerId);
      await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Nice' })
        .expect(201);
      await as(stranger).put(`/v1/likes/marker/${markerId}`).expect(200);
      await as(stranger)
        .patch('/v1/me')
        .send({ defaultTripVisibility: 'private' })
        .expect(200);

      const { body: copy } = await as(stranger)
        .post(`/v1/trips/${trip.id}/copy`)
        .expect(201);
      expect(copy).toMatchObject({
        title: 'Vienna',
        startDate: '2026-10-09',
        endDate: '2026-10-10',
        visibility: 'private',
        owner: { username: 'stranger' },
        myRole: 'owner',
        members: [{ user: { username: 'stranger' }, role: 'owner' }],
        likeCount: 0,
        copyCount: 0,
        copiedFrom: { tripId: trip.id, owner: { username: 'owner' } },
      });
      expect(copy.id).not.toBe(trip.id);
      expect(copy.days).toHaveLength(2);
      expect(copy.days[0].markers[0]).toMatchObject({
        name: 'Albertina',
        placeId,
        time: '10:00',
        position: 0,
        photoCount: 0,
        coverPhotoId: null,
        likeCount: 0,
        commentCount: 0,
        createdBy: { username: 'stranger' },
      });
      expect(copy.days[1].markers[0].name).toBe('Naschmarkt');

      const source = await as(owner).get(`/v1/trips/${trip.id}`);
      expect(source.body.copyCount).toBe(1);

      // The copy outlives the source; the link is cleared.
      await as(owner).delete(`/v1/trips/${trip.id}`).expect(204);
      const after = await as(stranger).get(`/v1/trips/${copy.id}`);
      expect(after.body.copiedFrom).toBeNull();
      expect(after.body.days[0].markers).toHaveLength(1);
    });

    it('refuses own and private trips', async () => {
      const own = await as(owner).post(`/v1/trips/${trip.id}/copy`).expect(403);
      expect(own.body.error.code).toBe('TRIP_NOT_COPYABLE');

      const secret = await createTrip(owner, 'Secret', 'private', ['editor']);
      await as(stranger).post(`/v1/trips/${secret.id}/copy`).expect(404);
      const asEditor = await as(editor)
        .post(`/v1/trips/${secret.id}/copy`)
        .expect(403);
      expect(asEditor.body.error.code).toBe('TRIP_NOT_COPYABLE');
    });

    it('copies a marker into one of my trips', async () => {
      const mine = await createTrip(stranger, 'My Vienna', 'private');
      const { body: copied } = await as(stranger)
        .post(`/v1/markers/${markerId}/copy`)
        .send({ dayId: mine.days[1].id })
        .expect(201);
      expect(copied).toMatchObject({
        tripId: mine.id,
        dayId: mine.days[1].id,
        placeId,
        name: 'Albertina',
        time: '10:00',
        position: 0,
        createdBy: { username: 'stranger' },
      });
      const row = await prisma.marker.findUniqueOrThrow({
        where: { id: copied.id },
      });
      expect(row.copiedFromMarkerId).toBe(markerId);

      // Not into someone else's trip, not from my own trip.
      await as(stranger)
        .post(`/v1/markers/${markerId}/copy`)
        .send({ dayId: trip.days[0].id })
        .expect(403);
      const own = await as(owner)
        .post(`/v1/markers/${markerId}/copy`)
        .send({ dayId: trip.days[1].id })
        .expect(403);
      expect(own.body.error.code).toBe('TRIP_NOT_COPYABLE');
      await as(stranger)
        .post(`/v1/markers/${markerId}/copy`)
        .send({ dayId: 'nope' })
        .expect(400);
    });
  });

  describe('explore', () => {
    it('ranks public trips of others by likes and copies, newest on ties', async () => {
      const second = await createTrip(editor, 'Budapest', 'public');
      await addMarker(editor, second.days[0].id, placeId);
      const third = await createTrip(editor, 'Graz', 'public');
      await addMarker(editor, third.days[0].id, placeId);
      // Not listed: empty, private, my own.
      await createTrip(editor, 'Empty', 'public');
      const secret = await createTrip(editor, 'Secret', 'private');
      await addMarker(editor, secret.days[0].id, placeId);
      const own = await createTrip(stranger, 'Mine', 'public');
      await addMarker(stranger, own.days[0].id, placeId);

      await as(stranger).put(`/v1/likes/trip/${third.id}`).expect(200);
      await as(owner).put(`/v1/likes/trip/${third.id}`).expect(200);
      await as(stranger).post(`/v1/trips/${trip.id}/copy`).expect(201);

      const all = await as(stranger).get('/v1/explore/trips').expect(200);
      // Graz: 2 likes; Vienna: 1 copy (counts 2); Budapest: 0, and newer than Vienna.
      expect(all.body.items.map((t: { title: string }) => t.title)).toEqual([
        'Graz',
        'Vienna',
        'Budapest',
      ]);
      expect(all.body.items[0]).toMatchObject({
        likedByMe: true,
        likeCount: 2,
        role: 'viewer',
      });

      const page1 = await as(stranger)
        .get('/v1/explore/trips?limit=2')
        .expect(200);
      const page2 = await as(stranger)
        .get(`/v1/explore/trips?limit=2&cursor=${page1.body.nextCursor}`)
        .expect(200);
      expect(
        [...page1.body.items, ...page2.body.items].map(
          (t: { title: string }) => t.title,
        ),
      ).toEqual(['Graz', 'Vienna', 'Budapest']);
      expect(page2.body.nextCursor).toBeNull();

      await as(stranger).post(`/v1/users/${editor.userId}/block`).expect(204);
      const afterBlock = await as(stranger).get('/v1/explore/trips');
      expect(
        afterBlock.body.items.map((t: { title: string }) => t.title),
      ).toEqual(['Vienna']);

      await as(stranger).get('/v1/explore/trips?cursor=nope').expect(400);
    });
  });

  describe('profiles', () => {
    it('shows public trips and hides profiles across a block', async () => {
      await createTrip(owner, 'Secret', 'private');
      const profile = await as(stranger).get('/v1/users/Owner').expect(200);
      expect(profile.body).toMatchObject({
        user: { username: 'owner' },
        publicTripCount: 1,
        nextCursor: null,
      });
      expect(profile.body.trips.map((t: { id: string }) => t.id)).toEqual([
        trip.id,
      ]);

      // Fixed paths under /users still resolve.
      await as(stranger).get('/v1/users/search?q=ow').expect(200);
      await as(stranger).get('/v1/users/nobody').expect(404);
      await as(owner).post(`/v1/users/${stranger.userId}/block`).expect(204);
      await as(stranger).get('/v1/users/owner').expect(404);
    });
  });

  describe('places', () => {
    it('shows the cover of the most liked public marker and likedByMe', async () => {
      const photoId = await readyPhoto(app, owner, markerId);
      await as(stranger).put(`/v1/likes/marker/${markerId}`).expect(200);
      await as(stranger).put(`/v1/likes/place/${placeId}`).expect(200);

      const bbox = '16.36,48.20,16.38,48.21';
      const inView = await as(stranger)
        .get(`/v1/places/in-view?bbox=${bbox}&zoom=15`)
        .expect(200);
      const item = inView.body.places.find(
        (p: { id: string }) => p.id === placeId,
      );
      expect(item).toMatchObject({ likeCount: 2, likedByMe: true });
      expect(item.coverThumbUrl).toContain(`photos/${photoId}/thumb.webp`);

      // Cached for everyone, personalized per viewer.
      const forEditor = await as(editor)
        .get(`/v1/places/in-view?bbox=${bbox}&zoom=15`)
        .expect(200);
      expect(
        forEditor.body.places.find((p: { id: string }) => p.id === placeId)
          .likedByMe,
      ).toBe(false);

      const detail = await as(stranger).get(`/v1/places/${placeId}`);
      expect(detail.body.photoThumbUrls).toHaveLength(1);

      // Across a block, the owner's photos aren't shown.
      await as(owner).post(`/v1/users/${stranger.userId}/block`).expect(204);
      const blocked = await as(stranger).get(`/v1/places/${placeId}`);
      expect(blocked.body.coverThumbUrl).toBeNull();
      expect(blocked.body.photoThumbUrls).toEqual([]);
    });
  });

  describe('counters', () => {
    it('rebuilds drifted counters from source rows', async () => {
      await as(stranger).put(`/v1/likes/marker/${markerId}`).expect(200);
      await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Hi' })
        .expect(201);
      await prisma.marker.update({
        where: { id: markerId },
        data: { likeCount: 7, commentCount: 9 },
      });
      await prisma.place.update({
        where: { id: placeId },
        data: { popularity: 42 },
      });
      await prisma.trip.update({
        where: { id: trip.id },
        data: { likeCount: 3 },
      });

      const fixed = await new CountersService(prisma).recountAll();
      expect(fixed).toMatchObject({
        'trips.likeCount': 1,
        'markers.likeCount': 1,
        'markers.commentCount': 1,
        'places.popularity': 1,
      });
      const marker = await prisma.marker.findUniqueOrThrow({
        where: { id: markerId },
      });
      expect(marker).toMatchObject({ likeCount: 1, commentCount: 1 });
      expect(await popularity()).toBe(1);
      expect(
        (await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } }))
          .likeCount,
      ).toBe(0);
    });
  });
});
