import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { REDIS } from '../../src/common/redis/redis.module';
import { decodePolyline } from '../../src/modules/routing/geo';
import {
  onboardedUser,
  publishLegalDocuments,
  resetState,
  type Session,
} from '../utils/auth-helpers';
import { api, type TripBody } from '../utils/api';
import { createTestApp } from '../utils/create-test-app';
import { ORS_STUB_KEY, startOrsStub, type OrsStub } from '../utils/ors-stub';
import { insertPlace } from '../utils/places';

interface AlongBody {
  place: { id: string; name: string };
  distanceFromRouteMeters: number;
  positionAlongRoute: number;
  etaFromStartSeconds: number;
}

// An east-west line through Vienna, about 1.5 km long.
const FROM = { lat: 48.2, lng: 16.36 };
const TO = { lat: 48.2, lng: 16.38 };
const point = (p: { lat: number; lng: number }) => `${p.lat},${p.lng}`;

describe('Routing (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let ors: OrsStub;
  let as: ReturnType<typeof api>['as'];
  let owner: Session;
  let stranger: Session;
  let trip: TripBody;
  let near: string;
  let far: string;

  beforeAll(async () => {
    ors = await startOrsStub();
    app = await createTestApp();
    prisma = app.get(PrismaService);
    redis = app.get<Redis>(REDIS);
    as = api(app).as;
  });

  afterAll(async () => {
    await app.close();
    await ors.close();
  });

  beforeEach(async () => {
    await resetState(app);
    await publishLegalDocuments(app);
    ors.mode = 'ok';
    ors.matrix = null;
    ors.requests = [];
    owner = await onboardedUser(app, 'owner');
    stranger = await onboardedUser(app, 'stranger');
    // ~110 m north of the line, and ~1.1 km north of it.
    near = await insertPlace(app, {
      name: 'Café Near',
      lat: 48.201,
      lng: 16.365,
      category: 'cafe',
    });
    far = await insertPlace(app, {
      name: 'Museum Far',
      lat: 48.21,
      lng: 16.37,
      category: 'museum',
    });
    trip = (
      await as(owner)
        .post('/v1/trips')
        .send({ title: 'Vienna', visibility: 'public' })
        .expect(201)
    ).body as TripBody;
  });

  async function addMarker(
    lat: number,
    lng: number,
    name = `Pin ${lat},${lng}`,
  ): Promise<string> {
    const { body } = await as(owner)
      .post(`/v1/days/${trip.days[0].id}/markers`)
      .send({ name, location: { lat, lng } })
      .expect(201);
    return (body as { id: string }).id;
  }

  describe('GET /v1/routes', () => {
    it('returns the route line and listed places along the way', async () => {
      // A custom pin nobody liked is never listed.
      await insertPlace(app, {
        name: 'Our flat',
        lat: 48.2005,
        lng: 16.37,
        source: 'user',
      });
      const { body } = await as(stranger)
        .get(`/v1/routes?from=${point(FROM)}&to=${point(TO)}`)
        .expect(200);

      expect(body.degraded).toBe(false);
      expect(body.attribution).toBe(
        '© openrouteservice.org | © OpenStreetMap contributors',
      );
      expect(decodePolyline(body.route.polyline)).toEqual([
        FROM,
        { lat: 48.2, lng: 16.37 },
        TO,
      ]);
      expect(body.route.distanceMeters).toBeGreaterThan(1700);
      expect(body.route.legs).toEqual([
        {
          fromMarkerId: null,
          toMarkerId: null,
          distanceMeters: body.route.distanceMeters,
          durationSeconds: body.route.durationSeconds,
        },
      ]);
      expect(body.alongTheWay.map((a: AlongBody) => a.place.id)).toEqual([
        near,
      ]);
      const [cafe] = body.alongTheWay as AlongBody[];
      expect(cafe.distanceFromRouteMeters).toBeGreaterThan(90);
      expect(cafe.distanceFromRouteMeters).toBeLessThan(130);
      expect(cafe.positionAlongRoute).toBeCloseTo(0.25, 1);
      expect(cafe.etaFromStartSeconds).toBeCloseTo(
        body.route.durationSeconds * cafe.positionAlongRoute,
        -1,
      );

      // What went to openrouteservice: [lng, lat] and the key.
      expect(ors.requests).toHaveLength(1);
      expect(ors.requests[0].path).toBe('/v2/directions/foot-walking/geojson');
      expect(ors.requests[0].authorization).toBe(ORS_STUB_KEY);
      expect(ors.requests[0].body.coordinates).toEqual([
        [FROM.lng, FROM.lat],
        [TO.lng, TO.lat],
      ]);
    });

    it('widens the search when driving and filters by category', async () => {
      const driving = await as(stranger)
        .get(`/v1/routes?from=${point(FROM)}&to=${point(TO)}&mode=driving`)
        .expect(200);
      expect(
        driving.body.alongTheWay.map((a: AlongBody) => a.place.id).sort(),
      ).toEqual([near, far].sort());
      expect(ors.requests[0].path).toBe('/v2/directions/driving-car/geojson');

      const museums = await as(stranger)
        .get(
          `/v1/routes?from=${point(FROM)}&to=${point(TO)}&mode=driving&categories=museum`,
        )
        .expect(200);
      expect(
        museums.body.alongTheWay.map((a: AlongBody) => a.place.id),
      ).toEqual([far]);
    });

    it('caches routes by coordinates and mode', async () => {
      const path = `/v1/routes?from=${point(FROM)}&to=${point(TO)}`;
      await as(stranger).get(path).expect(200);
      await as(owner).get(path).expect(200);
      expect(ors.requests).toHaveLength(1);
      await as(owner).get(`${path}&mode=cycling`).expect(200);
      expect(ors.requests).toHaveLength(2);
    });

    it('answers ROUTING_UNAVAILABLE when openrouteservice fails', async () => {
      ors.mode = 'error';
      const failed = await as(stranger)
        .get(`/v1/routes?from=${point(FROM)}&to=${point(TO)}`)
        .expect(503);
      expect(failed.body.error.code).toBe('ROUTING_UNAVAILABLE');
      // One retry on 5xx.
      expect(ors.requests).toHaveLength(2);

      ors.requests = [];
      ors.mode = 'rate_limited';
      await as(stranger)
        .get(`/v1/routes?from=${point(FROM)}&to=48.2,16.39`)
        .expect(503);
      expect(ors.requests).toHaveLength(1);
    });

    it('falls back to straight lines once the daily quota is used up', async () => {
      const day = new Date().toISOString().slice(0, 10);
      await redis.set(`ors:calls:directions:${day}`, '2000');
      const { body } = await as(stranger)
        .get(`/v1/routes?from=${point(FROM)}&to=${point(TO)}`)
        .expect(200);
      expect(body.degraded).toBe(true);
      expect(decodePolyline(body.route.polyline)).toEqual([FROM, TO]);
      expect(body.route.distanceMeters).toBeGreaterThan(1400);
      expect(body.route.distanceMeters).toBeLessThan(1550);
      expect(body.alongTheWay).toHaveLength(1);
      expect(ors.requests).toHaveLength(0);
    });

    it('validates points and checks excludeTripId access', async () => {
      const bad = await as(stranger)
        .get(`/v1/routes?from=48.2&to=${point(TO)}`)
        .expect(400);
      expect(bad.body.error.details.fields.from).toBeDefined();
      await as(stranger)
        .get(`/v1/routes?from=${point(FROM)}&to=${point(TO)}&mode=flying`)
        .expect(400);

      const secret = (
        await as(owner)
          .post('/v1/trips')
          .send({ title: 'Secret', visibility: 'private' })
          .expect(201)
      ).body as TripBody;
      await as(stranger)
        .get(
          `/v1/routes?from=${point(FROM)}&to=${point(TO)}&excludeTripId=${secret.id}`,
        )
        .expect(404);
    });
  });

  describe('GET /v1/days/:id/route', () => {
    it("routes through the day's markers and leaves the trip's places out", async () => {
      const a = await addMarker(FROM.lat, FROM.lng, 'Start');
      await as(owner)
        .post(`/v1/days/${trip.days[0].id}/markers`)
        .send({ placeId: near })
        .expect(201);
      const c = await addMarker(TO.lat, TO.lng, 'End');
      const b = (
        await prisma.marker.findFirstOrThrow({ where: { placeId: near } })
      ).id;

      const { body } = await as(stranger)
        .get(`/v1/days/${trip.days[0].id}/route?mode=driving`)
        .expect(200);
      expect(
        body.route.legs.map(
          (leg: { fromMarkerId: string; toMarkerId: string }) => [
            leg.fromMarkerId,
            leg.toMarkerId,
          ],
        ),
      ).toEqual([
        [a, b],
        [b, c],
      ]);
      expect(body.alongTheWay.map((x: AlongBody) => x.place.id)).toEqual([far]);
    });

    it('returns no route for fewer than two markers', async () => {
      await addMarker(FROM.lat, FROM.lng);
      const { body } = await as(owner)
        .get(`/v1/days/${trip.days[0].id}/route`)
        .expect(200);
      expect(body).toMatchObject({
        route: null,
        alongTheWay: [],
        degraded: false,
      });
      expect(ors.requests).toHaveLength(0);
    });

    it('keeps private trips to members', async () => {
      const secret = (
        await as(owner)
          .post('/v1/trips')
          .send({ title: 'Secret', visibility: 'private' })
          .expect(201)
      ).body as TripBody;
      await as(stranger).get(`/v1/days/${secret.days[0].id}/route`).expect(404);
    });
  });

  describe('POST /v1/days/:id/optimize', () => {
    /** Markers in the day order A, B, C along the line. */
    async function lineOfThree(): Promise<string[]> {
      return [
        await addMarker(48.2, 16.36, 'A'),
        await addMarker(48.2, 16.365, 'B'),
        await addMarker(48.2, 16.37, 'C'),
      ];
    }

    it('orders by straight line without Pro, first marker fixed', async () => {
      const a = await addMarker(48.2, 16.36, 'A');
      const c = await addMarker(48.2, 16.38, 'C');
      const b = await addMarker(48.2, 16.37, 'B');

      const { body } = await as(stranger)
        .post(`/v1/days/${trip.days[0].id}/optimize`)
        .expect(200);
      expect(body).toEqual({
        dayId: trip.days[0].id,
        markerIds: [a, b, c],
        mode: 'straight_line',
        savedMinutes: null,
        degraded: false,
        applied: false,
      });
      expect(ors.requests).toHaveLength(0);

      // Viewers get a proposal; saving it takes an owner or editor.
      await as(stranger)
        .post(`/v1/days/${trip.days[0].id}/optimize?apply=true`)
        .expect(403);
      const applied = await as(owner)
        .post(`/v1/days/${trip.days[0].id}/optimize?apply=true`)
        .expect(200);
      expect(applied.body.applied).toBe(true);
      const saved = await as(owner).get(`/v1/trips/${trip.id}`);
      expect(
        saved.body.days[0].markers.map((m: { id: string }) => m.id),
      ).toEqual([a, b, c]);
    });

    it('orders by travel time with Pro and reports minutes saved', async () => {
      const [a, b, c] = await lineOfThree();
      await prisma.entitlement.create({
        data: {
          userId: owner.userId,
          feature: 'best_route_realtime',
          source: 'manual',
        },
      });
      const me = await as(owner).get('/v1/me').expect(200);
      expect(me.body.entitlements).toEqual(['best_route_realtime']);

      // By travel time, C is on the way to B.
      ors.matrix = [
        [0, 1000, 100],
        [1000, 0, 1000],
        [100, 100, 0],
      ];
      const { body } = await as(owner)
        .post(`/v1/days/${trip.days[0].id}/optimize?mode=cycling`)
        .expect(200);
      expect(body).toMatchObject({
        markerIds: [a, c, b],
        mode: 'travel_time',
        savedMinutes: 30,
        degraded: false,
      });
      expect(ors.requests[0].path).toBe('/v2/matrix/cycling-regular');

      // Travel times unavailable: straight line, flagged.
      ors.mode = 'error';
      const fallback = await as(owner)
        .post(`/v1/days/${trip.days[0].id}/optimize`)
        .expect(200);
      expect(fallback.body).toMatchObject({
        markerIds: [a, b, c],
        mode: 'straight_line',
        savedMinutes: null,
        degraded: true,
      });

      // Expired entitlements don't count.
      await prisma.entitlement.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await as(owner)
        .post(`/v1/days/${trip.days[0].id}/optimize`)
        .expect(200);
      expect(expired.body).toMatchObject({
        mode: 'straight_line',
        degraded: false,
      });
    });

    it('optimizes at most 25 markers', async () => {
      for (let i = 0; i < 26; i++) {
        await addMarker(48.2 + i * 0.001, 16.36);
      }
      const { body } = await as(owner)
        .post(`/v1/days/${trip.days[0].id}/optimize`)
        .expect(422);
      expect(body.error).toMatchObject({
        code: 'LIMIT_REACHED',
        details: { resource: 'optimizeMarkers', max: 25 },
      });
    });
  });
});
