import { z } from 'zod';
import { parseServiceAccount } from '../../modules/notifications/push.provider';

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
    /** Which deployment this is; only `staging` may enable dev sign-in in production mode. */
    DEPLOY_ENV: z.enum(['local', 'staging', 'production']).default('local'),
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

    // App settings sent to the clients by GET /v1/app-config, so they change
    // without an app update (docs/knowledge/04-api-spec.md).
    /** How old a map square's places may get before the app reloads them in the background. */
    APP_PLACES_REFRESH_SECONDS: z.coerce.number().int().min(10).default(300),
    /** Longest edge the app shrinks a photo to before uploading it. */
    APP_PHOTO_MAX_EDGE_PX: z.coerce
      .number()
      .int()
      .min(1024)
      .max(4096)
      .default(2560),
    /** JPEG quality the app encodes photos with. */
    APP_PHOTO_JPEG_QUALITY: z.coerce
      .number()
      .int()
      .min(50)
      .max(100)
      .default(85),
    /** Photos the app uploads at the same time. */
    APP_PHOTO_PARALLEL_UPLOADS: z.coerce
      .number()
      .int()
      .min(1)
      .max(4)
      .default(2),
    /** Prominence from which a place gets the largest map pin. */
    APP_PIN_LARGE_MIN_PROMINENCE: z.coerce
      .number()
      .int()
      .min(0)
      .max(100)
      .default(95),
    /** Prominence from which a place gets the middle-sized map pin. */
    APP_PIN_MEDIUM_MIN_PROMINENCE: z.coerce
      .number()
      .int()
      .min(0)
      .max(100)
      .default(60),
    /** Most place pins the app draws on the map at once, the best known and most liked first. */
    APP_MAP_MAX_PINS: z.coerce.number().int().min(20).max(1000).default(150),

    /** Most people in one trip, owner included. Owners add friends in bulk, so this is the only cap. */
    APP_TRIP_MAX_MEMBERS: z.coerce.number().int().min(2).default(50),

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
    /**
     * People outside a trip (not the uploader, owner or members) who must like
     * a photo before it can represent a place (cover, place detail photos).
     */
    APP_PLACE_PHOTO_MIN_OUTSIDE_LIKES: z.coerce
      .number()
      .int()
      .min(1)
      .default(2),
    /**
     * Likes (popularity) a place needs before it ranks on the map by its likes,
     * ahead of every unliked place; below it, prominence (QRank) ranks it.
     */
    APP_PLACE_RANK_MIN_LIKES: z.coerce.number().int().min(1).default(1),
    /** Place photos one person may add in 24 hours, across all places. */
    APP_PLACE_PHOTO_DAILY_LIMIT: z.coerce.number().int().min(1).default(20),
    /** Explore's Nearby filter: trips with a stop within this many km of the user. */
    APP_EXPLORE_NEARBY_RADIUS_KM: z.coerce.number().min(1).max(500).default(50),
    // Routing: openrouteservice. Without a key, routes are straight lines
    // (degraded) and best route uses straight-line distance.
    ORS_API_KEY: optionalString,
    ORS_BASE_URL: z
      .string()
      .regex(/^https?:\/\/\S+$/, 'must be an http(s) URL')
      // api.openrouteservice.org was shut down on 2026-08-24.
      .default('https://api.heigit.org/openrouteservice'),
    /** Calls per UTC day before falling back (free plan: 2000 directions, 500 matrix). */
    ORS_DIRECTIONS_DAILY_QUOTA: z.coerce
      .number()
      .int()
      .positive()
      .default(2000),
    ORS_MATRIX_DAILY_QUOTA: z.coerce.number().int().positive().default(500),
    // Push: the Firebase service account JSON (raw or base64). Pushes are
    // skipped while unset; in-app notifications still work.
    FIREBASE_SERVICE_ACCOUNT_JSON: optionalString,
    // Email: Resend. Emails are skipped (with a warning) while unset.
    RESEND_API_KEY: optionalString,
    /** Sender, e.g. "Tripinly <no-reply@mail.tripinly.app>" on a domain verified in Resend. */
    EMAIL_FROM: optionalString,
    /** RevenueCat secret API key (v1). Account deletion deletes the customer; skipped while unset. */
    REVENUECAT_API_KEY: optionalString,
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
    /** QRank (Wikidata items ranked by Wikipedia page views, CC0), read by every OSM import. */
    QRANK_URL: z
      .string()
      .regex(/^https?:\/\/\S+$/, 'must be an http(s) URL')
      .default('https://qrank.toolforge.org/download/qrank.csv.gz'),
    /**
     * The worker copies Wikimedia Commons images of places into storage (daily
     * sync, weekly recheck) only when true; it also needs storage configured.
     */
    PLACE_IMAGES_SYNC_ENABLED: booleanFlag,
    /** Scratch space for downloads (a few GB per region). Defaults to the OS temp dir. */
    OSM_IMPORT_TMP_DIR: optionalString,
    /** Enables POST /v1/auth/dev for local development and staging. Refused in production. */
    DEV_AUTH_ENABLED: booleanFlag,
    /** Staging: dev sign-in also needs this value in the X-Dev-Auth-Secret header. */
    DEV_AUTH_SECRET: optionalString,
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
    if (
      env.FIREBASE_SERVICE_ACCOUNT_JSON &&
      !parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['FIREBASE_SERVICE_ACCOUNT_JSON'],
        message:
          'must be the service account JSON (project_id, client_email, private_key), raw or base64',
      });
    }
    if (env.RESEND_API_KEY && !env.EMAIL_FROM) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_FROM'],
        message: 'set EMAIL_FROM together with RESEND_API_KEY',
      });
    }
    // Dev sign-in: local freely; staging only behind a shared secret; never production.
    const staging = env.DEPLOY_ENV === 'staging';
    const production =
      env.DEPLOY_ENV === 'production' ||
      (env.NODE_ENV === 'production' && !staging);
    if (env.DEV_AUTH_ENABLED && production) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_AUTH_ENABLED'],
        message: 'must not be enabled in production',
      });
    }
    if (
      env.DEV_AUTH_ENABLED &&
      staging &&
      (env.DEV_AUTH_SECRET?.length ?? 0) < 32
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_AUTH_SECRET'],
        message: 'set at least 32 characters to enable dev sign-in on staging',
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

/**
 * Used by ConfigModule. Empty values count as unset, so the blank `.env.example`
 * that Railway imports falls back to defaults. Reports variable names only,
 * never their values.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(
    Object.fromEntries(
      Object.entries(raw).filter(
        ([, value]) => !(typeof value === 'string' && value.trim() === ''),
      ),
    ),
  );
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
