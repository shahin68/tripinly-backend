import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../utils/create-test-app';

describe('App config (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/app-config answers without a token, with the defaults', async () => {
    await request(app.getHttpServer())
      .get('/v1/app-config')
      .expect(200, { placesRefreshSeconds: 300 });
  });
});
