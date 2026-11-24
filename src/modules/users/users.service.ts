import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Redis } from 'ioredis';
import { AppException } from '../../common/errors/app.exception';
import { DomainEvents, domainEvent } from '../../common/events/domain-events';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  toPage,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';
import { StorageService } from '../../common/storage/storage.service';
import { Prisma, type User } from '../../generated/prisma/client';
import { EntitlementService } from '../billing/entitlement.service';
import { toProStatusDto } from '../billing/billing.dto';
import { ConsentsService } from '../consents/consents.service';
import { FollowsService } from './follows.service';
import { BlocksService } from '../moderation/blocks.service';
import { toTripSummaries, tripSummaryInclude } from '../trips/trip.mapper';
import { ageOn, MINIMUM_AGE, parseCalendarDate, toCalendarDate } from './age';
import {
  isReservedUsername,
  isValidUsername,
  normalizeUsername,
  USERNAME_CHANGE_INTERVAL_DAYS,
  USERNAME_HOLD_DAYS,
} from './username';
import {
  toUserSummary,
  USER_SUMMARY_SELECT,
  type UserSummaryRow,
} from './user-summary';
import type { ProfileDto } from './profile.dto';
import {
  type MeDto,
  type SearchUsersQueryDto,
  type UpdateMeDto,
  USER_SEARCH_TOTAL_CAP,
  type UserSearchPageDto,
  type UsernameAvailabilityDto,
} from './users.dto';
import { thumbUrl } from '../photos/photo-keys';

/** "Trips around here" in people search: the Nearby tab's default radius. */
export const PEOPLE_AROUND_RADIUS_METERS = 5000;

type PersonRow = UserSummaryRow & {
  isFollowing: boolean;
  followsMe: boolean;
  followers: number;
  tier: number;
};

/** Where a people page ends: rank tier, follower count and username (unique). */
interface PeopleCursor {
  tier: number;
  followers: number;
  username: string;
}

function encodePeopleCursor(position: PeopleCursor): string {
  return Buffer.from(
    JSON.stringify([position.tier, position.followers, position.username]),
  ).toString('base64url');
}

function decodePeopleCursor(cursor: string): PeopleCursor {
  try {
    const [tier, followers, username] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    ) as unknown[];
    if (
      Number.isInteger(tier) &&
      Number.isInteger(followers) &&
      typeof username === 'string'
    ) {
      return {
        tier: tier as number,
        followers: followers as number,
        username,
      };
    }
  } catch {
    // fall through
  }
  throw AppException.validation({ cursor: ['invalidCursor'] });
}

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consents: ConsentsService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly storage: StorageService,
    private readonly entitlements: EntitlementService,
    private readonly follows: FollowsService,
    private readonly events: EventEmitter2,
  ) {}

  async getMe(userId: string): Promise<MeDto> {
    const user = await this.requireUser(userId);
    return this.toMeDto(user);
  }

  async updateMe(userId: string, input: UpdateMeDto): Promise<MeDto> {
    const user = await this.requireUser(userId);
    const data: Prisma.UserUpdateInput = {};

    if (input.birthDate !== undefined) {
      if (user.onboardedAt) {
        throw AppException.validation({
          birthDate: ['immutableAfterOnboarding'],
        });
      }
      const birthDate = parseCalendarDate(input.birthDate);
      const today = parseCalendarDate(toCalendarDate(new Date()))!;
      if (!birthDate || birthDate > today || ageOn(birthDate, today) > 120) {
        throw AppException.validation({ birthDate: ['isValidBirthDate'] });
      }
      if (ageOn(birthDate, today) < MINIMUM_AGE) {
        // Under-16 sign-ups are rejected and nothing about them is kept.
        await this.deleteRejectedMinor(userId);
        throw new AppException(
          ErrorCode.AGE_REQUIREMENT_NOT_MET,
          HttpStatus.UNPROCESSABLE_ENTITY,
          { minimumAge: MINIMUM_AGE },
        );
      }
      data.birthDate = birthDate;
    }

    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.locale !== undefined) data.locale = input.locale;
    if (input.defaultTripVisibility !== undefined) {
      data.defaultTripVisibility = input.defaultTripVisibility;
    }

    let freedUsername: string | undefined;
    if (input.username !== undefined) {
      const username = normalizeUsername(input.username);
      if (username !== user.username) {
        await this.assertUsernameAvailable(username);
        if (user.onboardedAt && user.username) {
          const lastChange = user.usernameChangedAt ?? user.onboardedAt;
          const availableAt = new Date(
            lastChange.getTime() + USERNAME_CHANGE_INTERVAL_DAYS * DAY_MS,
          );
          if (availableAt > new Date()) {
            throw new AppException(
              ErrorCode.USERNAME_CHANGE_TOO_SOON,
              HttpStatus.UNPROCESSABLE_ENTITY,
              { availableAt: availableAt.toISOString() },
            );
          }
          data.usernameChangedAt = new Date();
          freedUsername = user.username;
        }
        data.username = username;
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data });
        if (freedUsername) {
          await tx.usernameHold.upsert({
            where: { username: freedUsername },
            create: {
              username: freedUsername,
              releasedAt: new Date(Date.now() + USERNAME_HOLD_DAYS * DAY_MS),
            },
            update: {
              releasedAt: new Date(Date.now() + USERNAME_HOLD_DAYS * DAY_MS),
            },
          });
        }
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppException(ErrorCode.USERNAME_TAKEN, HttpStatus.CONFLICT);
      }
      throw error;
    }

    await this.completeOnboardingIfReady(userId);
    this.meChanged(userId);
    return this.getMe(userId);
  }

  async checkUsername(
    userId: string,
    raw: string,
  ): Promise<UsernameAvailabilityDto> {
    const username = normalizeUsername(raw);
    if (!isValidUsername(username)) {
      return { username, available: false, reason: 'invalid' };
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    if (user?.username === username) return { username, available: true };
    const available = await this.isUsernameFree(username);
    return available
      ? { username, available: true }
      : { username, available: false, reason: 'taken' };
  }

  /**
   * People search and the people row on Nearby: onboarded, active users whose
   * username or display name starts with q (everyone without q), never the
   * caller or anyone with a block either way. Ranked friends first, then
   * follows either way, then (with a point) people with a visible stop of a
   * public, visible trip of theirs within PEOPLE_AROUND_RADIUS_METERS, then
   * the most followed, then by username. The point is used for this query
   * only and never stored or logged.
   */
  async search(
    userId: string,
    query: SearchUsersQueryDto,
  ): Promise<UserSearchPageDto> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const after = query.cursor ? decodePeopleCursor(query.cursor) : null;
    const prefix = query.q?.trim();
    const like = (text: string) => text.replace(/[\\%_]/g, '\\$&') + '%';
    const matches = prefix
      ? Prisma.sql`AND (u.username LIKE ${like(normalizeUsername(prefix))}
          OR u."displayName" ILIKE ${like(prefix)})`
      : Prisma.empty;
    const visible = Prisma.sql`u.id <> ${userId}::uuid AND u.status = 'active'
      AND u."onboardedAt" IS NOT NULL ${matches}
      AND NOT EXISTS (SELECT 1 FROM blocks b
        WHERE (b."blockerId" = u.id AND b."blockedId" = ${userId}::uuid)
           OR (b."blockerId" = ${userId}::uuid AND b."blockedId" = u.id))`;
    const near =
      query.lat !== undefined && query.lng !== undefined
        ? Prisma.sql`EXISTS (SELECT 1 FROM trips t JOIN markers m ON m."tripId" = t.id
            WHERE t."ownerId" = u.id AND t.visibility = 'public' AND t."hiddenAt" IS NULL
              AND m."hiddenAt" IS NULL
              AND ST_DWithin(m.location, ST_SetSRID(ST_MakePoint(${query.lng}, ${query.lat}), 4326)::geography, ${PEOPLE_AROUND_RADIUS_METERS}))`
        : Prisma.sql`false`;
    const position = after
      ? Prisma.sql`(tier > ${after.tier} OR (tier = ${after.tier} AND followers < ${after.followers})
          OR (tier = ${after.tier} AND followers = ${after.followers} AND username > ${after.username}))`
      : Prisma.sql`true`;
    const [rows, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<PersonRow[]>`
        SELECT * FROM (
          SELECT id, username, "displayName", "avatarPhotoId", "isFollowing", "followsMe", followers,
            CASE WHEN "isFollowing" AND "followsMe" THEN 0
                 WHEN "isFollowing" OR "followsMe" THEN 1
                 WHEN near THEN 2 ELSE 3 END AS tier
          FROM (
            SELECT u.id, u.username, u."displayName", u."avatarPhotoId",
              EXISTS (SELECT 1 FROM follows f WHERE f."followerId" = ${userId}::uuid AND f."followeeId" = u.id) AS "isFollowing",
              EXISTS (SELECT 1 FROM follows f WHERE f."followerId" = u.id AND f."followeeId" = ${userId}::uuid) AS "followsMe",
              (SELECT count(*)::int FROM follows f JOIN users fu ON fu.id = f."followerId"
                WHERE f."followeeId" = u.id AND fu.status = 'active') AS followers,
              ${near} AS near
            FROM users u
            WHERE ${visible}
          ) person
        ) ranked
        WHERE ${position}
        ORDER BY tier, followers DESC, username
        LIMIT ${limit + 1}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM (
          SELECT 1 FROM users u WHERE ${visible} LIMIT ${USER_SEARCH_TOTAL_CAP}
        ) capped`,
    ]);
    const kept = rows.slice(0, limit);
    const last = kept[kept.length - 1];
    return {
      items: kept.map((row) =>
        Object.assign(toUserSummary(row, this.storage), {
          isFriend: row.tier === 0,
          isFollowing: row.isFollowing,
          followsMe: row.followsMe,
        }),
      ),
      total,
      nextCursor:
        rows.length > limit && last
          ? encodePeopleCursor({
              tier: last.tier,
              followers: last.followers,
              username: last.username ?? '',
            })
          : null,
    };
  }

  /**
   * A public profile: the user and their public, visible trips (my own
   * profile: all trips I own, private ones too). Unknown, not onboarded,
   * suspended, or with a block either way → NOT_FOUND.
   */
  async profile(
    viewerId: string,
    username: string,
    cursor?: string,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<ProfileDto> {
    const user = await this.prisma.user.findFirst({
      where: {
        username: normalizeUsername(username),
        status: 'active',
        onboardedAt: { not: null },
        ...BlocksService.notBlockedWith(viewerId),
      },
      select: USER_SUMMARY_SELECT,
    });
    if (!user) throw AppException.notFound();

    const publicTrips: Prisma.TripWhereInput = {
      ownerId: user.id,
      visibility: 'public',
      hiddenAt: null,
    };
    // My own profile lists my private trips too; the count stays public trips.
    const where: Prisma.TripWhereInput =
      user.id === viewerId ? { ownerId: user.id, hiddenAt: null } : publicTrips;
    const position = cursor ? decodeCursor(cursor) : undefined;
    const [publicTripCount, followState, rows] = await Promise.all([
      this.prisma.trip.count({ where: publicTrips }),
      this.follows.stateFor(viewerId, user.id),
      this.prisma.trip.findMany({
        where: {
          ...where,
          ...(position && {
            OR: [
              { updatedAt: { lt: new Date(position.at) } },
              { updatedAt: new Date(position.at), id: { lt: position.id } },
            ],
          }),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: tripSummaryInclude(viewerId),
      }),
    ]);
    const dtos = await toTripSummaries(
      this.prisma,
      this.storage,
      viewerId,
      rows,
    );
    const byId = new Map(dtos.map((dto) => [dto.id, dto]));
    const page = toPage(
      rows,
      limit,
      (row) => ({ at: row.updatedAt.toISOString(), id: row.id }),
      (row) => byId.get(row.id)!,
    );
    return {
      user: toUserSummary(user, this.storage),
      ...followState,
      publicTripCount,
      trips: page.items,
      nextCursor: page.nextCursor,
    };
  }

  /** Sets onboardedAt once the profile is complete and required consents are given. */
  async completeOnboardingIfReady(userId: string): Promise<boolean> {
    const user = await this.requireUser(userId);
    if (user.onboardedAt) return true;
    if (missingProfileFields(user).length > 0) return false;
    if ((await this.consents.missingRequired(userId)).length > 0) return false;
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, onboardedAt: null },
      data: { onboardedAt: new Date() },
    });
    if (count > 0) this.meChanged(userId);
    return true;
  }

  /** My other devices hear that GET /me answers something new (`me.changed`). */
  meChanged(userId: string): void {
    this.events.emit(
      DomainEvents.ME_CHANGED,
      domainEvent(DomainEvents.ME_CHANGED, userId, {}),
    );
  }

  private async assertUsernameAvailable(username: string): Promise<void> {
    if (!isValidUsername(username)) {
      throw new AppException(
        ErrorCode.USERNAME_INVALID,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (!(await this.isUsernameFree(username))) {
      throw new AppException(ErrorCode.USERNAME_TAKEN, HttpStatus.CONFLICT);
    }
  }

  /** Not reserved, not held after a deletion or handle change, not in use. */
  private async isUsernameFree(username: string): Promise<boolean> {
    if (isReservedUsername(username)) return false;
    const [taken, hold] = await Promise.all([
      this.prisma.user.findUnique({
        where: { username },
        select: { id: true },
      }),
      this.prisma.usernameHold.findUnique({ where: { username } }),
    ]);
    return !taken && !(hold && hold.releasedAt > new Date());
  }

  private async deleteRejectedMinor(userId: string): Promise<void> {
    await this.prisma.user.delete({ where: { id: userId } });
    await this.redis.del(`consents:ok:${userId}`).catch(() => undefined);
    this.logger.log('Rejected an under-age sign-up and deleted the account');
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status === 'deleting') {
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
      );
    }
    return user;
  }

  private async toMeDto(user: User): Promise<MeDto> {
    const missingConsents = await this.consents.missingRequired(user.id);
    const missingFields = missingProfileFields(user);
    const pro = toProStatusDto(await this.entitlements.status(user.id));
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarPhotoId: user.avatarPhotoId,
      avatarThumbUrl: thumbUrl(this.storage, user.avatarPhotoId),
      birthDate: user.birthDate ? toCalendarDate(user.birthDate) : null,
      locale: user.locale,
      defaultTripVisibility: user.defaultTripVisibility,
      role: user.role,
      onboarding: {
        completed:
          user.onboardedAt !== null &&
          missingFields.length === 0 &&
          missingConsents.length === 0,
        missingProfileFields: missingFields,
        missingConsents,
      },
      entitlements: pro.entitlements,
      proExpiresAt: pro.proExpiresAt,
    };
  }
}

export function missingProfileFields(
  user: Pick<User, 'username' | 'displayName' | 'birthDate'>,
): ('username' | 'displayName' | 'birthDate')[] {
  const missing: ('username' | 'displayName' | 'birthDate')[] = [];
  if (!user.username) missing.push('username');
  if (!user.displayName) missing.push('displayName');
  if (!user.birthDate) missing.push('birthDate');
  return missing;
}
