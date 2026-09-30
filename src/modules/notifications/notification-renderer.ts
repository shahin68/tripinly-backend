import { Injectable } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { SUPPORTED_LANGUAGES } from '../../common/i18n/i18n.config';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Notification } from '../../generated/prisma/client';
import {
  toUserSummary,
  USER_SUMMARY_SELECT,
  type UserSummaryDto,
} from '../users/user-summary';
import type {
  CommentPayload,
  LikesPayload,
  TripChangesPayload,
} from './notification-types';

export interface RenderContext {
  actors: Map<string, UserSummaryDto>;
  trips: Map<string, { id: string; title: string }>;
}

export interface RenderedText {
  title: string;
  body: string;
}

export const FALLBACK_LANGUAGE = 'en';

/** The first candidate we have translations for ("de-AT" → "de"), else English. */
export function resolveLanguage(
  ...candidates: (string | null | undefined)[]
): string {
  for (const candidate of candidates) {
    const base = candidate?.toLowerCase().split(/[-_]/)[0];
    if (base && (SUPPORTED_LANGUAGES as readonly string[]).includes(base)) {
      return base;
    }
  }
  return FALLBACK_LANGUAGE;
}

/**
 * Turns notification rows into localized text and deep links; the same text
 * goes into the push and the in-app list (keys push.<type>.* in i18n).
 */
@Injectable()
export class NotificationRenderer {
  constructor(
    private readonly i18n: I18nService,
    private readonly prisma: PrismaService,
  ) {}

  async context(rows: Notification[]): Promise<RenderContext> {
    const actorIds = new Set<string>();
    const tripIds = new Set<string>();
    for (const row of rows) {
      if (row.actorId) actorIds.add(row.actorId);
      if (row.tripId) tripIds.add(row.tripId);
    }
    const [actors, trips] = await Promise.all([
      actorIds.size
        ? this.prisma.user.findMany({
            where: { id: { in: [...actorIds] } },
            select: USER_SUMMARY_SELECT,
          })
        : [],
      tripIds.size
        ? this.prisma.trip.findMany({
            where: { id: { in: [...tripIds] } },
            select: { id: true, title: true },
          })
        : [],
    ]);
    return {
      actors: new Map(actors.map((user) => [user.id, toUserSummary(user)])),
      trips: new Map(trips.map((trip) => [trip.id, trip])),
    };
  }

  text(row: Notification, context: RenderContext, lang: string): RenderedText {
    const actor = row.actorId ? context.actors.get(row.actorId) : undefined;
    const trip = row.tripId ? context.trips.get(row.tripId) : undefined;
    const args = {
      actor:
        actor?.displayName ??
        actor?.username ??
        this.t('push.someone', lang, {}),
      trip: trip?.title ?? '',
      count: row.count,
    };
    switch (row.type) {
      case 'comment_on_marker': {
        const payload = row.payload as unknown as CommentPayload;
        return {
          title: this.t('push.comment_on_marker.title', lang, {
            ...args,
            marker: payload.markerName,
          }),
          body: this.t('push.comment_on_marker.body', lang, {
            excerpt: payload.excerpt,
          }),
        };
      }
      case 'added_to_trip':
        return {
          title: this.t('push.added_to_trip.title', lang, args),
          body: this.t('push.added_to_trip.body', lang, args),
        };
      case 'trip_changed_by_collaborator': {
        const payload = row.payload as unknown as TripChangesPayload;
        const kinds = Object.keys(payload.kinds);
        const variant =
          payload.actorIds.length > 1
            ? 'many_actors'
            : kinds.length === 1 && kinds[0] === 'place_added'
              ? 'places_added'
              : 'one_actor';
        return {
          title: this.t('push.trip_changed_by_collaborator.title', lang, args),
          body: this.t(
            `push.trip_changed_by_collaborator.${variant}`,
            lang,
            args,
          ),
        };
      }
      case 'likes_grouped': {
        const payload = row.payload as unknown as LikesPayload;
        const inTrip = payload.tripIds.length === 1 && trip !== undefined;
        return {
          title: this.t('push.likes_grouped.title', lang, args),
          body: this.t(
            `push.likes_grouped.${inTrip ? 'in_trip' : 'anywhere'}`,
            lang,
            args,
          ),
        };
      }
    }
  }

  deepLink(row: Notification): string {
    if (row.type === 'comment_on_marker' && row.markerId) {
      return `tripinly://markers/${row.markerId}`;
    }
    if (row.type === 'likes_grouped') {
      const { tripIds } = row.payload as unknown as LikesPayload;
      return tripIds.length === 1
        ? `tripinly://trips/${tripIds[0]}`
        : 'tripinly://notifications';
    }
    return row.tripId
      ? `tripinly://trips/${row.tripId}`
      : 'tripinly://notifications';
  }

  private t(
    key: string,
    lang: string,
    args: Record<string, string | number>,
  ): string {
    return this.i18n.t(key, { lang, args });
  }
}
