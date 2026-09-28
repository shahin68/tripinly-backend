import { randomBytes } from 'node:crypto';
import { decrypt, encrypt, randomToken, sha256Hex } from './crypto';

describe('crypto helpers', () => {
  const key = randomBytes(32);

  it('round-trips AES-256-GCM with a fresh IV each time', () => {
    const a = encrypt('apple-refresh-token', key);
    const b = encrypt('apple-refresh-token', key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe('apple-refresh-token');
  });

  it('rejects tampered ciphertext and wrong keys', () => {
    const payload = encrypt('secret', key);
    const tampered = Buffer.from(payload, 'base64url');
    tampered[tampered.length - 1] ^= 1;
    expect(() => decrypt(tampered.toString('base64url'), key)).toThrow();
    expect(() => decrypt(payload, randomBytes(32))).toThrow();
  });

  it('produces URL-safe tokens and stable hashes', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
