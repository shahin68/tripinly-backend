import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { unzipSync, strFromU8 } from 'fflate';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { CoreModule } from '../../src/common/core.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { QueueModule } from '../../src/common/queue/queue.module';
import { StorageService } from '../../src/common/storage/storage.service';
import { AccountWorkerModule } from '../../src/modules/account/account-worker.module';
import { AccountSweeper } from '../../src/modules/account/account.sweeper';
import { EmailProvider } from '../../src/modules/notifications/email/email.provider';
import { EmailWorkerModule } from '../../src/modules/notifications/email/email-worker.module';
import { photoKeys } from '../../src/modules/photos/photo-keys';
import { PhotoProcessingModule } from '../../src/modules/photos/photo-processing.module';
import { PhotosWorkerModule } from '../../src/modules/photos/photos-worker.module';
import {
  devSignIn,
  onboardedUser,
  publishLegalDocuments,
  resetState,
  type Session,
} from '../utils/auth-helpers';
import { api, type TripBody } from '../utils/api';
import { createTestApp } from '../utils/create-test-app';
import { FakeEmailProvider } from '../utils/fake-providers';
import { readyPhoto } from '../utils/photos';
import { insertPlace } from '../utils/places';
import { eventually } from '../utils/realtime';

interface ExportBody {
  id: string;
  status: string;
  bytes: number | null;
  downloadUrl: string | null;
  expiresAt: string | null;
}

describe('Account deletion and export (integration)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let storage: StorageService;
  let as: ReturnType<typeof api>['as'];
  const email = new FakeEmailProvider();
  let placeId: string;

  beforeAll(async () => {
    app = await createTestApp({ imports: [PhotoProcessingModule] });
    const moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        EventEmitterModule.forRoot(),
        QueueModule,
        AccountWorkerModule,
        EmailWorkerModule,
        PhotosWorkerModule,
      ],
    })
      .overrideProvider(EmailProvider)
      .useValue(email)
      .compile();
    worker = await moduleRef.init();
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
    as = api(app).as;
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  beforeEach(async () => {
    await resetState(app);
    email.sent.length = 0;
    await publishLegalDocuments(app);
    placeId = await insertPlace(app, {
      name: 'Albertina',
      lat: 48.2046,
      lng: 16.3683,
    });
  });

  async function withEmail(session: Session, address: string): Promise<void> {
    await prisma.authIdentity.updateMany({
      where: { userId: session.userId },
      data: { email: address },
    });
  }

  async function createTrip(
    session: Session,
    title: string,
    options: { visibility?: 'public' | 'private'; members?: string[] } = {},
  ): Promise<TripBody> {
    return (
      await as(session)
        .post('/v1/trips')
        .send({
          title,
          visibility: options.visibility ?? 'public',
          memberUsernames: options.members ?? [],
        })
        .expect(201)
    ).body as TripBody;
  }

  async function addMarker(session: Session, trip: TripBody): Promise<string> {
    const { body } = await as(session)
      .post(`/v1/days/${trip.days[0].id}/markers`)
      .send({ placeId })
      .expect(201);
    return (body as { id: string }).id;
  }

  describe('DELETE /me', () => {
    it('needs a recent sign-in, also after refreshing', async () => {
      const alice = await onboardedUser(app, 'alice');
      const stale = await signToken(alice.userId, 11 * 60);
      const { body } = await api(app)
        .as({ ...alice, accessToken: stale })
        .delete('/v1/me')
        .expect(403);
      expect(body.error.code).toBe('REAUTH_REQUIRED');

      // A refresh keeps the original sign-in time.
      await prisma.refreshToken.updateMany({
        where: { userId: alice.userId },
        data: { authenticatedAt: new Date(Date.now() - 11 * 60 * 1000) },
      });
      const refreshed = await api(app)
        .anonymous.post('/v1/auth/refresh')
        .send({ refreshToken: alice.refreshToken })
        .expect(200);
      const again = await api(app)
        .as({ ...alice, accessToken: refreshed.body.accessToken as string })
        .delete('/v1/me')
        .expect(403);
      expect(again.body.error.code).toBe('REAUTH_REQUIRED');
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: alice.userId } }))
          .status,
      ).toBe('active');
    });

    it('works while a consent is still owed', async () => {
      const newcomer = await devSignIn(app, 'newcomer', 'Newcomer');
      await as(newcomer).delete('/v1/me').expect(202);
      await eventually(
        async () =>
          (await prisma.user.count({ where: { id: newcomer.userId } })) === 0,
        10_000,
        'newcomer deleted',
      );
    });

    it('deletes everything about the user and keeps what belongs to others', async () => {
      const alice = await onboardedUser(app, 'alice');
      const bob = await onboardedUser(app, 'bob');
      const carol = await onboardedUser(app, 'carol');
      await withEmail(alice, 'alice@example.com');

      // Alice owns a trip shared with Bob, and a public trip Bob copied.
      const shared = await createTrip(alice, 'Shared', {
        visibility: 'private',
        members: ['bob'],
      });
      await addMarker(bob, shared);
      const aliceMarkerPhotoTrip = await addMarker(alice, shared);
      const aliceOwnTripPhoto = await readyPhoto(
        app,
        bob,
        aliceMarkerPhotoTrip,
      );
      const original = await createTrip(alice, 'Original');
      await addMarker(alice, original);
      const copy = (
        await as(bob).post(`/v1/trips/${original.id}/copy`).expect(201)
      ).body as { id: string };

      // Carol's trip, where Alice is an editor, adds a place, comments,
      // uploads the cover photo and likes things.
      const carols = await createTrip(carol, 'Carol', { members: ['alice'] });
      const carolMarker = await addMarker(carol, carols);
      const aliceMarker = await addMarker(alice, carols);
      const alicePhoto = await readyPhoto(app, alice, carolMarker);
      const carolPhoto = await readyPhoto(app, carol, carolMarker);
      await as(alice)
        .post(`/v1/markers/${carolMarker}/comments`)
        .send({ body: 'Lovely' })
        .expect(201);
      await as(alice).put(`/v1/likes/trip/${carols.id}`).expect(200);
      await as(alice).put(`/v1/likes/marker/${carolMarker}`).expect(200);
      await as(alice).put(`/v1/likes/place/${placeId}`).expect(200);
      await as(carol).put(`/v1/likes/marker/${carolMarker}`).expect(200);
      expect(
        (await prisma.place.findUniqueOrThrow({ where: { id: placeId } }))
          .popularity,
      ).toBe(3);
      await as(alice).post(`/v1/users/${bob.userId}/block`).expect(204);
      await as(alice)
        .put('/v1/me/devices/alice-phone-token-000000001')
        .send({ platform: 'android', locale: 'en' })
        .expect(204);
      // Reports by and about Alice.
      await as(alice)
        .post('/v1/reports')
        .send({ targetType: 'trip', targetId: carols.id, reason: 'spam' })
        .expect(201);
      await as(carol)
        .post('/v1/reports')
        .send({ targetType: 'user', targetId: alice.userId, reason: 'spam' })
        .expect(201);

      // Grouped notifications she shares with Bob, and one that is hers alone.
      const sharedNote = await prisma.notification.create({
        data: {
          recipientId: carol.userId,
          type: 'likes_grouped',
          actorId: alice.userId,
          payload: {
            likerIds: [alice.userId, bob.userId],
            tripIds: [carols.id],
          },
          count: 2,
          pushedAt: new Date(),
        },
      });
      await prisma.notification.create({
        data: {
          recipientId: carol.userId,
          type: 'likes_grouped',
          actorId: alice.userId,
          payload: { likerIds: [alice.userId], tripIds: [carols.id] },
          pushedAt: new Date(),
        },
      });

      const { body } = await as(alice).delete('/v1/me').expect(202);
      expect(body).toEqual({ status: 'deleting' });
      // Signed out everywhere at once.
      await as(alice).get('/v1/me').expect(401);
      await api(app)
        .anonymous.post('/v1/auth/refresh')
        .send({ refreshToken: alice.refreshToken })
        .expect(401);

      await eventually(
        async () =>
          (await prisma.user.count({ where: { id: alice.userId } })) === 0,
        20_000,
        'alice deleted',
      );

      // Her trips are gone; Bob's copy stays, unlinked.
      expect(
        await prisma.trip.count({
          where: { id: { in: [shared.id, original.id] } },
        }),
      ).toBe(0);
      expect(
        await prisma.trip.findUniqueOrThrow({ where: { id: copy.id } }),
      ).toMatchObject({ copiedFromTripId: null, ownerId: bob.userId });

      // Carol's trip keeps Alice's place without an author, loses her
      // comment and photo, and the cover passes to Carol's photo.
      expect(
        await prisma.marker.findUniqueOrThrow({ where: { id: aliceMarker } }),
      ).toMatchObject({ createdById: null });
      expect(
        await prisma.marker.findUniqueOrThrow({ where: { id: carolMarker } }),
      ).toMatchObject({
        coverPhotoId: carolPhoto,
        commentCount: 0,
        likeCount: 1,
      });
      expect(await prisma.photo.count({ where: { id: alicePhoto } })).toBe(0);
      expect(
        (await prisma.trip.findUniqueOrThrow({ where: { id: carols.id } }))
          .likeCount,
      ).toBe(0);
      expect(
        (await prisma.place.findUniqueOrThrow({ where: { id: placeId } }))
          .popularity,
      ).toBe(1);

      // Nothing references her any more.
      const id = alice.userId;
      const counts = await Promise.all([
        prisma.tripMember.count({ where: { userId: id } }),
        prisma.like.count({ where: { userId: id } }),
        prisma.comment.count({ where: { authorId: id } }),
        prisma.photo.count({ where: { uploaderId: id } }),
        prisma.notification.count({
          where: { OR: [{ actorId: id }, { recipientId: id }] },
        }),
        prisma.block.count({
          where: { OR: [{ blockerId: id }, { blockedId: id }] },
        }),
        prisma.device.count({ where: { userId: id } }),
        prisma.refreshToken.count({ where: { userId: id } }),
        prisma.authIdentity.count({ where: { userId: id } }),
        prisma.consent.count({ where: { userId: id } }),
        prisma.report.count({ where: { reporterId: id } }),
      ]);
      expect(counts.every((count) => count === 0)).toBe(true);

      expect(
        await prisma.notification.findMany({
          where: { type: 'likes_grouped' },
        }),
      ).toEqual([
        expect.objectContaining({
          id: sharedNote.id,
          actorId: bob.userId,
          count: 1,
          payload: { likerIds: [bob.userId], tripIds: [carols.id] },
        }),
      ]);

      // Kept: a keyed consent proof, the username hold, and her report
      // without a reporter; the report about her is closed.
      const proofs = await prisma.consentProof.findMany();
      expect(proofs.map((p) => p.documentType).sort()).toEqual([
        'privacy',
        'terms',
      ]);
      expect(proofs[0].subjectHash).not.toContain(id);
      expect(proofs[0].retainUntil.getUTCFullYear()).toBe(
        new Date().getUTCFullYear() + 5,
      );
      expect(
        await prisma.usernameHold.findUnique({ where: { username: 'alice' } }),
      ).not.toBeNull();
      const reports = await prisma.report.findMany();
      expect(reports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ targetId: carols.id, reporterId: null }),
          expect.objectContaining({
            targetId: id,
            status: 'dismissed',
            action: 'target_deleted',
          }),
        ]),
      );

      // Files go after the rows; the confirmation email goes last.
      await eventually(
        async () =>
          (await storage.head(photoKeys(alicePhoto).original)) === null &&
          (await storage.head(photoKeys(aliceOwnTripPhoto).original)) === null,
        20_000,
        'files deleted',
      );
      expect(await storage.head(photoKeys(carolPhoto).original)).not.toBeNull();
      await eventually(() => email.sent.length === 1, 10_000, 'email');
      expect(email.sent[0]).toMatchObject({ to: 'alice@example.com' });
      expect(email.sent[0].subject).toContain('deleted');
    });
  });

  describe('DELETE /auth/dev/accounts', () => {
    const accounts = () => request(app.getHttpServer());

    async function gone(userId: string): Promise<void> {
      await eventually(
        async () => (await prisma.user.count({ where: { id: userId } })) === 0,
        10_000,
        'account deleted',
      );
    }

    it('deletes a developer account and frees its username at once', async () => {
      const alice = await onboardedUser(app, 'alice');

      await accounts()
        .delete('/v1/auth/dev/accounts')
        .query({ subject: 'alice' })
        .expect(202, { status: 'deleting' });
      await as(alice).get('/v1/me').expect(401);
      await gone(alice.userId);

      expect(
        await prisma.usernameHold.findUnique({ where: { username: 'alice' } }),
      ).toBeNull();
      const again = await devSignIn(app, 'alice');
      expect(again.userId).not.toBe(alice.userId);
      await as(again).patch('/v1/me').send({ username: 'alice' }).expect(200);
    });

    it('finds any account by username, with or without the @', async () => {
      const bob = await onboardedUser(app, 'bob');

      await accounts()
        .delete('/v1/auth/dev/accounts')
        .query({ username: '@Bob' })
        .expect(202);
      await gone(bob.userId);
      expect(
        await prisma.usernameHold.findUnique({ where: { username: 'bob' } }),
      ).toBeNull();
    });

    it('needs exactly one of subject or username, and a matching account', async () => {
      await onboardedUser(app, 'carol');

      for (const query of [{}, { subject: 'carol', username: 'carol' }]) {
        const { body } = await accounts()
          .delete('/v1/auth/dev/accounts')
          .query(query)
          .expect(400);
        expect(body.error.code).toBe('VALIDATION_FAILED');
      }
      await accounts()
        .delete('/v1/auth/dev/accounts')
        .query({ subject: 'Carol' })
        .expect(404);
      expect(await prisma.user.count()).toBe(1);
    });
  });

  describe('data export', () => {
    it('builds a ZIP once a day, links it, then expires it', async () => {
      const alice = await onboardedUser(app, 'alice');
      await withEmail(alice, 'alice@example.com');
      const trip = await createTrip(alice, 'Vienna');
      const markerId = await addMarker(alice, trip);
      const photoId = await readyPhoto(app, alice, markerId);
      await as(alice)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Go early' })
        .expect(201);
      await as(alice).get('/v1/me/export').expect(404);

      const started = (await as(alice).post('/v1/me/export').expect(202))
        .body as ExportBody;
      expect(started.status).toBe('pending');
      const ready = await eventually(
        async () => {
          const { body } = await as(alice).get('/v1/me/export').expect(200);
          return (body as ExportBody).status === 'ready'
            ? (body as ExportBody)
            : undefined;
        },
        20_000,
        'export ready',
      );
      expect(ready.id).toBe(started.id);
      expect(ready.bytes).toBeGreaterThan(0);

      const zip = unzipSync(
        new Uint8Array(await (await fetch(ready.downloadUrl!)).arrayBuffer()),
      );
      expect(Object.keys(zip).sort()).toEqual(
        [
          'README.txt',
          'blocks.json',
          'comments.json',
          'consents.json',
          'likes.json',
          'notifications.json',
          `photos/${photoId}.jpg`,
          'profile.json',
          'reports.json',
          'trips.json',
        ].sort(),
      );
      const json = (name: string): unknown => JSON.parse(strFromU8(zip[name]));
      expect(json('profile.json')).toMatchObject({
        username: 'alice',
        birthDate: '1990-05-17',
      });
      expect(json('trips.json')).toEqual([
        expect.objectContaining({ id: trip.id, role: 'owner' }),
      ]);
      expect(json('comments.json')).toEqual([
        expect.objectContaining({ body: 'Go early' }),
      ]);
      expect(strFromU8(zip['README.txt'])).toContain('profile.json');

      await eventually(() => email.sent.length === 1, 10_000, 'email');
      expect(email.sent[0]).toMatchObject({ to: 'alice@example.com' });

      // One a day.
      const limited = await as(alice).post('/v1/me/export').expect(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      expect(limited.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      // After 7 days the file and link are gone.
      await prisma.dataExport.update({
        where: { id: ready.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await worker.get(AccountSweeper).sweep();
      const expired = (await as(alice).get('/v1/me/export').expect(200))
        .body as ExportBody;
      expect(expired).toMatchObject({ status: 'expired', downloadUrl: null });
      expect(
        await storage.head(`exports/${alice.userId}/${ready.id}.zip`),
      ).toBeNull();
    });

    it('returns the pending export instead of starting a second one', async () => {
      const alice = await onboardedUser(app, 'alice');
      await prisma.dataExport.create({ data: { userId: alice.userId } });
      const [a, b] = await Promise.all([
        as(alice).post('/v1/me/export').expect(202),
        as(alice).post('/v1/me/export').expect(202),
      ]);
      expect((a.body as ExportBody).id).toBe((b.body as ExportBody).id);
      expect(await prisma.dataExport.count()).toBe(1);
    });
  });
});

/** An access token like the API issues, with a sign-in `authAgeSeconds` ago. */
function signToken(userId: string, authAgeSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    role: 'user',
    onb: true,
    auth_time: now - authAgeSeconds,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer('tripinly')
    .setAudience('tripinly-app')
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .setJti(randomUUID())
    .sign(new TextEncoder().encode(process.env.JWT_ACCESS_SECRET));
}
