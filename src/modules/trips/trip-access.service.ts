import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma, Trip, TripRole } from '../../generated/prisma/client';
import { BlocksService } from '../moderation/blocks.service';

export type TripCapability =
  'view' | 'edit_content' | 'comment' | 'like' | 'manage' | 'copy' | 'leave';

export interface TripAccess {
  trip: Trip;
  /** The caller's membership role, or null for a non-member viewing a public trip. */
  role: TripRole | null;
}

/**
 * The only place trip authorization is decided (see the trip-access skill).
 * A caller who may not view a trip gets NOT_FOUND, never FORBIDDEN, so private
 * trips never reveal that they exist.
 */
@Injectable()
export class TripAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocks: BlocksService,
  ) {}

  async assert(
    userId: string,
    tripId: string,
    capability: TripCapability,
  ): Promise<TripAccess> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: { members: { where: { userId }, select: { role: true } } },
    });
    if (!trip) throw AppException.notFound();
    const { members, ...rest } = trip;
    const access: TripAccess = { trip: rest, role: members[0]?.role ?? null };
    await this.check(userId, access, capability);
    return access;
  }

  /** Resolves the trip from a day, so a client-sent tripId is never trusted. */
  async assertForDay(
    userId: string,
    dayId: string,
    capability: TripCapability,
  ): Promise<TripAccess & { dayId: string; dayPosition: number }> {
    const day = await this.prisma.tripDay.findUnique({
      where: { id: dayId },
      select: { tripId: true, position: true },
    });
    if (!day) throw AppException.notFound();
    const access = await this.assert(userId, day.tripId, capability);
    return { ...access, dayId, dayPosition: day.position };
  }

  async assertForMarker(
    userId: string,
    markerId: string,
    capability: TripCapability,
  ): Promise<TripAccess> {
    const marker = await this.prisma.marker.findUnique({
      where: { id: markerId },
      select: { tripId: true, hiddenAt: true, createdById: true },
    });
    if (!marker) throw AppException.notFound();
    const access = await this.assert(userId, marker.tripId, capability);
    if (
      marker.hiddenAt &&
      marker.createdById !== userId &&
      !(await this.isAdmin(userId))
    ) {
      throw AppException.notFound();
    }
    return access;
  }

  /** `where` for trips the user may see in lists: their own memberships plus visible public trips. */
  visibleTripsWhere(userId: string): Prisma.TripWhereInput {
    return {
      OR: [
        {
          members: { some: { userId } },
          OR: [{ hiddenAt: null }, { ownerId: userId }],
        },
        {
          visibility: 'public',
          hiddenAt: null,
          owner: BlocksService.notBlockedWith(userId),
        },
      ],
    };
  }

  private async check(
    userId: string,
    { trip, role }: TripAccess,
    capability: TripCapability,
  ): Promise<void> {
    const isOwner = role === 'owner';
    const isMember = role !== null;

    // View: members (a hidden trip only to its owner), anyone for a visible public trip,
    // admins always. A block between caller and owner hides the trip entirely.
    let canView: boolean;
    if (isOwner) {
      canView = true;
    } else if (trip.hiddenAt || (!isMember && trip.visibility !== 'public')) {
      canView = await this.isAdmin(userId);
    } else {
      canView = true;
    }
    if (
      canView &&
      !isOwner &&
      (await this.blocks.isBlockedEither(userId, trip.ownerId))
    ) {
      canView = false;
    }
    if (!canView) throw AppException.notFound();

    const allowed: Record<TripCapability, boolean> = {
      view: true,
      edit_content: isMember,
      comment: isMember || trip.visibility === 'public',
      like: isMember || trip.visibility === 'public',
      manage: isOwner,
      copy: !isOwner && trip.visibility === 'public',
      leave: role === 'editor',
    };
    if (!allowed[capability]) {
      throw capability === 'copy'
        ? tripNotCopyable()
        : AppException.forbidden();
    }
  }

  private async isAdmin(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return user?.role === 'admin';
  }
}

/** Own trips and private trips can't be copied. */
export function tripNotCopyable(): AppException {
  return new AppException(ErrorCode.TRIP_NOT_COPYABLE, HttpStatus.FORBIDDEN);
}
