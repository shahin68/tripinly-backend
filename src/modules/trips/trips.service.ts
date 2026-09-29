import { HttpStatus, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  addDays,
  daysBetween,
  parseCalendarDate,
  toCalendarDate,
} from '../../common/dates/calendar-date';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  type Page,
  toPage,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma, Trip } from '../../generated/prisma/client';
import { BlocksService } from '../moderation/blocks.service';
import { normalizeUsername } from '../users/username';
import { USER_SUMMARY_SELECT } from '../users/user-summary';
import { TripAccessService } from './trip-access.service';
import { TripLimits } from './trip-limits';
import {
  dayDate,
  TRIP_DETAIL_INCLUDE,
  toTripDto,
  toTripSummaryDto,
  type TripWithDetails,
} from './trip.mapper';
import type {
  CreateTripDto,
  MeStatsDto,
  TripDayDto,
  TripDto,
  TripSummaryDto,
  UpdateTripDto,
} from './trips.dto';

type Tx = Prisma.TransactionClient;

export function limitReached(resource: string, max: number): AppException {
  return new AppException(
    ErrorCode.LIMIT_REACHED,
    HttpStatus.UNPROCESSABLE_ENTITY,
    {
      resource,
      max,
    },
  );
}

/** Locks the trip row so day positions and dates change one request at a time. */
export async function lockTrip(tx: Tx, tripId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM trips WHERE id = ${tripId}::uuid FOR UPDATE`;
}

/**
 * Trips and their days. With a start date, endDate is always
 * startDate + (number of days - 1); every day change keeps that true.
 */
@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly blocks: BlocksService,
    private readonly events: EventEmitter2,
  ) {}

  async create(userId: string, input: CreateTripDto): Promise<TripDto> {
    const { startDate, endDate, dayCount } = this.resolveNewDates(input);
    const owner = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { defaultTripVisibility: true },
    });
    const editorIds = await this.resolveInitialMembers(
      userId,
      input.memberUsernames ?? [],
    );

    const tripId = await this.prisma.$transaction(async (tx) => {
      // Serialize a user's trip creation so the limit holds under concurrency.
      await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const owned = await tx.trip.count({ where: { ownerId: userId } });
      if (owned >= TripLimits.TRIPS_PER_USER) {
        throw limitReached('trips', TripLimits.TRIPS_PER_USER);
      }
      const trip = await tx.trip.create({
        data: {
          ownerId: userId,
          title: input.title,
          startDate,
          endDate,
          visibility: input.visibility ?? owner.defaultTripVisibility,
          members: {
            create: [
              { userId, role: 'owner', addedById: userId },
              ...editorIds.map((id) => ({
                userId: id,
                role: 'editor' as const,
                addedById: userId,
              })),
            ],
          },
          days: {
            create: Array.from({ length: dayCount }, (_, position) => ({
              position,
            })),
          },
        },
      });
      return trip.id;
    });

    this.events.emit(
      DomainEvents.TRIP_CREATED,
      domainEvent(
        DomainEvents.TRIP_CREATED,
        userId,
        { memberIds: editorIds },
        tripId,
      ),
    );
    return this.get(userId, tripId);
  }

  async get(userId: string, tripId: string): Promise<TripDto> {
    const { role } = await this.access.assert(userId, tripId, 'view');
    const trip: TripWithDetails = await this.prisma.trip.findUniqueOrThrow({
      where: { id: tripId },
      include: TRIP_DETAIL_INCLUDE,
    });
    const people = [
      ...trip.members.map((member) => member.userId),
      ...trip.days.flatMap((day) =>
        day.markers.map((marker) => marker.createdById ?? ''),
      ),
    ].filter(Boolean);
    const hidden = await this.blocks.blockedAmong(userId, people);
    return toTripDto(trip, role, hidden);
  }

  async update(
    userId: string,
    tripId: string,
    input: UpdateTripDto,
  ): Promise<TripDto> {
    await this.access.assert(userId, tripId, 'manage');
    const changed: Record<string, unknown> = {};

    await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, tripId);
      const trip = await tx.trip.findUniqueOrThrow({ where: { id: tripId } });
      const dayCount = await tx.tripDay.count({ where: { tripId } });
      const data: Prisma.TripUpdateInput = {};

      if (input.title !== undefined && input.title !== trip.title) {
        data.title = changed.title = input.title;
      }
      if (
        input.visibility !== undefined &&
        input.visibility !== trip.visibility
      ) {
        data.visibility = changed.visibility = input.visibility;
      }

      if (input.startDate !== undefined || input.endDate !== undefined) {
        const next = await this.resizeForDates(tx, trip, dayCount, input);
        if (
          !sameDate(next.startDate, trip.startDate) ||
          !sameDate(next.endDate, trip.endDate)
        ) {
          data.startDate = next.startDate;
          data.endDate = next.endDate;
          changed.startDate = next.startDate
            ? toCalendarDate(next.startDate)
            : null;
          changed.endDate = next.endDate ? toCalendarDate(next.endDate) : null;
        }
        if (next.dayCount !== dayCount) changed.dayCount = next.dayCount;
      }
      if (Object.keys(changed).length > 0) {
        await tx.trip.update({
          where: { id: tripId },
          data: { ...data, updatedAt: new Date() },
        });
      }
    });

    if (Object.keys(changed).length > 0) {
      this.events.emit(
        DomainEvents.TRIP_UPDATED,
        domainEvent(DomainEvents.TRIP_UPDATED, userId, changed, tripId),
      );
    }
    return this.get(userId, tripId);
  }

  async delete(userId: string, tripId: string): Promise<void> {
    await this.access.assert(userId, tripId, 'manage');
    const members = await this.prisma.tripMember.findMany({
      where: { tripId },
      select: { userId: true },
    });
    await this.prisma.trip.delete({ where: { id: tripId } });
    this.events.emit(
      DomainEvents.TRIP_DELETED,
      domainEvent(
        DomainEvents.TRIP_DELETED,
        userId,
        { memberIds: members.map((m) => m.userId) },
        tripId,
      ),
    );
  }

  /** Trips I own or collaborate on, most recently changed first. */
  async listMine(
    userId: string,
    cursor?: string,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<Page<TripSummaryDto>> {
    const position = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.prisma.trip.findMany({
      where: {
        members: { some: { userId } },
        OR: [{ hiddenAt: null }, { ownerId: userId }],
        ...(position && {
          AND: {
            OR: [
              { updatedAt: { lt: new Date(position.at) } },
              { updatedAt: new Date(position.at), id: { lt: position.id } },
            ],
          },
        }),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        owner: { select: USER_SUMMARY_SELECT },
        members: { where: { userId }, select: { role: true } },
        _count: { select: { days: true, markers: true } },
      },
    });
    return toPage(
      rows,
      limit,
      (row) => ({ at: row.updatedAt.toISOString(), id: row.id }),
      (row) => toTripSummaryDto(row, row.members[0]?.role ?? null),
    );
  }

  async stats(userId: string): Promise<MeStatsDto> {
    const [tripCount, markerCount] = await Promise.all([
      this.prisma.tripMember.count({ where: { userId } }),
      this.prisma.marker.count({ where: { createdById: userId } }),
    ]);
    return { tripCount, markerCount, photoCount: 0 };
  }

  async addDay(userId: string, tripId: string): Promise<TripDayDto> {
    await this.access.assert(userId, tripId, 'edit_content');
    const { day, trip } = await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, tripId);
      const trip = await tx.trip.findUniqueOrThrow({ where: { id: tripId } });
      const count = await tx.tripDay.count({ where: { tripId } });
      if (count >= TripLimits.DAYS_PER_TRIP) {
        throw limitReached('days', TripLimits.DAYS_PER_TRIP);
      }
      const day = await tx.tripDay.create({
        data: { tripId, position: count },
      });
      const updated = await tx.trip.update({
        where: { id: tripId },
        data: {
          endDate: trip.startDate ? addDays(trip.startDate, count) : null,
          updatedAt: new Date(),
        },
      });
      return { day, trip: updated };
    });
    const dto: TripDayDto = {
      id: day.id,
      position: day.position,
      date: dayDate(trip, day.position),
      markers: [],
    };
    this.events.emit(
      DomainEvents.DAY_CREATED,
      domainEvent(DomainEvents.DAY_CREATED, userId, { day: dto }, tripId),
    );
    return dto;
  }

  /** Deletes a day with its markers; later days move up. A trip keeps at least one day. */
  async deleteDay(userId: string, dayId: string): Promise<void> {
    const { trip } = await this.access.assertForDay(
      userId,
      dayId,
      'edit_content',
    );
    await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, trip.id);
      const day = await tx.tripDay.findUnique({ where: { id: dayId } });
      if (!day) throw AppException.notFound();
      const count = await tx.tripDay.count({ where: { tripId: trip.id } });
      if (count <= 1) throw AppException.validation({ id: ['lastDay'] });
      await tx.tripDay.delete({ where: { id: dayId } });
      await shiftDaysUp(tx, trip.id, day.position);
      const current = await tx.trip.findUniqueOrThrow({
        where: { id: trip.id },
      });
      await tx.trip.update({
        where: { id: trip.id },
        data: {
          endDate: current.startDate
            ? addDays(current.startDate, count - 2)
            : null,
          updatedAt: new Date(),
        },
      });
    });
    this.events.emit(
      DomainEvents.DAY_DELETED,
      domainEvent(DomainEvents.DAY_DELETED, userId, { dayId }, trip.id),
    );
  }

  private resolveNewDates(input: CreateTripDto): {
    startDate: Date | null;
    endDate: Date | null;
    dayCount: number;
  } {
    const startDate = input.startDate
      ? parseCalendarDate(input.startDate)
      : null;
    const endDate = input.endDate ? parseCalendarDate(input.endDate) : null;
    if (input.startDate && !startDate)
      throw AppException.validation({ startDate: ['isDate'] });
    if (input.endDate && !endDate)
      throw AppException.validation({ endDate: ['isDate'] });
    if (endDate && !startDate)
      throw AppException.validation({ endDate: ['requiresStartDate'] });
    if (!startDate) return { startDate: null, endDate: null, dayCount: 1 };
    const dayCount = endDate ? daysBetween(startDate, endDate) + 1 : 1;
    if (dayCount < 1)
      throw AppException.validation({ endDate: ['beforeStartDate'] });
    if (dayCount > TripLimits.DAYS_PER_TRIP)
      throw limitReached('days', TripLimits.DAYS_PER_TRIP);
    return { startDate, endDate: addDays(startDate, dayCount - 1), dayCount };
  }

  /**
   * Applies new dates: removing the start date clears both dates; otherwise the
   * trip gets one day per date, adding empty days or removing trailing empty ones.
   */
  private async resizeForDates(
    tx: Tx,
    trip: Trip,
    dayCount: number,
    input: UpdateTripDto,
  ): Promise<{
    startDate: Date | null;
    endDate: Date | null;
    dayCount: number;
  }> {
    if (input.startDate === null) {
      if (input.endDate !== undefined) {
        throw AppException.validation({ endDate: ['requiresStartDate'] });
      }
      return { startDate: null, endDate: null, dayCount };
    }
    const startDate =
      input.startDate !== undefined
        ? parseCalendarDate(input.startDate)
        : trip.startDate;
    if (input.startDate !== undefined && !startDate) {
      throw AppException.validation({ startDate: ['isDate'] });
    }
    if (!startDate)
      throw AppException.validation({ endDate: ['requiresStartDate'] });

    let target = dayCount;
    if (input.endDate !== undefined) {
      const endDate = parseCalendarDate(input.endDate);
      if (!endDate) throw AppException.validation({ endDate: ['isDate'] });
      target = daysBetween(startDate, endDate) + 1;
      if (target < 1)
        throw AppException.validation({ endDate: ['beforeStartDate'] });
      if (target > TripLimits.DAYS_PER_TRIP)
        throw limitReached('days', TripLimits.DAYS_PER_TRIP);
    }

    if (target > dayCount) {
      await tx.tripDay.createMany({
        data: Array.from({ length: target - dayCount }, (_, i) => ({
          tripId: trip.id,
          position: dayCount + i,
        })),
      });
    } else if (target < dayCount) {
      const markersOnRemoved = await tx.marker.count({
        where: { tripId: trip.id, day: { position: { gte: target } } },
      });
      if (markersOnRemoved > 0)
        throw AppException.validation({ endDate: ['daysNotEmpty'] });
      await tx.tripDay.deleteMany({
        where: { tripId: trip.id, position: { gte: target } },
      });
    }
    return {
      startDate,
      endDate: addDays(startDate, target - 1),
      dayCount: target,
    };
  }

  /** Editors from usernames, all-or-nothing, with per-entry validation errors. */
  private async resolveInitialMembers(
    ownerId: string,
    usernames: string[],
  ): Promise<string[]> {
    if (usernames.length === 0) return [];
    const normalized = usernames.map(normalizeUsername);
    const users = await this.prisma.user.findMany({
      where: {
        username: { in: normalized },
        onboardedAt: { not: null },
        status: 'active',
      },
      select: { id: true, username: true },
    });
    const byName = new Map(users.map((user) => [user.username, user.id]));
    const blocked = await this.blocks.blockedAmong(
      ownerId,
      users.map((user) => user.id),
    );
    const iBlocked = new Set(
      (
        await this.prisma.block.findMany({
          where: {
            blockerId: ownerId,
            blockedId: { in: users.map((user) => user.id) },
          },
          select: { blockedId: true },
        })
      ).map((row) => row.blockedId),
    );

    const fields: Record<string, string[]> = {};
    const ids = new Set<string>();
    normalized.forEach((name, index) => {
      const id = byName.get(name);
      if (id === ownerId) return;
      if (!id || (blocked.has(id) && !iBlocked.has(id))) {
        fields[`memberUsernames.${index}`] = ['notFound'];
      } else if (iBlocked.has(id)) {
        fields[`memberUsernames.${index}`] = ['blocked'];
      } else {
        ids.add(id);
      }
    });
    if (Object.keys(fields).length > 0) throw AppException.validation(fields);
    if (ids.size + 1 > TripLimits.MEMBERS_PER_TRIP) {
      throw limitReached('members', TripLimits.MEMBERS_PER_TRIP);
    }
    return [...ids];
  }
}

/** Closes the gap after a deleted day. Two steps keep (tripId, position) unique throughout. */
async function shiftDaysUp(
  tx: Tx,
  tripId: string,
  fromPosition: number,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE trip_days SET position = -position - 1
    WHERE "tripId" = ${tripId}::uuid AND position > ${fromPosition}`;
  await tx.$executeRaw`
    UPDATE trip_days SET position = -position - 2
    WHERE "tripId" = ${tripId}::uuid AND position < 0`;
}

function sameDate(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}
