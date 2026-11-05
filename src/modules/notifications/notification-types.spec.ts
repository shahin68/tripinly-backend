import { isAboutComments } from './notification-types';

describe('isAboutComments', () => {
  it('is true for new comments and likes on comments only', () => {
    expect(isAboutComments({ type: 'comment_on_marker', payload: {} })).toBe(
      true,
    );
    expect(
      isAboutComments({
        type: 'likes_grouped',
        payload: { targetType: 'comment' },
      }),
    ).toBe(true);
    expect(
      isAboutComments({
        type: 'likes_grouped',
        payload: { targetType: 'photo' },
      }),
    ).toBe(false);
    // Likes rows from before 2026-11-01 say nothing about what was liked.
    expect(isAboutComments({ type: 'likes_grouped', payload: {} })).toBe(false);
    expect(
      isAboutComments({ type: 'trip_changed_by_collaborator', payload: {} }),
    ).toBe(false);
  });
});
