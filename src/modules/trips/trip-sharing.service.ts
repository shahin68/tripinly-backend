import { HttpStatus, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
import type { TripJoinRequest } from '../../generated/prisma/client';
import { BlocksService } from '../moderation/blocks.service';
import {
  toUserSummary,
  USER_SUMMARY_SELECT,
  type UserSummaryDto,
} from '../users/user-summary';
import { MembersService } from './members.service';
import { TripAccessService } from './trip-access.service';
import type { JoinRequestDto, TripMemberDto } from './trips.dto';

/**
 * Saving and joining other people's trips (decided 2026-10-16): there is one
 * trip with one owner, never a copy. A saved trip is the live original,
 * read-only; joining makes the person an editor once the owner accepts.
 */
@Injectable()
export class TripSharingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly members: MembersService,
    private readonly events: EventEmitter2,
  ) {}

  /** Idempotent. Only other people's public trips. */
  async save(userId: string, tripId: string): Promise<void> {
    await this.access.assert(userId, tripId, 'save');
    await this.prisma.tripSave.createMany({
      data: [{ tripId, userId }],
      skipDuplicates: true,
    });
  }

  /** Idempotent; works whatever the trip's state now. */
  async unsave(userId: string, tripId: string): Promise<void> {
    await this.prisma.tripSave.deleteMany({ where: { tripId, userId } });
  }

  /**
   * Asks the owner to join as an editor. Repeating a pending request returns
   * it unchanged; a declined request can't be sent again.
   */
  async requestJoin(userId: string, tripId: string): Promise<JoinRequestDto> {
    const { trip } = await this.access.assert(userId, tripId, 'join');
    const { count } = await this.prisma.tripJoinRequest.createMany({
      data: [{ tripId, userId }],
      skipDuplicates: true,
    });
    const request = await this.prisma.tripJoinRequest.findUniqueOrThrow({
      where: { tripId_userId: { tripId, userId } },
    });
    if (request.status === 'declined') throw joinRequestDeclined();
    if (count > 0) {
      this.events.emit(
        DomainEvents.JOIN_REQUESTED,
        domainEvent(
          DomainEvents.JOIN_REQUESTED,
          userId,
          { requestId: request.id, ownerId: trip.ownerId },
          tripId,
        ),
      );
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: USER_SUMMARY_SELECT,
    });
    return toJoinRequestDto(request, toUserSummary(user));
  }

  /** Withdraws my pending request. Idempotent; a declined one stays declined. */
  async cancelJoin(userId: string, tripId: string): Promise<void> {
    await this.prisma.tripJoinRequest.deleteMany({
      where: { tripId, userId, status: 'pending' },
    });
  }

  /** Owner: pending requests, newest first. */
  async listJoinRequests(
    userId: string,
    tripId: string,
    cursor?: string,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<Page<JoinRequestDto>> {
    await this.access.assert(userId, tripId, 'manage');
    const position = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.prisma.tripJoinRequest.findMany({
      where: {
        tripId,
        status: 'pending',
        user: { status: 'active', ...BlocksService.notBlockedWith(userId) },
        ...(position && {
          OR: [
            { createdAt: { lt: new Date(position.at) } },
            { createdAt: new Date(position.at), id: { lt: position.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { user: { select: USER_SUMMARY_SELECT } },
    });
    return toPage(
      rows,
      limit,
      (row) => ({ at: row.createdAt.toISOString(), id: row.id }),
      (row) => toJoinRequestDto(row, toUserSummary(row.user)),
    );
  }

  /**
   * Owner: adds the person as an editor (member limit applies) and removes
   * the request. Their save, if any, goes too: they're in the trip now.
   */
  async accept(userId: string, requestId: string): Promise<TripMemberDto> {
    const request = await this.ownersPendingRequest(userId, requestId);
    const member = await this.members.add(
      userId,
      request.tripId,
      request.userId,
    );
    await this.prisma.$transaction([
      this.prisma.tripJoinRequest.deleteMany({ where: { id: request.id } }),
      this.prisma.tripSave.deleteMany({
        where: { tripId: request.tripId, userId: request.userId },
      }),
    ]);
    return member;
  }

  /** Owner: declines; the person can't ask again. */
  async decline(userId: string, requestId: string): Promise<void> {
    const request = await this.ownersPendingRequest(userId, requestId);
    await this.prisma.tripJoinRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: { status: 'declined', decidedAt: new Date() },
    });
  }

  /**
   * A pending request on a trip the caller owns. Anyone else, and requests
   * from people who are gone or blocked either way, get NOT_FOUND.
   */
  private async ownersPendingRequest(
    userId: string,
    requestId: string,
  ): Promise<TripJoinRequest> {
    const request = await this.prisma.tripJoinRequest.findUnique({
      where: { id: requestId },
      include: { user: { select: { status: true } } },
    });
    if (!request || request.status !== 'pending') {
      throw AppException.notFound();
    }
    const { role } = await this.access.assert(userId, request.tripId, 'view');
    if (role !== 'owner') throw AppException.notFound();
    const blocked = await BlocksService.blockedAmong(this.prisma, userId, [
      request.userId,
    ]);
    if (request.user.status !== 'active' || blocked.size > 0) {
      throw AppException.notFound();
    }
    return request;
  }
}

function toJoinRequestDto(
  request: TripJoinRequest,
  user: UserSummaryDto,
): JoinRequestDto {
  return {
    id: request.id,
    tripId: request.tripId,
    user,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
  };
}

export function joinRequestDeclined(): AppException {
  return new AppException(ErrorCode.JOIN_REQUEST_DECLINED, HttpStatus.CONFLICT);
}
