import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { REDIS } from '../../src/common/redis/redis.module';
import { IN_VIEW_CACHE_VERSION_KEY } from '../../src/modules/places/places-cache';
import {
  onboardedUser,
  publishLegalDocuments,
  resetState,
  type Session,
} from '../utils/auth-helpers';
import { api, type TripBody } from '../utils/api';
import { createTestApp } from '../utils/create-test-app';
import { insertPlace } from '../utils/places';

const VIEW = '16.36,48.20,16.38,48.21';
const LOGO_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect x="100" y="50" width="400" height="100" fill="#000"/></svg>',
).toString('base64');

interface Brand {
  id: string;
  name: string;
  logoUrl: string | null;
}

describe('Brands (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: ReturnType<typeof api>['as'];
  let admin: Session;
  let alice: Session;

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
    admin = await onboardedUser(app, 'mia');
    await prisma.user.update({
      where: { id: admin.userId },
      data: { role: 'admin' },
    });
    alice = await onboardedUser(app, 'alice');
  });

  afterEach(() => jest.restoreAllMocks());

  const createBrand = async (name: string, wikidataId?: string) =>
    (
      await as(admin)
        .post('/v1/admin/brands')
        .send({ name, wikidataId })
        .expect(201)
    ).body as Brand;

  const uploadLogo = async (brandId: string) =>
    (
      await as(admin)
        .put(`/v1/admin/brands/${brandId}/logo`)
        .send({ image: LOGO_SVG })
        .expect(200)
    ).body as Brand;

  const inViewBrands = async () => {
    await app.get<Redis>(REDIS).incr(IN_VIEW_CACHE_VERSION_KEY);
    const places = (
      await as(alice).get(`/v1/places/in-view?bbox=${VIEW}&zoom=15`).expect(200)
    ).body.places as { name: string; brand: Brand | null }[];
    return Object.fromEntries(places.map((p) => [p.name, p.brand]));
  };

  const withConfig = (values: Record<string, unknown>) => {
    const config = app.get(ConfigService);
    const get = config.get.bind(config);
    jest
      .spyOn(config, 'get')
      .mockImplementation((key: string, options?: unknown) =>
        key in values ? values[key] : get(key, options as never),
      );
  };

  it('puts the brand and its logo on places, and serves the logo publicly', async () => {
    const zara = await createBrand('Zara', 'Q147662');
    expect(zara.logoUrl).toBeNull();
    const placeId = await insertPlace(app, {
      name: 'Zara',
      lat: 48.205,
      lng: 16.37,
      category: 'shopping',
    });
    await insertPlace(app, { name: 'Café', lat: 48.2051, lng: 16.3701 });
    await prisma.place.update({
      where: { id: placeId },
      data: { brandId: zara.id },
    });

    const uploaded = await uploadLogo(zara.id);
    expect(uploaded.logoUrl).toMatch(
      new RegExp(`^/v1/brands/${zara.id}/logo/[0-9a-f]{16}$`),
    );
    expect(await inViewBrands()).toEqual({
      Zara: { id: zara.id, name: 'Zara', logoUrl: uploaded.logoUrl },
      Café: null,
    });

    const logo = await request(app.getHttpServer())
      .get(uploaded.logoUrl!)
      .expect(200);
    expect(logo.headers['content-type']).toBe('image/webp');
    expect(logo.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect((logo.body as Buffer).length).toBeLessThan(8 * 1024);

    // An old hash is gone once the logo changed.
    await request(app.getHttpServer())
      .get(`/v1/brands/${zara.id}/logo/0000000000000000`)
      .expect(404);

    const details = await as(alice).get(`/v1/places/${placeId}`).expect(200);
    expect(details.body.brand).toEqual(uploaded);
  });

  it('keeps the name but drops the logo when logos are off or the brand is not listed', async () => {
    const zara = await createBrand('Zara', 'Q147662');
    const placeId = await insertPlace(app, {
      name: 'Zara',
      lat: 48.205,
      lng: 16.37,
      category: 'shopping',
    });
    await prisma.place.update({
      where: { id: placeId },
      data: { brandId: zara.id },
    });
    const { logoUrl } = await uploadLogo(zara.id);

    for (const values of [
      { BRAND_LOGOS_ENABLED: false },
      { BRAND_LOGOS_SHOWN: [] },
      { BRAND_LOGOS_SHOWN: ['gucci', 'q2639'] },
    ]) {
      withConfig(values);
      expect((await inViewBrands()).Zara).toEqual({
        id: zara.id,
        name: 'Zara',
        logoUrl: null,
      });
      await request(app.getHttpServer()).get(logoUrl!).expect(404);
      jest.restoreAllMocks();
    }
  });

  it('lets people find brands by the start of a word', async () => {
    await createBrand('Saint Laurent', 'Q2639');
    await createBrand('Zara', 'Q147662');
    await createBrand('Bazar');

    const found = async (q: string) =>
      (
        (
          await as(alice)
            .get(`/v1/brands?q=${encodeURIComponent(q)}`)
            .expect(200)
        ).body.items as Brand[]
      ).map((b) => b.name);
    expect(await found('zar')).toEqual(['Zara']);
    expect(await found('laur')).toEqual(['Saint Laurent']);
    expect(await found('(')).toEqual([]);
    await as(alice).get('/v1/brands').expect(400);
    await api(app).anonymous.get('/v1/brands?q=zar').expect(401);
  });

  it('never ties a spot people make to a brand, even when an old app sends one', async () => {
    const zara = await createBrand('Zara', 'Q147662');
    const trip = (
      await as(alice)
        .post('/v1/trips')
        .send({ title: 'Vienna', visibility: 'public' })
        .expect(201)
    ).body as TripBody;
    const day = trip.days[0].id;

    // Brand stores come only from the OSM import (decision 2026-11-23): a sent brandId, known or not, is ignored.
    for (const brandId of [zara.id, '00000000-0000-4000-8000-000000000000']) {
      const created = await as(alice)
        .post(`/v1/days/${day}/markers`)
        .send({
          name: `Zara ${brandId.slice(0, 4)}`,
          location: { lat: 48.198, lng: 16.35 },
          category: 'shopping',
          brandId,
        })
        .expect(201);
      const place = await prisma.place.findUniqueOrThrow({
        where: { id: created.body.placeId as string },
        select: { brandId: true, source: true },
      });
      expect(place).toEqual({ brandId: null, source: 'user' });
    }

    const placeId = await insertPlace(app, {
      name: 'Albertina',
      lat: 48.2,
      lng: 16.36,
    });
    await as(alice)
      .post(`/v1/days/${day}/markers`)
      .send({ placeId, brandId: zara.id })
      .expect(201);
  });

  it('lets an admin untie a wrong brand store', async () => {
    const zara = await createBrand('Zara', 'Q147662');
    const placeId = await insertPlace(app, {
      name: 'Zara Mariahilfer',
      lat: 48.198,
      lng: 16.35,
    });
    await prisma.place.update({
      where: { id: placeId },
      data: { brandId: zara.id },
    });
    await as(admin)
      .put(`/v1/admin/places/${placeId}/brand`)
      .send({ brandId: null })
      .expect(204);
    expect(
      (await prisma.place.findUniqueOrThrow({ where: { id: placeId } }))
        .brandId,
    ).toBeNull();
  });

  it('offers no brands while brands are off', async () => {
    await createBrand('Zara', 'Q147662');
    withConfig({ BRAND_LOGOS_ENABLED: false });
    const found = await as(alice).get('/v1/brands?q=zar').expect(200);
    expect(found.body.items).toEqual([]);
  });

  it('keeps brand admin to admins and refuses images it cannot use', async () => {
    const zara = await createBrand('Zara', 'Q147662');
    await as(alice).post('/v1/admin/brands').send({ name: 'Mine' }).expect(403);
    await as(alice)
      .put(`/v1/admin/brands/${zara.id}/logo`)
      .send({ image: LOGO_SVG })
      .expect(403);
    await as(admin)
      .post('/v1/admin/brands')
      .send({ name: 'Zara again', wikidataId: 'Q147662' })
      .expect(400);
    await as(admin)
      .put(`/v1/admin/brands/${zara.id}/logo`)
      .send({ image: Buffer.from('not an image').toString('base64') })
      .expect(415);

    await uploadLogo(zara.id);
    const removed = await as(admin)
      .delete(`/v1/admin/brands/${zara.id}/logo`)
      .expect(200);
    expect(removed.body.logoUrl).toBeNull();
  });
});
