export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /** String values only (FCM data payload). */
  data: Record<string, string>;
}

export interface PushResult {
  token: string;
  ok: boolean;
  /** FCM says the token is gone for good; delete the device. */
  unregistered: boolean;
}

/** Sends push messages; FCM in production (FcmPushProvider). */
export abstract class PushProvider {
  /** False when no credentials are configured: pushes are skipped, in-app rows still written. */
  abstract readonly enabled: boolean;
  abstract send(messages: PushMessage[]): Promise<PushResult[]>;
}

export interface FirebaseServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/**
 * FIREBASE_SERVICE_ACCOUNT_JSON holds the service account JSON downloaded from the
 * Firebase console, as is or base64-encoded. Returns undefined if it doesn't parse.
 */
export function parseServiceAccount(
  raw: string,
): FirebaseServiceAccount | undefined {
  const text = raw.trim().startsWith('{')
    ? raw
    : Buffer.from(raw, 'base64').toString('utf8');
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const { project_id, client_email, private_key } = json;
    if (
      typeof project_id !== 'string' ||
      typeof client_email !== 'string' ||
      typeof private_key !== 'string'
    ) {
      return undefined;
    }
    return {
      projectId: project_id,
      clientEmail: client_email,
      privateKey: private_key.replace(/\\n/g, '\n'),
    };
  } catch {
    return undefined;
  }
}
