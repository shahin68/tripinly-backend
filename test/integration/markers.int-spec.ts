import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  onboardedUser,
  publishLegalDocuments,
  resetState,
  type Session,
} from '../utils/auth-helpers';
import { api, type TripBody } from '../utils/api';
import { createTestApp } from '../utils/create-test-app';

const SACHER = { lat: 48.20383, lng: 16.36958 };
/** About 20 m from SACHER. */
const NEAR_SACHER = { lat: 48.20398, lng: 16.36972 };
/** About 150 m from SACHER. */
const FAR_FROM_SACHER = { lat: 48.20518, lng: 16.36958 };

describe('Markers and place matching (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: ReturnType<typeof api>['as'];
  let owner: Session;
  let editor: Session;
  let stranger: Session;
  let trip: TripBody;
  let dayId: string;

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
    owner = await onboardedUser(app, 'owner');
    editor = await onboardedUser(app, 'editor');
    stranger = await onboardedUser(app, 'stranger');
    const created = await as(owner)
      .post('/v1/trips')
      .send({
        title: 'Vienna',
        startDate: '2026-10-09',
        endDate: '2026-10-10',
        memberUsernames: ['editor'],
      })
      .expect(201);
    trip = created.body as TripBody;
    dayId = trip.days[0].id;
  });

  const addMarker = (
    body: Record<string, unknown>,
    session = owner,
    day = dayId,
  ) => as(session).post(`/v1/days/${day}/markers`).send(body);

  async function positions(day = dayId): Promise<string[]> {
    const markers = await prisma.marker.findMany({
      where: { dayId: day },
      orderBy: { position: 'asc' },
    });
    expect(markers.map((m) => m.position)).toEqual(markers.map((_, i) => i));
    return markers.map((m) => m.name);
  }

  describe('place matching', () => {
    it('reuses a place for the same name nearby and creates new ones otherwise', async () => {
      const first = await addMarker({
        name: 'Café Sacher',
        location: SACHER,
        time: '10:00',
      }).expect(201);
      expect(first.body).toMatchObject({
        tripId: trip.id,
        dayId,
        name: 'Café Sacher',
        location: SACHER,
        time: '10:00',
        position: 0,
        coverPhotoId: null,
        photoCount: 0,
        createdBy: expect.objectContaining({ username: 'owner' }),
      });
      const place = await prisma.place.findUniqueOrThrow({
        where: { id: first.body.placeId },
      });
      expect(place).toMatchObject({
        source: 'user',
        category: 'other',
        normalizedName: 'cafe sacher',
      });

      const near = await addMarker({
        name: '  cafe   SACHER',
        location: NEAR_SACHER,
      }).expect(201);
      expect(near.body.placeId).toBe(first.body.placeId);
      expect(near.body.location).toEqual(NEAR_SACHER);

      const far = await addMarker({
        name: 'Café Sacher',
        location: FAR_FROM_SACHER,
      }).expect(201);
      const other = await addMarker({
        name: 'Hotel Sacher',
        location: NEAR_SACHER,
        category: 'landmark',
      }).expect(201);
      expect(
        new Set([first.body.placeId, far.body.placeId, other.body.placeId])
          .size,
      ).toBe(3);
      expect(await prisma.place.count()).toBe(3);
    });

    it('matches by OSM ids and by placeId', async () => {
      const osm = {
        name: 'Stephansdom',
        location: { lat: 48.2085, lng: 16.3731 },
        osmType: 'way',
        osmId: '13705541',
      };
      const a = await addMarker(osm).expect(201);
      const b = await addMarker({
        ...osm,
        name: 'St. Stephen’s',
        location: { lat: 48.21, lng: 16.37 },
      }).expect(201);
      expect(b.body.placeId).toBe(a.body.placeId);
      const place = await prisma.place.findUniqueOrThrow({
        where: { id: a.body.placeId },
      });
      expect(place).toMatchObject({
        osmType: 'way',
        osmId: 13705541n,
        source: 'user',
      });

      const byId = await addMarker({ placeId: a.body.placeId }).expect(201);
      expect(byId.body).toMatchObject({
        placeId: a.body.placeId,
        name: 'Stephansdom',
        location: osm.location,
      });
      const renamed = await addMarker({
        placeId: a.body.placeId,
        name: 'Dom',
      }).expect(201);
      expect(renamed.body.name).toBe('Dom');
    });

    it('rejects Google IDs and mixed or incomplete input', async () => {
      const cases: Record<string, unknown>[] = [
        { placeId: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE' },
        {
          name: 'X',
          location: SACHER,
          googlePlaceId: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE',
        },
        { name: 'X' },
        { location: SACHER },
        {},
        { name: 'X', location: { lat: 91, lng: 0 } },
        { name: 'X', location: SACHER, time: '25:00' },
        { name: 'X', location: SACHER, osmType: 'way' },
      ];
      for (const body of cases) {
        const response = await addMarker(body).expect(400);
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
      }
      const existing = await addMarker({ name: 'X', location: SACHER }).expect(
        201,
      );
      const mixed = await addMarker({
        placeId: existing.body.placeId,
        location: SACHER,
        name: 'Y',
      }).expect(400);
      expect(mixed.body.error.details.fields).toEqual({
        location: ['notWithPlaceId'],
      });
      const unknown = await addMarker({
        placeId: '00000000-0000-4000-8000-000000000000',
      }).expect(400);
      expect(unknown.body.error.details.fields).toEqual({
        placeId: ['notFound'],
      });
    });
  });

  describe('POST /v1/days/:id/markers', () => {
    it('appends or inserts at a position', async () => {
      await addMarker({ name: 'A', location: SACHER }).expect(201);
      await addMarker({ name: 'B', location: SACHER }).expect(201);
      await addMarker({ name: 'Start', location: SACHER, position: 0 }).expect(
        201,
      );
      await addMarker({ name: 'End', location: SACHER, position: 99 }).expect(
        201,
      );
      expect(await positions()).toEqual(['Start', 'A', 'B', 'End']);
    });

    it('uses a client-chosen ID and refuses a taken one', async () => {
      const id = randomUUID();
      const created = await addMarker({
        id,
        name: 'A',
        location: SACHER,
      }).expect(201);
      expect(created.body.id).toBe(id);
      const again = await addMarker({ id, name: 'B', location: SACHER }).expect(
        409,
      );
      expect(again.body.error.code).toBe('ID_CONFLICT');
      expect(await positions()).toEqual(['A']);
    });

    it('applies trip access rules', async () => {
      await addMarker({ name: 'By editor', location: SACHER }, editor).expect(
        201,
      );
      await addMarker({ name: 'X', location: SACHER }, stranger).expect(403);
      await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ visibility: 'private' })
        .expect(200);
      await addMarker({ name: 'X', location: SACHER }, stranger).expect(404);
      await addMarker(
        { name: 'X', location: SACHER },
        owner,
        '00000000-0000-4000-8000-000000000000',
      ).expect(404);
    });

    it('limits markers per day', async () => {
      const place = await addMarker({ name: 'P', location: SACHER }).expect(
        201,
      );
      await prisma.marker.createMany({
        data: Array.from({ length: 49 }, (_, i) => ({
          dayId,
          tripId: trip.id,
          placeId: place.body.placeId,
          name: `M${i}`,
          lat: SACHER.lat,
          lng: SACHER.lng,
          position: i + 1,
        })),
      });
      const response = await addMarker({
        name: 'One more',
        location: SACHER,
      }).expect(422);
      expect(response.body.error.details).toEqual({
        resource: 'markers',
        max: 50,
      });
    });

    it('emits marker.created after saving', async () => {
      const emit = jest.spyOn(app.get(EventEmitter2), 'emit');
      const created = await addMarker({ name: 'A', location: SACHER }).expect(
        201,
      );
      expect(emit).toHaveBeenCalledWith(
        'marker.created',
        expect.objectContaining({
          event: 'marker.created',
          tripId: trip.id,
          actorId: owner.userId,
          data: { marker: expect.objectContaining({ id: created.body.id }) },
        }),
      );
      emit.mockRestore();
    });
  });

  describe('GET, PATCH and DELETE /v1/markers/:id', () => {
    it('shows markers of public trips to anyone and private ones to members', async () => {
      const marker = await addMarker({ name: 'A', location: SACHER }).expect(
        201,
      );
      await as(stranger).get(`/v1/markers/${marker.body.id}`).expect(200);
      await as(owner)
        .patch(`/v1/trips/${trip.id}`)
        .send({ visibility: 'private' })
        .expect(200);
      await as(stranger).get(`/v1/markers/${marker.body.id}`).expect(404);
      await as(editor).get(`/v1/markers/${marker.body.id}`).expect(200);
    });

    it('edits name, time and location, re-matching the place', async () => {
      const marker = await addMarker({
        name: 'Café Sacher',
        location: SACHER,
        time: '10:00',
      }).expect(201);
      const updated = await as(editor)
        .patch(`/v1/markers/${marker.body.id}`)
        .send({ name: 'Sacher', time: null, location: FAR_FROM_SACHER })
        .expect(200);
      expect(updated.body).toMatchObject({
        name: 'Sacher',
        time: null,
        location: FAR_FROM_SACHER,
      });
      expect(updated.body.placeId).not.toBe(marker.body.placeId);
      await as(stranger)
        .patch(`/v1/markers/${marker.body.id}`)
        .send({ name: 'x' })
        .expect(403);
    });

    it('moves markers between days of the same trip only', async () => {
      const secondDay = trip.days[1].id;
      const a = await addMarker({ name: 'A', location: SACHER }).expect(201);
      await addMarker({ name: 'B', location: SACHER }).expect(201);
      await addMarker({ name: 'C', location: SACHER }).expect(201);
      await addMarker({ name: 'X', location: SACHER }, owner, secondDay).expect(
        201,
      );

      await as(owner)
        .patch(`/v1/markers/${a.body.id}`)
        .send({ dayId: secondDay, position: 0 })
        .expect(200);
      expect(await positions()).toEqual(['B', 'C']);
      expect(await positions(secondDay)).toEqual(['A', 'X']);

      await as(owner)
        .patch(`/v1/markers/${a.body.id}`)
        .send({ position: 5 })
        .expect(200);
      expect(await positions(secondDay)).toEqual(['X', 'A']);

      const otherTrip = await as(owner)
        .post('/v1/trips')
        .send({ title: 'Other' })
        .expect(201);
      const wrong = await as(owner)
        .patch(`/v1/markers/${a.body.id}`)
        .send({ dayId: otherTrip.body.days[0].id })
        .expect(400);
      expect(wrong.body.error.details.fields).toEqual({ dayId: ['notInTrip'] });
    });

    it('deletes markers and closes the gap', async () => {
      await addMarker({ name: 'A', location: SACHER }).expect(201);
      const b = await addMarker({ name: 'B', location: SACHER }).expect(201);
      await addMarker({ name: 'C', location: SACHER }).expect(201);
      await as(stranger).delete(`/v1/markers/${b.body.id}`).expect(403);
      await as(editor).delete(`/v1/markers/${b.body.id}`).expect(204);
      expect(await positions()).toEqual(['A', 'C']);
      await as(editor).delete(`/v1/markers/${b.body.id}`).expect(404);
    });
  });

  describe('PUT /v1/days/:id/marker-order', () => {
    it("sets the order when given exactly the day's markers", async () => {
      const a = await addMarker({ name: 'A', location: SACHER }).expect(201);
      const b = await addMarker({ name: 'B', location: SACHER }).expect(201);
      const c = await addMarker({ name: 'C', location: SACHER }).expect(201);

      const response = await as(editor)
        .put(`/v1/days/${dayId}/marker-order`)
        .send({ markerIds: [c.body.id, a.body.id, b.body.id] })
        .expect(200);
      expect(response.body).toEqual({
        dayId,
        markerIds: [c.body.id, a.body.id, b.body.id],
      });
      expect(await positions()).toEqual(['C', 'A', 'B']);

      for (const markerIds of [
        [a.body.id, b.body.id],
        [a.body.id, b.body.id, b.body.id],
        [a.body.id, b.body.id, c.body.id, c.body.id],
      ]) {
        const bad = await as(owner)
          .put(`/v1/days/${dayId}/marker-order`)
          .send({ markerIds })
          .expect(400);
        expect(bad.body.error.details.fields).toEqual({
          markerIds: ['mustMatchDayMarkers'],
        });
      }
      await as(stranger)
        .put(`/v1/days/${dayId}/marker-order`)
        .send({ markerIds: [] })
        .expect(403);
    });
  });

  it('shows trips with their markers in order and counts them in my stats', async () => {
    await addMarker({ name: 'A', location: SACHER }).expect(201);
    await addMarker({ name: 'B', location: SACHER }, editor).expect(201);
    const view = await as(stranger).get(`/v1/trips/${trip.id}`).expect(200);
    expect(
      view.body.days[0].markers.map((m: { name: string }) => m.name),
    ).toEqual(['A', 'B']);

    // A viewer who blocked the editor doesn't see them as a member or marker creator.
    await as(stranger).post(`/v1/users/${editor.userId}/block`).expect(204);
    const filtered = await as(stranger).get(`/v1/trips/${trip.id}`).expect(200);
    expect(
      filtered.body.members.map(
        (m: { user: { username: string } }) => m.user.username,
      ),
    ).toEqual(['owner']);
    expect(filtered.body.days[0].markers[1].createdBy).toBeNull();

    const stats = await as(editor).get('/v1/me/stats').expect(200);
    expect(stats.body).toMatchObject({ tripCount: 1, markerCount: 1 });
  });
});
