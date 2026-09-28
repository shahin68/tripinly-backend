import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { REDIS } from '../../src/common/redis/redis.module';
import { ConsentsService } from '../../src/modules/consents/consents.service';

export interface Session {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

export const CURRENT_VERSION = 'v1';

/** Empties identity tables and Redis between tests. */
export async function resetState(app: INestApplication): Promise<void> {
  const prisma = app.get(PrismaService);
  await prisma.$executeRawUnsafe(
    'TRUNCATE "users", "username_holds", "legal_documents" RESTART IDENTITY CASCADE',
  );
  const redis = app.get<Redis>(REDIS);
  if (redis.status !== 'ready') {
    await new Promise((resolve) => redis.once('ready', resolve));
  }
  await redis.flushdb();
  app.get(ConsentsService).clearCache();
}

/** Publishes required documents (terms, privacy) at `version`. */
export async function publishLegalDocuments(
  app: INestApplication,
  version = CURRENT_VERSION,
  options: { publishedAt?: Date; requiresReconsent?: boolean } = {},
): Promise<void> {
  const prisma = app.get(PrismaService);
  const publishedAt = options.publishedAt ?? new Date(Date.now() - 60_000);
  await prisma.legalDocument.createMany({
    data: (['terms', 'privacy'] as const).flatMap((documentType) =>
      ['en', 'de'].map((locale) => ({
        documentType,
        version,
        locale,
        url: `https://example.com/${documentType}/${version}/${locale}`,
        publishedAt,
        requiresReconsent: options.requiresReconsent ?? true,
      })),
    ),
  });
  app.get(ConsentsService).clearCache();
}

export async function devSignIn(
  app: INestApplication,
  subject: string,
  name?: string,
): Promise<Session> {
  const response = await request(app.getHttpServer())
    .post('/v1/auth/dev')
    .send({ subject, name })
    .expect(200);
  const prisma = app.get(PrismaService);
  const identity = await prisma.authIdentity.findUniqueOrThrow({
    where: {
      provider_providerSubject: { provider: 'dev', providerSubject: subject },
    },
  });
  return {
    userId: identity.userId,
    accessToken: response.body.accessToken,
    refreshToken: response.body.refreshToken,
  };
}

export async function acceptRequiredConsents(
  app: INestApplication,
  session: Session,
  version = CURRENT_VERSION,
): Promise<void> {
  for (const documentType of ['terms', 'privacy']) {
    await request(app.getHttpServer())
      .post('/v1/me/consents')
      .auth(session.accessToken, { type: 'bearer' })
      .send({ documentType, version, locale: 'en', granted: true })
      .expect(200);
  }
}

/** Signs in and completes onboarding (profile + consents). Needs published documents. */
export async function onboardedUser(
  app: INestApplication,
  subject: string,
): Promise<Session> {
  const session = await devSignIn(app, subject, subject);
  await request(app.getHttpServer())
    .patch('/v1/me')
    .auth(session.accessToken, { type: 'bearer' })
    .send({ username: subject, birthDate: '1990-05-17' })
    .expect(200);
  await acceptRequiredConsents(app, session);
  return session;
}
