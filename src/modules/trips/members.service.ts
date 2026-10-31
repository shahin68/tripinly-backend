import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { domainEvent, DomainEvents } from '../../common/events/domain-events';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BlocksService, userBlockedError } from '../moderation/blocks.service';
import { toUserSummary, USER_SUMMARY_SELECT } from '../users/user-summary';
import { normalizeUsername } from '../users/username';
import { TripAccessService } from './trip-access.service';
import { limitReached, lockTrip, TripsService } from './trips.service';
import type { TripMemberDto } from './trips.dto';
import { StorageService } from '../../common/storage/storage.service';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly blocks: BlocksService,
    private readonly events: EventEmitter2,
    private readonly trips: TripsService,
    private readonly storage: StorageService,
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
      if (count >= this.trips.maxMembers()) {
        throw limitReached('members', this.trips.maxMembers());
      }
      const member = await tx.tripMember.create({
        data: { tripId, userId: memberId, role: 'editor', addedById },
        include: { user: { select: USER_SUMMARY_SELECT } },
      });
      return { member, created: true };
    });
    const dto: TripMemberDto = {
      user: toUserSummary(member.user, this.storage),
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

  /**
   * Owner adds several editors at once, all-or-nothing: unknown or blocked
   * usernames fail the whole request with per-entry errors, like trip
   * creation. People already in the trip are kept as they are.
   */
  async addMany(
    userId: string,
    tripId: string,
    usernames: string[],
  ): Promise<TripMemberDto[]> {
    await this.access.assert(userId, tripId, 'manage');
    const ids = await this.trips.resolveUsernames(
      userId,
      usernames,
      'usernames',
    );
    const max = this.trips.maxMembers();
    const { members, createdIds } = await this.prisma.$transaction(
      async (tx) => {
        await lockTrip(tx, tripId);
        const existing = await tx.tripMember.findMany({
          where: { tripId },
          select: { userId: true },
        });
        const present = new Set(existing.map((member) => member.userId));
        const newIds = ids.filter((id) => !present.has(id));
        if (present.size + newIds.length > max) {
          throw limitReached('members', max);
        }
        await tx.tripMember.createMany({
          data: newIds.map((id) => ({
            tripId,
            userId: id,
            role: 'editor' as const,
            addedById: userId,
          })),
        });
        const members = await tx.tripMember.findMany({
          where: { tripId, userId: { in: ids } },
          include: { user: { select: USER_SUMMARY_SELECT } },
        });
        return { members, createdIds: new Set(newIds) };
      },
    );
    const byId = new Map(
      members.map((member) => [
        member.userId,
        { user: toUserSummary(member.user, this.storage), role: member.role },
      ]),
    );
    const dtos = ids.flatMap((id) => byId.get(id) ?? []);
    for (const dto of dtos) {
      if (!createdIds.has(dto.user.id)) continue;
      this.events.emit(
        DomainEvents.MEMBER_ADDED,
        domainEvent(DomainEvents.MEMBER_ADDED, userId, { member: dto }, tripId),
      );
    }
    return dtos;
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
