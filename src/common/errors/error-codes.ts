/**
 * Stable error codes. Clients switch on these, never on the message text.
 * Keep in sync with "Stable error codes" in docs/knowledge/04-api-spec.md and
 * add a translation for each code to every i18n/<lang>/errors.json.
 */
export const ErrorCode = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  ONBOARDING_INCOMPLETE: 'ONBOARDING_INCOMPLETE',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  AGE_REQUIREMENT_NOT_MET: 'AGE_REQUIREMENT_NOT_MET',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  USERNAME_INVALID: 'USERNAME_INVALID',
  USERNAME_CHANGE_TOO_SOON: 'USERNAME_CHANGE_TOO_SOON',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  TRIP_NOT_COPYABLE: 'TRIP_NOT_COPYABLE',
  USER_BLOCKED: 'USER_BLOCKED',
  INVITE_EXPIRED: 'INVITE_EXPIRED',
  PHOTO_LIMIT_REACHED: 'PHOTO_LIMIT_REACHED',
  /** Days per trip, markers per day, trips per user, active invites; `details.resource` and `details.max`. */
  LIMIT_REACHED: 'LIMIT_REACHED',
  UPLOAD_TOO_LARGE: 'UPLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  PREMIUM_REQUIRED: 'PREMIUM_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  ROUTING_UNAVAILABLE: 'ROUTING_UNAVAILABLE',
  BBOX_TOO_LARGE: 'BBOX_TOO_LARGE',
  /** The Idempotency-Key was already used for a different request (422). */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** The first request with this Idempotency-Key is still running (409). */
  IDEMPOTENCY_KEY_IN_PROGRESS: 'IDEMPOTENCY_KEY_IN_PROGRESS',
  /** A client-chosen `id` on create already exists (409). */
  ID_CONFLICT: 'ID_CONFLICT',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_CODES = Object.values(ErrorCode);
