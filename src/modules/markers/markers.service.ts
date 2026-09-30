import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import type { Prisma } from '../../generated/prisma/client';
import { BlocksService } from '../moderation/blocks.service';
import { PhotoJobsService } from '../photos/photos.queue';
import {
  PlaceMatchingService,
  type PlaceInput,
} from '../places/place-matching.service';
import { TripAccessService } from '../trips/trip-access.service';
import { TripLimits } from '../trips/trip-limits';
import { limitReached, lockTrip } from '../trips/trips.service';
import {
  type CreateMarkerDto,
  MARKER_INCLUDE,
  type MarkerDto,
  type MarkerWithCreator,
  toMarkerDto,
  type UpdateMarkerDto,
} from './markers.dto';

type Tx = Prisma.TransactionClient;

/**
 * Markers on trip days. Positions are 0-based and contiguous per day; every
 * change runs under the trip lock so concurrent edits can't leave gaps.
 */
@Injectable()
export class MarkersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly places: PlaceMatchingService,
    private readonly blocks: BlocksService,
    private readonly events: EventEmitter2,
    private readonly storage: StorageService,
    private readonly photoJobs: PhotoJobsService,
  ) {}

  async create(
    userId: string,
    dayId: string,
    input: CreateMarkerDto,
  ): Promise<MarkerDto> {
    const placeInput = toPlaceInput(input);
    const { trip } = await this.access.assertForDay(
      userId,
      dayId,
      'edit_content',
    );

    const marker = await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, trip.id);
      await assertDayInTrip(tx, dayId, trip.id);
      const count = await tx.marker.count({ where: { dayId } });
      if (count >= TripLimits.MARKERS_PER_DAY) {
        throw limitReached('markers', TripLimits.MARKERS_PER_DAY);
      }
      const place = await this.places.match(tx, placeInput, userId);
      const position = Math.min(input.position ?? count, count);
      await tx.marker.updateMany({
        where: { dayId, position: { gte: position } },
        data: { position: { increment: 1 } },
      });
      const created = await tx.marker.create({
        data: {
          dayId,
          tripId: trip.id,
          placeId: place.id,
          name: input.name ?? place.name,
          lat: input.location?.lat ?? place.lat,
          lng: input.location?.lng ?? place.lng,
          time: input.time ?? null,
          position,
          createdById: userId,
        },
        include: MARKER_INCLUDE,
      });
      await touchTrip(tx, trip.id);
      return created;
    });

    const dto = toMarkerDto(marker, this.storage);
    this.events.emit(
      DomainEvents.MARKER_CREATED,
      domainEvent(
        DomainEvents.MARKER_CREATED,
        userId,
        { marker: dto },
        trip.id,
      ),
    );
    return dto;
  }

  async get(userId: string, markerId: string): Promise<MarkerDto> {
    await this.access.assertForMarker(userId, markerId, 'view');
    const marker = await this.prisma.marker.findUniqueOrThrow({
      where: { id: markerId },
      include: MARKER_INCLUDE,
    });
    return this.toVisibleDto(userId, marker);
  }

  async update(
    userId: string,
    markerId: string,
    input: UpdateMarkerDto,
  ): Promise<MarkerDto> {
    if (input.placeId && input.location) {
      throw AppException.validation({ location: ['notWithPlaceId'] });
    }
    const { trip } = await this.access.assertForMarker(
      userId,
      markerId,
      'edit_content',
    );

    const marker = await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, trip.id);
      const current = await tx.marker.findUnique({ where: { id: markerId } });
      if (!current) throw AppException.notFound();
      const data: Prisma.MarkerUncheckedUpdateInput = {};

      if (input.name !== undefined) data.name = input.name;
      if (input.time !== undefined) data.time = input.time;
      if (input.placeId || input.location) {
        const place = await this.places.match(
          tx,
          input.placeId
            ? { placeId: input.placeId }
            : {
                name: input.name ?? current.name,
                lat: input.location!.lat,
                lng: input.location!.lng,
              },
          userId,
        );
        data.placeId = place.id;
        data.lat = input.location?.lat ?? place.lat;
        data.lng = input.location?.lng ?? place.lng;
      }

      const targetDayId = input.dayId ?? current.dayId;
      if (targetDayId !== current.dayId || input.position !== undefined) {
        if (targetDayId !== current.dayId) {
          await assertDayInTrip(tx, targetDayId, trip.id, 'dayId');
          const count = await tx.marker.count({
            where: { dayId: targetDayId },
          });
          if (count >= TripLimits.MARKERS_PER_DAY) {
            throw limitReached('markers', TripLimits.MARKERS_PER_DAY);
          }
        }
        // Take the marker out of its day, then insert it at the target position.
        await tx.marker.updateMany({
          where: { dayId: current.dayId, position: { gt: current.position } },
          data: { position: { decrement: 1 } },
        });
        const remaining = await tx.marker.count({
          where: { dayId: targetDayId, id: { not: markerId } },
        });
        const position = Math.min(input.position ?? remaining, remaining);
        await tx.marker.updateMany({
          where: {
            dayId: targetDayId,
            id: { not: markerId },
            position: { gte: position },
          },
          data: { position: { increment: 1 } },
        });
        data.dayId = targetDayId;
        data.position = position;
      }

      const updated = await tx.marker.update({
        where: { id: markerId },
        data,
        include: MARKER_INCLUDE,
      });
      await touchTrip(tx, trip.id);
      return updated;
    });

    const dto = await this.toVisibleDto(userId, marker);
    this.events.emit(
      DomainEvents.MARKER_UPDATED,
      domainEvent(
        DomainEvents.MARKER_UPDATED,
        userId,
        { marker: dto },
        trip.id,
      ),
    );
    return dto;
  }

  async delete(userId: string, markerId: string): Promise<void> {
    const { trip } = await this.access.assertForMarker(
      userId,
      markerId,
      'edit_content',
    );
    const { dayId, photoIds } = await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, trip.id);
      const marker = await tx.marker.findUnique({ where: { id: markerId } });
      if (!marker) throw AppException.notFound();
      const photos = await tx.photo.findMany({
        where: { markerId },
        select: { id: true },
      });
      await tx.marker.delete({ where: { id: markerId } });
      await tx.marker.updateMany({
        where: { dayId: marker.dayId, position: { gt: marker.position } },
        data: { position: { decrement: 1 } },
      });
      await touchTrip(tx, trip.id);
      return { dayId: marker.dayId, photoIds: photos.map((p) => p.id) };
    });
    await this.photoJobs.deleteFiles(photoIds);
    this.events.emit(
      DomainEvents.MARKER_DELETED,
      domainEvent(
        DomainEvents.MARKER_DELETED,
        userId,
        { markerId, dayId },
        trip.id,
      ),
    );
  }

  /** Sets the order of a day's markers; the IDs must be exactly the day's (visible) markers. */
  async reorder(
    userId: string,
    dayId: string,
    markerIds: string[],
  ): Promise<string[]> {
    const { trip } = await this.access.assertForDay(
      userId,
      dayId,
      'edit_content',
    );
    const ordered = await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, trip.id);
      await assertDayInTrip(tx, dayId, trip.id);
      const markers = await tx.marker.findMany({
        where: { dayId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true, hiddenAt: true },
      });
      const visible = markers.filter((m) => !m.hiddenAt).map((m) => m.id);
      const requested = new Set(markerIds);
      if (
        requested.size !== markerIds.length ||
        requested.size !== visible.length ||
        visible.some((id) => !requested.has(id))
      ) {
        throw AppException.validation({ markerIds: ['mustMatchDayMarkers'] });
      }
      // Moderated (hidden) markers keep their relative order after the visible ones.
      const final = [
        ...markerIds,
        ...markers.filter((m) => m.hiddenAt).map((m) => m.id),
      ];
      for (const [position, id] of final.entries()) {
        await tx.marker.update({ where: { id }, data: { position } });
      }
      await touchTrip(tx, trip.id);
      return markerIds;
    });
    this.events.emit(
      DomainEvents.MARKERS_REORDERED,
      domainEvent(
        DomainEvents.MARKERS_REORDERED,
        userId,
        { dayId, markerIds: ordered },
        trip.id,
      ),
    );
    return ordered;
  }

  private async toVisibleDto(
    userId: string,
    marker: MarkerWithCreator,
  ): Promise<MarkerDto> {
    const people = [marker.createdById, marker.coverPhoto?.uploaderId].filter(
      (id): id is string => !!id,
    );
    const hidden = await this.blocks.blockedAmong(userId, people);
    return toMarkerDto(marker, this.storage, hidden);
  }
}

function toPlaceInput(input: CreateMarkerDto): PlaceInput {
  if (input.placeId && input.location) {
    throw AppException.validation({ location: ['notWithPlaceId'] });
  }
  if (input.placeId) {
    if (input.osmType || input.osmId) {
      throw AppException.validation({ osmId: ['notWithPlaceId'] });
    }
    return { placeId: input.placeId };
  }
  // DTO validation guarantees name and location here.
  return {
    name: input.name!,
    lat: input.location!.lat,
    lng: input.location!.lng,
    category: input.category,
    osm:
      input.osmType && input.osmId
        ? { type: input.osmType, id: BigInt(input.osmId) }
        : undefined,
  };
}

async function assertDayInTrip(
  tx: Tx,
  dayId: string,
  tripId: string,
  field?: string,
): Promise<void> {
  const day = await tx.tripDay.findUnique({
    where: { id: dayId },
    select: { tripId: true },
  });
  if (!day || day.tripId !== tripId) {
    throw field
      ? AppException.validation({ [field]: ['notInTrip'] })
      : AppException.notFound();
  }
}

async function touchTrip(tx: Tx, tripId: string): Promise<void> {
  await tx.trip.update({
    where: { id: tripId },
    data: { updatedAt: new Date() },
  });
}
