import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type App, cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../common/config/env';
import {
  parseServiceAccount,
  type PushMessage,
  PushProvider,
  type PushResult,
} from './push.provider';

/** FCM error codes meaning the token will never work again. */
const UNREGISTERED = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** FCM through firebase-admin; disabled while FIREBASE_SERVICE_ACCOUNT_JSON is unset. */
@Injectable()
export class FcmPushProvider extends PushProvider implements OnModuleDestroy {
  private readonly logger = new Logger(FcmPushProvider.name);
  private readonly app?: App;
  private readonly messaging?: Messaging;

  constructor(config: ConfigService<Env, true>) {
    super();
    const raw = config.get('FIREBASE_SERVICE_ACCOUNT_JSON', { infer: true });
    const account = raw ? parseServiceAccount(raw) : undefined;
    if (account) {
      // A unique app name, so several Nest contexts in one process (tests) don't collide.
      this.app = initializeApp({ credential: cert(account) }, randomUUID());
      this.messaging = getMessaging(this.app);
    }
  }

  get enabled(): boolean {
    return this.messaging !== undefined;
  }

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    if (!this.messaging || messages.length === 0) return [];
    const response = await this.messaging.sendEach(
      messages.map((message) => ({
        token: message.token,
        notification: { title: message.title, body: message.body },
        data: message.data,
        android: { priority: 'high' as const },
        apns: { payload: { aps: { sound: 'default' } } },
      })),
    );
    return response.responses.map((result, index) => {
      const code = result.error?.code;
      if (code && !UNREGISTERED.has(code)) {
        this.logger.warn(`FCM send failed: ${code}`);
      }
      return {
        token: messages[index].token,
        ok: result.success,
        unregistered: code !== undefined && UNREGISTERED.has(code),
      };
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.app) await deleteApp(this.app);
  }
}
