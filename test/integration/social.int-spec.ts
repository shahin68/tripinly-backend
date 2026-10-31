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
import { readyPhoto, readyPlacePhoto } from '../utils/photos';
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
    it("marks a stop's place hot: every stop there shows its count", async () => {
      const first = await as(stranger)
        .put(`/v1/places/${placeId}/hot`)
        .expect(200);
      expect(first.body).toEqual({ placeId, hot: true, hotCount: 1 });
      // Idempotent: one hot mark per person per place.
      await as(stranger).put(`/v1/places/${placeId}/hot`).expect(200);
      const marker = await as(stranger).get(`/v1/markers/${markerId}`);
      expect(marker.body).toMatchObject({
        hotCount: 1,
        hotByMe: true,
        canMarkHot: true,
      });
      const forOwner = await as(owner).get(`/v1/trips/${trip.id}`);
      expect(forOwner.body.days[0].markers[0]).toMatchObject({
        hotCount: 1,
        hotByMe: false,
      });
      // Another trip's stop at the same place shows the same count.
      const other = await createTrip(stranger, 'Vienna too', 'public');
      const otherMarker = await addMarker(stranger, other.days[0].id, placeId);
      expect(
        (await as(stranger).get(`/v1/markers/${otherMarker}`)).body,
      ).toMatchObject({ hotCount: 1, hotByMe: true });
      expect(await popularity()).toBe(1);

      const place = await as(stranger).get(`/v1/places/${placeId}`);
      expect(place.body).toMatchObject({ isTripinly: true, hotCount: 1 });

      const removed = await as(stranger)
        .delete(`/v1/places/${placeId}/hot`)
        .expect(200);
      expect(removed.body).toEqual({ placeId, hot: false, hotCount: 0 });
      await as(stranger).delete(`/v1/places/${placeId}/hot`).expect(200);
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

    it('keeps private trips to members, and their custom spots without a flame', async () => {
      const secret = await createTrip(owner, 'Secret', 'private', ['editor']);
      const secretMarker = await addMarker(owner, secret.days[0].id, placeId);
      await as(stranger).put(`/v1/likes/trip/${secret.id}`).expect(404);
      await as(stranger).get(`/v1/markers/${secretMarker}`).expect(404);

      // An OSM place is anyone's to mark hot, from a private trip too.
      await as(editor).put(`/v1/places/${placeId}/hot`).expect(200);
      expect(await popularity()).toBe(1);

      // A custom spot only in private trips has no flame button.
      const pin = await as(owner)
        .post(`/v1/days/${secret.days[0].id}/markers`)
        .send({ name: 'Our flat', location: { lat: 48.19, lng: 16.35 } })
        .expect(201);
      expect(pin.body).toMatchObject({ canMarkHot: false, hotCount: 0 });
      await as(editor).put(`/v1/places/${pin.body.placeId}/hot`).expect(404);

      // Going public gives it a flame; private again takes its marks out of the count.
      await as(owner)
        .patch(`/v1/trips/${secret.id}`)
        .send({ visibility: 'public' })
        .expect(200);
      expect(
        (await as(editor).get(`/v1/markers/${pin.body.id}`)).body,
      ).toMatchObject({ canMarkHot: true });
      await as(editor).put(`/v1/places/${pin.body.placeId}/hot`).expect(200);
      expect(await popularity(pin.body.placeId)).toBe(1);
      await as(owner)
        .patch(`/v1/trips/${secret.id}`)
        .send({ visibility: 'private' })
        .expect(200);
      expect(await popularity(pin.body.placeId)).toBe(0);
      expect(
        (await as(editor).get(`/v1/markers/${pin.body.id}`)).body,
      ).toMatchObject({ canMarkHot: false, hotCount: 0 });
      await as(stranger).get(`/v1/places/${pin.body.placeId}`).expect(404);
      expect(await popularity()).toBe(1);
    });

    it('marks places hot directly, only places the caller may see', async () => {
      const marked = await as(stranger)
        .put(`/v1/places/${placeId}/hot`)
        .expect(200);
      expect(marked.body).toMatchObject({ hot: true, hotCount: 1 });
      const detail = await as(stranger).get(`/v1/places/${placeId}`);
      expect(detail.body).toMatchObject({ hotByMe: true, hotCount: 1 });

      // A custom pin in a private trip isn't visible to others.
      const secret = await createTrip(owner, 'Secret', 'private');
      const pin = await as(owner)
        .post(`/v1/days/${secret.days[0].id}/markers`)
        .send({ name: 'Our flat', location: { lat: 48.19, lng: 16.35 } })
        .expect(201);
      await as(stranger).put(`/v1/places/${pin.body.placeId}/hot`).expect(404);
    });

    it('keeps hot marks when stops move or go, until a custom spot goes', async () => {
      await as(stranger).put(`/v1/places/${placeId}/hot`).expect(200);
      const other = await insertPlace(app, {
        name: 'Hofburg',
        lat: 48.2065,
        lng: 16.3654,
      });
      await as(owner)
        .patch(`/v1/markers/${markerId}`)
        .send({ placeId: other })
        .expect(200);
      expect(await popularity()).toBe(1);
      expect(await popularity(other)).toBe(0);
      await as(owner).delete(`/v1/markers/${markerId}`).expect(204);
      expect(await popularity()).toBe(1);

      // A custom spot goes with its last stop, and its hot marks with it.
      const pin = await as(owner)
        .post(`/v1/days/${trip.days[0].id}/markers`)
        .send({ name: 'Hot bench', location: { lat: 48.19, lng: 16.35 } })
        .expect(201);
      await as(stranger).put(`/v1/places/${pin.body.placeId}/hot`).expect(200);
      expect(await popularity(pin.body.placeId)).toBe(1);
      await as(owner).delete(`/v1/markers/${pin.body.id}`).expect(204);
      expect(
        await prisma.place.findUnique({ where: { id: pin.body.placeId } }),
      ).toBeNull();
      expect(await prisma.like.count()).toBe(1);
    });

    it('removes every like with a deleted trip', async () => {
      await as(stranger).put(`/v1/likes/trip/${trip.id}`).expect(200);
      await as(stranger).put(`/v1/places/${placeId}/hot`).expect(200);
      const comment = await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Lovely' })
        .expect(201);
      await as(owner).put(`/v1/likes/comment/${comment.body.id}`).expect(200);
      expect(await prisma.like.count()).toBe(3);

      await as(owner).delete(`/v1/trips/${trip.id}`).expect(204);
      // The place's hot mark belongs to the place, which stays.
      expect(await prisma.like.count()).toBe(1);
      expect(await popularity()).toBe(1);
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
      // Stops have no likes of their own, and places are marked hot instead.
      await as(stranger).put(`/v1/likes/marker/${markerId}`).expect(400);
      await as(stranger).put(`/v1/likes/place/${placeId}`).expect(400);
      await as(stranger)
        .put('/v1/places/00000000-0000-4000-8000-000000000000/hot')
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

  describe('saving and joining trips, copying markers', () => {
    it('saves someone else’s public trip as the live original, never a copy', async () => {
      await as(stranger).put(`/v1/trips/${trip.id}/save`).expect(204);
      await as(stranger).put(`/v1/trips/${trip.id}/save`).expect(204);
      expect(await prisma.trip.count()).toBe(1);

      const mine = await as(stranger).get('/v1/me/trips').expect(200);
      expect(mine.body.items).toEqual([
        expect.objectContaining({
          id: trip.id,
          owner: expect.objectContaining({ username: 'owner' }),
          role: 'viewer',
          savedByMe: true,
          saveCount: 1,
        }),
      ]);
      const detail = await as(stranger).get(`/v1/trips/${trip.id}`);
      expect(detail.body).toMatchObject({
        myRole: 'viewer',
        savedByMe: true,
        saveCount: 1,
      });
      // Saving is read-only.
      await as(stranger)
        .post(`/v1/days/${trip.days[0].id}/markers`)
        .send({ placeId })
        .expect(403);

      // A private trip isn't listed but the save is kept for when it's public again.
      await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ visibility: 'private' })
        .expect(200);
      expect(
        (await as(stranger).get('/v1/me/trips').expect(200)).body.items,
      ).toEqual([]);
      await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ visibility: 'public' })
        .expect(200);
      expect(
        (await as(stranger).get('/v1/me/trips').expect(200)).body.items,
      ).toHaveLength(1);

      await as(stranger).delete(`/v1/trips/${trip.id}/save`).expect(204);
      await as(stranger).delete(`/v1/trips/${trip.id}/save`).expect(204);
      expect(
        (await as(stranger).get('/v1/me/trips').expect(200)).body.items,
      ).toEqual([]);
    });

    it('refuses saving own, member and private trips, and across a block', async () => {
      await as(owner).put(`/v1/trips/${trip.id}/save`).expect(403);
      await as(editor).put(`/v1/trips/${trip.id}/save`).expect(403);
      const secret = await createTrip(owner, 'Secret', 'private');
      await as(stranger).put(`/v1/trips/${secret.id}/save`).expect(404);

      await as(stranger).put(`/v1/trips/${trip.id}/save`).expect(204);
      await as(owner).post(`/v1/users/${stranger.userId}/block`).expect(204);
      expect(await prisma.tripSave.count()).toBe(0);
      await as(stranger).put(`/v1/trips/${trip.id}/save`).expect(404);
    });

    it('joins as an editor only once the owner accepts', async () => {
      const { body: request } = await as(stranger)
        .post(`/v1/trips/${trip.id}/join-request`)
        .expect(200);
      expect(request).toMatchObject({
        tripId: trip.id,
        user: { username: 'stranger' },
        status: 'pending',
      });
      // Idempotent while pending.
      const again = await as(stranger)
        .post(`/v1/trips/${trip.id}/join-request`)
        .expect(200);
      expect(again.body.id).toBe(request.id);
      expect(
        (await as(stranger).get(`/v1/trips/${trip.id}`)).body,
      ).toMatchObject({ myRole: 'viewer', myJoinRequest: 'pending' });
      // Not a member yet.
      await as(stranger)
        .post(`/v1/days/${trip.days[0].id}/markers`)
        .send({ placeId })
        .expect(403);

      // Only the owner sees and decides requests.
      await as(editor).get(`/v1/trips/${trip.id}/join-requests`).expect(403);
      await as(editor)
        .post(`/v1/join-requests/${request.id}/accept`)
        .expect(404);
      const ownersView = await as(owner).get(`/v1/trips/${trip.id}`);
      expect(ownersView.body.pendingJoinRequestCount).toBe(1);
      const list = await as(owner)
        .get(`/v1/trips/${trip.id}/join-requests`)
        .expect(200);
      expect(list.body).toEqual({
        items: [expect.objectContaining({ id: request.id, status: 'pending' })],
        nextCursor: null,
      });

      await as(stranger).put(`/v1/trips/${trip.id}/save`).expect(204);
      const { body: member } = await as(owner)
        .post(`/v1/join-requests/${request.id}/accept`)
        .expect(200);
      expect(member).toMatchObject({
        user: { username: 'stranger' },
        role: 'editor',
      });
      await as(owner)
        .post(`/v1/join-requests/${request.id}/accept`)
        .expect(404);

      // Same trip, same owner; the save made way for the membership.
      expect(await prisma.trip.count()).toBe(1);
      expect(await prisma.tripSave.count()).toBe(0);
      const joined = await as(stranger).get(`/v1/trips/${trip.id}`);
      expect(joined.body).toMatchObject({
        myRole: 'editor',
        myJoinRequest: null,
        savedByMe: false,
        owner: { username: 'owner' },
      });
      await as(stranger)
        .post(`/v1/days/${trip.days[0].id}/markers`)
        .send({ placeId })
        .expect(201);
      // A member keeps access when the trip turns private.
      await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ visibility: 'private' })
        .expect(200);
      await as(stranger).get(`/v1/trips/${trip.id}`).expect(200);
      await as(stranger).post(`/v1/trips/${trip.id}/join-request`).expect(403);
    });

    it('keeps a declined request declined, and lets a pending one be withdrawn', async () => {
      const { body: request } = await as(stranger)
        .post(`/v1/trips/${trip.id}/join-request`)
        .expect(200);
      await as(owner)
        .post(`/v1/join-requests/${request.id}/decline`)
        .expect(204);
      const refused = await as(stranger)
        .post(`/v1/trips/${trip.id}/join-request`)
        .expect(409);
      expect(refused.body.error.code).toBe('JOIN_REQUEST_DECLINED');
      // Withdrawing doesn't erase a decline.
      await as(stranger)
        .delete(`/v1/trips/${trip.id}/join-request`)
        .expect(204);
      expect(
        (await as(stranger).get(`/v1/trips/${trip.id}`)).body.myJoinRequest,
      ).toBe('declined');
      expect(
        (await as(owner).get(`/v1/trips/${trip.id}/join-requests`)).body.items,
      ).toEqual([]);

      const other = await onboardedUser(app, 'other');
      await as(other).post(`/v1/trips/${trip.id}/join-request`).expect(200);
      await as(other).delete(`/v1/trips/${trip.id}/join-request`).expect(204);
      expect(
        (await as(other).get(`/v1/trips/${trip.id}`)).body.myJoinRequest,
      ).toBeNull();
    });

    it('refuses joining own, member and private trips, and across a block', async () => {
      await as(owner).post(`/v1/trips/${trip.id}/join-request`).expect(403);
      await as(editor).post(`/v1/trips/${trip.id}/join-request`).expect(403);
      const secret = await createTrip(owner, 'Secret', 'private');
      await as(stranger)
        .post(`/v1/trips/${secret.id}/join-request`)
        .expect(404);

      const { body: request } = await as(stranger)
        .post(`/v1/trips/${trip.id}/join-request`)
        .expect(200);
      await as(stranger).post(`/v1/users/${owner.userId}/block`).expect(204);
      expect(await prisma.tripJoinRequest.count()).toBe(0);
      await as(owner)
        .post(`/v1/join-requests/${request.id}/accept`)
        .expect(404);
    });

    it('no longer copies whole trips', async () => {
      await as(stranger).post(`/v1/trips/${trip.id}/copy`).expect(404);
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
    it('ranks public trips (mine too) by likes only, newest on ties', async () => {
      const second = await createTrip(editor, 'Budapest', 'public');
      await addMarker(editor, second.days[0].id, placeId);
      const third = await createTrip(editor, 'Graz', 'public');
      await addMarker(editor, third.days[0].id, placeId);
      // Not listed: empty, private. Listed: my own, as owner.
      await createTrip(editor, 'Empty', 'public');
      const secret = await createTrip(editor, 'Secret', 'private');
      await addMarker(editor, secret.days[0].id, placeId);
      const own = await createTrip(stranger, 'Mine', 'public');
      await addMarker(stranger, own.days[0].id, placeId);

      await as(stranger).put(`/v1/likes/trip/${third.id}`).expect(200);
      await as(owner).put(`/v1/likes/trip/${third.id}`).expect(200);
      await as(stranger).put(`/v1/trips/${trip.id}/save`).expect(204);

      const all = await as(stranger).get('/v1/explore/trips').expect(200);
      // Graz: 2 likes; the rest none (a save doesn't count), newest first.
      expect(all.body.items.map((t: { title: string }) => t.title)).toEqual([
        'Graz',
        'Mine',
        'Budapest',
        'Vienna',
      ]);
      expect(all.body.items[1]).toMatchObject({
        role: 'owner',
        savedByMe: false,
      });
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
      ).toEqual(['Graz', 'Mine', 'Budapest', 'Vienna']);
      expect(page2.body.nextCursor).toBeNull();

      // includeMine=false leaves out what the caller owns (Budapest, Graz) or edits (Vienna).
      const others = await as(editor)
        .get('/v1/explore/trips?includeMine=false')
        .expect(200);
      expect(others.body.items.map((t: { title: string }) => t.title)).toEqual([
        'Mine',
      ]);
      await as(editor).get('/v1/explore/trips?includeMine=maybe').expect(400);

      await as(stranger).post(`/v1/users/${editor.userId}/block`).expect(204);
      const afterBlock = await as(stranger).get('/v1/explore/trips');
      expect(
        afterBlock.body.items.map((t: { title: string }) => t.title),
      ).toEqual(['Mine', 'Vienna']);

      await as(stranger).get('/v1/explore/trips?cursor=nope').expect(400);
    });
    it('filters by period, season and nearby', async () => {
      const budapest = await createTrip(editor, 'Budapest', 'public');
      const pest = await insertPlace(app, {
        name: 'Parliament',
        lat: 47.507,
        lng: 19.0456,
      });
      await addMarker(editor, budapest.days[0].id, pest);
      // Vienna was created 40 days ago and liked twice, Budapest this week and liked once.
      await as(stranger).put(`/v1/likes/trip/${trip.id}`).expect(200);
      await as(editor).put(`/v1/likes/trip/${trip.id}`).expect(200);
      await prisma.trip.update({
        where: { id: trip.id },
        data: { createdAt: new Date(Date.now() - 40 * 86_400_000) },
      });
      await as(stranger).put(`/v1/likes/trip/${budapest.id}`).expect(200);
      const titles = async (query: string) =>
        (
          (await as(stranger).get(`/v1/explore/trips?${query}`).expect(200))
            .body.items as { title: string }[]
        ).map((t) => t.title);

      expect(await titles('period=all')).toEqual(['Vienna', 'Budapest']);
      // Week, month and year keep the trips created in that window, ranked by likes.
      expect(await titles('period=week')).toEqual(['Budapest']);
      expect(await titles('period=month')).toEqual(['Budapest']);
      expect(await titles('period=year')).toEqual(['Vienna', 'Budapest']);

      // Season: only trips travelled in the current season.
      const now = new Date();
      const offSeason = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 6, 1),
      );
      await prisma.trip.update({
        where: { id: trip.id },
        data: { startDate: now, endDate: now },
      });
      await prisma.trip.update({
        where: { id: budapest.id },
        data: { startDate: offSeason, endDate: offSeason },
      });
      expect(await titles('period=season')).toEqual(['Vienna']);

      // Nearby: a stop within the radius (50 km), with any period.
      const near = `lat=${ALBERTINA.lat}&lng=${ALBERTINA.lng}`;
      expect(await titles(near)).toEqual(['Vienna']);
      expect(await titles(`${near}&period=year`)).toEqual(['Vienna']);
      expect(await titles(`${near}&period=week`)).toEqual([]);
      expect(await titles('lat=47.5&lng=19.05')).toEqual(['Budapest']);

      await as(stranger).get('/v1/explore/trips?period=day').expect(400);
      await as(stranger).get('/v1/explore/trips?lat=48.2').expect(400);
      await as(stranger).get('/v1/explore/trips?lat=200&lng=16').expect(400);
    });
  });

  describe('profiles', () => {
    it('shows public trips and hides profiles across a block', async () => {
      const secret = await createTrip(owner, 'Secret', 'private');
      const profile = await as(stranger).get('/v1/users/Owner').expect(200);
      expect(profile.body).toMatchObject({
        user: { username: 'owner' },
        publicTripCount: 1,
        nextCursor: null,
      });
      expect(profile.body.trips.map((t: { id: string }) => t.id)).toEqual([
        trip.id,
      ]);

      // My own profile lists my private trips too; the count stays public.
      const mine = await as(owner).get('/v1/users/owner').expect(200);
      expect(mine.body.publicTripCount).toBe(1);
      expect(
        (mine.body.trips as { id: string }[]).map((t) => t.id).sort(),
      ).toEqual([trip.id, secret.id].sort());

      // Fixed paths under /users still resolve.
      await as(stranger).get('/v1/users/search?q=ow').expect(200);
      await as(stranger).get('/v1/users/nobody').expect(404);
      await as(owner).post(`/v1/users/${stranger.userId}/block`).expect(204);
      await as(stranger).get('/v1/users/owner').expect(404);
    });
  });

  describe('places', () => {
    const bbox = '16.36,48.20,16.38,48.21';

    const inViewItem = async (viewer: Session) => {
      const { body } = await as(viewer)
        .get(`/v1/places/in-view?bbox=${bbox}&zoom=15`)
        .expect(200);
      return (body.places as { id: string }[]).find(
        (p) => p.id === placeId,
      ) as Record<string, unknown>;
    };

    const detail = async (viewer: Session) =>
      (await as(viewer).get(`/v1/places/${placeId}`).expect(200)).body as {
        coverPhotoId: string | null;
        coverThumbUrl: string | null;
        photoThumbUrls: string[];
        images: { id: string; source: string; credit: unknown }[];
      };

    const likePhoto = (session: Session, photoId: string) =>
      as(session).put(`/v1/likes/photo/${photoId}`).expect(200);

    const people = (...subjects: string[]) =>
      Promise.all(subjects.map((subject) => onboardedUser(app, subject)));

    it('shows no cover or detail photo for a photo nobody liked', async () => {
      await readyPhoto(app, owner, markerId);
      await as(stranger).put(`/v1/places/${placeId}/hot`).expect(200);

      const item = await inViewItem(stranger);
      expect(item).toMatchObject({
        hotCount: 1,
        hotByMe: true,
        coverPhotoId: null,
        coverThumbUrl: null,
      });
      const place = await detail(stranger);
      expect(place).toMatchObject({ coverPhotoId: null, coverThumbUrl: null });
      expect(place.photoThumbUrls).toEqual([]);
    });

    it("counts three likes from anyone but the uploader, the trip's members too", async () => {
      const photoId = await readyPhoto(app, owner, markerId);
      await likePhoto(owner, photoId);
      await likePhoto(editor, photoId);
      await likePhoto(stranger, photoId);
      expect(await detail(stranger)).toMatchObject({
        coverPhotoId: null,
        photoThumbUrls: [],
      });

      const [other] = await people('other');
      await likePhoto(other, photoId);
      expect((await detail(stranger)).coverPhotoId).toBe(photoId);
    });

    it('shows a photo three people liked, in every place shape', async () => {
      const photoId = await readyPhoto(app, owner, markerId);
      const [other] = await people('other');
      await likePhoto(stranger, photoId);
      await likePhoto(editor, photoId);
      await likePhoto(other, photoId);
      await as(other).put(`/v1/places/${placeId}/hot`).expect(200);

      const item = await inViewItem(stranger);
      expect(item).toMatchObject({
        coverPhotoId: photoId,
        coverSource: 'trip',
      });
      expect(item.coverThumbUrl).toContain(`photos/${photoId}/thumb.webp`);
      const place = await detail(stranger);
      expect(place.coverPhotoId).toBe(photoId);
      expect(place.photoThumbUrls).toHaveLength(1);

      // Cached for everyone, personalized per viewer.
      expect(await inViewItem(editor)).toMatchObject({
        coverPhotoId: photoId,
        hotByMe: false,
      });

      const popular = await as(stranger)
        .get(`/v1/places/popular?bbox=${bbox}`)
        .expect(200);
      expect(popular.body.items).toEqual([
        expect.objectContaining({ id: placeId, coverPhotoId: photoId }),
      ]);
      const nearby = await as(stranger)
        .get(`/v1/places/nearby?lat=${ALBERTINA.lat}&lng=${ALBERTINA.lng}`)
        .expect(200);
      expect(
        (nearby.body.items as { id: string }[]).find((p) => p.id === placeId),
      ).toMatchObject({ coverPhotoId: photoId });
    });

    it('falls back to the Commons image, with its credit, until a photo qualifies', async () => {
      const commons = await app.get(PrismaService).placeImage.create({
        data: {
          placeId,
          origin: 'wikidata_p18',
          commonsTitle: 'File:Albertina Wien.jpg',
          status: 'ready',
          width: 1280,
          height: 853,
          authorText: 'Jane Doe',
          licenseCode: 'cc-by-sa-3.0-at',
          licenseShortName: 'CC BY-SA 3.0 at',
          licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/at',
        },
      });
      // Not ready yet: never shown.
      await app.get(PrismaService).placeImage.create({
        data: { placeId, origin: 'osm_image', commonsTitle: 'File:Other.jpg' },
      });

      expect(await inViewItem(stranger)).toMatchObject({
        coverPhotoId: null,
        coverImageId: commons.id,
        coverSource: 'commons',
        coverThumbUrl: expect.stringContaining(
          `place-images/${commons.id}/thumb.webp`,
        ),
      });
      const before = await detail(stranger);
      expect(before.images).toEqual([
        {
          id: commons.id,
          source: 'commons',
          thumbUrl: expect.stringContaining(
            `place-images/${commons.id}/thumb.webp`,
          ),
          displayUrl: expect.stringContaining(
            `place-images/${commons.id}/display.webp`,
          ),
          width: 1280,
          height: 853,
          credit: {
            author: 'Jane Doe',
            title: 'Albertina Wien',
            license: 'CC BY-SA 3.0 at',
            licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/at',
            sourceUrl:
              'https://commons.wikimedia.org/wiki/File:Albertina_Wien.jpg',
          },
        },
      ]);

      const photoId = await readyPhoto(app, owner, markerId);
      for (const session of await people('ada', 'ben', 'cal'))
        await likePhoto(session, photoId);
      expect(await inViewItem(stranger)).toMatchObject({
        coverPhotoId: photoId,
        coverImageId: photoId,
        coverSource: 'trip',
      });
      const after = await detail(stranger);
      expect(after.images.map((image) => [image.id, image.source])).toEqual([
        [photoId, 'trip'],
        [commons.id, 'commons'],
      ]);
      expect(after.images[0].credit).toBeNull();
    });

    it("picks the most liked photo, the place's own photos too, the newer on a tie", async () => {
      const [a, b, c] = await people('ada', 'ben', 'cal');
      const tripPhoto = await readyPhoto(app, owner, markerId);
      for (const session of [a, b, c]) await likePhoto(session, tripPhoto);
      const best = await readyPlacePhoto(app, stranger, placeId);
      for (const session of [a, b, c, editor]) await likePhoto(session, best);
      const newer = await readyPlacePhoto(app, editor, placeId);
      for (const session of [a, b, c]) await likePhoto(session, newer);

      const place = await detail(owner);
      expect(place.coverPhotoId).toBe(best);
      expect(place.images.map((image) => [image.id, image.source])).toEqual([
        [best, 'trip'],
        [newer, 'trip'],
        [tripPhoto, 'trip'],
      ]);
    });

    it('leaves out photos of suspended people', async () => {
      const photoId = await readyPlacePhoto(app, editor, placeId);
      for (const session of await people('ada', 'ben', 'cal'))
        await likePhoto(session, photoId);
      expect((await detail(stranger)).coverPhotoId).toBe(photoId);

      await prisma.user.update({
        where: { id: editor.userId },
        data: { status: 'suspended' },
      });
      expect((await detail(stranger)).coverPhotoId).toBeNull();
    });

    it("leaves out trip photos across a block, but not the place's own photos", async () => {
      const likers = await people('ada', 'ben', 'cal');
      // The editor's photo in the owner's public trip.
      const photoId = await readyPhoto(app, editor, markerId);
      for (const session of likers) await likePhoto(session, photoId);
      expect((await detail(stranger)).coverPhotoId).toBe(photoId);

      await as(editor).post(`/v1/users/${stranger.userId}/block`).expect(204);
      expect(await detail(stranger)).toMatchObject({
        coverPhotoId: null,
        coverThumbUrl: null,
        photoThumbUrls: [],
      });
      // Others still see it.
      expect((await detail(likers[0])).coverPhotoId).toBe(photoId);

      // A place photo stays the place's image for everyone: the pin names no one.
      const placePhoto = await readyPlacePhoto(app, editor, placeId);
      for (const session of likers) await likePhoto(session, placePhoto);
      expect((await detail(stranger)).coverPhotoId).toBe(placePhoto);

      // A block with the trip owner hides the trip photo too.
      await as(stranger).delete(`/v1/users/${editor.userId}/block`);
      await as(stranger).post(`/v1/users/${owner.userId}/block`).expect(204);
      expect((await detail(stranger)).images.map((image) => image.id)).toEqual([
        placePhoto,
      ]);
    });
  });

  describe('counters', () => {
    it('rebuilds drifted counters from source rows', async () => {
      await as(stranger).put(`/v1/places/${placeId}/hot`).expect(200);
      await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Hi' })
        .expect(201);
      await prisma.marker.update({
        where: { id: markerId },
        data: { commentCount: 9 },
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
        'markers.commentCount': 1,
        'places.popularity': 1,
      });
      const marker = await prisma.marker.findUniqueOrThrow({
        where: { id: markerId },
      });
      expect(marker).toMatchObject({ commentCount: 1 });
      expect(await popularity()).toBe(1);
      expect(
        (await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } }))
          .likeCount,
      ).toBe(0);
    });
  });
});
