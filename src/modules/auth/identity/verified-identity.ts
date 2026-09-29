export interface VerifiedIdentity {
  provider: 'google' | 'apple' | 'dev';
  /** Stable provider user ID (`sub`); the identity key. */
  subject: string;
  email?: string;
  /** Suggested display name from the provider, if it shared one. */
  name?: string;
}
