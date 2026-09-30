import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PhotoProcessingModule } from '../../src/modules/photos/photo-processing.module';
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
import { connect, realtimeUrl } from '../utils/realtime';

interface AdminReport {
  id: string;
  targetType: string;
  targetId: string;
  status: string;
  action: string | null;
  openReportCount: number;
  reporter: { username: string } | null;
  target: {
    exists: boolean;
    owner: { username: string } | null;
    text: string | null;
    hidden: boolean;
  };
}

describe('Moderation (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: ReturnType<typeof api>['as'];
  let admin: Session;
  let owner: Session;
  let reporter: Session;
  let other: Session;
  let trip: TripBody;
  let privateTrip: TripBody;
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
    admin = await onboardedUser(app, 'mia');
    await prisma.user.update({
      where: { id: admin.userId },
      data: { role: 'admin' },
    });
    owner = await onboardedUser(app, 'owner');
    reporter = await onboardedUser(app, 'reporter');
    other = await onboardedUser(app, 'other');
    placeId = await insertPlace(app, {
      name: 'Albertina',
      lat: 48.2046,
      lng: 16.3683,
    });
    trip = await createTrip('Vienna', 'public');
    privateTrip = await createTrip('Secret', 'private');
    markerId = (
      await as(owner)
        .post(`/v1/days/${trip.days[0].id}/markers`)
        .send({ placeId })
        .expect(201)
    ).body.id as string;
  });

  async function createTrip(
    title: string,
    visibility: 'public' | 'private',
  ): Promise<TripBody> {
    return (
      await as(owner).post('/v1/trips').send({ title, visibility }).expect(201)
    ).body as TripBody;
  }

  function report(
    session: Session,
    targetType: string,
    targetId: string,
    reason = 'spam',
  ) {
    return as(session)
      .post('/v1/reports')
      .send({ targetType, targetId, reason });
  }

  async function openReports(): Promise<AdminReport[]> {
    const { body } = await as(admin).get('/v1/admin/reports').expect(200);
    return (body as { items: AdminReport[] }).items;
  }

  describe('POST /reports', () => {
    it('accepts a report once per target, and only for what the reporter can see', async () => {
      const first = await report(reporter, 'trip', trip.id).expect(201);
      const again = await report(reporter, 'trip', trip.id, 'hate').expect(200);
      expect(again.body.id).toBe(first.body.id);
      expect(first.body).toMatchObject({
        targetType: 'trip',
        targetId: trip.id,
        reason: 'spam',
        status: 'open',
      });
      await report(reporter, 'trip', privateTrip.id).expect(404);
      await report(reporter, 'user', reporter.userId).expect(404);
      await report(reporter, 'marker', markerId).expect(201);
      await report(reporter, 'user', owner.userId).expect(201);

      const { body } = await as(reporter)
        .post('/v1/reports')
        .send({ targetType: 'place', targetId: trip.id, reason: 'rude' })
        .expect(400);
      expect(body.error.code).toBe('VALIDATION_FAILED');
    });

    it('lets someone report a user they blocked', async () => {
      await as(reporter).post(`/v1/users/${owner.userId}/block`).expect(204);
      await report(reporter, 'user', owner.userId).expect(201);
    });

    it('limits reports to 20 a day', async () => {
      const targets = await Promise.all(
        Array.from({ length: 21 }, (_, i) =>
          prisma.user.create({
            data: { username: `target${i}`, onboardedAt: new Date() },
          }),
        ),
      );
      for (const target of targets.slice(0, 20)) {
        await report(reporter, 'user', target.id).expect(201);
      }
      const { body } = await report(reporter, 'user', targets[20].id).expect(
        429,
      );
      expect(body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('admin review', () => {
    it('is for admins only', async () => {
      const { body } = await as(owner).get('/v1/admin/reports').expect(403);
      expect(body.error.code).toBe('FORBIDDEN');
      const reportId = (await report(reporter, 'trip', trip.id).expect(201))
        .body.id as string;
      await as(owner)
        .patch(`/v1/admin/reports/${reportId}`)
        .send({ action: 'dismiss' })
        .expect(403);
    });

    it('lists open reports oldest first with a target snapshot', async () => {
      await report(reporter, 'marker', markerId).expect(201);
      await report(other, 'marker', markerId).expect(201);
      await report(reporter, 'trip', trip.id).expect(201);
      const items = await openReports();
      expect(items.map((item) => item.targetType)).toEqual([
        'marker',
        'marker',
        'trip',
      ]);
      expect(items[0]).toMatchObject({
        reporter: { username: 'reporter' },
        openReportCount: 2,
        target: {
          exists: true,
          owner: { username: 'owner' },
          text: 'Albertina',
          hidden: false,
        },
      });
    });

    it('hides a marker: gone for others and from popularity, audited, all reports resolved', async () => {
      await as(other).put(`/v1/likes/marker/${markerId}`).expect(200);
      expect(
        (await prisma.place.findUniqueOrThrow({ where: { id: placeId } }))
          .popularity,
      ).toBe(1);
      const reportId = (await report(reporter, 'marker', markerId).expect(201))
        .body.id as string;
      await report(other, 'marker', markerId).expect(201);

      const { body } = await as(admin)
        .patch(`/v1/admin/reports/${reportId}`)
        .send({ action: 'hide_content', note: 'Offensive name' })
        .expect(200);
      expect(body).toMatchObject({
        status: 'actioned',
        action: 'hide_content',
        target: { hidden: true },
      });

      await as(other).get(`/v1/markers/${markerId}`).expect(404);
      await as(owner).get(`/v1/markers/${markerId}`).expect(200);
      expect(
        (await prisma.place.findUniqueOrThrow({ where: { id: placeId } }))
          .popularity,
      ).toBe(0);
      expect(await openReports()).toEqual([]);
      expect(await prisma.adminAuditLog.findMany()).toEqual([
        expect.objectContaining({
          adminId: admin.userId,
          action: 'hide_content',
          targetType: 'marker',
          targetId: markerId,
          reportId,
          note: 'Offensive name',
        }),
      ]);
    });

    it('suspends the author: signed out at once, kept out, gone from Explore', async () => {
      const exploreBefore = await as(other)
        .get('/v1/explore/trips')
        .expect(200);
      expect(
        (exploreBefore.body.items as { id: string }[]).map((t) => t.id),
      ).toContain(trip.id);
      const commentId = (
        await as(owner)
          .post(`/v1/markers/${markerId}/comments`)
          .send({ body: 'Buy my stuff' })
          .expect(201)
      ).body.id as string;
      const reportId = (
        await report(reporter, 'comment', commentId).expect(201)
      ).body.id as string;
      const socket = await connect(await realtimeUrl(app), owner);
      const disconnected = new Promise<string>((resolve) =>
        socket.socket.once('disconnect', resolve),
      );

      await as(admin)
        .patch(`/v1/admin/reports/${reportId}`)
        .send({ action: 'suspend_user' })
        .expect(200);

      expect(await disconnected).toBe('io server disconnect');
      expect(socket.events('account.suspended')).toHaveLength(1);
      socket.close();
      const { body } = await as(owner).get('/v1/me').expect(403);
      expect(body.error.code).toBe('ACCOUNT_SUSPENDED');
      const refresh = await api(app)
        .anonymous.post('/v1/auth/refresh')
        .send({ refreshToken: owner.refreshToken })
        .expect(403);
      expect(refresh.body.error.code).toBe('ACCOUNT_SUSPENDED');
      const explore = await as(other).get('/v1/explore/trips').expect(200);
      expect(
        (explore.body.items as { id: string }[]).map((t) => t.id),
      ).not.toContain(trip.id);
      expect(await prisma.adminAuditLog.findFirst()).toMatchObject({
        action: 'suspend_user',
        targetType: 'user',
        targetId: owner.userId,
      });
    });

    it('deletes content through the normal service', async () => {
      const photoId = await readyPhoto(app, owner, markerId);
      const reportId = (await report(reporter, 'photo', photoId).expect(201))
        .body.id as string;
      const { body } = await as(admin)
        .patch(`/v1/admin/reports/${reportId}`)
        .send({ action: 'delete_content' })
        .expect(200);
      expect(body).toMatchObject({
        action: 'delete_content',
        target: { exists: false },
      });
      expect(await prisma.photo.count({ where: { id: photoId } })).toBe(0);
      expect(
        (await prisma.marker.findUniqueOrThrow({ where: { id: markerId } }))
          .coverPhotoId,
      ).toBeNull();
    });

    it('refuses actions that do not fit the target, and suspending an admin', async () => {
      const userReport = (
        await report(reporter, 'user', owner.userId).expect(201)
      ).body.id as string;
      const { body } = await as(admin)
        .patch(`/v1/admin/reports/${userReport}`)
        .send({ action: 'hide_content' })
        .expect(400);
      expect(body.error.code).toBe('VALIDATION_FAILED');

      const adminReport = (
        await report(reporter, 'user', admin.userId).expect(201)
      ).body.id as string;
      await as(admin)
        .patch(`/v1/admin/reports/${adminReport}`)
        .send({ action: 'suspend_user' })
        .expect(403);
      await as(admin)
        .patch(`/v1/admin/reports/${adminReport}`)
        .send({ action: 'ban' })
        .expect(400);
      expect(await prisma.adminAuditLog.count()).toBe(0);
    });
  });
});
