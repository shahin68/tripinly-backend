import { z } from 'zod';

const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const booleanFlag = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

/**
 * Environment variables, validated at startup. The app refuses to boot when one
 * is missing or malformed. Modules add their variables here as they are built
 * (see docs/knowledge/06-architecture-and-infra.md for the full list).
 */
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL'),
    REDIS_URL: z
      .string()
      .regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL'),
    CONSENT_PROOF_RETENTION_YEARS: z.coerce.number().int().min(1).default(5),

    // Auth (docs/knowledge/07-security-and-gdpr.md)
    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).default(60),
    /** 32 random bytes, base64. Encrypts stored Apple refresh tokens. */
    ENCRYPTION_KEY: z
      .string()
      .refine(
        (value) => Buffer.from(value, 'base64').length === 32,
        'must be 32 bytes, base64-encoded',
      ),
    /** Comma-separated OAuth client IDs (iOS, Android, web) accepted as `aud`. Google sign-in is off when unset. */
    GOOGLE_CLIENT_IDS: optionalString,
    APPLE_BUNDLE_ID: optionalString,
    APPLE_TEAM_ID: optionalString,
    APPLE_KEY_ID: optionalString,
    /** The .p8 key contents; literal "\n" sequences are accepted. */
    APPLE_PRIVATE_KEY: optionalString,
    /** Base for invite and share links (App Links / Universal Links domain once there is one). */
    APP_LINK_BASE_URL: z
      .string()
      .regex(
        /^[a-z][a-z0-9+.-]*:\/\/\S+$/,
        'must be a URL such as https://tripinly.app',
      )
      .default('tripinly://app'),
    // Photo storage: Cloudflare R2 (any S3-compatible store; VersityGW locally).
    // Photo endpoints answer 503 while unset.
    R2_ACCOUNT_ID: optionalString,
    /** Overrides the endpoint derived from R2_ACCOUNT_ID, e.g. http://localhost:7070 for the local VersityGW. */
    R2_ENDPOINT: z
      .string()
      .trim()
      .regex(/^https?:\/\/\S+$/, 'must be an http(s) URL')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    R2_ACCESS_KEY_ID: optionalString,
    R2_SECRET_ACCESS_KEY: optionalString,
    R2_BUCKET: optionalString,

    // Places (docs/knowledge/10-maps-places-routing.md)
    /** Photon geocoder for address and city search. Public komoot instance at first, self-hosted later. */
    PHOTON_BASE_URL: z
      .string()
      .regex(/^https?:\/\/\S+$/, 'must be an http(s) URL')
      .default('https://photon.komoot.io'),
    // Routing: openrouteservice. Without a key, routes are straight lines
    // (degraded) and best route uses straight-line distance.
    ORS_API_KEY: optionalString,
    ORS_BASE_URL: z
      .string()
      .regex(/^https?:\/\/\S+$/, 'must be an http(s) URL')
      .default('https://api.openrouteservice.org'),
    /** Calls per UTC day before falling back (free plan: 2000 directions, 500 matrix). */
    ORS_DIRECTIONS_DAILY_QUOTA: z.coerce
      .number()
      .int()
      .positive()
      .default(2000),
    ORS_MATRIX_DAILY_QUOTA: z.coerce.number().int().positive().default(500),
    /** Comma-separated Geofabrik extracts, e.g. europe/austria,europe/hungary. */
    OSM_IMPORT_REGIONS: z
      .string()
      .default('europe/austria,europe/hungary')
      .transform((value) =>
        value
          .split(',')
          .map((region) => region.trim())
          .filter(Boolean),
      )
      .pipe(
        z
          .array(
            z
              .string()
              .regex(
                /^[a-z0-9-]+(\/[a-z0-9-]+)*$/,
                'must be Geofabrik paths such as europe/austria',
              ),
          )
          .min(1),
      ),
    /** The worker schedules imports only when true (they download hundreds of MB). */
    OSM_IMPORT_ENABLED: booleanFlag,
    /** Cron (UTC) for the monthly refresh. */
    OSM_IMPORT_CRON: z.string().trim().min(9).default('0 3 2 * *'),
    GEOFABRIK_BASE_URL: z
      .string()
      .regex(/^https?:\/\/\S+$/, 'must be an http(s) URL')
      .default('https://download.geofabrik.de'),
    /** Scratch space for downloads (a few GB per region). Defaults to the OS temp dir. */
    OSM_IMPORT_TMP_DIR: optionalString,
    /** Enables POST /v1/auth/dev for local development. Refused in production. */
    DEV_AUTH_ENABLED: booleanFlag,
  })
  .superRefine((env, ctx) => {
    const apple = [
      env.APPLE_BUNDLE_ID,
      env.APPLE_TEAM_ID,
      env.APPLE_KEY_ID,
      env.APPLE_PRIVATE_KEY,
    ];
    if (apple.some(Boolean) && !apple.every(Boolean)) {
      ctx.addIssue({
        code: 'custom',
        path: ['APPLE_BUNDLE_ID'],
        message:
          'set all of APPLE_BUNDLE_ID, APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY, or none',
      });
    }
    const storage = [
      env.R2_ACCESS_KEY_ID,
      env.R2_SECRET_ACCESS_KEY,
      env.R2_BUCKET,
    ];
    if (storage.some(Boolean) && !storage.every(Boolean)) {
      ctx.addIssue({
        code: 'custom',
        path: ['R2_BUCKET'],
        message:
          'set all of R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET, or none',
      });
    }
    if (env.R2_BUCKET && !env.R2_ACCOUNT_ID && !env.R2_ENDPOINT) {
      ctx.addIssue({
        code: 'custom',
        path: ['R2_ACCOUNT_ID'],
        message:
          'set R2_ACCOUNT_ID (or R2_ENDPOINT) with the storage credentials',
      });
    }
    if (env.DEV_AUTH_ENABLED && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_AUTH_ENABLED'],
        message: 'must not be enabled in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  ${issues.join('\n  ')}`);
    this.name = 'EnvValidationError';
  }
}

/** Used by ConfigModule. Reports variable names only, never their values. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
