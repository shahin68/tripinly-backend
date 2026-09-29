import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env';
import { randomToken, sha256Hex } from '../../common/crypto/crypto';
import { toCalendarDate } from '../../common/dates/calendar-date';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BlocksService } from '../moderation/blocks.service';
import { MembersService } from '../trips/members.service';
import { TripAccessService } from '../trips/trip-access.service';
import { TripLimits } from '../trips/trip-limits';
import { limitReached, TripsService } from '../trips/trips.service';
import type { TripDto } from '../trips/trips.dto';
import { toUserSummary, USER_SUMMARY_SELECT } from '../users/user-summary';
import type { InviteDto, InvitePreviewDto, InvitesDto } from './invites.dto';

export const INVITE_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Invite links: a random token (stored hashed) tied to one trip, valid for
 * 7 days, reusable until then, revocable by the owner. Accepting makes the
 * caller an editor.
 */
@Injectable()
export class InvitesService {
  private readonly linkBase: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TripAccessService,
    private readonly members: MembersService,
    private readonly trips: TripsService,
    private readonly blocks: BlocksService,
    config: ConfigService<Env, true>,
  ) {
    this.linkBase = config
      .get('APP_LINK_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  async create(userId: string, tripId: string): Promise<InviteDto> {
    await this.access.assert(userId, tripId, 'manage');
    const active = await this.prisma.tripInvite.count({
      where: { tripId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (active >= TripLimits.ACTIVE_INVITES_PER_TRIP) {
      throw limitReached('invites', TripLimits.ACTIVE_INVITES_PER_TRIP);
    }
    const token = randomToken();
    const invite = await this.prisma.tripInvite.create({
      data: {
        tripId,
        tokenHash: sha256Hex(token),
        createdById: userId,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * DAY_MS),
      },
    });
    return {
      id: invite.id,
      url: `${this.linkBase}/invites/${token}`,
      token,
      expiresAt: invite.expiresAt.toISOString(),
      createdAt: invite.createdAt.toISOString(),
    };
  }

  async listActive(userId: string, tripId: string): Promise<InvitesDto> {
    await this.access.assert(userId, tripId, 'manage');
    const invites = await this.prisma.tripInvite.findMany({
      where: { tripId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      items: invites.map((invite) => ({
        id: invite.id,
        expiresAt: invite.expiresAt.toISOString(),
        createdAt: invite.createdAt.toISOString(),
      })),
    };
  }

  async revoke(
    userId: string,
    tripId: string,
    inviteId: string,
  ): Promise<void> {
    await this.access.assert(userId, tripId, 'manage');
    const { count } = await this.prisma.tripInvite.updateMany({
      where: { id: inviteId, tripId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) {
      const exists = await this.prisma.tripInvite.count({
        where: { id: inviteId, tripId },
      });
      if (!exists) throw AppException.notFound();
    }
  }

  async preview(userId: string, token: string): Promise<InvitePreviewDto> {
    const invite = await this.findUsable(userId, token);
    const { trip } = invite;
    return {
      tripId: trip.id,
      title: trip.title,
      owner: toUserSummary(trip.owner),
      startDate: trip.startDate ? toCalendarDate(trip.startDate) : null,
      endDate: trip.endDate ? toCalendarDate(trip.endDate) : null,
      expiresAt: invite.expiresAt.toISOString(),
      alreadyMember: trip.members.length > 0,
    };
  }

  async accept(userId: string, token: string): Promise<TripDto> {
    const invite = await this.findUsable(userId, token);
    await this.members.add(userId, invite.tripId, userId, invite.createdById);
    return this.trips.get(userId, invite.tripId);
  }

  /**
   * Unknown tokens and trips hidden from the caller (a block with the owner, or
   * a moderated trip) are NOT_FOUND; expired or revoked ones are INVITE_EXPIRED.
   */
  private async findUsable(userId: string, token: string) {
    const invite = await this.prisma.tripInvite.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: {
        trip: {
          include: {
            owner: { select: USER_SUMMARY_SELECT },
            members: { where: { userId }, select: { role: true } },
          },
        },
      },
    });
    if (!invite) throw AppException.notFound();
    if (
      invite.trip.hiddenAt ||
      (await this.blocks.isBlockedEither(userId, invite.trip.ownerId))
    ) {
      throw AppException.notFound();
    }
    if (invite.revokedAt || invite.expiresAt <= new Date()) {
      throw new AppException(ErrorCode.INVITE_EXPIRED, HttpStatus.GONE);
    }
    return invite;
  }
}
