import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  acceptRequiredConsents,
  devSignIn,
  onboardedUser,
  publishLegalDocuments,
  resetState,
} from '../utils/auth-helpers';
import { createTestApp } from '../utils/create-test-app';

/** Stands in for any regular feature route (onboarding and consents required). */
@Controller('test-protected')
class ProtectedController {
  @Get()
  ok() {
    return { ok: true };
  }
}

@Module({ controllers: [ProtectedController] })
class ProtectedModule {}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Onboarding, profile, consents and devices (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp({ imports: [ProtectedModule] });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState(app);
    await publishLegalDocuments(app);
  });

  describe('onboarding', () => {
    it('walks a new user through profile and consents', async () => {
      const session = await devSignIn(app, 'newbie', 'Newbie');
      const auth = { type: 'bearer' } as const;

      const me = await request(server())
        .get('/v1/me')
        .auth(session.accessToken, auth)
        .expect(200);
      expect(me.body.onboarding).toEqual({
        completed: false,
        missingProfileFields: ['username', 'birthDate'],
        missingConsents: ['terms', 'privacy'],
      });

      const blocked = await request(server())
        .get('/v1/test-protected')
        .auth(session.accessToken, auth)
        .expect(403);
      expect(blocked.body.error.code).toBe('ONBOARDING_INCOMPLETE');

      const updated = await request(server())
        .patch('/v1/me')
        .auth(session.accessToken, auth)
        .send({ username: '  Newbie.One ', birthDate: '2000-02-29' })
        .expect(200);
      expect(updated.body).toMatchObject({
        username: 'newbie.one',
        birthDate: '2000-02-29',
      });
      expect(updated.body.onboarding.missingConsents).toEqual([
        'terms',
        'privacy',
      ]);

      await acceptRequiredConsents(app, session);
      const done = await request(server())
        .get('/v1/me')
        .auth(session.accessToken, auth)
        .expect(200);
      expect(done.body.onboarding.completed).toBe(true);

      // The token still says "not onboarded"; the guard checks the database instead.
      await request(server())
        .get('/v1/test-protected')
        .auth(session.accessToken, auth)
        .expect(200);

      const refreshed = await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(200);
      expect(refreshed.body.onboardingRequired).toBe(false);
    });

    it('rejects under-16 users and deletes the account', async () => {
      const session = await devSignIn(app, 'too-young');
      const birthDate = new Date(Date.now() - 15 * 365 * DAY_MS)
        .toISOString()
        .slice(0, 10);
      const response = await request(server())
        .patch('/v1/me')
        .auth(session.accessToken, { type: 'bearer' })
        .send({ birthDate })
        .expect(422);
      expect(response.body.error).toMatchObject({
        code: 'AGE_REQUIREMENT_NOT_MET',
        details: { minimumAge: 16 },
      });
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.refreshToken.count()).toBe(0);
      await request(server())
        .get('/v1/me')
        .auth(session.accessToken, { type: 'bearer' })
        .expect(401);
    });

    it('accepts users who turn 16 today', async () => {
      const session = await devSignIn(app, 'sixteen');
      const today = new Date();
      const birthDate = `${today.getUTCFullYear() - 16}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
      await request(server())
        .patch('/v1/me')
        .auth(session.accessToken, { type: 'bearer' })
        .send({ birthDate })
        .expect(200);
    });

    it('rejects impossible birth dates', async () => {
      const session = await devSignIn(app, 'bad-date');
      for (const birthDate of ['2999-01-01', '1990-02-30', '1990-1-1']) {
        const response = await request(server())
          .patch('/v1/me')
          .auth(session.accessToken, { type: 'bearer' })
          .send({ birthDate })
          .expect(400);
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('does not allow changing the birth date after onboarding', async () => {
      const session = await onboardedUser(app, 'settled');
      const response = await request(server())
        .patch('/v1/me')
        .auth(session.accessToken, { type: 'bearer' })
        .send({ birthDate: '1980-01-01' })
        .expect(400);
      expect(response.body.error.details.fields.birthDate).toEqual([
        'immutableAfterOnboarding',
      ]);
    });

    it('lets signed-out clients read the legal documents in their language', async () => {
      const response = await request(server())
        .get('/v1/legal/documents')
        .set('Accept-Language', 'de')
        .expect(200);
      expect(response.body.items).toHaveLength(2);
      expect(response.body.items[0]).toMatchObject({
        locale: 'de',
        version: 'v1',
        required: true,
      });

      const fallback = await request(server())
        .get('/v1/legal/documents?locale=hu')
        .expect(200);
      expect(fallback.body.items[0].locale).toBe('en');
    });
  });

  describe('usernames', () => {
    it('validates format and availability', async () => {
      await onboardedUser(app, 'taken_name');
      const session = await devSignIn(app, 'chooser');
      const auth = { type: 'bearer' } as const;

      const invalid = await request(server())
        .patch('/v1/me')
        .auth(session.accessToken, auth)
        .send({ username: 'a..b' })
        .expect(422);
      expect(invalid.body.error.code).toBe('USERNAME_INVALID');

      for (const username of ['Taken_Name', 'admin']) {
        const taken = await request(server())
          .patch('/v1/me')
          .auth(session.accessToken, auth)
          .send({ username })
          .expect(409);
        expect(taken.body.error.code).toBe('USERNAME_TAKEN');
      }

      const check = await request(server())
        .get('/v1/users/check-username?username=taken_name')
        .auth(session.accessToken, auth)
        .expect(200);
      expect(check.body).toEqual({
        username: 'taken_name',
        available: false,
        reason: 'taken',
      });

      const free = await request(server())
        .get('/v1/users/check-username?username=Free.Name')
        .auth(session.accessToken, auth)
        .expect(200);
      expect(free.body).toEqual({ username: 'free.name', available: true });
    });

    it('allows one change every 30 days and holds the old name', async () => {
      const session = await onboardedUser(app, 'old_name');
      const auth = { type: 'bearer' } as const;

      const tooSoon = await request(server())
        .patch('/v1/me')
        .auth(session.accessToken, auth)
        .send({ username: 'new_name' })
        .expect(422);
      expect(tooSoon.body.error.code).toBe('USERNAME_CHANGE_TOO_SOON');
      expect(
        Date.parse(tooSoon.body.error.details.availableAt),
      ).toBeGreaterThan(Date.now());

      await prisma.user.update({
        where: { id: session.userId },
        data: { onboardedAt: new Date(Date.now() - 31 * DAY_MS) },
      });
      await request(server())
        .patch('/v1/me')
        .auth(session.accessToken, auth)
        .send({ username: 'new_name' })
        .expect(200);

      const other = await onboardedUser(app, 'someone');
      await prisma.user.update({
        where: { id: other.userId },
        data: { onboardedAt: new Date(Date.now() - 31 * DAY_MS) },
      });
      const held = await request(server())
        .patch('/v1/me')
        .auth(other.accessToken, auth)
        .send({ username: 'old_name' })
        .expect(409);
      expect(held.body.error.code).toBe('USERNAME_TAKEN');
    });
  });

  describe('consents', () => {
    it('only accepts the current version', async () => {
      const session = await devSignIn(app, 'consenter');
      const response = await request(server())
        .post('/v1/me/consents')
        .auth(session.accessToken, { type: 'bearer' })
        .send({
          documentType: 'terms',
          version: 'v0',
          locale: 'en',
          granted: true,
        })
        .expect(400);
      expect(response.body.error.details.fields.version).toEqual([
        'notCurrentVersion',
      ]);
    });

    it('asks for consent again when a new version requires it', async () => {
      const session = await onboardedUser(app, 'returning');
      const auth = { type: 'bearer' } as const;
      await request(server())
        .get('/v1/test-protected')
        .auth(session.accessToken, auth)
        .expect(200);

      await publishLegalDocuments(app, 'v2', {
        publishedAt: new Date(Date.now() - 1000),
      });
      const blocked = await request(server())
        .get('/v1/test-protected')
        .auth(session.accessToken, auth)
        .expect(403);
      expect(blocked.body.error.code).toBe('CONSENT_REQUIRED');

      const list = await request(server())
        .get('/v1/me/consents')
        .auth(session.accessToken, auth)
        .expect(200);
      expect(list.body.missingRequired).toEqual(['terms', 'privacy']);

      await acceptRequiredConsents(app, session, 'v2');
      await request(server())
        .get('/v1/test-protected')
        .auth(session.accessToken, auth)
        .expect(200);
    });

    it('does not ask again for a minor update', async () => {
      const session = await onboardedUser(app, 'minor_update');
      await publishLegalDocuments(app, 'v1.1', {
        publishedAt: new Date(Date.now() - 1000),
        requiresReconsent: false,
      });
      await request(server())
        .get('/v1/test-protected')
        .auth(session.accessToken, { type: 'bearer' })
        .expect(200);
    });

    it('blocks the app after a required consent is withdrawn', async () => {
      const session = await onboardedUser(app, 'withdrawer');
      const auth = { type: 'bearer' } as const;
      const response = await request(server())
        .post('/v1/me/consents')
        .auth(session.accessToken, auth)
        .send({
          documentType: 'privacy',
          version: 'v1',
          locale: 'en',
          granted: false,
        })
        .expect(200);
      expect(response.body.missingRequired).toEqual(['privacy']);
      const blocked = await request(server())
        .get('/v1/test-protected')
        .auth(session.accessToken, auth)
        .expect(403);
      expect(blocked.body.error.code).toBe('CONSENT_REQUIRED');
    });
  });

  describe('devices', () => {
    const fcmToken = 'fcm:device-token_0123456789';

    it('registers a device and moves it to whoever signs in on it next', async () => {
      const alice = await onboardedUser(app, 'alice');
      const bob = await onboardedUser(app, 'bob');
      const auth = { type: 'bearer' } as const;

      await request(server())
        .put(`/v1/me/devices/${fcmToken}`)
        .auth(alice.accessToken, auth)
        .send({ platform: 'ios', locale: 'hu-HU' })
        .expect(204);
      await request(server())
        .put(`/v1/me/devices/${fcmToken}`)
        .auth(bob.accessToken, auth)
        .send({ platform: 'ios', locale: 'en' })
        .expect(204);

      const devices = await prisma.device.findMany();
      expect(devices).toEqual([
        expect.objectContaining({ userId: bob.userId, locale: 'en' }),
      ]);

      // Alice can no longer remove Bob's device.
      await request(server())
        .delete(`/v1/me/devices/${fcmToken}`)
        .auth(alice.accessToken, auth)
        .expect(204);
      expect(await prisma.device.count()).toBe(1);
      await request(server())
        .delete(`/v1/me/devices/${fcmToken}`)
        .auth(bob.accessToken, auth)
        .expect(204);
      expect(await prisma.device.count()).toBe(0);
    });

    it('validates the platform and token', async () => {
      const session = await onboardedUser(app, 'validator');
      const auth = { type: 'bearer' } as const;
      const badToken = await request(server())
        .put('/v1/me/devices/short')
        .auth(session.accessToken, auth)
        .send({ platform: 'ios', locale: 'en' })
        .expect(400);
      expect(badToken.body.error.details.fields).toEqual({
        fcmToken: ['isLength'],
      });
      const badPlatform = await request(server())
        .put(`/v1/me/devices/${fcmToken}`)
        .auth(session.accessToken, auth)
        .send({ platform: 'windows', locale: 'en' })
        .expect(400);
      expect(badPlatform.body.error.details.fields).toEqual({
        platform: ['isIn'],
      });
    });
  });
});
