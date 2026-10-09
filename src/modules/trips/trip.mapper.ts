import { addDays, toCalendarDate } from '../../common/dates/calendar-date';
import type {
  Prisma,
  Trip,
  TripRole,
  User,
} from '../../generated/prisma/client';
import { MARKER_INCLUDE, toMarkerDto } from '../markers/markers.dto';
import { BlocksService } from '../moderation/blocks.service';
import { thumbUrl, type UrlSigner } from '../photos/photo-keys';
import { likedAmong } from '../social/liked';
import { toUserSummary, USER_SUMMARY_SELECT } from '../users/user-summary';
import type { DestinationDto, TripDto, TripSummaryDto } from './trips.dto';

type Summary = Pick<User, 'id' | 'username' | 'displayName'>;

export const TRIP_DETAIL_INCLUDE = {
  owner: { select: USER_SUMMARY_SELECT },
  members: {
    include: { user: { select: USER_SUMMARY_SELECT } },
    // Owner first (enum order), then by join date.
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  },
  days: {
    orderBy: { position: 'asc' },
    include: {
      markers: {
        where: { hiddenAt: null },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        include: MARKER_INCLUDE,
      },
    },
  },
  copiedFrom: { select: { id: true, owner: { select: USER_SUMMARY_SELECT } } },
} satisfies Prisma.TripInclude;

export type TripWithDetails = Prisma.TripGetPayload<{
  include: typeof TRIP_DETAIL_INCLUDE;
}>;

export function dayDate(
  trip: Pick<Trip, 'startDate'>,
  position: number,
): string | null {
  return trip.startDate
    ? toCalendarDate(addDays(trip.startDate, position))
    : null;
}

export function toDestination(
  trip: Pick<Trip, 'destinationName' | 'destinationLat' | 'destinationLng'>,
): DestinationDto | null {
  if (
    trip.destinationName === null ||
    trip.destinationLat === null ||
    trip.destinationLng === null
  ) {
    return null;
  }
  return {
    name: trip.destinationName,
    location: { lat: trip.destinationLat, lng: trip.destinationLng },
  };
}

/** The columns for a destination from the API; null clears them. */
export function destinationColumns(destination: DestinationDto | null) {
  return {
    destinationName: destination?.name ?? null,
    destinationLat: destination?.location.lat ?? null,
    destinationLng: destination?.location.lng ?? null,
  };
}

/**
 * `hiddenUserIds`: users with a block in either direction with the viewer.
 * They are left out of the member list and shown as no creator on markers,
 * and their cover photos aren't shown. `likedIds`: the trip and markers the
 * viewer liked.
 */
export function toTripDto(
  trip: TripWithDetails,
  myRole: TripRole | null,
  signer: UrlSigner,
  hiddenUserIds: ReadonlySet<string> = new Set(),
  likedIds: ReadonlySet<string> = new Set(),
): TripDto {
  return {
    id: trip.id,
    title: trip.title,
    startDate: trip.startDate ? toCalendarDate(trip.startDate) : null,
    endDate: trip.endDate ? toCalendarDate(trip.endDate) : null,
    destination: toDestination(trip),
    visibility: trip.visibility,
    owner: toUserSummary(trip.owner),
    myRole: myRole ?? 'viewer',
    members: trip.members
      .filter((member) => !hiddenUserIds.has(member.userId))
      .map((member) => ({
        user: toUserSummary(member.user),
        role: member.role,
      })),
    likeCount: trip.likeCount,
    likedByMe: likedIds.has(trip.id),
    copyCount: trip.copyCount,
    copiedFrom: trip.copiedFrom
      ? {
          tripId: trip.copiedFrom.id,
          owner: toUserSummary(trip.copiedFrom.owner),
        }
      : null,
    days: trip.days.map((day) => ({
      id: day.id,
      position: day.position,
      date: dayDate(trip, day.position),
      markers: day.markers.map((marker) =>
        toMarkerDto(marker, signer, hiddenUserIds, likedIds),
      ),
    })),
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  };
}

/** The first marker (by day, then position) that has a cover: the trip's card image. */
export const TRIP_COVER_MARKER = {
  where: { hiddenAt: null, coverPhotoId: { not: null } },
  orderBy: [{ day: { position: 'asc' } }, { position: 'asc' }],
  take: 1,
  select: { coverPhotoId: true, coverPhoto: { select: { uploaderId: true } } },
} satisfies Prisma.Trip$markersArgs;

export type TripWithCounts = Trip & {
  owner: Summary;
  _count: { days: number; markers: number };
  markers: {
    coverPhotoId: string | null;
    coverPhoto: { uploaderId: string } | null;
  }[];
};

export function toTripSummaryDto(
  trip: TripWithCounts,
  role: TripRole | null,
  signer: UrlSigner,
  hiddenUserIds: ReadonlySet<string> = new Set(),
  likedIds: ReadonlySet<string> = new Set(),
): TripSummaryDto {
  const cover = trip.markers[0];
  const coverPhotoId =
    cover?.coverPhoto && !hiddenUserIds.has(cover.coverPhoto.uploaderId)
      ? cover.coverPhotoId
      : null;
  return {
    id: trip.id,
    title: trip.title,
    startDate: trip.startDate ? toCalendarDate(trip.startDate) : null,
    endDate: trip.endDate ? toCalendarDate(trip.endDate) : null,
    visibility: trip.visibility,
    owner: toUserSummary(trip.owner),
    role: role ?? 'viewer',
    coverThumbUrl: thumbUrl(signer, coverPhotoId),
    dayCount: trip._count.days,
    markerCount: trip._count.markers,
    likeCount: trip.likeCount,
    likedByMe: likedIds.has(trip.id),
    copyCount: trip.copyCount,
    updatedAt: trip.updatedAt.toISOString(),
  };
}

/** What every trip list (mine, Explore, profiles) loads per trip. */
export function tripSummaryInclude(userId: string) {
  return {
    owner: { select: USER_SUMMARY_SELECT },
    members: { where: { userId }, select: { role: true } },
    _count: { select: { days: true, markers: true } },
    markers: TRIP_COVER_MARKER,
  } satisfies Prisma.TripInclude;
}

type SummaryRow = TripWithCounts & { members: { role: TripRole }[] };

/** Summaries for one viewer: hides covers across blocks and fills likedByMe. */
export async function toTripSummaries(
  db: Pick<Prisma.TransactionClient, 'block' | 'like'>,
  signer: UrlSigner,
  userId: string,
  rows: SummaryRow[],
): Promise<TripSummaryDto[]> {
  const [hidden, liked] = await Promise.all([
    BlocksService.blockedAmong(
      db,
      userId,
      rows.flatMap((row) =>
        row.markers.flatMap((m) =>
          m.coverPhoto ? [m.coverPhoto.uploaderId] : [],
        ),
      ),
    ),
    likedAmong(db, userId, { type: 'trip', ids: rows.map((row) => row.id) }),
  ]);
  return rows.map((row) =>
    toTripSummaryDto(row, row.members[0]?.role ?? null, signer, hidden, liked),
  );
}
