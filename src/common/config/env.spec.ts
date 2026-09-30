import { EnvValidationError, validateEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('validateEnv', () => {
  it('applies defaults', () => {
    expect(validateEnv(valid)).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      CONSENT_PROOF_RETENTION_YEARS: 5,
    });
  });

  it('treats empty optional values as unset and parses flags', () => {
    const env = validateEnv({
      ...valid,
      GOOGLE_CLIENT_IDS: ' ',
      DEV_AUTH_ENABLED: 'true',
    });
    expect(env.GOOGLE_CLIENT_IDS).toBeUndefined();
    expect(env.DEV_AUTH_ENABLED).toBe(true);
  });

  it('requires Apple settings together', () => {
    expect(() => validateEnv({ ...valid, APPLE_TEAM_ID: 'TEAM' })).toThrow(
      /APPLE_BUNDLE_ID/,
    );
  });

  it('refuses dev auth in production', () => {
    expect(() =>
      validateEnv({
        ...valid,
        NODE_ENV: 'production',
        DEV_AUTH_ENABLED: 'true',
      }),
    ).toThrow(/DEV_AUTH_ENABLED/);
  });

  it('rejects a short JWT secret and a wrong-size encryption key', () => {
    expect(() =>
      validateEnv({
        ...valid,
        JWT_ACCESS_SECRET: 'short',
        ENCRYPTION_KEY: 'AAAA',
      }),
    ).toThrow(/JWT_ACCESS_SECRET[\s\S]*ENCRYPTION_KEY/);
  });

  it('coerces numbers from strings', () => {
    expect(validateEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
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
    expect(() => validateEnv({ ...valid, R2_BUCKET: 'photos' })).toThrow(
      EnvValidationError,
    );
    const storage = {
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET: 'photos',
    };
    expect(() => validateEnv({ ...valid, ...storage })).toThrow(
      /R2_ACCOUNT_ID/,
    );
    expect(
      validateEnv({
        ...valid,
        ...storage,
        R2_ENDPOINT: 'http://localhost:9000',
      }).R2_ENDPOINT,
    ).toBe('http://localhost:9000');
    expect(
      validateEnv({ ...valid, R2_ENDPOINT: '' }).R2_ENDPOINT,
    ).toBeUndefined();
  });
});
