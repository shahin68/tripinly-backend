import { addDays, toCalendarDate } from '../../common/dates/calendar-date';
import type {
  JoinRequestStatus,
  Prisma,
  Trip,
  TripRole,
  User,
} from '../../generated/prisma/client';
import {
  coverPeople,
  MARKER_INCLUDE,
  pickedCover,
  toMarkerDto,
} from '../markers/markers.dto';
import type { PlaceCover } from '../places/place-covers.service';
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
  _count: {
    select: {
      saves: true,
      // Same people as the owner's request list (blocks delete requests).
      joinRequests: {
        where: { status: 'pending', user: { status: 'active' } },
      },
    },
  },
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

/** The viewer's own save and join request on a trip. */
export interface TripViewerState {
  savedByMe: boolean;
  joinRequest: JoinRequestStatus | null;
}

const NO_VIEWER_STATE: TripViewerState = {
  savedByMe: false,
  joinRequest: null,
};

/**
 * `hiddenUserIds`: users with a block in either direction with the viewer.
 * They are left out of the member list and shown as no creator on markers,
 * and their cover photos aren't shown. `likedIds`: the trip and markers the
 * viewer liked. `placeCovers`: the stops' places' images, for stops without a
 * picked cover.
 */
export function toTripDto(
  trip: TripWithDetails,
  myRole: TripRole | null,
  signer: UrlSigner,
  hiddenUserIds: ReadonlySet<string> = new Set(),
  likedIds: ReadonlySet<string> = new Set(),
  viewer: TripViewerState = NO_VIEWER_STATE,
  placeCovers: ReadonlyMap<string, PlaceCover> = new Map(),
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
    saveCount: trip._count.saves,
    savedByMe: viewer.savedByMe,
    myJoinRequest: viewer.joinRequest,
    pendingJoinRequestCount: myRole === 'owner' ? trip._count.joinRequests : 0,
    days: trip.days.map((day) => ({
      id: day.id,
      position: day.position,
      date: dayDate(trip, day.position),
      markers: day.markers.map((marker) =>
        toMarkerDto(marker, signer, hiddenUserIds, likedIds, placeCovers),
      ),
    })),
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  };
}

/** The first stop (by day, then position) with a picked cover: the trip's card image. */
export const TRIP_COVER_MARKER = {
  where: {
    hiddenAt: null,
    OR: [{ coverPhotoId: { not: null } }, { coverImageId: { not: null } }],
  },
  orderBy: [{ day: { position: 'asc' } }, { position: 'asc' }],
  take: 1,
  select: {
    id: true,
    coverPhotoId: true,
    coverImageId: true,
    coverPhoto: MARKER_INCLUDE.coverPhoto,
    coverImage: MARKER_INCLUDE.coverImage,
  },
} satisfies Prisma.Trip$markersArgs;

/** Without a picked cover, the card shows the trip's first photo. */
export const TRIP_FIRST_PHOTO = {
  where: { status: 'ready', hiddenAt: null, marker: { hiddenAt: null } },
  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  take: 1,
  select: { id: true, uploaderId: true },
} satisfies Prisma.Trip$photosArgs;

export type TripWithCounts = Trip & {
  owner: Summary;
  _count: { days: number; markers: number; members: number; saves: number };
  saves: { userId: string }[];
  markers: Prisma.MarkerGetPayload<{
    select: typeof TRIP_COVER_MARKER.select;
  }>[];
  photos: { id: string; uploaderId: string }[];
};

export function toTripSummaryDto(
  trip: TripWithCounts,
  role: TripRole | null,
  signer: UrlSigner,
  hiddenUserIds: ReadonlySet<string> = new Set(),
  likedIds: ReadonlySet<string> = new Set(),
): TripSummaryDto {
  const picked = trip.markers[0];
  const first = trip.photos[0];
  const cover =
    (picked && pickedCover(picked, signer, hiddenUserIds)) ??
    (first && !hiddenUserIds.has(first.uploaderId)
      ? { id: first.id, thumbUrl: thumbUrl(signer, first.id) }
      : null);
  return {
    id: trip.id,
    title: trip.title,
    startDate: trip.startDate ? toCalendarDate(trip.startDate) : null,
    endDate: trip.endDate ? toCalendarDate(trip.endDate) : null,
    visibility: trip.visibility,
    owner: toUserSummary(trip.owner),
    role: role ?? 'viewer',
    coverPhotoId: cover?.id ?? null,
    coverThumbUrl: cover?.thumbUrl ?? null,
    dayCount: trip._count.days,
    markerCount: trip._count.markers,
    editorCount: trip._count.members,
    likeCount: trip.likeCount,
    likedByMe: likedIds.has(trip.id),
    saveCount: trip._count.saves,
    savedByMe: trip.saves.length > 0,
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  };
}

/** What every trip list (mine, Explore, profiles) loads per trip. */
export function tripSummaryInclude(userId: string) {
  return {
    owner: { select: USER_SUMMARY_SELECT },
    members: { where: { userId }, select: { role: true } },
    saves: { where: { userId }, select: { userId: true } },
    _count: {
      select: {
        days: true,
        markers: true,
        members: { where: { role: 'editor' } },
        saves: true,
      },
    },
    markers: TRIP_COVER_MARKER,
    photos: TRIP_FIRST_PHOTO,
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
      rows.flatMap((row) => [
        ...row.markers.flatMap(coverPeople),
        ...row.photos.map((photo) => photo.uploaderId),
      ]),
    ),
    likedAmong(db, userId, { type: 'trip', ids: rows.map((row) => row.id) }),
  ]);
  return rows.map((row) =>
    toTripSummaryDto(row, row.members[0]?.role ?? null, signer, hidden, liked),
  );
}
