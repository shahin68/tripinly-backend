import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PLACE_CATEGORIES } from '../../src/modules/markers/markers.dto';
import { REPORT_REASONS } from '../../src/modules/moderation/reports.dto';
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
    const res = await request(app.getHttpServer())
      .get('/v1/app-config')
      .expect(200);
    const { placeKinds, explorePeriods, reportReasons, ...values } =
      res.body as Record<string, unknown>;
    expect(placeKinds).toHaveLength(PLACE_CATEGORIES.length);
    expect(explorePeriods).toHaveLength(4);
    expect(reportReasons).toHaveLength(REPORT_REASONS.length);
    expect(values).toEqual({
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
      osmPinsEnabled: true,
    });
  });

  it('lists kinds, Explore periods and report reasons in order, labelled in the asked language', async () => {
    const config = async (language: string) =>
      (
        await request(app.getHttpServer())
          .get('/v1/app-config')
          .set('Accept-Language', language)
          .expect(200)
      ).body as {
        placeKinds: {
          key: string;
          label: string;
          icon: number;
          forSpots: boolean;
          forFilters: boolean;
        }[];
        explorePeriods: { key: string; label: string; isDefault: boolean }[];
        reportReasons: { key: string; label: string }[];
      };

    const en = await config('en');
    // Spot first: picked by default and never a filter chip.
    expect(en.placeKinds[0]).toEqual({
      key: 'other',
      label: 'Spot',
      icon: 1,
      forSpots: true,
      forFilters: false,
    });
    expect(en.placeKinds.find((kind) => kind.key === 'cafe')).toMatchObject({
      label: 'Café',
      forFilters: true,
    });
    // No seasons (Shahin 2026-11-23); This month is the default.
    expect(en.explorePeriods.map((period) => period.key)).toEqual([
      'week',
      'month',
      'year',
      'all',
    ]);
    expect(
      en.explorePeriods.filter((period) => period.isDefault),
    ).toMatchObject([{ key: 'month', label: 'This month' }]);
    expect(en.reportReasons.map((reason) => reason.key)).toEqual([
      ...REPORT_REASONS,
    ]);

    const de = await config('de-AT');
    expect(de.explorePeriods[0].label).toBe('Diese Woche');
    // Every label is translated in every language: none falls back to its key.
    for (const language of ['en', 'de', 'hu']) {
      const lists = await config(language);
      for (const item of [
        ...lists.placeKinds,
        ...lists.explorePeriods,
        ...lists.reportReasons,
      ]) {
        expect(item.label).not.toMatch(/^lists\./);
      }
    }
  });
});
