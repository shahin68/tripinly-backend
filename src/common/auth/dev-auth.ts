import { timingSafeEqual } from 'node:crypto';

/** No secret configured (local) passes; otherwise a constant-time match. */
export function devSecretMatches(
  expected: string | undefined,
  given?: string,
): boolean {
  if (!expected) return true;
  const a = Buffer.from(expected);
  const b = Buffer.from(given ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
