import type { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  devSignIn,
  onboardedUser,
  publishLegalDocuments,
  resetState,
  type Session,
} from '../utils/auth-helpers';
import { api } from '../utils/api';
import { createTestApp } from '../utils/create-test-app';

interface UserPage {
  items: { id: string; username: string; displayName: string }[];
  nextCursor: string | null;
}

describe('Follows (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: ReturnType<typeof api>['as'];
  let anonymous: ReturnType<typeof api>['anonymous'];
  let ann: Session;
  let bea: Session;
  let cid: Session;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ({ as, anonymous } = api(app));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState(app);
    await publishLegalDocuments(app);
    ann = await onboardedUser(app, 'ann');
    bea = await onboardedUser(app, 'bea');
    cid = await onboardedUser(app, 'cid');
  });

  const follow = (from: Session, to: Session) =>
    as(from).put(`/v1/users/${to.userId}/follow`).expect(204);

  const usernames = (page: UserPage) => page.items.map((u) => u.username);

  const list = async (session: Session, path: string): Promise<UserPage> =>
    (await as(session).get(path).expect(200)).body as UserPage;

  it('follows and unfollows idempotently and emits user.followed once', async () => {
    const emit = jest.spyOn(app.get(EventEmitter2), 'emit');
    await follow(ann, bea);
    await follow(ann, bea);
    expect(
      await prisma.follow.count({
        where: { followerId: ann.userId, followeeId: bea.userId },
      }),
    ).toBe(1);
    const followed = emit.mock.calls.filter(
      ([event]) => event === 'user.followed',
    );
    expect(followed).toHaveLength(1);
    expect(followed[0][1]).toMatchObject({
      actorId: ann.userId,
      data: { followeeId: bea.userId },
    });
    emit.mockRestore();

    expect(usernames(await list(ann, '/v1/me/following'))).toEqual(['bea']);
    expect(usernames(await list(bea, '/v1/me/followers'))).toEqual(['ann']);

    await as(ann).delete(`/v1/users/${bea.userId}/follow`).expect(204);
    await as(ann).delete(`/v1/users/${bea.userId}/follow`).expect(204);
    expect(await prisma.follow.count()).toBe(0);
    expect((await list(ann, '/v1/me/following')).items).toEqual([]);
  });

  it('rejects following yourself, unknown, suspended and malformed ids', async () => {
    const self = await as(ann)
      .put(`/v1/users/${ann.userId}/follow`)
      .expect(400);
    expect(self.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { id: ['cannotFollowSelf'] } },
    });

    const unknown = await as(ann)
      .put('/v1/users/00000000-0000-4000-8000-000000000000/follow')
      .expect(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');

    await prisma.user.update({
      where: { id: cid.userId },
      data: { status: 'suspended' },
    });
    await as(ann).put(`/v1/users/${cid.userId}/follow`).expect(404);

    const malformed = await as(ann).put('/v1/users/nope/follow').expect(400);
    expect(malformed.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('answers 404 across a block in either direction', async () => {
    await as(ann).post(`/v1/users/${bea.userId}/block`).expect(204);
    const mine = await as(ann).put(`/v1/users/${bea.userId}/follow`);
    expect(mine.status).toBe(404);
    expect(mine.body.error.code).toBe('NOT_FOUND');
    await as(bea).put(`/v1/users/${ann.userId}/follow`).expect(404);
    expect(await prisma.follow.count()).toBe(0);
  });

  it('removes follows both ways when either side blocks', async () => {
    await follow(ann, bea);
    await follow(bea, ann);
    await follow(ann, cid);
    expect(usernames(await list(ann, '/v1/me/friends'))).toEqual(['bea']);

    await as(bea).post(`/v1/users/${ann.userId}/block`).expect(204);
    expect(await prisma.follow.count()).toBe(1);
    expect((await list(ann, '/v1/me/friends')).items).toEqual([]);
    expect(usernames(await list(ann, '/v1/me/following'))).toEqual(['cid']);

    // Unblocking doesn't bring the follows back.
    await as(bea).delete(`/v1/users/${ann.userId}/block`).expect(204);
    expect((await list(ann, '/v1/me/followers')).items).toEqual([]);
  });

  it('lists only mutual follows as friends', async () => {
    await follow(ann, bea);
    await follow(bea, ann);
    await follow(ann, cid); // one way: not a friend
    const friends = await list(ann, '/v1/me/friends');
    expect(friends).toEqual({
      items: [
        {
          id: bea.userId,
          username: 'bea',
          displayName: 'bea',
        },
      ],
      nextCursor: null,
    });
    expect((await list(cid, '/v1/me/friends')).items).toEqual([]);
    expect(usernames(await list(cid, '/v1/me/followers'))).toEqual(['ann']);
    expect(usernames(await list(ann, '/v1/me/following')).sort()).toEqual([
      'bea',
      'cid',
    ]);
  });

  it('pages friends by display name and follows by recency', async () => {
    const names = ['dan', 'eve', 'fay', 'gus', 'hal'];
    for (const name of [...names].reverse()) {
      const other = await onboardedUser(app, name);
      await follow(ann, other);
      await follow(other, ann);
    }
    const first = await list(ann, '/v1/me/friends?limit=2');
    expect(usernames(first)).toEqual(['dan', 'eve']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await list(
      ann,
      `/v1/me/friends?limit=2&cursor=${first.nextCursor}`,
    );
    expect(usernames(second)).toEqual(['fay', 'gus']);
    const third = await list(
      ann,
      `/v1/me/friends?limit=2&cursor=${second.nextCursor}`,
    );
    expect(third).toMatchObject({ nextCursor: null });
    expect(usernames(third)).toEqual(['hal']);

    // Following: most recently followed first (hal was followed first).
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: UserPage = await list(
        ann,
        `/v1/me/following?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...usernames(page));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['dan', 'eve', 'fay', 'gus', 'hal']);

    await as(ann).get('/v1/me/friends?cursor=nope').expect(400);
    await as(ann).get('/v1/me/followers?limit=51').expect(400);
  });

  it('shows follow state and counts on the public profile', async () => {
    await follow(ann, bea);
    await follow(bea, ann);
    await follow(cid, bea);

    const profile = await as(ann).get('/v1/users/bea').expect(200);
    expect(profile.body).toMatchObject({
      user: { username: 'bea' },
      followerCount: 2,
      followingCount: 1,
      isFollowing: true,
      followsMe: true,
      isFriend: true,
    });

    const forCid = await as(cid).get('/v1/users/ann').expect(200);
    expect(forCid.body).toMatchObject({
      followerCount: 1,
      followingCount: 1,
      isFollowing: false,
      followsMe: false,
      isFriend: false,
    });

    // Counts leave out people with a block with the viewer.
    await as(cid).post(`/v1/users/${ann.userId}/block`).expect(204);
    const blockedView = await as(cid).get('/v1/users/bea').expect(200);
    expect(blockedView.body).toMatchObject({
      followerCount: 1,
      isFollowing: true,
      isFriend: false,
    });

    const own = await as(bea).get('/v1/users/bea').expect(200);
    expect(own.body).toMatchObject({
      isFollowing: false,
      followsMe: false,
      isFriend: false,
    });
  });

  it('needs a signed-in, onboarded user', async () => {
    for (const path of [
      '/v1/me/friends',
      '/v1/me/following',
      '/v1/me/followers',
    ]) {
      await anonymous.get(path).expect(401);
    }
    await request(app.getHttpServer())
      .put(`/v1/users/${bea.userId}/follow`)
      .expect(401);

    const newcomer = await devSignIn(app, 'newcomer');
    const blocked = await as(newcomer)
      .put(`/v1/users/${bea.userId}/follow`)
      .expect(403);
    expect(blocked.body.error.code).toBe('ONBOARDING_INCOMPLETE');
    const friends = await as(newcomer).get('/v1/me/friends').expect(403);
    expect(friends.body.error.code).toBe('ONBOARDING_INCOMPLETE');
  });
});
