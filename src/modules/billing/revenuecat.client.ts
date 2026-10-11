import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env';

const REVENUECAT_API = 'https://api.revenuecat.com/v1';
const HTTP_TIMEOUT_MS = 10_000;

/** The RevenueCat REST calls the backend makes. The app user id is our user id. */
@Injectable()
export class RevenueCatClient {
  private readonly logger = new Logger(RevenueCatClient.name);
  private readonly apiKey?: string;

  constructor(config: ConfigService<Env, true>) {
    this.apiKey = config.get('REVENUECAT_API_KEY', { infer: true });
  }

  /**
   * Deletes the customer and their purchase history (account deletion).
   * Returns false when not configured. Throws on failure so the job retries;
   * a customer RevenueCat never saw counts as deleted.
   */
  async deleteSubscriber(appUserId: string): Promise<boolean> {
    if (!this.apiKey) {
      this.logger.warn(
        'RevenueCat customer deletion skipped: REVENUECAT_API_KEY is not set',
      );
      return false;
    }
    const response = await fetch(
      `${REVENUECAT_API}/subscribers/${encodeURIComponent(appUserId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`RevenueCat returned ${response.status}`);
    }
    return true;
  }
}
