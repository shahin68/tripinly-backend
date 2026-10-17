import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { AppException } from '../../common/errors/app.exception';
import { withClientIds } from '../../common/errors/id-conflict';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import type { Prisma } from '../../generated/prisma/client';
import { BlocksService } from '../moderation/blocks.service';
import { PhotoJobsService } from '../photos/photos.queue';
import { recomputePopularity } from '../places/popularity';
import { likedAmong } from '../social/liked';
import {
  PlaceMatchingService,
  type PlaceInput,
} from '../places/place-matching.service';
import { PlacesService } from '../places/places.service';
import { releaseUserPlaces } from '../places/user-places';
import { recountLikes } from '../social/counters.service';
import { TripAccessService } from '../trips/trip-access.service';
import { TripLimits } from '../trips/trip-limits';
import { limitReached, lockTrip } from '../trips/trips.service';
import {
  type CopyMarkerDto,
  type CreateMarkerDto,
  MARKER_INCLUDE,
  type MarkerDto,
  type MarkerWithCreator,
  toMarkerDto,
  type UpdateMarkerDto,
} from './markers.dto';
import { assertConfirmedIfShared, mayDeleteStop } from './stop-deletion';

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
    private readonly placeLookup: PlacesService,
    private readonly blocks: BlocksService,
    private readonly events: EventEmitter2,
    private readonly storage: StorageService,
    private readonly photoJobs: PhotoJobsService,
  ) {}

  async create(
    userId: string,
    dayId: string,
    input: CreateMarkerDto,
    lang: string,
  ): Promise<MarkerDto> {
    const { trip } = await this.access.assertForDay(
      userId,
      dayId,
      'edit_content',
    );
    // A point with no name is named after what's there, before the trip lock.
    const placeInput =
      input.location && input.name === undefined && !input.placeId
        ? await this.placeLookup.placeAt(
            input.location.lat,
            input.location.lng,
            lang,
          )
        : toPlaceInput(input);

    const marker = await withClientIds(input.id !== undefined, () =>
      this.prisma.$transaction(async (tx) => {
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
            id: input.id,
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
        // A user-made place's likes count once a public trip has it.
        await recomputePopularity(tx, [place.id]);
        await touchTrip(tx, trip.id);
        return created;
      }),
    );

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

    const result = await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, trip.id);
      const current = await tx.marker.findUnique({ where: { id: markerId } });
      if (!current) throw AppException.notFound();
      const data: Prisma.MarkerUncheckedUpdateInput = {};
      // The marker's likes count toward its place: moving it moves them.
      let movedPlaces: string[] = [];
      let leftPlaceId: string | null = null;

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
        if (place.id !== current.placeId) leftPlaceId = current.placeId;
        if (place.id !== current.placeId) {
          movedPlaces = [current.placeId, place.id];
        }
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
      await recomputePopularity(tx, movedPlaces);
      await touchTrip(tx, trip.id);
      return { updated, leftPlaceId };
    });
    const marker = result.updated;
    if (result.leftPlaceId)
      await releaseUserPlaces(this.prisma, this.photoJobs, [
        result.leftPlaceId,
      ]);

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

  /**
   * Whoever added the stop, or the trip owner, deletes it with everything on
   * it; with other people's photos, comments or likes on it only when
   * `confirm` (B4, B5). Other editors get 403: they use removeMine.
   */
  async delete(
    userId: string,
    markerId: string,
    confirm = false,
  ): Promise<void> {
    const { trip } = await this.access.assertForMarker(
      userId,
      markerId,
      'edit_content',
    );
    const stop = await this.prisma.marker.findUnique({
      where: { id: markerId },
      select: { createdById: true },
    });
    if (!stop) throw AppException.notFound();
    if (!mayDeleteStop(userId, trip.ownerId, stop)) {
      throw AppException.forbidden();
    }
    await assertConfirmedIfShared(this.prisma, [markerId], userId, confirm);
    if (!(await this.remove(userId, markerId, trip.id))) {
      throw AppException.notFound();
    }
  }

  /**
   * Takes the caller's own photos, comments and likes off a stop; the stop and
   * everyone else's content stay (B4). Anyone who can see the stop may do it.
   * A cover among their photos passes to the next ready, visible photo.
   */
  async removeMine(userId: string, markerId: string): Promise<void> {
    const { trip } = await this.access.assertForMarker(
      userId,
      markerId,
      'view',
    );
    const result = await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, trip.id);
      const marker = await tx.marker.findUnique({
        where: { id: markerId },
        select: { placeId: true, coverPhotoId: true },
      });
      if (!marker) throw AppException.notFound();
      const photos = await tx.photo.findMany({
        where: { markerId, uploaderId: userId },
        select: { id: true },
      });
      const comments = await tx.comment.findMany({
        where: { markerId, authorId: userId },
        select: { id: true },
      });
      const photoIds = photos.map((p) => p.id);
      const commentIds = comments.map((c) => c.id);
      // Their photos' and comments' own likes go with them (likes trigger).
      await tx.photo.deleteMany({ where: { id: { in: photoIds } } });
      await tx.comment.deleteMany({ where: { id: { in: commentIds } } });

      const [otherPhotos, otherComments] = await Promise.all([
        tx.photo.findMany({ where: { markerId }, select: { id: true } }),
        tx.comment.findMany({ where: { markerId }, select: { id: true } }),
      ]);
      const likes = await tx.like.findMany({
        where: {
          userId,
          OR: [
            {
              targetType: 'photo',
              targetId: { in: otherPhotos.map((p) => p.id) },
            },
            {
              targetType: 'comment',
              targetId: { in: otherComments.map((c) => c.id) },
            },
          ],
        },
        select: { id: true, targetType: true, targetId: true },
      });
      await tx.like.deleteMany({
        where: { id: { in: likes.map((like) => like.id) } },
      });
      const unliked = (type: string) =>
        likes.filter((l) => l.targetType === type).map((l) => l.targetId);
      await recountLikes(tx, 'photo', unliked('photo'));
      await recountLikes(tx, 'comment', unliked('comment'));
      await tx.marker.update({
        where: { id: markerId },
        data: { commentCount: otherComments.length },
      });

      let coverPhotoId = marker.coverPhotoId;
      if (coverPhotoId && photoIds.includes(coverPhotoId)) {
        const next = await tx.photo.findFirst({
          where: { markerId, status: 'ready', hiddenAt: null },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          select: { id: true },
        });
        coverPhotoId = next?.id ?? null;
        await tx.marker.update({
          where: { id: markerId },
          data: { coverPhotoId },
        });
      }
      return { photoIds, commentIds, coverPhotoId };
    });

    await this.photoJobs.deleteFiles(result.photoIds);
    const emit = (
      name: (typeof DomainEvents)[keyof typeof DomainEvents],
      data: unknown,
    ) => this.events.emit(name, domainEvent(name, userId, data, trip.id));
    for (const photoId of result.photoIds) {
      emit(DomainEvents.PHOTO_DELETED, {
        photoId,
        markerId,
        coverPhotoId: result.coverPhotoId,
      });
    }
    for (const commentId of result.commentIds) {
      emit(DomainEvents.COMMENT_DELETED, { commentId, markerId });
    }
  }

  /**
   * Deletes a marker without an access check (moderation, and delete above).
   * Returns false when it was already gone.
   */
  async remove(
    actorId: string,
    markerId: string,
    tripId?: string,
  ): Promise<boolean> {
    const tripOf =
      tripId ??
      (
        await this.prisma.marker.findUnique({
          where: { id: markerId },
          select: { tripId: true },
        })
      )?.tripId;
    if (!tripOf) return false;
    const trip = { id: tripOf };
    const result = await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, trip.id);
      const marker = await tx.marker.findUnique({ where: { id: markerId } });
      if (!marker) return null;
      const photos = await tx.photo.findMany({
        where: { markerId },
        select: { id: true },
      });
      await tx.marker.delete({ where: { id: markerId } });
      await recomputePopularity(tx, [marker.placeId]);
      await tx.marker.updateMany({
        where: { dayId: marker.dayId, position: { gt: marker.position } },
        data: { position: { decrement: 1 } },
      });
      await touchTrip(tx, trip.id);
      return {
        dayId: marker.dayId,
        placeId: marker.placeId,
        photoIds: photos.map((p) => p.id),
      };
    });
    if (!result) return false;
    await this.photoJobs.deleteFiles(result.photoIds);
    await releaseUserPlaces(this.prisma, this.photoJobs, [result.placeId]);
    this.events.emit(
      DomainEvents.MARKER_DELETED,
      domainEvent(
        DomainEvents.MARKER_DELETED,
        actorId,
        { markerId, dayId: result.dayId },
        trip.id,
      ),
    );
    return true;
  }

  /**
   * Deletes all of a day's markers in one go ("clear day"). Moderated (hidden)
   * markers stay, as they do for reorder; they move up to fill the gap.
   */
  async clearDay(
    userId: string,
    dayId: string,
    confirm = false,
  ): Promise<void> {
    const { trip } = await this.access.assertForDay(
      userId,
      dayId,
      'edit_content',
    );
    const result = await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, trip.id);
      await assertDayInTrip(tx, dayId, trip.id);
      const markers = await tx.marker.findMany({
        where: { dayId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          placeId: true,
          hiddenAt: true,
          createdById: true,
        },
      });
      const deleted = markers.filter((m) => !m.hiddenAt);
      if (deleted.length === 0) return null;
      // All or nothing: a day with other people's stops is cleared by the trip owner.
      if (deleted.some((m) => !mayDeleteStop(userId, trip.ownerId, m))) {
        throw AppException.forbidden();
      }
      const markerIds = deleted.map((m) => m.id);
      await assertConfirmedIfShared(tx, markerIds, userId, confirm);
      const photos = await tx.photo.findMany({
        where: { markerId: { in: markerIds } },
        select: { id: true },
      });
      await tx.marker.deleteMany({ where: { id: { in: markerIds } } });
      await recomputePopularity(
        tx,
        deleted.map((m) => m.placeId),
      );
      for (const [position, marker] of markers
        .filter((m) => m.hiddenAt)
        .entries()) {
        await tx.marker.update({
          where: { id: marker.id },
          data: { position },
        });
      }
      await touchTrip(tx, trip.id);
      return {
        markerIds,
        placeIds: deleted.map((m) => m.placeId),
        photoIds: photos.map((p) => p.id),
      };
    });
    if (!result) return;
    await this.photoJobs.deleteFiles(result.photoIds);
    await releaseUserPlaces(this.prisma, this.photoJobs, result.placeIds);
    for (const markerId of result.markerIds) {
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
  }

  /**
   * Copies a marker of a public trip (not my own) to a day of a trip I can
   * edit: same name, location, time and place; no photos, comments or likes.
   */
  async copy(
    userId: string,
    markerId: string,
    input: CopyMarkerDto,
  ): Promise<MarkerDto> {
    await this.access.assertForMarker(userId, markerId, 'copy');
    const source = await this.prisma.marker.findUniqueOrThrow({
      where: { id: markerId },
    });
    const { trip } = await this.access.assertForDay(
      userId,
      input.dayId,
      'edit_content',
    );

    const marker = await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, trip.id);
      await assertDayInTrip(tx, input.dayId, trip.id);
      const count = await tx.marker.count({ where: { dayId: input.dayId } });
      if (count >= TripLimits.MARKERS_PER_DAY) {
        throw limitReached('markers', TripLimits.MARKERS_PER_DAY);
      }
      const position = Math.min(input.position ?? count, count);
      await tx.marker.updateMany({
        where: { dayId: input.dayId, position: { gte: position } },
        data: { position: { increment: 1 } },
      });
      const created = await tx.marker.create({
        data: {
          dayId: input.dayId,
          tripId: trip.id,
          placeId: source.placeId,
          name: source.name,
          lat: source.lat,
          lng: source.lng,
          time: source.time,
          position,
          createdById: userId,
          copiedFromMarkerId: source.id,
        },
        include: MARKER_INCLUDE,
      });
      await recomputePopularity(tx, [source.placeId]);
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
    const [hidden, liked] = await Promise.all([
      this.blocks.blockedAmong(userId, people),
      likedAmong(this.prisma, userId, { type: 'place', ids: [marker.placeId] }),
    ]);
    return toMarkerDto(marker, this.storage, hidden, liked);
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
  // DTO validation guarantees location here; create() looks up a missing name.
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
