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
import {
  MOTIS_FIXTURE_TIME,
  type MotisStub,
  startMotisStub,
} from '../utils/motis-stub';
import { insertPlace } from '../utils/places';

interface StepBody {
  kind: string;
  vehicle: string | null;
  line: { name: string; color: string | null } | null;
  from: { name: string | null; time: string };
  to: { name: string | null; time: string };
  polyline: string;
}
interface LegBody {
  fromMarkerId: string | null;
  toMarkerId: string | null;
  departure: string;
  arrival: string;
  steps: StepBody[];
}

// Leopold Museum to Café Sacher, as in the fixture.
const FROM = '48.2027,16.3594';
const TO = '48.2038,16.3697';
const GRAZ = '47.0707,15.4395';
const route = (query: string) =>
  `/v1/routes?from=${FROM}&to=${TO}&mode=transit&${query}`;

describe('Public transport routes (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let motis: MotisStub;
  let as: ReturnType<typeof api>['as'];
  let owner: Session;
  let rider: Session;

  beforeAll(async () => {
    motis = await startMotisStub();
    app = await createTestApp();
    prisma = app.get(PrismaService);
    redis = app.get<Redis>(REDIS);
    as = api(app).as;
  });

  afterAll(async () => {
    await app.close();
    await motis.close();
  });

  beforeEach(async () => {
    await resetState(app);
    await publishLegalDocuments(app);
    motis.mode = 'ok';
    motis.requests = [];
    owner = await onboardedUser(app, 'owner');
    rider = await onboardedUser(app, 'rider');
    await prisma.entitlement.createMany({
      data: [owner, rider].map((user) => ({
        userId: user.userId,
        feature: 'routes',
        source: 'manual',
      })),
    });
  });

  describe('GET /v1/routes?mode=transit', () => {
    it('rides the U2 with its colour, walks at both ends, places only near the walks', async () => {
      // Beside the first walk, and above the U2 (riders can't stop there).
      const byWalk = await insertPlace(app, {
        name: 'Café by the walk',
        lat: 48.2029,
        lng: 16.36,
        category: 'cafe',
      });
      await insertPlace(app, {
        name: 'Above the U-Bahn',
        lat: 48.2018,
        lng: 16.3652,
        category: 'museum',
      });

      const { body } = await as(rider)
        .get(route(`departAt=${MOTIS_FIXTURE_TIME}`))
        .expect(200);

      expect(body.degraded).toBe(false);
      expect(body.attribution).toBe(
        'Timetables: Wiener Linien, Datenquelle: Stadt Wien – data.wien.gv.at (CC BY 4.0) | © OpenStreetMap contributors',
      );
      expect(body.route).toMatchObject({
        departure: '2026-11-17T09:44:00.000Z',
        arrival: '2026-11-17T09:57:00.000Z',
        durationSeconds: 780,
        transfers: 0,
        typicalTimes: false,
      });
      const [leg] = body.route.legs as LegBody[];
      expect(leg.fromMarkerId).toBeNull();
      expect(leg.steps.map((step) => step.kind)).toEqual([
        'walk',
        'ride',
        'walk',
      ]);
      expect(leg.steps[1]).toMatchObject({
        vehicle: 'subway',
        line: { name: 'U2', color: '#A862A4', textColor: '#FFFFFF' },
        headsign: 'Wien Karlsplatz',
        from: { name: 'Museumsquartier' },
        to: { name: 'Karlsplatz' },
      });
      expect(decodePolyline(leg.steps[0].polyline)[0].lat).toBeCloseTo(
        48.2027,
        3,
      );
      expect(decodePolyline(body.route.polyline).length).toBeGreaterThan(3);
      expect(
        body.alongTheWay.map((a: { place: { id: string } }) => a.place.id),
      ).toEqual([byWalk]);

      // What went to the transit service.
      expect(motis.requests).toHaveLength(1);
      expect(Object.fromEntries(motis.requests[0])).toEqual({
        fromPlace: FROM,
        toPlace: TO,
        time: MOTIS_FIXTURE_TIME,
        arriveBy: 'false',
      });
    });

    it('arrives by a time with the latest departure, and caches per minute', async () => {
      const { body } = await as(rider)
        .get(route('arriveBy=2026-11-17T10:00:00Z'))
        .expect(200);
      expect(body.route.legs[0].steps[1].line.name).toBe('2');
      expect(body.route.arrival).toBe('2026-11-17T10:00:00.000Z');
      expect(motis.requests[0].get('arriveBy')).toBe('true');

      await as(owner).get(route('arriveBy=2026-11-17T10:00:30Z')).expect(200);
      expect(motis.requests).toHaveLength(1);
    });

    it('answers TRANSIT_NO_COVERAGE outside the covered cities, without asking', async () => {
      const { body } = await as(rider)
        .get(`/v1/routes?from=${FROM}&to=${GRAZ}&mode=transit`)
        .expect(422);
      expect(body.error.code).toBe('TRANSIT_NO_COVERAGE');
      expect(motis.requests).toHaveLength(0);
    });

    it('answers TRANSIT_NO_CONNECTION when nothing runs, even on typical times', async () => {
      motis.mode = 'empty';
      const { body } = await as(rider)
        .get(route(`departAt=${MOTIS_FIXTURE_TIME}`))
        .expect(422);
      expect(body.error.code).toBe('TRANSIT_NO_CONNECTION');
    });

    it('uses this week for dates beyond the timetable', async () => {
      // A Tuesday far ahead: the same weekday and clock time this week stands in.
      const far = new Date(Date.now() + 70 * 86_400_000);
      motis.mode = 'empty';
      await as(rider)
        .get(route(`departAt=${far.toISOString()}`))
        .expect(422);
      expect(motis.requests).toHaveLength(2);
      const stand = Date.parse(motis.requests[1].get('time') ?? '');
      expect(stand - Date.now()).toBeLessThan(7 * 86_400_000 + 3_600_000);
    });

    it('answers ROUTING_UNAVAILABLE when the transit service fails or its quota is used up', async () => {
      motis.mode = 'error';
      const failed = await as(rider).get(route('')).expect(503);
      expect(failed.body.error.code).toBe('ROUTING_UNAVAILABLE');
      expect(motis.requests).toHaveLength(2);

      motis.mode = 'ok';
      motis.requests = [];
      const day = new Date().toISOString().slice(0, 10);
      await redis.set(`transit:calls:${day}`, '20000');
      await as(rider).get(route('departAt=2026-11-17T08:00:00Z')).expect(503);
      expect(motis.requests).toHaveLength(0);
    });

    it('is Tripinly Pro and validates the times', async () => {
      await prisma.entitlement.deleteMany({ where: { userId: rider.userId } });
      const pro = await as(rider).get(route('')).expect(403);
      expect(pro.body.error.code).toBe('PREMIUM_REQUIRED');

      const both = await as(owner)
        .get(
          route(
            `departAt=${MOTIS_FIXTURE_TIME}&arriveBy=${MOTIS_FIXTURE_TIME}`,
          ),
        )
        .expect(400);
      expect(both.body.error.details.fields.arriveBy).toEqual([
        'notWithDepartAt',
      ]);
      const walking = await as(owner)
        .get(`/v1/routes?from=${FROM}&to=${TO}&departAt=${MOTIS_FIXTURE_TIME}`)
        .expect(400);
      expect(walking.body.error.details.fields.departAt).toEqual([
        'transitOnly',
      ]);
      await as(owner).get(route('departAt=tomorrow')).expect(400);
      expect(motis.requests).toHaveLength(0);
    });
  });

  describe('GET /v1/days/:id/route?mode=transit', () => {
    it('leaves each leg when the one before arrives', async () => {
      const trip = (
        await as(owner)
          .post('/v1/trips')
          .send({ title: 'Vienna', visibility: 'public' })
          .expect(201)
      ).body as TripBody;
      const dayId = trip.days[0].id;
      const ids: string[] = [];
      for (const [lat, lng] of [
        [48.2027, 16.3594],
        [48.2038, 16.3697],
        [48.21, 16.37],
      ]) {
        const { body } = await as(owner)
          .post(`/v1/days/${dayId}/markers`)
          .send({ name: `Pin ${lat}`, location: { lat, lng } })
          .expect(201);
        ids.push((body as { id: string }).id);
      }

      const { body } = await as(rider)
        .get(
          `/v1/days/${dayId}/route?mode=transit&departAt=${MOTIS_FIXTURE_TIME}`,
        )
        .expect(200);
      const legs = body.route.legs as LegBody[];
      expect(legs.map((leg) => [leg.fromMarkerId, leg.toMarkerId])).toEqual([
        [ids[0], ids[1]],
        [ids[1], ids[2]],
      ]);
      expect(motis.requests).toHaveLength(2);
      expect(motis.requests[1].get('time')).toBe(legs[0].arrival);
      expect(body.route.departure).toBe(legs[0].departure);
      expect(body.route.arrival).toBe(legs[1].arrival);

      // Outside Vienna: the whole day is not covered.
      await as(owner)
        .post(`/v1/days/${dayId}/markers`)
        .send({ name: 'Graz', location: { lat: 47.0707, lng: 15.4395 } })
        .expect(201);
      const graz = await as(rider)
        .get(`/v1/days/${dayId}/route?mode=transit`)
        .expect(422);
      expect(graz.body.error.code).toBe('TRANSIT_NO_COVERAGE');
    });

    it('estimates a leg with no connection as a straight walk, degraded', async () => {
      const trip = (
        await as(owner)
          .post('/v1/trips')
          .send({ title: 'Vienna', visibility: 'public' })
          .expect(201)
      ).body as TripBody;
      const dayId = trip.days[0].id;
      for (const [lat, lng] of [
        [48.2027, 16.3594],
        [48.2038, 16.3697],
      ]) {
        await as(owner)
          .post(`/v1/days/${dayId}/markers`)
          .send({ name: `Pin ${lat}`, location: { lat, lng } })
          .expect(201);
      }
      await as(owner)
        .post(`/v1/days/${dayId}/markers`)
        .send({ name: 'Pin 3', location: { lat: 48.21, lng: 16.37 } })
        .expect(201);
      motis.mode = 'empty';
      const { body } = await as(rider)
        .get(
          `/v1/days/${dayId}/route?mode=transit&departAt=${MOTIS_FIXTURE_TIME}`,
        )
        .expect(200);
      expect(body.degraded).toBe(true);
      const legs = body.route.legs as LegBody[];
      expect(legs.every((leg) => leg.steps.length === 1)).toBe(true);
      expect(legs[1].departure).toBe(legs[0].arrival);
    });
  });
});
