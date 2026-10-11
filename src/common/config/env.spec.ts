import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnvValidationError, validateEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  APP_JWT_ACCESS_SECRET: 'x'.repeat(32),
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('validateEnv', () => {
  it('applies defaults', () => {
    expect(validateEnv(valid)).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      APP_LOG_LEVEL: 'info',
      APP_CONSENT_PROOF_RETENTION_YEARS: 5,
      APP_PLACES_REFRESH_SECONDS: 300,
      APP_PHOTO_MAX_EDGE_PX: 2560,
      APP_PHOTO_JPEG_QUALITY: 85,
      APP_PHOTO_PARALLEL_UPLOADS: 2,
      APP_PLACE_PHOTO_MIN_OUTSIDE_LIKES: 2,
    });
  });

  it('treats empty optional values as unset and parses flags', () => {
    const env = validateEnv({
      ...valid,
      APP_GOOGLE_CLIENT_IDS: ' ',
      APP_DEV_AUTH_ENABLED: 'true',
    });
    expect(env.APP_GOOGLE_CLIENT_IDS).toBeUndefined();
    expect(env.APP_DEV_AUTH_ENABLED).toBe(true);
  });

  it('falls back to defaults for every blank variable in .env.example', () => {
    const blank = Object.fromEntries(
      readFileSync(join(__dirname, '../../../.env.example'), 'utf8')
        .split('\n')
        .filter((line) => /^[A-Z][A-Z0-9_]*=$/.test(line))
        .map((line) => [line.slice(0, -1), '']),
    );
    expect(Object.keys(blank).length).toBeGreaterThan(30);
    expect(validateEnv({ ...blank, ...valid })).toMatchObject({
      NODE_ENV: 'development',
      APP_DEPLOY_ENV: 'local',
      PORT: 3000,
      APP_DEV_AUTH_ENABLED: false,
    });
  });

  it('still requires secrets left blank', () => {
    expect(() => validateEnv({ ...valid, APP_JWT_ACCESS_SECRET: '' })).toThrow(
      /APP_JWT_ACCESS_SECRET/,
    );
  });

  it('requires Apple settings together', () => {
    expect(() => validateEnv({ ...valid, APP_APPLE_TEAM_ID: 'TEAM' })).toThrow(
      /APP_APPLE_BUNDLE_ID/,
    );
  });

  it('checks the Firebase service account and the email sender', () => {
    const account = {
      project_id: 'tripinly',
      client_email: 'push@tripinly.iam.gserviceaccount.com',
      private_key:
        '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
    };
    expect(
      validateEnv({
        ...valid,
        APP_FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(account),
      }).APP_FIREBASE_SERVICE_ACCOUNT_JSON,
    ).toBeDefined();
    expect(
      validateEnv({
        ...valid,
        APP_FIREBASE_SERVICE_ACCOUNT_JSON: Buffer.from(
          JSON.stringify(account),
        ).toString('base64'),
      }).APP_FIREBASE_SERVICE_ACCOUNT_JSON,
    ).toBeDefined();
    expect(() =>
      validateEnv({
        ...valid,
        APP_FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"x"}',
      }),
    ).toThrow(/APP_FIREBASE_SERVICE_ACCOUNT_JSON/);
    expect(() =>
      validateEnv({ ...valid, APP_RESEND_API_KEY: 're_123' }),
    ).toThrow(/APP_EMAIL_FROM/);
  });

  it('refuses dev auth in production', () => {
    expect(() =>
      validateEnv({
        ...valid,
        NODE_ENV: 'production',
        APP_DEV_AUTH_ENABLED: 'true',
      }),
    ).toThrow(/APP_DEV_AUTH_ENABLED/);
  });

  it('allows dev auth on staging only behind a secret, never on production', () => {
    const staging = {
      ...valid,
      NODE_ENV: 'production',
      APP_DEPLOY_ENV: 'staging',
      APP_DEV_AUTH_ENABLED: 'true',
    };
    expect(() => validateEnv(staging)).toThrow(/APP_DEV_AUTH_SECRET/);
    expect(
      validateEnv({ ...staging, APP_DEV_AUTH_SECRET: 's'.repeat(32) })
        .APP_DEV_AUTH_ENABLED,
    ).toBe(true);
    expect(() =>
      validateEnv({
        ...valid,
        APP_DEPLOY_ENV: 'production',
        APP_DEV_AUTH_ENABLED: 'true',
        APP_DEV_AUTH_SECRET: 's'.repeat(32),
      }),
    ).toThrow(/APP_DEV_AUTH_ENABLED/);
  });

  it('rejects a short JWT secret and a wrong-size encryption key', () => {
    expect(() =>
      validateEnv({
        ...valid,
        APP_JWT_ACCESS_SECRET: 'short',
        APP_ENCRYPTION_KEY: 'AAAA',
      }),
    ).toThrow(/APP_JWT_ACCESS_SECRET[\s\S]*APP_ENCRYPTION_KEY/);
  });

  it('coerces numbers from strings', () => {
    expect(validateEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('needs at least one outside like for place photos', () => {
    expect(
      validateEnv({ ...valid, APP_PLACE_PHOTO_MIN_OUTSIDE_LIKES: '3' })
        .APP_PLACE_PHOTO_MIN_OUTSIDE_LIKES,
    ).toBe(3);
    expect(() =>
      validateEnv({ ...valid, APP_PLACE_PHOTO_MIN_OUTSIDE_LIKES: '0' }),
    ).toThrow(EnvValidationError);
  });

  it('rejects missing and malformed variables, naming them without values', () => {
    const secret = 'mysql://root:hunter2@db/prod';
    let error: unknown;
    try {
      validateEnv({ DATABASE_URL: secret, NODE_ENV: 'staging' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    const message = (error as Error).message;
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('REDIS_URL');
    expect(message).toContain('NODE_ENV');
    expect(message).not.toContain('hunter2');
  });
  it('requires photo storage settings together, with an account or endpoint', () => {
    expect(() => validateEnv({ ...valid, APP_R2_BUCKET: 'photos' })).toThrow(
      EnvValidationError,
    );
    const storage = {
      APP_R2_ACCESS_KEY_ID: 'key',
      APP_R2_SECRET_ACCESS_KEY: 'secret',
      APP_R2_BUCKET: 'photos',
    };
    expect(() => validateEnv({ ...valid, ...storage })).toThrow(
      /APP_R2_ACCOUNT_ID/,
    );
    expect(
      validateEnv({
        ...valid,
        ...storage,
        APP_R2_ENDPOINT: 'http://localhost:9000',
      }).APP_R2_ENDPOINT,
    ).toBe('http://localhost:9000');
    expect(
      validateEnv({ ...valid, APP_R2_ENDPOINT: '' }).APP_R2_ENDPOINT,
    ).toBeUndefined();
  });
});
