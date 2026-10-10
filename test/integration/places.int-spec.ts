import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
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
import { startPhotonStub, type PhotonStub } from '../utils/photon-stub';
import { insertPlace } from '../utils/places';

/** A zoom-15 view of Vienna's centre. */
const VIEW = '16.36,48.20,16.38,48.21';
const CENTRE = { lat: 48.205, lng: 16.37 };

interface PlaceBody {
  id: string;
  name: string;
  category: string;
  isTripinly: boolean;
  likeCount: number;
  distanceMeters?: number;
}

describe('Places: in-view, search, nearby, popular (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: ReturnType<typeof api>['as'];
  let photon: PhotonStub;
  let alice: Session;
  let bob: Session;

  beforeAll(async () => {
    photon = await startPhotonStub();
    app = await createTestApp();
    prisma = app.get(PrismaService);
    as = api(app).as;
  });

  afterAll(async () => {
    await app.close();
    await photon.close();
  });

  beforeEach(async () => {
    await resetState(app);
    await publishLegalDocuments(app);
    alice = await onboardedUser(app, 'alice');
    bob = await onboardedUser(app, 'bob');
    photon.features = [];
    photon.mode = 'ok';
    photon.requests = [];
  });

  const createTrip = async (session: Session, visibility = 'private') =>
    (
      await as(session)
        .post('/v1/trips')
        .send({
          title: 'Vienna',
          startDate: '2026-10-09',
          endDate: '2026-10-09',
          visibility,
        })
        .expect(201)
    ).body as TripBody;

  const names = (items: PlaceBody[]) => items.map((item) => item.name);

  describe('GET /v1/places/tiles', () => {
    // Zoom-13 squares are 360 / 2^13 ≈ 0.0439° a side; these two sit on top of each other in Vienna.
    const SOUTH = '13/372/1096';
    const NORTH = '13/372/1097';

    it('returns for each square what in-view returns for it, in one request', async () => {
      await insertPlace(app, { name: 'South', lat: 48.2, lng: 16.37 });
      await insertPlace(app, { name: 'North', lat: 48.21, lng: 16.37 });

      const { body } = await as(alice)
        .get(`/v1/places/tiles?tiles=${SOUTH},${NORTH}&zoom=15`)
        .expect(200);

      expect(body.tiles.map((tile: { tile: string }) => tile.tile)).toEqual([
        SOUTH,
        NORTH,
      ]);
      expect(names(body.tiles[0].places)).toEqual(['South']);
      expect(names(body.tiles[1].places)).toEqual(['North']);
      expect(body.attribution).toBe('© OpenStreetMap contributors');

      const side = 360 / 2 ** 13;
      const south = await as(alice)
        .get(
          `/v1/places/in-view?bbox=${372 * side},${1096 * side},${373 * side},${1097 * side}&zoom=15`,
        )
        .expect(200);
      expect(body.tiles[0].places).toEqual(south.body.places);
    });

    it('rejects malformed squares, too many, and squares too large for the zoom', async () => {
      const malformed = await as(alice)
        .get('/v1/places/tiles?tiles=abc&zoom=15')
        .expect(400);
      expect(malformed.body.error.details.fields).toEqual({
        tiles: ['invalidTiles'],
      });

      const many = Array.from({ length: 17 }, (_, i) => `13/${i}/1096`).join(
        ',',
      );
      await as(alice).get(`/v1/places/tiles?tiles=${many}&zoom=15`).expect(400);

      const outside = await as(alice)
        .get('/v1/places/tiles?tiles=13/5000/1096&zoom=15')
        .expect(400);
      expect(outside.body.error.details.fields).toEqual({
        tiles: ['invalidTiles'],
      });

      const large = await as(alice)
        .get('/v1/places/tiles?tiles=10/46/137&zoom=15')
        .expect(400);
      expect(large.body.error.code).toBe('BBOX_TOO_LARGE');
    });
  });

  describe('GET /v1/places/in-view', () => {
    it('lists Tripinly places by popularity, then OSM places, never unliked user places', async () => {
      await insertPlace(app, {
        name: 'Liked a little',
        lat: 48.205,
        lng: 16.37,
        popularity: 2,
      });
      await insertPlace(app, {
        name: 'Liked a lot',
        lat: 48.206,
        lng: 16.371,
        popularity: 9,
      });
      await insertPlace(app, { name: 'OSM sight', lat: 48.204, lng: 16.372 });
      await insertPlace(app, {
        name: 'Private custom pin',
        lat: 48.2051,
        lng: 16.3701,
        source: 'user',
      });
      await insertPlace(app, {
        name: 'Gone from OSM',
        lat: 48.2052,
        lng: 16.3702,
        isActive: false,
      });
      await insertPlace(app, { name: 'Outside', lat: 48.3, lng: 16.5 });

      const { body } = await as(alice)
        .get(`/v1/places/in-view?bbox=${VIEW}&zoom=15`)
        .expect(200);

      expect(names(body.places)).toEqual([
        'Liked a lot',
        'Liked a little',
        'OSM sight',
      ]);
      expect(body.places[0]).toEqual({
        id: expect.any(String),
        name: 'Liked a lot',
        category: 'attraction',
        location: { lat: 48.206, lng: 16.371 },
        isTripinly: true,
        likeCount: 9,
        coverThumbUrl: null,
        likedByMe: false,
      });
      expect(body.places[2].isTripinly).toBe(false);
      expect(body.clusters).toEqual([]);
      expect(body.attribution).toBe('© OpenStreetMap contributors');
    });

    it('filters by category and localizes names', async () => {
      await insertPlace(app, {
        name: 'Kunsthistorisches Museum',
        names: { 'name:hu': 'Szépművészeti Múzeum Bécs' },
        category: 'museum',
        lat: 48.2037,
        lng: 16.3618,
      });
      await insertPlace(app, {
        name: 'Café',
        category: 'cafe',
        lat: 48.205,
        lng: 16.37,
      });

      const { body } = await as(alice)
        .get(`/v1/places/in-view?bbox=${VIEW}&zoom=15&categories=museum,park`)
        .set('Accept-Language', 'hu-HU')
        .expect(200);

      expect(names(body.places)).toEqual(['Szépművészeti Múzeum Bécs']);
    });

    it('spreads OSM places over the view, sights first', async () => {
      // A cluster of cafés in the south-west corner and one museum in the north-east.
      for (let i = 0; i < 12; i++) {
        await insertPlace(app, {
          name: `Café ${i}`,
          category: 'cafe',
          lat: 48.2005 + i * 0.0001,
          lng: 16.3605,
        });
      }
      await insertPlace(app, {
        name: 'Museum',
        category: 'museum',
        lat: 48.2095,
        lng: 16.3795,
      });
      await insertPlace(app, {
        name: 'Café NE',
        category: 'cafe',
        lat: 48.2094,
        lng: 16.3794,
      });

      const { body } = await as(alice)
        .get(`/v1/places/in-view?bbox=${VIEW}&zoom=15&limit=10`)
        .expect(200);

      expect(body.places).toHaveLength(10);
      // Round-robin over cells: the museum and one café per occupied cell come first.
      expect(names(body.places).slice(0, 2)).toEqual(
        expect.arrayContaining(['Museum']),
      );
      expect(names(body.places)).toContain('Café NE');
    });

    it('keeps the same picks when the view moves a little', async () => {
      for (let i = 0; i < 30; i++) {
        await insertPlace(app, {
          name: `Café ${i}`,
          category: 'cafe',
          lat: 48.2005 + (i % 6) * 0.0015,
          lng: 16.3605 + Math.floor(i / 6) * 0.003,
        });
      }
      const picks = async (bbox: string) => {
        const { body } = await as(alice)
          .get(`/v1/places/in-view?bbox=${bbox}&zoom=15&limit=10`)
          .expect(200);
        return body.places as { name: string; location: { lng: number } }[];
      };

      const before = await picks(VIEW);
      // Half a tile east: the two western columns of cafés leave the view.
      const after = new Set(
        (await picks('16.366,48.20,16.386,48.21')).map((p) => p.name),
      );
      const stillInView = before.filter((p) => p.location.lng >= 16.366);
      expect(stillInView.length).toBeGreaterThan(0);
      // Every pick still in view stays picked.
      expect(
        stillInView.map((p) => p.name).filter((n) => !after.has(n)),
      ).toEqual([]);
    });

    it('fills the map with notable OSM places below zoom 14 while hot spots are few', async () => {
      await insertPlace(app, {
        name: 'Stephansdom',
        lat: 48.2085,
        lng: 16.3731,
        tags: { wikidata: 'Q167592' },
      });
      await insertPlace(app, {
        name: 'Corner café',
        category: 'cafe',
        lat: 48.209,
        lng: 16.374,
      });
      await insertPlace(app, {
        name: 'Hot spot',
        lat: 48.21,
        lng: 16.37,
        popularity: 3,
      });
      const bbox = '16.1,48.1,16.6,48.4';

      const zoomedOut = await as(alice)
        .get(`/v1/places/in-view?bbox=${bbox}&zoom=11`)
        .expect(200);
      expect(names(zoomedOut.body.places)).toEqual(['Hot spot', 'Stephansdom']);

      const farOut = await as(alice)
        .get(`/v1/places/in-view?bbox=${bbox}&zoom=9`)
        .expect(200);
      expect(names(farOut.body.places)).toEqual(['Hot spot']);
    });

    it('shows only Tripinly places below zoom 14, clustered when over the limit', async () => {
      for (let i = 0; i < 8; i++) {
        await insertPlace(app, {
          name: `West ${i}`,
          lat: 48.2 + i * 0.001,
          lng: 16.3,
          popularity: 1,
        });
        await insertPlace(app, {
          name: `East ${i}`,
          lat: 48.2 + i * 0.001,
          lng: 16.45,
          popularity: 1,
        });
      }
      await insertPlace(app, {
        name: 'Lonely',
        lat: 48.15,
        lng: 16.2,
        popularity: 5,
      });
      await insertPlace(app, { name: 'OSM only', lat: 48.201, lng: 16.301 });
      const bbox = '16.1,48.1,16.6,48.4';

      const few = await as(alice)
        .get(`/v1/places/in-view?bbox=${bbox}&zoom=11&limit=50`)
        .expect(200);
      expect(few.body.places).toHaveLength(17);
      expect(names(few.body.places)).not.toContain('OSM only');
      expect(few.body.clusters).toEqual([]);

      const clustered = await as(alice)
        .get(`/v1/places/in-view?bbox=${bbox}&zoom=11&limit=10`)
        .expect(200);
      expect(names(clustered.body.places)).toEqual(['Lonely']);
      expect(clustered.body.clusters).toHaveLength(2);
      expect(
        clustered.body.clusters.map((c: { count: number }) => c.count),
      ).toEqual([8, 8]);
      expect(clustered.body.clusters[0].location).toEqual({
        lat: expect.any(Number),
        lng: expect.any(Number),
      });
    });

    it('rejects a bbox too large for the zoom, and malformed ones', async () => {
      const large = await as(alice)
        .get('/v1/places/in-view?bbox=16.0,48.0,16.5,48.3&zoom=15')
        .expect(400);
      expect(large.body.error.code).toBe('BBOX_TOO_LARGE');
      expect(large.body.error.details.maxSpanDegrees).toBeCloseTo(0.0879, 3);

      const inverted = await as(alice)
        .get('/v1/places/in-view?bbox=16.38,48.20,16.36,48.21&zoom=15')
        .expect(400);
      expect(inverted.body.error.details.fields).toEqual({
        bbox: ['invalidBbox'],
      });

      const malformed = await as(alice)
        .get('/v1/places/in-view?bbox=abc&zoom=99&categories=shops')
        .expect(400);
      expect(Object.keys(malformed.body.error.details.fields).sort()).toEqual([
        'bbox',
        'categories',
        'zoom',
      ]);
    });

    it('caches results until the next import bumps the version', async () => {
      await insertPlace(app, { name: 'First', lat: 48.205, lng: 16.37 });
      const url = `/v1/places/in-view?bbox=${VIEW}&zoom=15`;
      await as(alice).get(url).expect(200);
      await insertPlace(app, { name: 'Second', lat: 48.2055, lng: 16.3705 });

      const cached = await as(bob).get(url).expect(200);
      expect(names(cached.body.places)).toEqual(['First']);

      await app.get<Redis>(REDIS).incr(IN_VIEW_CACHE_VERSION_KEY);
      const fresh = await as(bob).get(url).expect(200);
      expect(names(fresh.body.places).sort()).toEqual(['First', 'Second']);
    });

    it('requires sign-in', async () => {
      await api(app)
        .anonymous.get(`/v1/places/in-view?bbox=${VIEW}&zoom=15`)
        .expect(401);
    });
  });

  describe('GET /v1/places/search', () => {
    const photonCity = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [16.3725, 48.2083] },
      properties: {
        osm_type: 'R',
        osm_id: 109166,
        name: 'Wien',
        type: 'city',
        country: 'Österreich',
      },
    };

    it('merges our places (any language) with Photon, dropping duplicates', async () => {
      await insertPlace(app, {
        name: 'Kunsthistorisches Museum',
        names: { 'name:en': 'Museum of Art History' },
        category: 'museum',
        lat: 48.2037,
        lng: 16.3618,
        osmId: 4242,
      });
      await insertPlace(app, {
        name: 'Museum Custom',
        lat: 48.2,
        lng: 16.3,
        source: 'user',
      });
      photon.features = [
        photonCity,
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [16.3618, 48.2037] },
          properties: {
            osm_type: 'N',
            osm_id: 4242,
            name: 'Kunsthistorisches Museum',
            type: 'house',
          },
        },
      ];

      const { body } = await as(alice)
        .get('/v1/places/search?q=museum%20of%20art&lat=48.2&lng=16.37')
        .set('Accept-Language', 'en')
        .expect(200);

      expect(body.items).toEqual([
        {
          source: 'place',
          id: expect.any(String),
          name: 'Museum of Art History',
          category: 'museum',
          location: { lat: 48.2037, lng: 16.3618 },
          isTripinly: false,
          likeCount: 0,
          type: null,
          address: null,
          osmType: 'node',
          osmId: '4242',
        },
        expect.objectContaining({
          source: 'photon',
          id: null,
          name: 'Wien',
          osmType: 'relation',
          osmId: '109166',
        }),
      ]);
      const sent = photon.requests[0];
      expect(sent.get('q')).toBe('museum of art');
      expect(sent.get('lang')).toBe('en');
      expect(sent.get('lat')).toBe('48.2');
      expect(sent.get('lon')).toBe('16.37');
    });

    it('finds partial names and never lists unliked user places', async () => {
      await insertPlace(app, {
        name: 'Stephansdom',
        lat: 48.2085,
        lng: 16.373,
      });
      await insertPlace(app, {
        name: 'Stephans Home',
        lat: 48.2,
        lng: 16.3,
        source: 'user',
      });
      await insertPlace(app, {
        name: 'Stephans Bakery',
        lat: 48.2,
        lng: 16.3,
        source: 'user',
        popularity: 3,
      });

      const { body } = await as(alice)
        .get('/v1/places/search?q=stephans')
        .set('Accept-Language', 'hu')
        .expect(200);
      expect(names(body.items).sort()).toEqual([
        'Stephans Bakery',
        'Stephansdom',
      ]);
      // Hungarian has no Photon index: no lang parameter.
      expect(photon.requests[0].has('lang')).toBe(false);
    });

    it('returns our places when Photon fails or times out', async () => {
      await insertPlace(app, {
        name: 'Wiener Riesenrad',
        lat: 48.2166,
        lng: 16.3958,
      });
      photon.mode = 'error';
      const failed = await as(alice)
        .get('/v1/places/search?q=riesenrad')
        .expect(200);
      expect(names(failed.body.items)).toEqual(['Wiener Riesenrad']);

      photon.mode = 'hang';
      const started = Date.now();
      const slow = await as(alice)
        .get('/v1/places/search?q=riesenrad')
        .expect(200);
      expect(names(slow.body.items)).toEqual(['Wiener Riesenrad']);
      expect(Date.now() - started).toBeLessThan(4_000);
    });

    it('answers a single letter with Photon results only', async () => {
      await insertPlace(app, {
        name: 'Wiener Riesenrad',
        lat: 48.2166,
        lng: 16.3959,
      });
      photon.features = [photonCity];

      const { body } = await as(alice).get('/v1/places/search?q=w').expect(200);

      expect(names(body.items)).toEqual(['Wien']);
      expect(photon.requests[0].get('q')).toBe('w');
    });

    it('validates the query', async () => {
      const { body } = await as(alice)
        .get('/v1/places/search?q=%20&lat=48.2')
        .expect(400);
      expect(Object.keys(body.error.details.fields).sort()).toEqual([
        'lng',
        'q',
      ]);
    });
  });

  describe('GET /v1/places/nearby', () => {
    it('ranks liked places by popularity and distance, topped up with OSM sights', async () => {
      await insertPlace(app, {
        name: 'Popular far',
        lat: 48.225,
        lng: 16.37,
        popularity: 50,
      });
      await insertPlace(app, {
        name: 'Popular near',
        lat: 48.2055,
        lng: 16.37,
        popularity: 10,
      });
      await insertPlace(app, {
        name: 'Sight',
        category: 'historic',
        lat: 48.206,
        lng: 16.371,
      });
      await insertPlace(app, {
        name: 'Far sight',
        category: 'museum',
        lat: 48.21,
        lng: 16.37,
      });
      await insertPlace(app, {
        name: 'Cafe',
        category: 'cafe',
        lat: 48.2051,
        lng: 16.3701,
      });
      await insertPlace(app, {
        name: 'Out of range',
        lat: 48.4,
        lng: 16.37,
        popularity: 99,
      });

      const { body } = await as(alice)
        .get(`/v1/places/nearby?lat=${CENTRE.lat}&lng=${CENTRE.lng}&radiusKm=5`)
        .expect(200);

      // 50 / (1 + 2.2)^1.2 ≈ 12.4 beats 10 / (1 + 0.06)^1.2 ≈ 9.3.
      expect(names(body.items)).toEqual([
        'Popular far',
        'Popular near',
        'Sight',
        'Far sight',
      ]);
      expect(body.items[1].distanceMeters).toBeGreaterThan(40);
      expect(body.items[1].distanceMeters).toBeLessThan(70);
      expect(body.nextCursor).toBeNull();
    });

    it('pages through liked places without topping up', async () => {
      for (let i = 0; i < 12; i++) {
        await insertPlace(app, {
          name: `Liked ${i}`,
          lat: 48.205 + i * 0.001,
          lng: 16.37,
          popularity: 5,
        });
      }
      await insertPlace(app, {
        name: 'Sight',
        category: 'historic',
        lat: 48.2051,
        lng: 16.3701,
      });

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `&cursor=${cursor}` : '';
        const page = await as(alice)
          .get(
            `/v1/places/nearby?lat=${CENTRE.lat}&lng=${CENTRE.lng}&limit=5${query}`,
          )
          .expect(200);
        seen.push(...names(page.body.items as PlaceBody[]));
        cursor = page.body.nextCursor as string | null;
      } while (cursor);

      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
      expect(seen[0]).toBe('Liked 0');
      expect(seen).not.toContain('Sight');
    });

    it('rejects bad coordinates, radius and cursors', async () => {
      const { body } = await as(alice)
        .get('/v1/places/nearby?lat=95&lng=16&radiusKm=80')
        .expect(400);
      expect(Object.keys(body.error.details.fields).sort()).toEqual([
        'lat',
        'radiusKm',
      ]);
      await as(alice)
        .get('/v1/places/nearby?lat=48&lng=16&cursor=nope')
        .expect(400);
    });
  });

  describe('GET /v1/places/popular', () => {
    it("lists liked places in the view, leaving out the trip's own places", async () => {
      const inTrip = await insertPlace(app, {
        name: 'In trip',
        lat: 48.205,
        lng: 16.37,
        popularity: 4,
      });
      await insertPlace(app, {
        name: 'Not in trip',
        lat: 48.206,
        lng: 16.371,
        popularity: 2,
      });
      await insertPlace(app, { name: 'OSM only', lat: 48.207, lng: 16.372 });
      const trip = await createTrip(alice);
      await as(alice)
        .post(`/v1/places/${inTrip}/add-to-trip`)
        .send({ dayId: trip.days[0].id })
        .expect(201);

      const all = await as(alice)
        .get(`/v1/places/popular?bbox=${VIEW}`)
        .expect(200);
      expect(names(all.body.items)).toEqual(['In trip', 'Not in trip']);

      const excluded = await as(alice)
        .get(`/v1/places/popular?bbox=${VIEW}&excludeTripId=${trip.id}`)
        .expect(200);
      expect(names(excluded.body.items)).toEqual(['Not in trip']);

      // Someone else's private trip can't be probed.
      await as(bob)
        .get(`/v1/places/popular?bbox=${VIEW}&excludeTripId=${trip.id}`)
        .expect(404);
    });
  });

  describe('GET /v1/places/:id and add-to-trip', () => {
    it('shows OSM places with tags and attribution', async () => {
      const id = await insertPlace(app, {
        name: 'Café Central',
        category: 'cafe',
        lat: 48.2104,
        lng: 16.3655,
        osmId: 77,
        tags: {
          website: 'https://example.com',
          opening_hours: 'Mo-Su 08:00-21:00',
        },
      });

      const { body } = await as(alice).get(`/v1/places/${id}`).expect(200);
      expect(body).toEqual({
        id,
        name: 'Café Central',
        category: 'cafe',
        location: { lat: 48.2104, lng: 16.3655 },
        isTripinly: false,
        likeCount: 0,
        coverThumbUrl: null,
        likedByMe: false,
        source: 'osm',
        isActive: true,
        osmType: 'node',
        osmId: '77',
        tags: {
          website: 'https://example.com',
          openingHours: 'Mo-Su 08:00-21:00',
          cuisine: null,
          wikidata: null,
        },
        photoThumbUrls: [],
        attribution: '© OpenStreetMap contributors',
      });
    });

    it("keeps a custom pin from a private trip to that trip's members", async () => {
      const trip = await createTrip(alice);
      const marker = await as(alice)
        .post(`/v1/days/${trip.days[0].id}/markers`)
        .send({ name: 'Our flat', location: { lat: 48.19, lng: 16.35 } })
        .expect(201);
      const placeId = marker.body.placeId as string;

      await as(alice).get(`/v1/places/${placeId}`).expect(200);
      await as(bob).get(`/v1/places/${placeId}`).expect(404);

      const bobTrip = await createTrip(bob);
      const viaAdd = await as(bob)
        .post(`/v1/places/${placeId}/add-to-trip`)
        .send({ dayId: bobTrip.days[0].id })
        .expect(400);
      expect(viaAdd.body.error.details.fields).toEqual({
        placeId: ['notFound'],
      });
      await as(bob)
        .post(`/v1/days/${bobTrip.days[0].id}/markers`)
        .send({ placeId })
        .expect(400);

      // Once the trip is public, the pin is visible through it.
      await as(alice)
        .patch(`/v1/trips/${trip.id}`)
        .send({ visibility: 'public' })
        .expect(200);
      await as(bob).get(`/v1/places/${placeId}`).expect(200);
    });

    it('adds a place to a day as a marker', async () => {
      const id = await insertPlace(app, {
        name: 'Albertina',
        category: 'museum',
        lat: 48.2046,
        lng: 16.3683,
      });
      const trip = await createTrip(alice);

      const { body } = await as(alice)
        .post(`/v1/places/${id}/add-to-trip`)
        .send({ dayId: trip.days[0].id, time: '10:30' })
        .expect(201);
      expect(body).toEqual(
        expect.objectContaining({
          placeId: id,
          name: 'Albertina',
          location: { lat: 48.2046, lng: 16.3683 },
          time: '10:30',
          position: 0,
        }),
      );

      // Only editors can add, and the place must exist.
      await as(bob)
        .post(`/v1/places/${id}/add-to-trip`)
        .send({ dayId: trip.days[0].id })
        .expect(404);
      await as(alice)
        .post(`/v1/places/${id}/add-to-trip`)
        .send({ dayId: 'not-a-uuid' })
        .expect(400);
    });

    it('returns 404 for unknown places', async () => {
      await as(alice)
        .get('/v1/places/00000000-0000-4000-8000-000000000000')
        .expect(404);
      expect(await prisma.place.count()).toBe(0);
    });
  });
});
