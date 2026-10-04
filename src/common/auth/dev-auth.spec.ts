import { devSecretMatches } from './dev-auth';

describe('devSecretMatches', () => {
  it('passes anything when no secret is configured (local)', () => {
    expect(devSecretMatches(undefined)).toBe(true);
    expect(devSecretMatches(undefined, 'whatever')).toBe(true);
  });

  it('needs the exact secret when one is configured (staging)', () => {
    expect(devSecretMatches('s3cret', 's3cret')).toBe(true);
    expect(devSecretMatches('s3cret', 's3cre')).toBe(false);
    expect(devSecretMatches('s3cret', 'S3CRET')).toBe(false);
    expect(devSecretMatches('s3cret')).toBe(false);
  });
});
