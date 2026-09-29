import { addDays, toCalendarDate } from '../../common/dates/calendar-date';
import type {
  Prisma,
  Trip,
  TripRole,
  User,
} from '../../generated/prisma/client';
import { MARKER_INCLUDE, toMarkerDto } from '../markers/markers.dto';
import { toUserSummary, USER_SUMMARY_SELECT } from '../users/user-summary';
import type { TripDto, TripSummaryDto } from './trips.dto';

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

/**
 * `hiddenUserIds`: users with a block in either direction with the viewer.
 * They are left out of the member list and shown as no creator on markers.
 */
export function toTripDto(
  trip: TripWithDetails,
  myRole: TripRole | null,
  hiddenUserIds: ReadonlySet<string> = new Set(),
): TripDto {
  return {
    id: trip.id,
    title: trip.title,
    startDate: trip.startDate ? toCalendarDate(trip.startDate) : null,
    endDate: trip.endDate ? toCalendarDate(trip.endDate) : null,
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
    likedByMe: false,
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
        toMarkerDto(
          marker.createdById && hiddenUserIds.has(marker.createdById)
            ? { ...marker, createdBy: null }
            : marker,
        ),
      ),
    })),
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  };
}

export type TripWithCounts = Trip & {
  owner: Summary;
  _count: { days: number; markers: number };
};

export function toTripSummaryDto(
  trip: TripWithCounts,
  role: TripRole | null,
): TripSummaryDto {
  return {
    id: trip.id,
    title: trip.title,
    startDate: trip.startDate ? toCalendarDate(trip.startDate) : null,
    endDate: trip.endDate ? toCalendarDate(trip.endDate) : null,
    visibility: trip.visibility,
    owner: toUserSummary(trip.owner),
    role: role ?? 'viewer',
    coverThumbUrl: null,
    dayCount: trip._count.days,
    markerCount: trip._count.markers,
    likeCount: trip.likeCount,
    copyCount: trip.copyCount,
    updatedAt: trip.updatedAt.toISOString(),
  };
}
