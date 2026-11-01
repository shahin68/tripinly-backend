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
  PlaceHotPayload,
  TripChangesPayload,
} from './notification-types';
import { StorageService } from '../../common/storage/storage.service';

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
    private readonly storage: StorageService,
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
      actors: new Map(
        actors.map((user) => [user.id, toUserSummary(user, this.storage)]),
      ),
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
      case 'join_accepted':
        return {
          title: this.t('push.join_accepted.title', lang, args),
          body: this.t('push.join_accepted.body', lang, args),
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
      case 'join_requested':
        return {
          title: this.t('push.join_requested.title', lang, args),
          body: this.t('push.join_requested.body', lang, args),
        };
      case 'likes_grouped': {
        const payload = row.payload as unknown as LikesPayload;
        if (payload.targetType && row.count === 1) {
          const item = {
            ...args,
            marker: payload.markerName ?? '',
            excerpt: payload.excerpt ?? '',
          };
          const key = `push.liked.${payload.targetType}`;
          return {
            title: this.t(`${key}.title`, lang, item),
            body: this.t(`${key}.body`, lang, item),
          };
        }
        // Rows from before 2026-11-01, and old grouped summaries.
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
      case 'followed':
        return {
          title: this.t('push.followed.title', lang, args),
          body: this.t('push.followed.body', lang, args),
        };
      case 'became_friends':
        return {
          title: this.t('push.became_friends.title', lang, args),
          body: this.t('push.became_friends.body', lang, args),
        };
      case 'trip_saved':
        return {
          title: this.t('push.trip_saved.title', lang, args),
          body: this.t('push.trip_saved.body', lang, args),
        };
      case 'place_hot': {
        const payload = row.payload as unknown as PlaceHotPayload;
        const hot = {
          ...args,
          place: payload.placeName,
          count: payload.milestone,
        };
        return {
          title: this.t('push.place_hot.title', lang, hot),
          body: this.t('push.place_hot.body', lang, hot),
        };
      }
    }
  }

  /**
   * Where a tap opens (client 04-realtime-and-push.md, Deep links): the stop
   * when the notification is about one (`markers/{id}`, which older apps
   * read as its trip), a trip's Members sheet for join requests, a profile
   * for follows, else the trip.
   */
  deepLink(row: Notification, context: RenderContext): string {
    switch (row.type) {
      case 'followed':
      case 'became_friends': {
        const actor = row.actorId ? context.actors.get(row.actorId) : undefined;
        return actor
          ? `tripinly://users/${actor.username}`
          : 'tripinly://notifications';
      }
      case 'join_requested':
        return row.tripId
          ? `tripinly://trips/${row.tripId}/members`
          : 'tripinly://notifications';
      default:
        if (row.markerId) return `tripinly://markers/${row.markerId}`;
        return row.tripId
          ? `tripinly://trips/${row.tripId}`
          : 'tripinly://notifications';
    }
  }

  private t(
    key: string,
    lang: string,
    args: Record<string, string | number>,
  ): string {
    return this.i18n.t(key, { lang, args });
  }
}
