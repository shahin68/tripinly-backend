/** Rules from docs/knowledge/02-domain-rules.md → Usernames. */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
export const USERNAME_HOLD_DAYS = 30;
export const USERNAME_CHANGE_INTERVAL_DAYS = 30;

const USERNAME_PATTERN = /^[a-z0-9_](?:[a-z0-9_]|\.(?!\.))*[a-z0-9_]$/;

export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'api',
  'app',
  'help',
  'info',
  'me',
  'moderator',
  'null',
  'official',
  'root',
  'security',
  'settings',
  'staff',
  'support',
  'system',
  'team',
  'tripinly',
  'undefined',
  'www',
]);

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

/** Format only; availability (taken, reserved, held) is checked separately. */
export function isValidUsername(username: string): boolean {
  return (
    username.length >= USERNAME_MIN &&
    username.length <= USERNAME_MAX &&
    USERNAME_PATTERN.test(username)
  );
}

export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.has(username);
}
