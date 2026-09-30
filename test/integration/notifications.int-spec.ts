import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { CoreModule } from '../../src/common/core.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { QueueModule } from '../../src/common/queue/queue.module';
import { EmailProvider } from '../../src/modules/notifications/email/email.provider';
import { EmailService } from '../../src/modules/notifications/email/email.service';
import { EmailWorkerModule } from '../../src/modules/notifications/email/email-worker.module';
import { NotificationPlanner } from '../../src/modules/notifications/notification-planner';
import { NotificationTimings } from '../../src/modules/notifications/notification-timings';
import { NotificationsWorkerModule } from '../../src/modules/notifications/notifications-worker.module';
import { PushProvider } from '../../src/modules/notifications/push.provider';
import {
  onboardedUser,
  publishLegalDocuments,
  resetState,
  type Session,
} from '../utils/auth-helpers';
import { api, type TripBody } from '../utils/api';
import { createTestApp } from '../utils/create-test-app';
import { FakeEmailProvider, FakePushProvider } from '../utils/fake-providers';
import { insertPlace } from '../utils/places';
import { connect, eventually, realtimeUrl, sleep } from '../utils/realtime';

/** Batching windows shortened from 10 minutes and 1 hour. */
const WINDOW_MS = 700;

interface NotificationBody {
  id: string;
  type: string;
  actor: { username: string } | null;
  trip: { id: string; title: string } | null;
  markerId: string | null;
  count: number;
  title: string;
  body: string;
  deepLink: string;
  read: boolean;
}

describe('Notifications (integration)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let as: ReturnType<typeof api>['as'];
  const push = new FakePushProvider();
  const email = new FakeEmailProvider();
  let owner: Session;
  let editor: Session;
  let stranger: Session;
  let trip: TripBody;
  let placeId: string;

  // Device tokens (FCM tokens are at least 20 characters).
  const OWNER_PHONE = 'owner-phone-token-000000001';
  const OWNER_TABLET = 'owner-tablet-token-00000002';
  const EDITOR_PHONE = 'editor-phone-token-00000003';

  beforeAll(async () => {
    app = await createTestApp();
    const moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        EventEmitterModule.forRoot(),
        QueueModule,
        NotificationsWorkerModule,
        EmailWorkerModule,
      ],
    })
      .overrideProvider(PushProvider)
      .useValue(push)
      .overrideProvider(EmailProvider)
      .useValue(email)
      .overrideProvider(NotificationTimings)
      .useValue({ collaboratorBatchMs: WINDOW_MS, likesWindowMs: WINDOW_MS })
      .compile();
    worker = await moduleRef.init();
    prisma = app.get(PrismaService);
    as = api(app).as;
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  beforeEach(async () => {
    await resetState(app);
    push.reset();
    email.sent.length = 0;
    await publishLegalDocuments(app);
    owner = await onboardedUser(app, 'owner');
    editor = await onboardedUser(app, 'editor');
    stranger = await onboardedUser(app, 'stranger');
    await device(owner, OWNER_PHONE, 'de-AT');
    await device(owner, OWNER_TABLET, 'en-GB');
    await device(editor, EDITOR_PHONE, 'hu-HU');
    placeId = await insertPlace(app, {
      name: 'Albertina',
      lat: 48.2046,
      lng: 16.3683,
    });
    trip = (
      await as(owner)
        .post('/v1/trips')
        .send({
          title: 'Vienna',
          visibility: 'public',
          memberUsernames: ['editor'],
        })
        .expect(201)
    ).body as TripBody;
    // Being added at creation notifies the editor; start each test from quiet.
    await eventually(
      () => push.to(EDITOR_PHONE).length === 1,
      5000,
      'added push',
    );
    push.reset();
  });

  async function device(session: Session, token: string, locale: string) {
    await as(session)
      .put(`/v1/me/devices/${token}`)
      .send({ platform: 'android', locale })
      .expect(204);
  }

  async function addMarker(session: Session): Promise<string> {
    const { body } = await as(session)
      .post(`/v1/days/${trip.days[0].id}/markers`)
      .send({ placeId })
      .expect(201);
    return (body as { id: string }).id;
  }

  async function list(session: Session, lang = 'en') {
    const { body } = await as(session)
      .get('/v1/notifications')
      .set('Accept-Language', lang)
      .expect(200);
    return body as {
      items: NotificationBody[];
      nextCursor: string | null;
      unreadCount: number;
    };
  }

  it('tells the added member right away, in each device language', async () => {
    await as(owner)
      .post(`/v1/trips/${trip.id}/members`)
      .send({ username: 'stranger' })
      .expect(200);
    await device(stranger, 'stranger-phone-token-0000004', 'de');
    const [row] = await eventually(
      async () => {
        const rows = await prisma.notification.findMany({
          where: { recipientId: stranger.userId },
        });
        return rows.length ? rows : undefined;
      },
      5000,
      'row',
    );
    expect(row).toMatchObject({ type: 'added_to_trip', actorId: owner.userId });
    // The owner (the actor) hears nothing.
    await sleep(300);
    expect(push.to(OWNER_PHONE)).toEqual([]);
    const page = await list(stranger, 'de');
    expect(page.items[0]).toMatchObject({
      type: 'added_to_trip',
      actor: { username: 'owner' },
      trip: { id: trip.id, title: 'Vienna' },
      title: 'Zu Vienna hinzugefügt',
      body: 'owner hat dich zu dieser Reise hinzugefügt.',
      deepLink: `tripinly://trips/${trip.id}`,
      read: false,
      count: 1,
    });
  });

  describe('comments', () => {
    it('notifies the trip owner and the marker’s creator, not the commenter', async () => {
      const markerId = await addMarker(editor);
      await sleep(WINDOW_MS + 500); // let the owner's batched change flush
      push.reset();

      await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({
          body: 'Go early in the morning, the queue gets long after ten!',
        })
        .expect(201);
      await eventually(
        () => push.to(OWNER_TABLET).length && push.to(EDITOR_PHONE).length,
        5000,
        'comment pushes',
      );
      const [de] = push.to(OWNER_PHONE);
      const [en] = push.to(OWNER_TABLET);
      const [hu] = push.to(EDITOR_PHONE);
      expect(en).toMatchObject({
        title: 'stranger commented on Albertina',
        body: 'Go early in the morning, the queue gets long after ten!',
        data: {
          type: 'comment_on_marker',
          deepLink: `tripinly://markers/${markerId}`,
        },
      });
      expect(de.title).toBe('stranger hat Albertina kommentiert');
      expect(hu.title).toBe('stranger hozzászólt: Albertina');
      expect(en.data.notificationId).toEqual(expect.any(String));
    });

    it('removes the notification when the comment is deleted', async () => {
      const markerId = await addMarker(owner);
      const { body } = await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Nice' })
        .expect(201);
      await eventually(
        async () =>
          (await prisma.notification.count({
            where: { type: 'comment_on_marker' },
          })) === 1,
      );
      await as(stranger)
        .delete(`/v1/comments/${(body as { id: string }).id}`)
        .expect(204);
      await eventually(
        async () =>
          (await prisma.notification.count({
            where: { type: 'comment_on_marker' },
          })) === 0,
        5000,
        'deletion',
      );
    });

    it('skips recipients with a block with the actor', async () => {
      const markerId = await addMarker(owner);
      await as(owner).post(`/v1/users/${stranger.userId}/block`).expect(204);
      await worker.get(NotificationPlanner).plan({
        kind: 'comment_created',
        actorId: stranger.userId,
        tripId: trip.id,
        markerId,
        commentId: '00000000-0000-4000-8000-000000000000',
        body: 'hello',
        recipientIds: [owner.userId],
      });
      expect(
        await prisma.notification.count({
          where: { recipientId: owner.userId, type: 'comment_on_marker' },
        }),
      ).toBe(0);
    });

    it('keeps the in-app entry but sends no push when the type is switched off', async () => {
      await as(owner)
        .patch('/v1/me/notification-settings')
        .send({ commentOnMarker: false })
        .expect(200, {
          commentOnMarker: false,
          addedToTrip: true,
          tripChangedByCollaborator: true,
          likesGrouped: true,
        });
      const markerId = await addMarker(owner);
      await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Nice' })
        .expect(201);
      await eventually(
        async () =>
          (
            await prisma.notification.findFirst({
              where: { recipientId: owner.userId, type: 'comment_on_marker' },
            })
          )?.pushedAt ?? undefined,
        5000,
        'push job',
      );
      expect(push.to(OWNER_PHONE)).toEqual([]);
      expect((await list(owner)).items[0].type).toBe('comment_on_marker');
    });
  });

  describe('collaborator changes', () => {
    it('batches changes per trip and recipient into one push', async () => {
      await addMarker(editor);
      await addMarker(editor);
      await addMarker(editor);
      await sleep(200);
      expect(push.to(OWNER_TABLET)).toEqual([]);
      const [message] = await eventually(
        () =>
          push.to(OWNER_TABLET).length ? push.to(OWNER_TABLET) : undefined,
        5000,
        'batched push',
      );
      expect(message).toMatchObject({
        title: 'Changes in Vienna',
        body: 'editor added 3 places',
        data: { type: 'trip_changed_by_collaborator' },
      });
      expect(push.to(OWNER_PHONE)[0].body).toBe(
        'editor hat 3 Orte hinzugefügt',
      );
      await sleep(WINDOW_MS);
      expect(push.to(OWNER_TABLET)).toHaveLength(1);
      // The editor made the changes, so hears nothing.
      expect(push.to(EDITOR_PHONE)).toEqual([]);

      // A change after the push opens a new batch.
      await as(editor).post(`/v1/trips/${trip.id}/days`).expect(201);
      await eventually(
        () => push.to(OWNER_TABLET).length === 2,
        5000,
        'second batch',
      );
      expect(push.to(OWNER_TABLET)[1].body).toBe('editor made a change');
      const rows = await prisma.notification.findMany({
        where: { recipientId: owner.userId },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((row) => row.count)).toEqual([3, 1]);
    });

    it('names several collaborators together', async () => {
      await as(owner)
        .post(`/v1/trips/${trip.id}/members`)
        .send({ username: 'stranger' })
        .expect(200);
      await addMarker(editor);
      await addMarker(stranger);
      const [message] = await eventually(
        () =>
          push.to(OWNER_TABLET).length ? push.to(OWNER_TABLET) : undefined,
        5000,
        'batched push',
      );
      expect(message.body).toBe('stranger and others made 2 changes');
    });

    it('drops a batched push, and its entry, for someone who lost access meanwhile', async () => {
      const privateTrip = (
        await as(owner)
          .post('/v1/trips')
          .send({
            title: 'Secret',
            visibility: 'private',
            memberUsernames: ['editor'],
          })
          .expect(201)
      ).body as TripBody;
      await eventually(() => push.to(EDITOR_PHONE).length === 1);
      push.reset();
      await as(owner)
        .post(`/v1/days/${privateTrip.days[0].id}/markers`)
        .send({ placeId })
        .expect(201);
      await eventually(
        async () =>
          (await prisma.notification.count({
            where: {
              recipientId: editor.userId,
              tripId: privateTrip.id,
              type: 'trip_changed_by_collaborator',
            },
          })) === 1,
      );
      await as(owner)
        .delete(`/v1/trips/${privateTrip.id}/members/${editor.userId}`)
        .expect(204);
      await sleep(WINDOW_MS + 700);
      expect(push.to(EDITOR_PHONE)).toEqual([]);
      expect(
        await prisma.notification.count({
          where: {
            recipientId: editor.userId,
            tripId: privateTrip.id,
            type: 'trip_changed_by_collaborator',
          },
        }),
      ).toBe(0);
      // The earlier "added to" entry stays stored but is no longer listed.
      const titles = (await list(editor)).items.map((item) => item.trip?.title);
      expect(titles).not.toContain('Secret');
    });
  });

  describe('likes', () => {
    it('groups likes into one push per window and counts each person once', async () => {
      const markerId = await addMarker(owner);
      await as(stranger).put(`/v1/likes/marker/${markerId}`).expect(200);
      await as(stranger).delete(`/v1/likes/marker/${markerId}`).expect(200);
      await as(stranger).put(`/v1/likes/marker/${markerId}`).expect(200);
      await as(editor).put(`/v1/likes/trip/${trip.id}`).expect(200);
      // Own likes never notify.
      await as(owner).put(`/v1/likes/marker/${markerId}`).expect(200);

      const [message] = await eventually(
        () =>
          push.to(OWNER_TABLET).length ? push.to(OWNER_TABLET) : undefined,
        5000,
        'likes push',
      );
      expect(message).toMatchObject({
        title: 'New likes',
        body: '2 people liked your posts in Vienna',
        data: {
          type: 'likes_grouped',
          deepLink: `tripinly://trips/${trip.id}`,
        },
      });
      await sleep(WINDOW_MS);
      expect(push.to(OWNER_TABLET)).toHaveLength(1);
      const page = await list(owner);
      expect(
        page.items.find((item) => item.type === 'likes_grouped'),
      ).toMatchObject({
        count: 2,
        body: '2 people liked your posts in Vienna',
      });
    });
  });

  describe('devices', () => {
    it('removes devices FCM reports as unregistered', async () => {
      push.unregistered.add(OWNER_TABLET);
      const markerId = await addMarker(owner);
      await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Nice' })
        .expect(201);
      await eventually(
        async () =>
          (await prisma.device.count({ where: { fcmToken: OWNER_TABLET } })) ===
          0,
        5000,
        'device removal',
      );
      expect(
        await prisma.device.count({ where: { fcmToken: OWNER_PHONE } }),
      ).toBe(1);
    });
  });

  describe('in-app list', () => {
    it('pages newest first, counts unread and marks read by id or all', async () => {
      const markerId = await addMarker(owner);
      for (const text of ['one', 'two', 'three']) {
        await as(stranger)
          .post(`/v1/markers/${markerId}/comments`)
          .send({ body: text })
          .expect(201);
      }
      await eventually(
        async () => (await list(owner)).unreadCount === 3,
        5000,
        'three notifications',
      );
      const first = (
        await as(owner).get('/v1/notifications?limit=2').expect(200)
      ).body as { items: NotificationBody[]; nextCursor: string };
      expect(first.items.map((item) => item.body)).toEqual(['three', 'two']);
      const second = (
        await as(owner)
          .get(`/v1/notifications?limit=2&cursor=${first.nextCursor}`)
          .expect(200)
      ).body as { items: NotificationBody[]; nextCursor: string | null };
      expect(second.items.map((item) => item.body)).toEqual(['one']);
      expect(second.nextCursor).toBeNull();

      await as(owner)
        .post('/v1/notifications/read')
        .send({ ids: [first.items[0].id] })
        .expect(204);
      expect((await list(owner)).unreadCount).toBe(2);
      // Someone else can't mark my notifications.
      await as(stranger)
        .post('/v1/notifications/read')
        .send({ all: true })
        .expect(204);
      expect((await list(owner)).unreadCount).toBe(2);
      await as(owner)
        .post('/v1/notifications/read')
        .send({ all: true })
        .expect(204);
      const after = await list(owner);
      expect(after.unreadCount).toBe(0);
      expect(after.items.every((item) => item.read)).toBe(true);
    });

    it('hides entries caused by someone I have a block with', async () => {
      const markerId = await addMarker(owner);
      await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Nice' })
        .expect(201);
      await eventually(async () => (await list(owner)).items.length === 1);
      await as(stranger).post(`/v1/users/${owner.userId}/block`).expect(204);
      const page = await list(owner);
      expect(page.items).toEqual([]);
      expect(page.unreadCount).toBe(0);
    });

    it('validates input', async () => {
      await as(owner).post('/v1/notifications/read').send({}).expect(400);
      await as(owner)
        .post('/v1/notifications/read')
        .send({ ids: ['nope'] })
        .expect(400);
      await as(owner)
        .post('/v1/notifications/read')
        .send({ all: false })
        .expect(400);
      await as(owner)
        .patch('/v1/me/notification-settings')
        .send({ likesGrouped: 'no' })
        .expect(400);
      await api(app).anonymous.get('/v1/notifications').expect(401);
      await as(owner).get('/v1/me/notification-settings').expect(200, {
        commentOnMarker: true,
        addedToTrip: true,
        tripChangedByCollaborator: true,
        likesGrouped: true,
      });
    });

    it('arrives live as notification.created on the user room', async () => {
      const socket = await connect(await realtimeUrl(app), owner);
      try {
        const markerId = await addMarker(owner);
        await as(stranger)
          .post(`/v1/markers/${markerId}/comments`)
          .send({ body: 'Live!' })
          .expect(201);
        const event = await socket.waitFor<NotificationBody>(
          'notification.created',
          (e) => e.data.type === 'comment_on_marker',
          5000,
        );
        expect(event.data).toMatchObject({
          body: 'Live!',
          title: 'stranger commented on Albertina',
          read: false,
        });
      } finally {
        socket.close();
      }
    });
  });

  describe('email', () => {
    it('renders and sends a queued email in the recipient’s language', async () => {
      await app
        .get(EmailService)
        .send('data_export_ready', 'someone@example.com', 'de-AT', {
          downloadUrl: 'https://files.example.com/export.zip?sig=a&b=<c>',
        });
      const [message] = await eventually(
        () => (email.sent.length ? email.sent : undefined),
        5000,
        'email',
      );
      expect(message.to).toBe('someone@example.com');
      expect(message.subject).toBe('Deine Tripinly-Daten sind bereit');
      expect(message.text).toContain(
        'Meine Daten herunterladen: https://files.example.com/export.zip?sig=a&b=<c>',
      );
      expect(message.html).toContain(
        'href="https://files.example.com/export.zip?sig=a&amp;b=&lt;c&gt;"',
      );
      expect(message.idempotencyKey).toMatch(/^data_export_ready\//);
    });
  });
});
