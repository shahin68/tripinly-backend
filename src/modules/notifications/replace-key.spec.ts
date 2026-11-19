import { replaceKeyFor } from './notification-types';

describe('replaceKeyFor', () => {
  it('lets the pushes of one group replace each other, within 64 characters', () => {
    const groupKey = `likes:photo:${'a'.repeat(36)}:${'b'.repeat(36)}`;
    const first = replaceKeyFor({ id: 'n1', groupKey });
    expect(replaceKeyFor({ id: 'n2', groupKey })).toBe(first);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(replaceKeyFor({ id: 'n3', groupKey: `${groupKey}x` })).not.toBe(
      first,
    );
  });

  it('replaces nothing for a single notification', () => {
    expect(replaceKeyFor({ id: 'n1', groupKey: null })).toBe('n1');
  });
});
