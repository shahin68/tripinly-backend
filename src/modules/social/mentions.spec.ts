import { mentionedUsernames } from './mentions';

describe('mentionedUsernames', () => {
  it('finds handles after a start, a space or punctuation, lower-cased and once each', () => {
    expect(
      mentionedUsernames('@Anna, see (@jonas.k) and @anna again. Thanks @lea.'),
    ).toEqual(['anna', 'jonas.k', 'lea']);
  });

  it('skips emails, double @ and handles too short', () => {
    expect(mentionedUsernames('mail me@anna.at or @@bob, @ab')).toEqual([]);
  });
});
