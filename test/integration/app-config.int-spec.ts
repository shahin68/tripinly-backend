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
      .expect(200, {
        placesRefreshSeconds: 300,
        photoMaxEdgePx: 2560,
        photoJpegQuality: 85,
        photoParallelUploads: 2,
        pinLargeMinProminence: 95,
        pinMediumMinProminence: 60,
        mapMaxPins: 150,
        photoPinMinProminence: 90,
        photoPinMinHotCount: 3,
        mapMaxPhotoPins: 100,
        pinDotBelowZoom: 14,
        // Switched on in global-setup; TRANSIT_REGIONS defaults to vienna.
        transitAreas: [
          {
            id: 'vienna',
            name: 'Vienna',
            south: 48.11,
            west: 16.18,
            north: 48.33,
            east: 16.58,
          },
        ],
      });
  });
});
