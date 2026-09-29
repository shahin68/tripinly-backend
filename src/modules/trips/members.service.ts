import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BlocksService, userBlockedError } from '../moderation/blocks.service';
import { toUserSummary, USER_SUMMARY_SELECT } from '../users/user-summary';
import { normalizeUsername } from '../users/username';
import { TripAccessService } from './trip-access.service';
import { TripLimits } from './trip-limits';
import { limitReached, lockTrip } from './trips.service';
import type { TripMemberDto } from './trips.dto';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly blocks: BlocksService,
    private readonly events: EventEmitter2,
  ) {}

  /** Owner adds an editor by username. Idempotent for existing members. */
  async addByUsername(
    userId: string,
    tripId: string,
    username: string,
  ): Promise<TripMemberDto> {
    await this.access.assert(userId, tripId, 'manage');
    const target = await this.prisma.user.findFirst({
      where: {
        username: normalizeUsername(username),
        onboardedAt: { not: null },
        status: 'active',
      },
      select: USER_SUMMARY_SELECT,
    });
    if (!target) throw AppException.notFound();
    if (
      target.id !== userId &&
      (await this.blocks.isBlockedEither(userId, target.id))
    ) {
      // Say "blocked" only to the person who blocked; otherwise the user just isn't found.
      const iBlocked = await this.prisma.block.count({
        where: { blockerId: userId, blockedId: target.id },
      });
      throw iBlocked ? userBlockedError() : AppException.notFound();
    }
    return this.add(userId, tripId, target.id);
  }

  /**
   * Adds `memberId` as an editor (invite acceptance and add-by-username).
   * Access checks are the caller's job.
   */
  async add(
    actorId: string,
    tripId: string,
    memberId: string,
    addedById: string = actorId,
  ): Promise<TripMemberDto> {
    const { member, created } = await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, tripId);
      const existing = await tx.tripMember.findUnique({
        where: { tripId_userId: { tripId, userId: memberId } },
        include: { user: { select: USER_SUMMARY_SELECT } },
      });
      if (existing) return { member: existing, created: false };
      const count = await tx.tripMember.count({ where: { tripId } });
      if (count >= TripLimits.MEMBERS_PER_TRIP) {
        throw limitReached('members', TripLimits.MEMBERS_PER_TRIP);
      }
      const member = await tx.tripMember.create({
        data: { tripId, userId: memberId, role: 'editor', addedById },
        include: { user: { select: USER_SUMMARY_SELECT } },
      });
      return { member, created: true };
    });
    const dto: TripMemberDto = {
      user: toUserSummary(member.user),
      role: member.role,
    };
    if (created) {
      this.events.emit(
        DomainEvents.MEMBER_ADDED,
        domainEvent(
          DomainEvents.MEMBER_ADDED,
          actorId,
          { member: dto },
          tripId,
        ),
      );
    }
    return dto;
  }

  /** Owner removes an editor, or an editor leaves. The owner can't be removed. */
  async remove(
    userId: string,
    tripId: string,
    memberId: string,
  ): Promise<void> {
    await this.access.assert(
      userId,
      tripId,
      memberId === userId ? 'leave' : 'manage',
    );
    const member = await this.prisma.tripMember.findUnique({
      where: { tripId_userId: { tripId, userId: memberId } },
    });
    if (!member) throw AppException.notFound();
    if (member.role === 'owner') throw AppException.forbidden();
    await this.prisma.tripMember.delete({ where: { id: member.id } });
    this.events.emit(
      DomainEvents.MEMBER_REMOVED,
      domainEvent(
        DomainEvents.MEMBER_REMOVED,
        userId,
        { userId: memberId, reason: memberId === userId ? 'left' : 'removed' },
        tripId,
      ),
    );
  }
}
