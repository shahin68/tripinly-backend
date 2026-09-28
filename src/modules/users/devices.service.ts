import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { DevicePlatform } from '../../generated/prisma/client';

export interface DeviceRegistration {
  platform: DevicePlatform;
  locale: string;
}

/** Push devices. An FCM token belongs to whoever registered it last. */
@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async register(
    userId: string,
    fcmToken: string,
    input: DeviceRegistration,
  ): Promise<void> {
    const now = new Date();
    // Upserting by token also moves a shared phone's token to the new account,
    // so the previous user stops receiving pushes on it.
    await this.prisma.device.upsert({
      where: { fcmToken },
      create: { userId, fcmToken, ...input, lastSeenAt: now },
      update: { userId, ...input, lastSeenAt: now },
    });
  }

  /** Removes the device only if it belongs to the user. Idempotent. */
  async remove(userId: string, fcmToken: string): Promise<void> {
    await this.prisma.device.deleteMany({ where: { userId, fcmToken } });
  }
}
