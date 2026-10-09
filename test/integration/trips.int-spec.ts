import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  devSignIn,
  onboardedUser,
  publishLegalDocuments,
  resetState,
  type Session,
} from '../utils/auth-helpers';
import { api, type TripBody } from '../utils/api';
import { createTestApp } from '../utils/create-test-app';

describe('Trips, days and members (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: ReturnType<typeof api>['as'];
  let owner: Session;
  let editor: Session;
  let stranger: Session;

  beforeAll(async () => {
    app = await createTestApp();
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
  });

  async function createTrip(
    body: Record<string, unknown> = {},
    session = owner,
  ): Promise<TripBody> {
    const response = await as(session)
      .post('/v1/trips')
      .send({ title: 'Vienna weekend', ...body })
      .expect(201);
    return response.body as TripBody;
  }

  describe('POST /v1/trips', () => {
    it('creates one day per date, with the owner and initial editors as members', async () => {
      const trip = await createTrip({
        startDate: '2026-10-09',
        endDate: '2026-10-11',
        memberUsernames: ['Editor'],
      });
      expect(trip).toMatchObject({
        title: 'Vienna weekend',
        startDate: '2026-10-09',
        endDate: '2026-10-11',
        visibility: 'public',
        myRole: 'owner',
        copiedFrom: null,
        likeCount: 0,
        copyCount: 0,
      });
      expect(trip.days.map((day) => [day.position, day.date])).toEqual([
        [0, '2026-10-09'],
        [1, '2026-10-10'],
        [2, '2026-10-11'],
      ]);
      expect(
        (trip.members as { role: string; user: { username: string } }[]).map(
          (m) => [m.user.username, m.role],
        ),
      ).toEqual([
        ['owner', 'owner'],
        ['editor', 'editor'],
      ]);
    });

    it('creates a single undated day and uses the default visibility', async () => {
      await as(owner)
        .patch('/v1/me')
        .send({ defaultTripVisibility: 'private' })
        .expect(200);
      const trip = await createTrip();
      expect(trip).toMatchObject({
        startDate: null,
        endDate: null,
        destination: null,
        visibility: 'private',
      });
      expect(trip.days).toEqual([
        expect.objectContaining({ position: 0, date: null, markers: [] }),
      ]);
    });

    it('keeps an optional destination', async () => {
      const trip = await createTrip({
        destination: {
          name: ' Paris ',
          location: { lat: 48.8566, lng: 2.3522 },
        },
      });
      expect(trip.destination).toEqual({
        name: 'Paris',
        location: { lat: 48.8566, lng: 2.3522 },
      });
      const { body } = await as(owner).get(`/v1/trips/${trip.id}`).expect(200);
      expect(body.destination).toEqual(trip.destination);
    });

    it('validates dates, members and limits', async () => {
      const cases: [Record<string, unknown>, number, string, unknown?][] = [
        [
          { endDate: '2026-10-11' },
          400,
          'VALIDATION_FAILED',
          { endDate: ['requiresStartDate'] },
        ],
        [
          { startDate: '2026-10-11', endDate: '2026-10-09' },
          400,
          'VALIDATION_FAILED',
          { endDate: ['beforeStartDate'] },
        ],
        [
          { startDate: '2026-02-30' },
          400,
          'VALIDATION_FAILED',
          { startDate: ['isDate'] },
        ],
        [
          { startDate: '2026-10-01', endDate: '2026-10-21' },
          422,
          'LIMIT_REACHED',
        ],
        [
          { memberUsernames: ['editor', 'nobody_here'] },
          400,
          'VALIDATION_FAILED',
          { 'memberUsernames.1': ['notFound'] },
        ],
        [{ title: '' }, 400, 'VALIDATION_FAILED'],
        [{ destination: { name: 'Paris' } }, 400, 'VALIDATION_FAILED'],
        [
          { destination: { name: '', location: { lat: 48.8, lng: 2.3 } } },
          400,
          'VALIDATION_FAILED',
        ],
        [
          { destination: { name: 'Paris', location: { lat: 95, lng: 2.3 } } },
          400,
          'VALIDATION_FAILED',
        ],
      ];
      for (const [body, status, code, fields] of cases) {
        const response = await as(owner)
          .post('/v1/trips')
          .send({ title: 'T', ...body })
          .expect(status);
        expect(response.body.error.code).toBe(code);
        if (fields) expect(response.body.error.details.fields).toEqual(fields);
      }
      expect(await prisma.trip.count()).toBe(0);
    });

    it('refuses people who blocked the owner, and says "blocked" only to the blocker', async () => {
      await as(editor).post(`/v1/users/${owner.userId}/block`).expect(204);
      const hidden = await as(owner)
        .post('/v1/trips')
        .send({ title: 'T', memberUsernames: ['editor'] })
        .expect(400);
      expect(hidden.body.error.details.fields).toEqual({
        'memberUsernames.0': ['notFound'],
      });

      await as(stranger).post(`/v1/users/${owner.userId}/block`).expect(204);
      await as(owner).post(`/v1/users/${editor.userId}/block`).expect(204);
      const blocked = await as(owner)
        .post('/v1/trips')
        .send({ title: 'T', memberUsernames: ['editor'] })
        .expect(400);
      expect(blocked.body.error.details.fields).toEqual({
        'memberUsernames.0': ['blocked'],
      });
    });

    it('limits trips per user', async () => {
      await prisma.trip.createMany({
        data: Array.from({ length: 200 }, (_, i) => ({
          ownerId: owner.userId,
          title: `T${i}`,
          visibility: 'public' as const,
        })),
      });
      const response = await as(owner)
        .post('/v1/trips')
        .send({ title: 'One more' })
        .expect(422);
      expect(response.body.error).toMatchObject({
        code: 'LIMIT_REACHED',
        details: { resource: 'trips', max: 200 },
      });
    });

    it('requires a finished onboarding', async () => {
      const newbie = await devSignIn(app, 'newbie');
      const response = await as(newbie)
        .post('/v1/trips')
        .send({ title: 'T' })
        .expect(403);
      expect(response.body.error.code).toBe('ONBOARDING_INCOMPLETE');
      await api(app)
        .anonymous.post('/v1/trips')
        .send({ title: 'T' })
        .expect(401);
    });
  });

  describe('GET /v1/trips/:id', () => {
    it('shows public trips to anyone and private trips only to members', async () => {
      const publicTrip = await createTrip({ memberUsernames: ['editor'] });
      const privateTrip = await createTrip({
        visibility: 'private',
        memberUsernames: ['editor'],
      });

      const viewed = await as(stranger)
        .get(`/v1/trips/${publicTrip.id}`)
        .expect(200);
      expect(viewed.body.myRole).toBe('viewer');
      const asEditor = await as(editor)
        .get(`/v1/trips/${privateTrip.id}`)
        .expect(200);
      expect(asEditor.body.myRole).toBe('editor');

      const hidden = await as(stranger)
        .get(`/v1/trips/${privateTrip.id}`)
        .expect(404);
      expect(hidden.body.error.code).toBe('NOT_FOUND');
      await as(stranger)
        .get('/v1/trips/00000000-0000-4000-8000-000000000000')
        .expect(404);
      const malformed = await as(stranger)
        .get('/v1/trips/not-a-uuid')
        .expect(400);
      expect(malformed.body.error.details.fields.id).toEqual(['isUuid']);
    });

    it('hides trips across a block in either direction', async () => {
      const trip = await createTrip();
      await as(stranger).post(`/v1/users/${owner.userId}/block`).expect(204);
      await as(stranger).get(`/v1/trips/${trip.id}`).expect(404);
      await as(stranger).delete(`/v1/users/${owner.userId}/block`).expect(204);
      await as(stranger).get(`/v1/trips/${trip.id}`).expect(200);
      await as(owner).post(`/v1/users/${stranger.userId}/block`).expect(204);
      await as(stranger).get(`/v1/trips/${trip.id}`).expect(404);
    });

    it('shows moderated trips only to the owner and admins', async () => {
      const trip = await createTrip({ memberUsernames: ['editor'] });
      await prisma.trip.update({
        where: { id: trip.id },
        data: { hiddenAt: new Date() },
      });
      await as(owner).get(`/v1/trips/${trip.id}`).expect(200);
      await as(editor).get(`/v1/trips/${trip.id}`).expect(404);
      await as(stranger).get(`/v1/trips/${trip.id}`).expect(404);
      await prisma.user.update({
        where: { id: stranger.userId },
        data: { role: 'admin' },
      });
      await as(stranger).get(`/v1/trips/${trip.id}`).expect(200);
    });
  });

  describe('PATCH and DELETE /v1/trips/:id', () => {
    it('lets only the owner manage the trip', async () => {
      const trip = await createTrip({ memberUsernames: ['editor'] });
      const updated = await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ title: 'Budapest', visibility: 'private' })
        .expect(200);
      expect(updated.body).toMatchObject({
        title: 'Budapest',
        visibility: 'private',
      });

      const forbidden = await as(editor)
        .patch(`/v1/trips/${trip.id}`)
        .send({ title: 'x' })
        .expect(403);
      expect(forbidden.body.error.code).toBe('FORBIDDEN');
      await as(stranger)
        .patch(`/v1/trips/${trip.id}`)
        .send({ title: 'x' })
        .expect(404);
      await as(editor).delete(`/v1/trips/${trip.id}`).expect(403);

      await as(owner).delete(`/v1/trips/${trip.id}`).expect(204);
      await as(owner).get(`/v1/trips/${trip.id}`).expect(404);
      expect(await prisma.tripDay.count()).toBe(0);
    });

    it('resizes the days when the dates change', async () => {
      const trip = await createTrip({
        startDate: '2026-10-09',
        endDate: '2026-10-10',
      });
      const longer = await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ endDate: '2026-10-12' })
        .expect(200);
      expect(longer.body.days.map((d: { date: string }) => d.date)).toEqual([
        '2026-10-09',
        '2026-10-10',
        '2026-10-11',
        '2026-10-12',
      ]);

      const moved = await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ startDate: '2026-11-01' })
        .expect(200);
      expect(moved.body).toMatchObject({
        startDate: '2026-11-01',
        endDate: '2026-11-04',
      });

      await as(owner)
        .post(`/v1/days/${longer.body.days[3].id}/markers`)
        .send({ name: 'Pin', location: { lat: 48.2, lng: 16.37 } })
        .expect(201);
      const blocked = await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ endDate: '2026-11-02' })
        .expect(400);
      expect(blocked.body.error.details.fields).toEqual({
        endDate: ['daysNotEmpty'],
      });

      const shorter = await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ startDate: '2026-11-01', endDate: '2026-11-04' })
        .expect(200);
      expect(shorter.body.days).toHaveLength(4);

      const undated = await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ startDate: null })
        .expect(200);
      expect(undated.body).toMatchObject({ startDate: null, endDate: null });
      expect(undated.body.days.map((d: { date: null }) => d.date)).toEqual([
        null,
        null,
        null,
        null,
      ]);
    });

    it('sets, changes and removes the destination', async () => {
      const trip = await createTrip();
      const paris = { name: 'Paris', location: { lat: 48.8566, lng: 2.3522 } };
      const set = await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ destination: paris })
        .expect(200);
      expect(set.body.destination).toEqual(paris);

      const titled = await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ title: 'Paris in spring' })
        .expect(200);
      expect(titled.body.destination).toEqual(paris);

      const cleared = await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ destination: null })
        .expect(200);
      expect(cleared.body.destination).toBeNull();

      await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ destination: { name: 'Paris' } })
        .expect(400);
    });
  });

  describe('days', () => {
    it('appends and deletes days, keeping positions and dates in step', async () => {
      const trip = await createTrip({
        startDate: '2026-10-09',
        endDate: '2026-10-10',
        memberUsernames: ['editor'],
      });
      const added = await as(editor)
        .post(`/v1/trips/${trip.id}/days`)
        .expect(201);
      expect(added.body).toMatchObject({
        position: 2,
        date: '2026-10-11',
        markers: [],
      });

      await as(editor).delete(`/v1/days/${trip.days[0].id}`).expect(204);
      const after = await as(owner).get(`/v1/trips/${trip.id}`).expect(200);
      expect(after.body.endDate).toBe('2026-10-10');
      expect(
        after.body.days.map((d: { id: string; position: number }) => [
          d.id,
          d.position,
        ]),
      ).toEqual([
        [trip.days[1].id, 0],
        [added.body.id, 1],
      ]);

      await as(owner).delete(`/v1/days/${trip.days[1].id}`).expect(204);
      const last = await as(owner)
        .delete(`/v1/days/${added.body.id}`)
        .expect(400);
      expect(last.body.error.details.fields).toEqual({ id: ['lastDay'] });
      await as(stranger).post(`/v1/trips/${trip.id}/days`).expect(403);
    });

    it('limits days per trip', async () => {
      const trip = await createTrip({
        startDate: '2026-10-01',
        endDate: '2026-10-20',
      });
      const response = await as(owner)
        .post(`/v1/trips/${trip.id}/days`)
        .expect(422);
      expect(response.body.error.details).toEqual({
        resource: 'days',
        max: 20,
      });
    });
  });

  describe('members', () => {
    it('adds editors by username, lets them leave and lets the owner remove them', async () => {
      const trip = await createTrip();
      const added = await as(owner)
        .post(`/v1/trips/${trip.id}/members`)
        .send({ username: 'Editor' })
        .expect(200);
      expect(added.body).toEqual({
        user: expect.objectContaining({ username: 'editor' }),
        role: 'editor',
      });
      await as(owner)
        .post(`/v1/trips/${trip.id}/members`)
        .send({ username: 'editor' })
        .expect(200);
      expect(
        await prisma.tripMember.count({ where: { tripId: trip.id } }),
      ).toBe(2);

      await as(editor)
        .post(`/v1/trips/${trip.id}/members`)
        .send({ username: 'stranger' })
        .expect(403);
      await as(owner)
        .post(`/v1/trips/${trip.id}/members`)
        .send({ username: 'nobody' })
        .expect(404);

      await as(editor)
        .delete(`/v1/trips/${trip.id}/members/${editor.userId}`)
        .expect(204);
      await as(owner)
        .post(`/v1/trips/${trip.id}/members`)
        .send({ username: 'editor' })
        .expect(200);
      await as(owner)
        .delete(`/v1/trips/${trip.id}/members/${editor.userId}`)
        .expect(204);
      await as(owner)
        .delete(`/v1/trips/${trip.id}/members/${editor.userId}`)
        .expect(404);
      await as(owner)
        .delete(`/v1/trips/${trip.id}/members/${owner.userId}`)
        .expect(403);
    });

    it('respects blocks when adding', async () => {
      const trip = await createTrip();
      await as(owner).post(`/v1/users/${editor.userId}/block`).expect(204);
      const mine = await as(owner)
        .post(`/v1/trips/${trip.id}/members`)
        .send({ username: 'editor' })
        .expect(403);
      expect(mine.body.error.code).toBe('USER_BLOCKED');

      await as(stranger).post(`/v1/users/${owner.userId}/block`).expect(204);
      await as(owner)
        .post(`/v1/trips/${trip.id}/members`)
        .send({ username: 'stranger' })
        .expect(404);
    });
  });

  describe('invites', () => {
    it('lets people join with a link until it is revoked or expires', async () => {
      const trip = await createTrip({ visibility: 'private' });
      const invite = await as(owner)
        .post(`/v1/trips/${trip.id}/invites`)
        .expect(201);
      expect(invite.body.url).toBe(
        `tripinly://app/invites/${invite.body.token}`,
      );
      await as(editor).post(`/v1/trips/${trip.id}/invites`).expect(404);

      const preview = await as(editor)
        .get(`/v1/invites/${invite.body.token}`)
        .expect(200);
      expect(preview.body).toMatchObject({
        tripId: trip.id,
        title: 'Vienna weekend',
        alreadyMember: false,
      });

      const joined = await as(editor)
        .post(`/v1/invites/${invite.body.token}/accept`)
        .expect(200);
      expect(joined.body.myRole).toBe('editor');
      await as(editor)
        .post(`/v1/invites/${invite.body.token}/accept`)
        .expect(200);
      await as(owner)
        .post(`/v1/invites/${invite.body.token}/accept`)
        .expect(200);
      const member = await prisma.tripMember.findFirstOrThrow({
        where: { userId: editor.userId },
      });
      expect(member.addedById).toBe(owner.userId);

      const list = await as(owner)
        .get(`/v1/trips/${trip.id}/invites`)
        .expect(200);
      expect(list.body.items).toEqual([
        expect.objectContaining({ id: invite.body.id }),
      ]);
      expect(list.body.items[0].token).toBeUndefined();

      await as(owner)
        .delete(`/v1/trips/${trip.id}/invites/${invite.body.id}`)
        .expect(204);
      const revoked = await as(stranger)
        .post(`/v1/invites/${invite.body.token}/accept`)
        .expect(410);
      expect(revoked.body.error.code).toBe('INVITE_EXPIRED');

      const second = await as(owner)
        .post(`/v1/trips/${trip.id}/invites`)
        .expect(201);
      await prisma.tripInvite.update({
        where: { id: second.body.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await as(stranger).get(`/v1/invites/${second.body.token}`).expect(410);

      await as(stranger)
        .get(`/v1/invites/${'x'.repeat(43)}`)
        .expect(404);
    });

    it('hides invites across a block with the owner', async () => {
      const trip = await createTrip();
      const invite = await as(owner)
        .post(`/v1/trips/${trip.id}/invites`)
        .expect(201);
      await as(owner).post(`/v1/users/${stranger.userId}/block`).expect(204);
      await as(stranger).get(`/v1/invites/${invite.body.token}`).expect(404);
      await as(stranger)
        .post(`/v1/invites/${invite.body.token}/accept`)
        .expect(404);
    });
  });

  describe('blocking', () => {
    it('removes each user from the other’s trips and lists blocked users', async () => {
      const ownersTrip = await createTrip({ memberUsernames: ['editor'] });
      const editorsTrip = await createTrip(
        { memberUsernames: ['owner'] },
        editor,
      );

      await as(owner).post(`/v1/users/${editor.userId}/block`).expect(204);
      await as(owner).post(`/v1/users/${editor.userId}/block`).expect(204);
      expect(
        await prisma.tripMember.count({ where: { tripId: ownersTrip.id } }),
      ).toBe(1);
      expect(
        await prisma.tripMember.count({ where: { tripId: editorsTrip.id } }),
      ).toBe(1);

      const list = await as(owner).get('/v1/me/blocks').expect(200);
      expect(list.body).toEqual({
        items: [expect.objectContaining({ username: 'editor' })],
        nextCursor: null,
      });

      await as(owner).post(`/v1/users/${owner.userId}/block`).expect(400);
      await as(owner)
        .post('/v1/users/00000000-0000-4000-8000-000000000000/block')
        .expect(404);
    });
  });

  describe('my trips', () => {
    it('lists owned and shared trips, newest change first, with cursor pagination', async () => {
      const first = await createTrip({ title: 'First' });
      await createTrip({ title: 'Second' });
      await createTrip({ title: 'Shared', memberUsernames: ['owner'] }, editor);
      await createTrip({ title: 'Not mine' }, stranger);
      await as(owner)
        .patch(`/v1/trips/${first.id}`)
        .send({ title: 'First, renamed' })
        .expect(200);

      const page1 = await as(owner).get('/v1/me/trips?limit=2').expect(200);
      expect(
        page1.body.items.map((t: { title: string; role: string }) => [
          t.title,
          t.role,
        ]),
      ).toEqual([
        ['First, renamed', 'owner'],
        ['Shared', 'editor'],
      ]);
      expect(page1.body.items[0]).toMatchObject({
        dayCount: 1,
        markerCount: 0,
        coverThumbUrl: null,
      });
      const page2 = await as(owner)
        .get(`/v1/me/trips?limit=2&cursor=${page1.body.nextCursor}`)
        .expect(200);
      expect(page2.body).toEqual({
        items: [expect.objectContaining({ title: 'Second' })],
        nextCursor: null,
      });

      const bad = await as(owner)
        .get('/v1/me/trips?cursor=garbage')
        .expect(400);
      expect(bad.body.error.details.fields).toEqual({
        cursor: ['invalidCursor'],
      });
      await as(owner).get('/v1/me/trips?limit=51').expect(400);

      const stats = await as(owner).get('/v1/me/stats').expect(200);
      expect(stats.body).toEqual({
        tripCount: 3,
        markerCount: 0,
        photoCount: 0,
      });
    });
  });

  describe('user search', () => {
    it('finds onboarded people by prefix, never yourself or blocked users', async () => {
      await onboardedUser(app, 'edith');
      await devSignIn(app, 'edgar_unfinished');
      const found = await as(owner).get('/v1/users/search?q=ed').expect(200);
      expect(
        found.body.items.map((u: { username: string }) => u.username),
      ).toEqual(['edith', 'editor']);

      await as(editor).post(`/v1/users/${owner.userId}/block`).expect(204);
      const afterBlock = await as(owner)
        .get('/v1/users/search?q=ED')
        .expect(200);
      expect(
        afterBlock.body.items.map((u: { username: string }) => u.username),
      ).toEqual(['edith']);

      await as(owner).get('/v1/users/search?q=o').expect(400);
      const self = await as(owner).get('/v1/users/search?q=own').expect(200);
      expect(self.body.items).toEqual([]);
    });
  });
});
