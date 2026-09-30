import { Test } from '@nestjs/testing';
import { I18nService } from 'nestjs-i18n';
import { i18nModule } from '../../common/i18n/i18n.config';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Notification } from '../../generated/prisma/client';
import {
  NotificationRenderer,
  type RenderContext,
  resolveLanguage,
} from './notification-renderer';
import { excerpt } from './notification-types';

const TRIP = '11111111-1111-4111-8111-111111111111';
const OTHER_TRIP = '22222222-2222-4222-8222-222222222222';
const MARKER = '33333333-3333-4333-8333-333333333333';
const JONAS = '44444444-4444-4444-8444-444444444444';

function row(overrides: Partial<Notification>): Notification {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    recipientId: '66666666-6666-4666-8666-666666666666',
    type: 'added_to_trip',
    actorId: JONAS,
    tripId: TRIP,
    markerId: null,
    payload: {},
    groupKey: null,
    count: 1,
    readAt: null,
    pushedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('NotificationRenderer', () => {
  let renderer: NotificationRenderer;
  const context: RenderContext = {
    actors: new Map([
      [JONAS, { id: JONAS, username: 'jonas', displayName: 'Jonas' }],
    ]),
    trips: new Map([[TRIP, { id: TRIP, title: 'Vienna' }]]),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [i18nModule],
      providers: [
        NotificationRenderer,
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    renderer = new NotificationRenderer(
      moduleRef.get(I18nService),
      moduleRef.get(PrismaService),
    );
  });

  it('summarizes collaborator changes', () => {
    const places = row({
      type: 'trip_changed_by_collaborator',
      count: 3,
      payload: { actorIds: [JONAS], kinds: { place_added: 3 } },
    });
    expect(renderer.text(places, context, 'en')).toEqual({
      title: 'Changes in Vienna',
      body: 'Jonas added 3 places',
    });
    expect(renderer.text({ ...places, count: 1 }, context, 'de').body).toBe(
      'Jonas hat einen Ort hinzugefügt',
    );
    const mixed = row({
      type: 'trip_changed_by_collaborator',
      count: 2,
      payload: { actorIds: [JONAS], kinds: { place_added: 1, day_added: 1 } },
    });
    expect(renderer.text(mixed, context, 'hu').body).toBe(
      'Jonas 2 módosítást végzett',
    );
  });

  it('groups likes within one trip or across trips', () => {
    const one = row({
      type: 'likes_grouped',
      payload: { likerIds: [JONAS], tripIds: [TRIP] },
    });
    expect(renderer.text(one, context, 'en').body).toBe(
      'Jonas liked your post in Vienna',
    );
    expect(renderer.deepLink(one)).toBe(`tripinly://trips/${TRIP}`);
    const many = row({
      type: 'likes_grouped',
      tripId: null,
      count: 12,
      payload: { likerIds: [JONAS], tripIds: [TRIP, OTHER_TRIP] },
    });
    expect(renderer.text(many, context, 'en').body).toBe(
      '12 people liked your posts',
    );
    expect(renderer.deepLink(many)).toBe('tripinly://notifications');
  });

  it('falls back when the actor account is gone and links comments to the marker', () => {
    const comment = row({
      type: 'comment_on_marker',
      actorId: null,
      markerId: MARKER,
      payload: { commentId: 'c', markerName: 'Albertina', excerpt: 'Nice' },
    });
    expect(renderer.text(comment, context, 'de')).toEqual({
      title: 'Jemand hat Albertina kommentiert',
      body: 'Nice',
    });
    expect(renderer.deepLink(comment)).toBe(`tripinly://markers/${MARKER}`);
  });
});

describe('resolveLanguage', () => {
  it('takes the first supported base language, else English', () => {
    expect(resolveLanguage('de-AT', 'hu')).toBe('de');
    expect(resolveLanguage('fr-FR', 'hu_HU')).toBe('hu');
    expect(resolveLanguage(undefined, null, 'es')).toBe('en');
  });
});

describe('excerpt', () => {
  it('flattens whitespace and cuts long comments to 80 characters', () => {
    expect(excerpt('  so\n\nnice  ')).toBe('so nice');
    const long = excerpt('a'.repeat(200));
    expect(long).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
  });
});
