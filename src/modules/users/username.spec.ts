import {
  isReservedUsername,
  isValidUsername,
  normalizeUsername,
} from './username';

describe('usernames', () => {
  it.each(['abc', 'jonas.k', 'a_b.c_d', 'x'.repeat(30), '_under', 'num8er'])(
    'accepts %s',
    (name) => expect(isValidUsername(name)).toBe(true),
  );

  it.each([
    ['ab', 'too short'],
    ['x'.repeat(31), 'too long'],
    ['.start', 'leading dot'],
    ['end.', 'trailing dot'],
    ['dou..ble', 'consecutive dots'],
    ['Upper', 'uppercase'],
    ['spa ce', 'space'],
    ['emoji😀', 'non-ascii'],
    ['da-sh', 'dash'],
  ])('rejects %s (%s)', (name) => expect(isValidUsername(name)).toBe(false));

  it('normalizes to trimmed lowercase', () => {
    expect(normalizeUsername('  Jonas.K ')).toBe('jonas.k');
  });

  it('knows reserved names', () => {
    expect(isReservedUsername('tripinly')).toBe(true);
    expect(isReservedUsername('jonas')).toBe(false);
  });
});
