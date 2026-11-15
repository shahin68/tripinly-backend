import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envSchema } from '../../../common/config/env';
import { pick, shiftItinerary, typicalTime } from './transit-planner';
import { regionFor } from './transit-regions';
import { type MotisPlan, toPlan } from './transit.provider';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(__dirname, '../../../../test/fixtures', name), 'utf8'),
  ) as MotisPlan;
const rides = toPlan(fixture('motis-plan-vienna.json'));
const walkOnly = toPlan(fixture('motis-walk-vienna.json'));
const LEAVE = new Date('2026-11-17T09:42:00Z');

describe('toPlan', () => {
  it('maps MOTIS legs to walks and rides with the line colours', () => {
    const [u2] = rides.itineraries;
    expect(u2.departure).toBe('2026-11-17T09:44:00.000Z');
    expect(u2.arrival).toBe('2026-11-17T09:57:00.000Z');
    expect(u2.steps.map((step) => step.kind)).toEqual(['walk', 'ride', 'walk']);
    const ride = u2.steps[1];
    expect(ride).toMatchObject({
      vehicle: 'subway',
      line: { name: 'U2', color: '#A862A4', textColor: '#FFFFFF' },
      headsign: 'Wien Karlsplatz',
      from: { name: 'Museumsquartier' },
      to: { name: 'Karlsplatz' },
      durationSeconds: 120,
    });
    // The route's own ends have no name (MOTIS calls them START and END).
    expect(u2.steps[0].from.name).toBeNull();
    expect(u2.steps[2].to.name).toBeNull();
    expect(u2.steps[0].distanceMeters).toBe(292);
    // Precision 6 decoded: the path starts where the walk starts.
    expect(u2.steps[0].path[0].lat).toBeCloseTo(48.2027, 3);
    expect(ride.distanceMeters).toBeGreaterThan(500);
    expect(rides.itineraries[1].steps[1].vehicle).toBe('tram');
    expect(rides.walk).toBeNull();
    expect(walkOnly.walk?.steps).toHaveLength(1);
  });
});

describe('pick', () => {
  it('takes the earliest arrival when leaving at a time', () => {
    expect(pick(rides, LEAVE, false)?.steps[1].line?.name).toBe('U2');
    // Leaving after the U2 has gone: the next one.
    expect(
      pick(rides, new Date('2026-11-17T09:45:00Z'), false)?.steps[1].line?.name,
    ).toBe('D');
  });

  it('takes the latest departure when arriving by a time', () => {
    expect(
      pick(rides, new Date('2026-11-17T10:00:00Z'), true)?.steps[1].line?.name,
    ).toBe('2');
    expect(
      pick(rides, new Date('2026-11-17T09:58:00Z'), true)?.steps[1].line?.name,
    ).toBe('U2');
  });

  it('walks when walking arrives no later, from the requested time', () => {
    const both = { ...rides, walk: walkOnly.walk };
    // 818 s on foot arrives 09:55, before the U2 (09:57).
    const walk = pick(both, LEAVE, false);
    expect(walk?.steps.map((step) => step.kind)).toEqual(['walk']);
    expect(walk?.departure).toBe(LEAVE.toISOString());
    // Arriving by 10:00: on foot means leaving 09:46:20, tram 2 leaves later (09:47).
    const by = pick(both, new Date('2026-11-17T10:00:00Z'), true);
    expect(by?.steps[1]?.line?.name).toBe('2');
    expect(pick({ itineraries: [], walk: null }, LEAVE, false)).toBeNull();
  });
});

describe('typicalTime', () => {
  const now = new Date('2026-11-15T12:00:00Z');

  it('leaves times within six days alone', () => {
    expect(typicalTime(LEAVE, now, 'Europe/Vienna')).toBeNull();
  });

  it('moves far dates to the same weekday and clock time this week', () => {
    // Tuesday 2027-03-30 10:42 summer time (08:42Z) -> Tuesday 2026-11-17 10:42 winter time (09:42Z).
    const moved = typicalTime(
      new Date('2027-03-30T08:42:00Z'),
      now,
      'Europe/Vienna',
    );
    expect(moved?.toISOString()).toBe('2026-11-17T09:42:00.000Z');
    // A past date moves forward the same way.
    expect(
      typicalTime(
        new Date('2026-10-20T08:42:00Z'),
        now,
        'Europe/Vienna',
      )?.toISOString(),
    ).toBe('2026-11-17T09:42:00.000Z');
  });

  it('shifts every time of a trip', () => {
    const [u2] = rides.itineraries;
    const moved = shiftItinerary(u2, 60_000);
    expect(moved.departure).toBe('2026-11-17T09:45:00.000Z');
    expect(moved.steps[2].to.time).toBe('2026-11-17T09:58:00.000Z');
  });
});

describe('transit regions', () => {
  it('finds the city containing both ends', () => {
    const opera = { lat: 48.2031, lng: 16.3691 };
    const schoenbrunn = { lat: 48.1845, lng: 16.3122 };
    const graz = { lat: 47.0707, lng: 15.4395 };
    expect(regionFor(['vienna'], opera, schoenbrunn)?.id).toBe('vienna');
    expect(regionFor(['vienna'], opera, graz)).toBeUndefined();
    expect(regionFor([], opera, schoenbrunn)).toBeUndefined();
  });

  it('accepts only cities with a recipe in TRANSIT_REGIONS', () => {
    const base = {
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      JWT_ACCESS_SECRET: 'x'.repeat(32),
      ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    };
    expect(envSchema.parse(base).TRANSIT_REGIONS).toEqual(['vienna']);
    expect(envSchema.parse(base).TRANSIT_ENABLED).toBe(false);
    expect(
      envSchema.safeParse({ ...base, TRANSIT_REGIONS: 'vienna,atlantis' })
        .success,
    ).toBe(false);
    expect(
      envSchema.safeParse({ ...base, TRANSIT_REGIONS: 'toString' }).success,
    ).toBe(false);
  });
});
