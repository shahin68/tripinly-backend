import type { INestApplication } from '@nestjs/common';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { PhotoProcessingModule } from '../../src/modules/photos/photo-processing.module';
import {
  devSignIn,
  onboardedUser,
  publishLegalDocuments,
  resetState,
  type Session,
} from '../utils/auth-helpers';
import { api, type TripBody } from '../utils/api';
import { createTestApp } from '../utils/create-test-app';
import { jpegWithGps, readyPhoto } from '../utils/photos';
import { insertPlace } from '../utils/places';
import {
  connect,
  connectWithToken,
  realtimeUrl,
  sleep,
  type TestSocket,
} from '../utils/realtime';

describe('Realtime (integration)', () => {
  let app: INestApplication;
  let url: string;
  let as: ReturnType<typeof api>['as'];
  let owner: Session;
  let editor: Session;
  let stranger: Session;
  let publicTrip: TripBody;
  let privateTrip: TripBody;
  let placeId: string;
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    app = await createTestApp({ imports: [PhotoProcessingModule] });
    url = await realtimeUrl(app);
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
    placeId = await insertPlace(app, {
      name: 'Albertina',
      lat: 48.2046,
      lng: 16.3683,
    });
    publicTrip = await createTrip('Vienna', 'public');
    privateTrip = await createTrip('Budapest', 'private');
  });

  afterEach(() => {
    while (sockets.length) sockets.pop()!.close();
  });

  async function createTrip(
    title: string,
    visibility: 'public' | 'private',
  ): Promise<TripBody> {
    return (
      await as(owner)
        .post('/v1/trips')
        .send({ title, visibility, memberUsernames: ['editor'] })
        .expect(201)
    ).body as TripBody;
  }

  async function open(session: Session): Promise<TestSocket> {
    const socket = await connect(url, session);
    sockets.push(socket);
    return socket;
  }

  async function subscribed(
    session: Session,
    tripId: string,
  ): Promise<TestSocket> {
    const socket = await open(session);
    expect(await socket.subscribe(tripId)).toEqual({ ok: true, tripId });
    return socket;
  }

  async function addMarker(session: Session, trip: TripBody): Promise<string> {
    const { body } = await as(session)
      .post(`/v1/days/${trip.days[0].id}/markers`)
      .send({ placeId })
      .expect(201);
    return (body as { id: string }).id;
  }

  describe('handshake', () => {
    it('rejects missing, invalid and expired tokens', async () => {
      await expect(connectWithToken(url)).rejects.toThrow('UNAUTHENTICATED');
      await expect(connectWithToken(url, 'nope')).rejects.toThrow(
        'UNAUTHENTICATED',
      );
      const expired = await signToken(owner.userId, -10);
      await expect(connectWithToken(url, expired)).rejects.toThrow(
        'TOKEN_EXPIRED',
      );
    });

    it('rejects users who have not finished onboarding', async () => {
      const newcomer = await devSignIn(app, 'newcomer', 'Newcomer');
      await expect(connect(url, newcomer)).rejects.toThrow(
        'ONBOARDING_INCOMPLETE',
      );
    });

    it('closes the socket when the access token expires', async () => {
      const socket = await connectWithToken(
        url,
        await signToken(owner.userId, 1),
      );
      sockets.push(socket);
      const disconnected = new Promise<string>((resolve) =>
        socket.socket.once('disconnect', resolve),
      );
      await socket.waitFor('error', undefined, 3000).catch(() => undefined);
      expect(await disconnected).toBe('io server disconnect');
      expect(socket.received).toContainEqual(
        expect.objectContaining({ event: 'error' }),
      );
    });
  });

  describe('trip rooms', () => {
    it('refuses to subscribe to a private trip without access, and to bad ids', async () => {
      const socket = await open(stranger);
      expect(await socket.subscribe(privateTrip.id)).toEqual({
        ok: false,
        tripId: privateTrip.id,
        error: { code: 'NOT_FOUND' },
      });
      expect(await socket.subscribe('not-a-uuid')).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
      await as(editor).post(`/v1/trips/${privateTrip.id}/days`).expect(201);
      await sleep(300);
      expect(socket.events('day.created')).toEqual([]);
    });

    it('delivers changes to members, including the actor, with viewer-neutral payloads', async () => {
      const ownerSocket = await subscribed(owner, privateTrip.id);
      const editorSocket = await subscribed(editor, privateTrip.id);

      await as(owner).put(`/v1/likes/trip/${privateTrip.id}`).expect(200);
      const markerId = await addMarker(owner, privateTrip);

      const event = await editorSocket.waitFor<{
        marker: { id: string; likedByMe: boolean };
      }>('marker.created');
      expect(event).toMatchObject({
        event: 'marker.created',
        tripId: privateTrip.id,
        actorId: owner.userId,
        data: { marker: { id: markerId, likedByMe: false } },
      });
      expect(typeof event.at).toBe('string');
      await ownerSocket.waitFor('marker.created');

      await as(owner).put(`/v1/likes/marker/${markerId}`).expect(200);
      await as(owner)
        .patch(`/v1/markers/${markerId}`)
        .send({ time: '09:30' })
        .expect(200);
      const updated = await editorSocket.waitFor<{
        marker: { likedByMe: boolean; likeCount: number };
      }>('marker.updated');
      expect(updated.data.marker).toMatchObject({
        likedByMe: false,
        likeCount: 1,
      });
    });

    it('carries events raised by photo processing', async () => {
      const markerId = await addMarker(owner, publicTrip);
      const socket = await subscribed(stranger, publicTrip.id);
      const photoId = await readyPhoto(
        app,
        owner,
        markerId,
        await jpegWithGps(),
      );
      const ready = await socket.waitFor<{ photo: { id: string } }>(
        'photo.ready',
      );
      expect(ready.data.photo.id).toBe(photoId);
      await socket.waitFor('marker.cover_changed');
      expect(socket.events('photo.processing')).toHaveLength(1);
    });

    it('throttles like counts to one per target per 2 s, ending on the latest count', async () => {
      const markerId = await addMarker(owner, publicTrip);
      const socket = await subscribed(owner, publicTrip.id);
      await as(stranger).put(`/v1/likes/marker/${markerId}`).expect(200);
      await as(editor).put(`/v1/likes/marker/${markerId}`).expect(200);
      await as(owner).put(`/v1/likes/marker/${markerId}`).expect(200);

      const first = await socket.waitFor<{ count: number }>(
        'like.count_changed',
      );
      expect(first.data).toEqual({
        targetType: 'marker',
        targetId: markerId,
        count: 1,
      });
      await sleep(1000);
      expect(socket.events('like.count_changed')).toHaveLength(1);
      const last = await socket.waitFor<{ count: number }>(
        'like.count_changed',
        (event) => event.data.count === 3,
        3000,
      );
      expect(last.data.count).toBe(3);
      expect(socket.events('like.count_changed')).toHaveLength(2);
    });

    it('deletes: sends trip.deleted, empties the room and updates trip lists', async () => {
      const socket = await subscribed(editor, privateTrip.id);
      await as(owner).delete(`/v1/trips/${privateTrip.id}`).expect(204);
      await socket.waitFor('trip.deleted');
      await socket.waitFor('trips.changed', (event) => {
        const data = event.data as { tripId: string; change: string };
        return data.tripId === privateTrip.id && data.change === 'removed';
      });
    });
  });

  describe('access changes', () => {
    it('evicts non-members when a trip turns private', async () => {
      const strangerSocket = await subscribed(stranger, publicTrip.id);
      const editorSocket = await subscribed(editor, publicTrip.id);

      await as(owner)
        .patch(`/v1/trips/${publicTrip.id}`)
        .send({ visibility: 'private' })
        .expect(200);
      await strangerSocket.waitFor('trip.updated');
      await sleep(200);

      await addMarker(owner, publicTrip);
      await editorSocket.waitFor('marker.created');
      await sleep(300);
      expect(strangerSocket.events('marker.created')).toEqual([]);
      expect(await strangerSocket.subscribe(publicTrip.id)).toMatchObject({
        ok: false,
        error: { code: 'NOT_FOUND' },
      });
    });

    it('tells an added member and a removed member, and evicts them from a private trip', async () => {
      const editorSocket = await subscribed(editor, privateTrip.id);
      const strangerSocket = await open(stranger);

      await as(owner)
        .post(`/v1/trips/${privateTrip.id}/members`)
        .send({ username: 'stranger' })
        .expect(200);
      await strangerSocket.waitFor('trips.changed', (event) => {
        const data = event.data as { change: string };
        return data.change === 'added';
      });
      await editorSocket.waitFor('member.added');

      await as(owner)
        .delete(`/v1/trips/${privateTrip.id}/members/${editor.userId}`)
        .expect(204);
      await editorSocket.waitFor('member.removed');
      await editorSocket.waitFor('trips.changed', (event) => {
        const data = event.data as { change: string };
        return data.change === 'removed';
      });
      await sleep(200);
      await as(owner).post(`/v1/trips/${privateTrip.id}/days`).expect(201);
      await sleep(300);
      expect(editorSocket.events('day.created')).toEqual([]);
    });

    it('never delivers events caused by someone the viewer has a block with', async () => {
      const strangerSocket = await subscribed(stranger, publicTrip.id);
      const ownerSocket = await subscribed(owner, publicTrip.id);
      await as(stranger).post(`/v1/users/${editor.userId}/block`).expect(204);

      await addMarker(editor, publicTrip);
      await ownerSocket.waitFor('marker.created');
      await sleep(300);
      expect(strangerSocket.events('marker.created')).toEqual([]);

      await addMarker(owner, publicTrip);
      await strangerSocket.waitFor('marker.created');
    });

    it('removes a blocked user from the blocker’s trip rooms', async () => {
      const strangerSocket = await subscribed(stranger, publicTrip.id);
      await as(owner).post(`/v1/users/${stranger.userId}/block`).expect(204);
      await sleep(300);
      // A third person's change is no longer delivered either.
      await addMarker(editor, publicTrip);
      await sleep(300);
      expect(strangerSocket.events('marker.created')).toEqual([]);
    });
  });
});

/** An access token like the API issues, with a custom lifetime in seconds. */
function signToken(userId: string, ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: 'user', onb: true })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer('tripinly')
    .setAudience('tripinly-app')
    .setIssuedAt(now - 60)
    .setExpirationTime(now + ttlSeconds)
    .setJti(randomUUID())
    .sign(new TextEncoder().encode(process.env.JWT_ACCESS_SECRET));
}
