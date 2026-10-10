import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client, type LoginTicket } from 'google-auth-library';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from 'jose';
import request from 'supertest';
import { decrypt } from '../../src/common/crypto/crypto';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  APPLE_ISSUER,
  AppleIdentityVerifier,
} from '../../src/modules/auth/identity/apple-identity.verifier';
import { devSignIn, resetState, type Session } from '../utils/auth-helpers';
import { createTestApp } from '../utils/create-test-app';

const APPLE_BUNDLE_ID = 'com.tripinly.test';

describe('Auth (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let appleKey: CryptoKey;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256');
    appleKey = pair.privateKey;
    const jwk: JWK = {
      ...(await exportJWK(pair.publicKey)),
      kid: 'test',
      alg: 'ES256',
    };
    const keySet = createLocalJWKSet({ keys: [jwk] });
    app = await createTestApp({
      override: (builder) =>
        builder.overrideProvider(AppleIdentityVerifier).useFactory({
          factory: (config: ConfigService) =>
            new AppleIdentityVerifier(config as never, keySet),
          inject: [ConfigService],
        }),
    });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState(app);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function appleToken(
    claims: Record<string, unknown>,
    audience = APPLE_BUNDLE_ID,
  ) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'test' })
      .setIssuer(APPLE_ISSUER)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(appleKey);
  }

  function mockGoogle(payload: Record<string, unknown> | Error) {
    return jest
      .spyOn(OAuth2Client.prototype, 'verifyIdToken')
      .mockImplementation((() =>
        payload instanceof Error
          ? Promise.reject(payload)
          : Promise.resolve({
              getPayload: () => payload,
            } as unknown as LoginTicket)) as never);
  }

  describe('POST /v1/auth/google', () => {
    const payload = {
      iss: 'https://accounts.google.com',
      sub: 'google-123',
      email: 'jonas@example.com',
      name: 'Jonas Keller',
    };

    it('creates the account on first sign-in and reuses it afterwards', async () => {
      mockGoogle(payload);
      const first = await request(server())
        .post('/v1/auth/google')
        .send({ idToken: 'x' })
        .expect(200);
      expect(first.body).toEqual({
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(String),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(String),
        onboardingRequired: true,
      });

      mockGoogle({ ...payload, email: 'jonas.new@example.com' });
      await request(server())
        .post('/v1/auth/google')
        .send({ idToken: 'x' })
        .expect(200);

      const identities = await prisma.authIdentity.findMany({
        include: { user: true },
      });
      expect(identities).toHaveLength(1);
      expect(identities[0].email).toBe('jonas.new@example.com');
      expect(identities[0].user.displayName).toBe('Jonas Keller');
    });

    it('checks the token against the configured client IDs', async () => {
      const spy = mockGoogle(payload);
      await request(server())
        .post('/v1/auth/google')
        .send({ idToken: 'x' })
        .expect(200);
      expect(spy).toHaveBeenCalledWith({
        idToken: 'x',
        audience: ['test-google-client-id'],
      });
    });

    it('rejects an invalid token', async () => {
      mockGoogle(new Error('Wrong recipient'));
      const response = await request(server())
        .post('/v1/auth/google')
        .send({ idToken: 'x' })
        .expect(401);
      expect(response.body.error).toMatchObject({
        code: 'UNAUTHENTICATED',
        details: { reason: 'invalid_identity_token' },
      });
    });

    it('rejects a missing token with VALIDATION_FAILED', async () => {
      const response = await request(server())
        .post('/v1/auth/google')
        .send({})
        .expect(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.details.fields.idToken).toBeDefined();
    });

    it('refuses suspended accounts', async () => {
      mockGoogle(payload);
      await request(server())
        .post('/v1/auth/google')
        .send({ idToken: 'x' })
        .expect(200);
      await prisma.user.updateMany({ data: { status: 'suspended' } });
      const response = await request(server())
        .post('/v1/auth/google')
        .send({ idToken: 'x' })
        .expect(403);
      expect(response.body.error.code).toBe('ACCOUNT_SUSPENDED');
    });
  });

  describe('POST /v1/auth/apple', () => {
    it('signs in, keeps the name Apple sends once, and stores the Apple token encrypted', async () => {
      jest
        .spyOn(AppleIdentityVerifier.prototype, 'exchangeAuthorizationCode')
        .mockResolvedValue('apple-refresh-token');
      const identityToken = await appleToken({
        sub: 'apple-001',
        email: 'x@privaterelay.appleid.com',
      });

      await request(server())
        .post('/v1/auth/apple')
        .send({
          identityToken,
          authorizationCode: 'code',
          givenName: 'Anna',
          familyName: 'Nagy',
        })
        .expect(200);

      const identity = await prisma.authIdentity.findFirstOrThrow({
        include: { user: true },
      });
      expect(identity.provider).toBe('apple');
      expect(identity.user.displayName).toBe('Anna Nagy');
      expect(identity.appleRefreshToken).not.toContain('apple-refresh-token');
      const key = Buffer.from(process.env.ENCRYPTION_KEY!, 'base64');
      expect(decrypt(identity.appleRefreshToken!, key)).toBe(
        'apple-refresh-token',
      );
    });

    it('still signs in when the code exchange fails', async () => {
      jest
        .spyOn(AppleIdentityVerifier.prototype, 'exchangeAuthorizationCode')
        .mockResolvedValue(null);
      const identityToken = await appleToken({ sub: 'apple-002' });
      await request(server())
        .post('/v1/auth/apple')
        .send({ identityToken, authorizationCode: 'code' })
        .expect(200);
      const identity = await prisma.authIdentity.findFirstOrThrow();
      expect(identity.appleRefreshToken).toBeNull();
    });

    it('rejects a token issued for another app', async () => {
      const identityToken = await appleToken(
        { sub: 'apple-003' },
        'com.someone.else',
      );
      const response = await request(server())
        .post('/v1/auth/apple')
        .send({ identityToken, authorizationCode: 'code' })
        .expect(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('POST /v1/auth/refresh', () => {
    let session: Session;

    beforeEach(async () => {
      session = await devSignIn(app, 'refresh-user');
    });

    it('rotates the refresh token', async () => {
      const response = await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(200);
      expect(response.body.refreshToken).not.toBe(session.refreshToken);
      await request(server())
        .get('/v1/me')
        .auth(response.body.accessToken, { type: 'bearer' })
        .expect(200);
    });

    const refresh = (refreshToken: string) =>
      request(server()).post('/v1/auth/refresh').send({ refreshToken });
    /** Moves every rotation of this user's tokens back past the grace period. */
    const pastGrace = () =>
      prisma.refreshToken.updateMany({
        where: { userId: session.userId, revokedAt: { not: null } },
        data: { revokedAt: new Date(Date.now() - 31_000) },
      });

    it('revokes the whole session when an old token is reused after the grace period', async () => {
      const rotated = await refresh(session.refreshToken).expect(200);
      await pastGrace();

      const reuse = await refresh(session.refreshToken).expect(401);
      expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');

      // The legitimate holder of the newer token is signed out too.
      const newer = await refresh(rotated.body.refreshToken).expect(401);
      expect(newer.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    });

    it('answers a token used again within 30 s whose answer was lost', async () => {
      const lost = await refresh(session.refreshToken).expect(200);

      const again = await refresh(session.refreshToken).expect(200);
      expect(again.body.refreshToken).not.toBe(lost.body.refreshToken);

      // The session goes on with the second answer; the lost one is used up.
      await refresh(again.body.refreshToken).expect(200);
      await pastGrace();
      const stale = await refresh(lost.body.refreshToken).expect(401);
      expect(stale.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    });

    it('revokes the session when a token is reused after its successor was used', async () => {
      const rotated = await refresh(session.refreshToken).expect(200);
      await refresh(rotated.body.refreshToken).expect(200);

      const reuse = await refresh(session.refreshToken).expect(401);
      expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    });

    it('answers two concurrent refreshes of the same token', async () => {
      const results = await Promise.all(
        [1, 2].map(() => refresh(session.refreshToken)),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const [first, second] = results.map((r) => r.body.refreshToken);
      expect(first).not.toBe(second);
    });

    it('rejects unknown and expired tokens', async () => {
      await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: 'nope' })
        .expect(401);
      await prisma.refreshToken.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const response = await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('refuses suspended accounts and ends their sessions', async () => {
      await prisma.user.update({
        where: { id: session.userId },
        data: { status: 'suspended' },
      });
      const response = await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(403);
      expect(response.body.error.code).toBe('ACCOUNT_SUSPENDED');
      expect(
        await prisma.refreshToken.count({ where: { revokedAt: null } }),
      ).toBe(0);
    });
  });

  describe('POST /v1/auth/logout', () => {
    it('revokes the session and unregisters the device', async () => {
      const session = await devSignIn(app, 'logout-user');
      const fcmToken = 'fcm-token-logout-0000000000';
      await request(server())
        .put(`/v1/me/devices/${fcmToken}`)
        .auth(session.accessToken, { type: 'bearer' })
        .send({ platform: 'android', locale: 'de-AT' })
        .expect(204);

      await request(server())
        .post('/v1/auth/logout')
        .send({ refreshToken: session.refreshToken, fcmToken })
        .expect(204);

      expect(await prisma.device.count()).toBe(0);
      await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
    });

    it('succeeds silently for unknown tokens', async () => {
      await request(server())
        .post('/v1/auth/logout')
        .send({ refreshToken: 'unknown' })
        .expect(204);
    });
  });

  describe('access tokens', () => {
    it('requires a bearer token', async () => {
      const response = await request(server()).get('/v1/me').expect(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
      await request(server())
        .get('/v1/me')
        .set('Authorization', 'Basic abc')
        .expect(401);
      await request(server())
        .get('/v1/me')
        .auth('not-a-jwt', { type: 'bearer' })
        .expect(401);
    });

    it('reports expired tokens as TOKEN_EXPIRED', async () => {
      const session = await devSignIn(app, 'expired-user');
      const secret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET);
      const past = Math.floor(Date.now() / 1000) - 3600;
      const expired = await new SignJWT({ role: 'user', onb: false })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(session.userId)
        .setIssuer('tripinly')
        .setAudience('tripinly-app')
        .setIssuedAt(past - 900)
        .setExpirationTime(past)
        .sign(secret);
      const response = await request(server())
        .get('/v1/me')
        .auth(expired, { type: 'bearer' })
        .expect(401);
      expect(response.body.error.code).toBe('TOKEN_EXPIRED');
    });

    it('rejects tokens signed with another key', async () => {
      const forged = await new SignJWT({ role: 'admin', onb: true })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('00000000-0000-0000-0000-000000000000')
        .setIssuer('tripinly')
        .setAudience('tripinly-app')
        .setExpirationTime('5m')
        .sign(
          new TextEncoder().encode('another-secret-that-is-long-enough-000'),
        );
      const response = await request(server())
        .get('/v1/me')
        .auth(forged, { type: 'bearer' })
        .expect(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('rate limiting', () => {
    it('limits auth requests per IP', async () => {
      for (let i = 0; i < 20; i++) {
        await request(server())
          .post('/v1/auth/refresh')
          .send({ refreshToken: 'x' })
          .expect(401);
      }
      const response = await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: 'x' })
        .expect(429);
      expect(response.body.error.code).toBe('RATE_LIMITED');
      expect(response.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(response.headers['retry-after']).toBeDefined();
    });
  });
});
