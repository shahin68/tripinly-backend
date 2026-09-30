import type {
  EmailMessage,
  EmailProvider,
} from '../../src/modules/notifications/email/email.provider';
import type {
  PushMessage,
  PushProvider,
  PushResult,
} from '../../src/modules/notifications/push.provider';

/** Records pushes instead of calling FCM. Tokens in `unregistered` fail as FCM would. */
export class FakePushProvider implements PushProvider {
  enabled = true;
  readonly sent: PushMessage[] = [];
  readonly unregistered = new Set<string>();

  send(messages: PushMessage[]): Promise<PushResult[]> {
    this.sent.push(...messages);
    return Promise.resolve(
      messages.map((message) => ({
        token: message.token,
        ok: !this.unregistered.has(message.token),
        unregistered: this.unregistered.has(message.token),
      })),
    );
  }

  to(token: string): PushMessage[] {
    return this.sent.filter((message) => message.token === token);
  }

  reset(): void {
    this.sent.length = 0;
    this.unregistered.clear();
    this.enabled = true;
  }
}

export class FakeEmailProvider implements EmailProvider {
  enabled = true;
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}
