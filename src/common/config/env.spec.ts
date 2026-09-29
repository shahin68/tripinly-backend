import { EnvValidationError, validateEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
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
});
