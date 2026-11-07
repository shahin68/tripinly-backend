import { isAboutComments, milestoneReached } from './notification-types';

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

describe('milestoneReached', () => {
  const milestones = [5, 25, 100];

  it('is the count when it is a milestone above the one pushed', () => {
    expect(milestoneReached(5, milestones)).toBe(5);
    expect(milestoneReached(25, milestones, 5)).toBe(25);
  });

  it('is nothing between milestones or for one already pushed', () => {
    expect(milestoneReached(4, milestones)).toBeUndefined();
    expect(milestoneReached(6, milestones)).toBeUndefined();
    expect(milestoneReached(5, milestones, 5)).toBeUndefined();
    expect(milestoneReached(5, milestones, 25)).toBeUndefined();
  });
});
