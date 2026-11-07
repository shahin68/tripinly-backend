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
      unseenCount: number;
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
      title: 'owner hat dich zu Vienna hinzugefügt',
      body: 'Öffne die Reise, um gemeinsam zu planen.',
      deepLink: `tripinly://trips/${trip.id}`,
      read: false,
      count: 1,
    });
  });

  it('tells the owner right away when someone asks to join, then the person once accepted', async () => {
    const { body: request } = await as(stranger)
      .post(`/v1/trips/${trip.id}/join-request`)
      .expect(200);
    await eventually(
      () => push.to(OWNER_TABLET).length,
      5000,
      'join request push',
    );
    expect(push.to(OWNER_TABLET)[0]).toMatchObject({
      title: 'stranger wants to join Vienna',
      body: 'Tap to accept or decline.',
      data: {
        type: 'join_requested',
        deepLink: `tripinly://trips/${trip.id}/members`,
      },
    });
    // Asking again doesn't notify again.
    await as(stranger).post(`/v1/trips/${trip.id}/join-request`).expect(200);
    await sleep(300);
    expect(push.to(OWNER_TABLET)).toHaveLength(1);

    await device(stranger, 'stranger-phone-token-0000004', 'en');
    await as(owner)
      .post(`/v1/join-requests/${(request as { id: string }).id}/accept`)
      .expect(200);
    const [accepted] = await eventually(
      () => push.to('stranger-phone-token-0000004').length,
      5000,
      'accepted push',
    ).then(() => push.to('stranger-phone-token-0000004'));
    expect(accepted).toMatchObject({
      title: 'owner accepted your request',
      body: "You're in Vienna now.",
      data: { type: 'join_accepted', deepLink: `tripinly://trips/${trip.id}` },
    });
  });

  it('tells the person once when the owner declines their request or removes them', async () => {
    const { body: request } = await as(stranger)
      .post(`/v1/trips/${trip.id}/join-request`)
      .expect(200);
    await device(stranger, 'stranger-phone-token-0000004', 'en');
    await as(owner)
      .post(`/v1/join-requests/${(request as { id: string }).id}/decline`)
      .expect(204);
    const [declined] = await eventually(
      () => push.to('stranger-phone-token-0000004').length,
      5000,
      'declined push',
    ).then(() => push.to('stranger-phone-token-0000004'));
    expect(declined).toMatchObject({
      title: 'owner declined your request',
      body: "You can't join Vienna.",
      data: { type: 'join_declined', deepLink: `tripinly://trips/${trip.id}` },
    });

    // Removed from a private trip: the entry stays although the trip is gone from view.
    await as(owner)
      .patch(`/v1/trips/${trip.id}`)
      .send({ visibility: 'private' })
      .expect(200);
    await as(owner)
      .delete(`/v1/trips/${trip.id}/members/${editor.userId}`)
      .expect(204);
    const removed = await eventually(
      () =>
        push.to(EDITOR_PHONE).find((m) => m.data.type === 'removed_from_trip'),
      5000,
      'removed push',
    );
    expect(removed).toMatchObject({
      title: 'owner eltávolított innen: Vienna',
      data: { type: 'removed_from_trip', deepLink: 'tripinly://notifications' },
    });
    expect((await list(editor)).items[0]).toMatchObject({
      type: 'removed_from_trip',
      trip: null,
      title: 'owner removed you from Vienna',
    });

    // Leaving says nothing.
    await as(owner)
      .post(`/v1/trips/${trip.id}/members`)
      .send({ username: 'stranger' })
      .expect(200);
    await as(stranger)
      .delete(`/v1/trips/${trip.id}/members/${stranger.userId}`)
      .expect(204);
    await sleep(500);
    expect(
      await prisma.notification.count({
        where: { type: 'removed_from_trip', recipientId: stranger.userId },
      }),
    ).toBe(0);
  });

  describe('comments', () => {
    it('notifies everyone on the trip, not the commenter', async () => {
      const markerId = await addMarker(editor);
      // The owner hears about the new stop first.
      await eventually(() => push.to(OWNER_TABLET).length === 1);
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
      // The owner and the editor (a member).
      await eventually(
        async () =>
          (await prisma.notification.count({
            where: { type: 'comment_on_marker' },
          })) === 2,
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

    it('pushes a reply to its thread only; the rest of the trip gets the entry', async () => {
      const STRANGER_PHONE = 'stranger-phone-token-0000004';
      await device(stranger, STRANGER_PHONE, 'en');
      const markerId = await addMarker(owner);
      await eventually(() => push.to(EDITOR_PHONE).length === 1);
      const { body: main } = await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Worth it?' })
        .expect(201);
      await eventually(
        () =>
          push.to(OWNER_TABLET).length && push.to(EDITOR_PHONE).length === 2,
        5000,
        'main comment pushes',
      );
      push.reset();

      await as(editor)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Totally', parentId: (main as { id: string }).id })
        .expect(201);
      const [reply] = await eventually(
        () => push.to(STRANGER_PHONE).length && push.to(STRANGER_PHONE),
        5000,
        'reply push',
      );
      expect(reply).toMatchObject({
        title: 'editor replied on Albertina',
        body: 'Totally',
        data: { type: 'comment_reply' },
      });
      // The owner isn't in the thread: an entry and a red dot, no push.
      await eventually(
        async () =>
          prisma.notification.findFirst({
            where: { recipientId: owner.userId, type: 'comment_reply' },
          }),
        5000,
        'owner entry',
      );
      await sleep(300);
      expect(push.to(OWNER_TABLET)).toEqual([]);
      await as(owner)
        .get(`/v1/trips/${trip.id}/new-activity`)
        .expect(200, { markerIds: [markerId], commentMarkerIds: [markerId] });
    });

    it('pushes a comment with a mention to the mentioned people only', async () => {
      const STRANGER_PHONE = 'stranger-phone-token-0000004';
      await device(stranger, STRANGER_PHONE, 'en');
      const markerId = await addMarker(owner);
      await eventually(() => push.to(EDITOR_PHONE).length === 1);
      await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Lovely' })
        .expect(201);
      await eventually(() => push.to(OWNER_TABLET).length);
      push.reset();

      // stranger isn't on the trip: their handle stays plain text.
      const { body } = await as(owner)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: '@editor, @stranger: shall we go?' })
        .expect(201);
      expect(body).toMatchObject({
        mentions: [{ userId: editor.userId, username: 'editor' }],
      });
      const [mention] = await eventually(
        () => push.to(EDITOR_PHONE).length && push.to(EDITOR_PHONE),
        5000,
        'mention push',
      );
      expect(mention.data.type).toBe('comment_mention');
      await eventually(async () =>
        prisma.notification.findFirst({
          where: { recipientId: stranger.userId, type: 'comment_on_marker' },
        }),
      );
      await sleep(300);
      expect(push.to(STRANGER_PHONE)).toEqual([]);
    });

    it('sends no comment push while that stop’s comments are open', async () => {
      const markerId = await addMarker(owner);
      await eventually(() => push.to(EDITOR_PHONE).length === 1);
      push.reset();
      const socket = await connect(await realtimeUrl(app), editor);
      try {
        await expect(
          socket.emit('comments.watch', { markerId }),
        ).resolves.toEqual({ ok: true, markerId });
        await as(stranger)
          .post(`/v1/markers/${markerId}/comments`)
          .send({ body: 'Nice' })
          .expect(201);
        await eventually(() => push.to(OWNER_TABLET).length);
        await sleep(300);
        expect(push.to(EDITOR_PHONE)).toEqual([]);

        // Closed again: pushes come back.
        await socket.emit('comments.unwatch', { markerId });
        await as(stranger)
          .post(`/v1/markers/${markerId}/comments`)
          .send({ body: 'Again' })
          .expect(201);
        await eventually(() => push.to(EDITOR_PHONE).length, 5000, 'push');
      } finally {
        socket.close();
      }
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
          joinRequested: true,
          newFollowers: true,
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
    it('pushes every change at once', async () => {
      await addMarker(editor);
      await addMarker(editor);
      await addMarker(editor);
      const messages = await eventually(
        () =>
          push.to(OWNER_TABLET).length === 3
            ? push.to(OWNER_TABLET)
            : undefined,
        5000,
        'three pushes',
      );
      expect(messages[0]).toMatchObject({
        title: 'Changes in Vienna',
        body: 'editor added a place',
        data: { type: 'trip_changed_by_collaborator' },
      });
      expect(push.to(OWNER_PHONE)[0].body).toBe(
        'editor hat einen Ort hinzugefügt',
      );
      // The editor made the changes, so hears nothing.
      expect(push.to(EDITOR_PHONE)).toEqual([]);
      const rows = await prisma.notification.findMany({
        where: { recipientId: owner.userId },
      });
      expect(rows.map((row) => row.count)).toEqual([1, 1, 1]);
    });

    it('drops the same change again within the cooldown', async () => {
      const markerId = await addMarker(editor);
      await eventually(() => push.to(OWNER_TABLET).length === 1);
      const change = {
        kind: 'trip_changed' as const,
        actorId: editor.userId,
        tripId: trip.id,
        change: 'place_updated' as const,
        subjectId: markerId,
      };
      await worker.get(NotificationPlanner).plan(change);
      await worker.get(NotificationPlanner).plan(change);
      await worker
        .get(NotificationPlanner)
        .plan({ ...change, change: 'place_deleted' });
      expect(
        await prisma.notification.count({
          where: { recipientId: owner.userId },
        }),
      ).toBe(3);
    });
  });

  describe('likes', () => {
    it('gathers likes on an item in one entry and pushes only at a milestone', async () => {
      await as(stranger).put(`/v1/likes/trip/${trip.id}`).expect(200);
      await as(stranger).delete(`/v1/likes/trip/${trip.id}`).expect(200);
      await as(stranger).put(`/v1/likes/trip/${trip.id}`).expect(200);
      await as(editor).put(`/v1/likes/trip/${trip.id}`).expect(200);
      // Own likes never notify, and a flame on an OSM spot notifies no one.
      await as(owner).put(`/v1/likes/trip/${trip.id}`).expect(200);
      await as(stranger).put(`/v1/places/${placeId}/hot`).expect(200);

      const [entry] = await eventually(
        async () => {
          const rows = await prisma.notification.findMany({
            where: { recipientId: owner.userId, type: 'likes_grouped' },
          });
          return rows.length === 1 && rows[0].count === 2 ? rows : undefined;
        },
        5000,
        'likes entry',
      );
      expect(entry).toMatchObject({ actorId: editor.userId, tripId: trip.id });
      expect((await list(owner)).items[0]).toMatchObject({
        type: 'likes_grouped',
        title: 'editor and 1 other liked your trip',
        body: 'Vienna',
        deepLink: `tripinly://trips/${trip.id}`,
        count: 2,
      });
      await sleep(500);
      expect(push.to(OWNER_TABLET)).toEqual([]);

      // The fifth like pushes, once.
      const fifth = {
        kind: 'liked' as const,
        actorId: stranger.userId,
        targetType: 'trip' as const,
        targetId: trip.id,
        tripId: trip.id,
        count: 5,
      };
      await worker.get(NotificationPlanner).plan(fifth);
      await worker.get(NotificationPlanner).plan(fifth);
      const [milestone] = await eventually(
        () =>
          push.to(OWNER_TABLET).length ? push.to(OWNER_TABLET) : undefined,
        5000,
        'milestone push',
      );
      expect(milestone).toMatchObject({
        title: 'stranger and 4 others liked your trip',
        data: {
          type: 'likes_grouped',
          deepLink: `tripinly://trips/${trip.id}`,
        },
      });
      await sleep(500);
      expect(push.to(OWNER_TABLET)).toHaveLength(1);
      expect(
        await prisma.notification.count({ where: { type: 'likes_grouped' } }),
      ).toBe(1);
    });

    it('gathers likes on a photo in a place gallery too', async () => {
      const photo = await prisma.photo.create({
        data: {
          uploaderId: owner.userId,
          placeId,
          status: 'ready',
          mimeType: 'image/jpeg',
          bytes: 10,
          position: 0,
        },
      });
      await as(stranger).put(`/v1/likes/photo/${photo.id}`).expect(200);
      const [entry] = await eventually(
        async () => {
          const page = await list(owner);
          return page.items.length ? page.items : undefined;
        },
        5000,
        'place photo entry',
      );
      expect(entry).toMatchObject({
        type: 'likes_grouped',
        trip: null,
        title: 'stranger liked your photo',
        body: 'Albertina',
      });
    });

    it('names the photo or comment and opens its stop', async () => {
      const markerId = await addMarker(owner);
      const { body: comment } = await as(owner)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'you coming?' })
        .expect(201);
      await as(stranger)
        .put(`/v1/likes/comment/${(comment as { id: string }).id}`)
        .expect(200);
      const [liked] = await eventually(
        () =>
          push.to(OWNER_TABLET).length ? push.to(OWNER_TABLET) : undefined,
        5000,
        'comment like push',
      );
      expect(liked).toMatchObject({
        title: 'stranger liked your comment',
        body: '"you coming?" on Albertina',
        data: {
          type: 'likes_grouped',
          deepLink: `tripinly://markers/${markerId}`,
        },
      });
    });

    it('stops likes and flames when the Likes switch is off', async () => {
      await as(owner)
        .patch('/v1/me/notification-settings')
        .send({ likesGrouped: false })
        .expect(200);
      const markerId = await addMarker(owner);
      const { body: comment } = await as(owner)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'you coming?' })
        .expect(201);
      await as(stranger)
        .put(`/v1/likes/comment/${(comment as { id: string }).id}`)
        .expect(200);
      await worker.get(NotificationPlanner).plan({
        kind: 'liked',
        actorId: stranger.userId,
        targetType: 'trip',
        targetId: trip.id,
        tripId: trip.id,
        count: 5,
      });
      await eventually(
        async () =>
          (await prisma.notification.count({
            where: { recipientId: owner.userId, pushedAt: { not: null } },
          })) === 2,
        5000,
        'push jobs',
      );
      expect(push.to(OWNER_TABLET)).toEqual([]);
    });
  });

  describe('saves', () => {
    it('puts a save in the notification center, without a push', async () => {
      await as(stranger).put(`/v1/trips/${trip.id}/save`).expect(204);
      await as(stranger).delete(`/v1/trips/${trip.id}/save`).expect(204);
      await as(stranger).put(`/v1/trips/${trip.id}/save`).expect(204);
      const [saved] = await eventually(
        async () => {
          const page = await list(owner);
          return page.items.length ? page.items : undefined;
        },
        5000,
        'save entry',
      );
      expect(saved).toMatchObject({
        type: 'trip_saved',
        title: 'stranger saved your trip',
        body: 'Vienna',
        deepLink: `tripinly://trips/${trip.id}`,
      });
      await sleep(500);
      expect(push.to(OWNER_TABLET)).toEqual([]);
      expect(
        await prisma.notification.count({ where: { type: 'trip_saved' } }),
      ).toBe(1);
    });
  });

  describe('follows', () => {
    it('says followed once per person ever, then friends when followed back, once a day', async () => {
      await as(stranger).put(`/v1/users/${owner.userId}/follow`).expect(204);
      await as(stranger).delete(`/v1/users/${owner.userId}/follow`).expect(204);
      await as(stranger).put(`/v1/users/${owner.userId}/follow`).expect(204);
      const [followed] = await eventually(
        () =>
          push.to(OWNER_TABLET).length ? push.to(OWNER_TABLET) : undefined,
        5000,
        'follow push',
      );
      expect(followed).toMatchObject({
        title: 'stranger followed you',
        body: 'Follow back to become friends.',
        data: { type: 'followed', deepLink: 'tripinly://users/stranger' },
      });
      await device(stranger, 'stranger-phone-token-0000004', 'en');
      await as(owner).put(`/v1/users/${stranger.userId}/follow`).expect(204);
      const [friends] = await eventually(
        () =>
          push.to('stranger-phone-token-0000004').length
            ? push.to('stranger-phone-token-0000004')
            : undefined,
        5000,
        'friends push',
      );
      expect(friends).toMatchObject({
        title: 'You and owner are now friends',
        data: { type: 'became_friends', deepLink: 'tripinly://users/owner' },
      });
      await sleep(500);
      expect(push.to(OWNER_TABLET)).toHaveLength(1);
    });

    it('says nothing across a block, and stops with the New followers switch', async () => {
      await as(owner)
        .patch('/v1/me/notification-settings')
        .send({ newFollowers: false })
        .expect(200);
      await as(stranger).put(`/v1/users/${owner.userId}/follow`).expect(204);
      await eventually(
        async () =>
          (await prisma.notification.count({
            where: { recipientId: owner.userId, pushedAt: { not: null } },
          })) === 1,
        5000,
        'push job',
      );
      expect(push.to(OWNER_TABLET)).toEqual([]);
      await worker.get(NotificationPlanner).plan({
        kind: 'followed',
        actorId: editor.userId,
        followeeId: owner.userId,
      });
      // The editor doesn't follow the owner: nothing to tell.
      expect(
        await prisma.notification.count({
          where: { recipientId: owner.userId, actorId: editor.userId },
        }),
      ).toBe(0);
    });
  });

  describe('spots getting hot', () => {
    /** A spot the owner made by naming a stop, so they are its creator. */
    async function ownersSpot(): Promise<{ spotId: string; markerId: string }> {
      const { body } = await as(owner)
        .post(`/v1/days/${trip.days[0].id}/markers`)
        .send({ name: 'DC Flats', location: { lat: 48.23, lng: 16.41 } })
        .expect(201);
      const stop = body as { id: string; placeId: string };
      return { spotId: stop.placeId, markerId: stop.id };
    }

    it('gathers flames in one entry for the creator, pushing once per milestone', async () => {
      const { spotId, markerId } = await ownersSpot();
      const planner = worker.get(NotificationPlanner);
      const flame = (hotCount: number) =>
        planner.plan({
          kind: 'place_hot',
          actorId: stranger.userId,
          placeId: spotId,
          hotCount,
        });
      await flame(4);
      await flame(5);
      // Taken back and given again: no second push for the same milestone.
      await flame(5);
      const rows = await prisma.notification.findMany({
        where: { type: 'place_hot' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        recipientId: owner.userId,
        actorId: stranger.userId,
        tripId: trip.id,
        markerId,
        count: 5,
      });
      const [hot] = await eventually(
        () =>
          push.to(OWNER_TABLET).find((m) => m.data.type === 'place_hot')
            ? push.to(OWNER_TABLET).filter((m) => m.data.type === 'place_hot')
            : undefined,
        5000,
        'hot push',
      );
      expect(hot).toMatchObject({
        title: 'DC Flats is getting hot',
        body: '5 people marked your spot hot. Nice find!',
        data: { deepLink: `tripinly://markers/${markerId}` },
      });
      await flame(25);
      await eventually(
        () =>
          push.to(OWNER_TABLET).filter((m) => m.data.type === 'place_hot')
            .length === 2,
        5000,
        'second milestone push',
      );
      expect(
        await prisma.notification.count({ where: { type: 'place_hot' } }),
      ).toBe(1);
      await sleep(300);
      expect(
        push.to(OWNER_TABLET).filter((m) => m.data.type === 'place_hot'),
      ).toHaveLength(2);
    });

    it('sends nothing for OpenStreetMap spots, which have no creator', async () => {
      await worker
        .get(NotificationPlanner)
        .plan({ kind: 'place_hot', placeId, hotCount: 5 });
      expect(
        await prisma.notification.count({ where: { type: 'place_hot' } }),
      ).toBe(0);
    });
  });

  describe('new activity on stops', () => {
    it('marks stops with unread notifications until I open them', async () => {
      const markerId = await addMarker(owner);
      await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Nice' })
        .expect(201);
      await eventually(async () => {
        const { body } = await as(owner)
          .get(`/v1/trips/${trip.id}/new-activity`)
          .expect(200);
        return (body as { markerIds: string[] }).markerIds.length === 1;
      });
      await as(owner)
        .get(`/v1/trips/${trip.id}/new-activity`)
        .expect(200, { markerIds: [markerId], commentMarkerIds: [markerId] });
      // Opening the stop leaves the comment's mark; seeing the comments clears it.
      await as(owner)
        .post('/v1/notifications/read')
        .send({ markerId, kind: 'other' })
        .expect(204);
      await as(owner)
        .get(`/v1/trips/${trip.id}/new-activity`)
        .expect(200, { markerIds: [markerId], commentMarkerIds: [markerId] });
      await as(owner)
        .post('/v1/notifications/read')
        .send({ markerId, kind: 'comments' })
        .expect(204);
      await as(owner)
        .get(`/v1/trips/${trip.id}/new-activity`)
        .expect(200, { markerIds: [], commentMarkerIds: [] });
    });

    it('leaves out blocked people and refuses trips I cannot see', async () => {
      const markerId = await addMarker(owner);
      await as(stranger)
        .post(`/v1/markers/${markerId}/comments`)
        .send({ body: 'Nice' })
        .expect(201);
      await eventually(async () => (await list(owner)).items.length === 1);
      await as(owner).post(`/v1/users/${stranger.userId}/block`).expect(204);
      await as(owner)
        .get(`/v1/trips/${trip.id}/new-activity`)
        .expect(200, { markerIds: [], commentMarkerIds: [] });
      const { body: secret } = await as(owner)
        .post('/v1/trips')
        .send({ title: 'Secret', visibility: 'private' })
        .expect(201);
      await as(stranger)
        .get(`/v1/trips/${(secret as TripBody).id}/new-activity`)
        .expect(404);
      await api(app)
        .anonymous.get(`/v1/trips/${trip.id}/new-activity`)
        .expect(401);
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

    it('counts entries new since I last opened the center, read or not', async () => {
      await as(stranger).put(`/v1/trips/${trip.id}/save`).expect(204);
      await eventually(async () => (await list(owner)).unseenCount === 1);
      await as(owner).post('/v1/notifications/seen').expect(204);
      expect(await list(owner)).toMatchObject({
        unseenCount: 0,
        unreadCount: 1,
      });
      // An entry coming back on top (another like on the same trip) is unseen again.
      await as(stranger).put(`/v1/likes/trip/${trip.id}`).expect(200);
      await eventually(async () => (await list(owner)).unseenCount === 1);
      await as(editor).put(`/v1/likes/trip/${trip.id}`).expect(200);
      await eventually(async () => (await list(owner)).items[0].count === 2);
      await as(owner).post('/v1/notifications/seen').expect(204);
      await as(stranger).delete(`/v1/likes/trip/${trip.id}`).expect(200);
      await as(stranger).put(`/v1/likes/trip/${trip.id}`).expect(200);
      await eventually(async () => (await list(owner)).unseenCount === 1);
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
        .post('/v1/notifications/read')
        .send({ kind: 'comments' })
        .expect(400);
      await as(owner)
        .post('/v1/notifications/read')
        .send({
          markerId: '00000000-0000-4000-8000-000000000000',
          kind: 'photos',
        })
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
        joinRequested: true,
        newFollowers: true,
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
