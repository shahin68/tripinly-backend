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
  MembershipPayload,
  PlaceHotPayload,
  TripChangesPayload,
} from './notification-types';
import { COMMENT_TYPES, shownActorIds } from './notification-types';
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
      for (const id of shownActorIds(row)) actorIds.add(id);
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
      case 'comment_on_marker':
      case 'comment_reply':
      case 'comment_mention': {
        const payload = row.payload as unknown as CommentPayload;
        const people = this.people(row, context, lang);
        return {
          title: this.t(`push.${row.type}.${people.variant}`, lang, {
            ...args,
            ...people.args,
            marker: payload.markerName,
          }),
          body: this.t(`push.${row.type}.body`, lang, {
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
        // One entry per item since 2026-11-07: the latest liker and how many others.
        if (payload.targetType && (row.count === 1 || row.groupKey)) {
          const item = {
            ...args,
            count: row.count - 1,
            marker: payload.markerName ?? '',
            excerpt: payload.excerpt ?? '',
          };
          const key = `push.liked.${payload.targetType}`;
          return {
            title: this.t(
              `${key}.${row.count > 1 ? 'title_others' : 'title'}`,
              lang,
              item,
            ),
            // A photo in a place's gallery has no trip.
            body: this.t(
              `${key}.${payload.targetType === 'photo' && !trip ? 'body_place' : 'body'}`,
              lang,
              item,
            ),
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
      case 'followed': {
        const people = this.people(row, context, lang);
        return {
          title: this.t(`push.followed.${people.variant}`, lang, {
            ...args,
            ...people.args,
          }),
          body: this.t('push.followed.body', lang, args),
        };
      }
      case 'became_friends':
        return {
          title: this.t('push.became_friends.title', lang, args),
          body: this.t('push.became_friends.body', lang, args),
        };
      case 'trip_saved': {
        const people = this.people(row, context, lang);
        return {
          title: this.t(`push.trip_saved.${people.variant}`, lang, {
            ...args,
            ...people.args,
          }),
          body: this.t('push.trip_saved.body', lang, args),
        };
      }
      case 'place_hot': {
        const payload = row.payload as unknown as PlaceHotPayload;
        // Rows from before 2026-11-07 were written once per milestone.
        const hot = {
          ...args,
          place: payload.placeName,
          count: Math.max(row.count, payload.milestone ?? 0),
        };
        return {
          title: this.t('push.place_hot.title', lang, hot),
          body: this.t('push.place_hot.body', lang, hot),
        };
      }
      case 'join_declined':
      case 'removed_from_trip': {
        const payload = row.payload as unknown as MembershipPayload;
        const ended = { ...args, trip: payload.tripTitle };
        return {
          title: this.t(`push.${row.type}.title`, lang, ended),
          body: this.t(`push.${row.type}.body`, lang, ended),
        };
      }
    }
  }

  /**
   * Where a tap opens (client 04-realtime-and-push.md, Deep links): a stop's
   * comments sheet for comments and comment likes (`markers/{id}/comments`),
   * the stop when the notification is about one (`markers/{id}`), a trip's
   * Members sheet for join requests, the profile for a follow (my Followers
   * for several, `me/followers`), else the trip.
   */
  deepLink(row: Notification, context: RenderContext): string {
    const aboutComments =
      (COMMENT_TYPES as readonly string[]).includes(row.type) ||
      (row.type === 'likes_grouped' &&
        (row.payload as Partial<LikesPayload>).targetType === 'comment');
    if (aboutComments && row.markerId) {
      return `tripinly://markers/${row.markerId}/comments`;
    }
    switch (row.type) {
      case 'followed':
      case 'became_friends': {
        if (row.type === 'followed' && shownActorIds(row).length > 1) {
          return 'tripinly://me/followers';
        }
        const actor = row.actorId ? context.actors.get(row.actorId) : undefined;
        return actor
          ? `tripinly://users/${actor.username}`
          : 'tripinly://notifications';
      }
      case 'join_requested':
        return row.tripId
          ? `tripinly://trips/${row.tripId}/members`
          : 'tripinly://notifications';
      // The trip is public (a join request): open it to see why, or ask elsewhere.
      case 'join_declined':
        return `tripinly://trips/${(row.payload as unknown as MembershipPayload).tripId}`;
      case 'removed_from_trip':
        return 'tripinly://notifications';
      default:
        if (row.markerId) return `tripinly://markers/${row.markerId}`;
        return row.tripId
          ? `tripinly://trips/${row.tripId}`
          : 'tripinly://notifications';
    }
  }

  /**
   * Who a grouped row names: one person once (`title`), one person several
   * times (`title_times`), two people (`title_two`) or more (`title_many`,
   * with how many others).
   */
  private people(
    row: Notification,
    context: RenderContext,
    lang: string,
  ): {
    variant: 'title' | 'title_times' | 'title_two' | 'title_many';
    args: Record<string, string | number>;
  } {
    const ids = (row.payload as { actorIds?: string[] } | null)?.actorIds ?? [];
    const name = (id?: string) => {
      const user = id ? context.actors.get(id) : undefined;
      return (
        user?.displayName ?? user?.username ?? this.t('push.someone', lang, {})
      );
    };
    if (ids.length > 2) {
      return { variant: 'title_many', args: { count: ids.length - 1 } };
    }
    if (ids.length === 2) {
      return { variant: 'title_two', args: { actor2: name(ids[1]) } };
    }
    return { variant: row.count > 1 ? 'title_times' : 'title', args: {} };
  }

  private t(
    key: string,
    lang: string,
    args: Record<string, string | number>,
  ): string {
    return this.i18n.t(key, { lang, args });
  }
}
