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
