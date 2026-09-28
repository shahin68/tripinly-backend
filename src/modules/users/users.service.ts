import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';
import { Prisma, type User } from '../../generated/prisma/client';
import { ConsentsService } from '../consents/consents.service';
import { ageOn, MINIMUM_AGE, parseCalendarDate, toCalendarDate } from './age';
import {
  isReservedUsername,
  isValidUsername,
  normalizeUsername,
  USERNAME_CHANGE_INTERVAL_DAYS,
  USERNAME_HOLD_DAYS,
} from './username';
import type { MeDto, UpdateMeDto, UsernameAvailabilityDto } from './users.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consents: ConsentsService,
    @Inject(REDIS) private readonly redis: Redis,
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

  /** Sets onboardedAt once the profile is complete and required consents are given. */
  async completeOnboardingIfReady(userId: string): Promise<boolean> {
    const user = await this.requireUser(userId);
    if (user.onboardedAt) return true;
    if (missingProfileFields(user).length > 0) return false;
    if ((await this.consents.missingRequired(userId)).length > 0) return false;
    await this.prisma.user.updateMany({
      where: { id: userId, onboardedAt: null },
      data: { onboardedAt: new Date() },
    });
    return true;
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
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
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
      // Filled by EntitlementService in the billing stage.
      entitlements: [],
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
