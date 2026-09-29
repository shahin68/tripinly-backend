import { ageOn, parseCalendarDate } from './age';

const d = (value: string) => parseCalendarDate(value)!;

describe('age', () => {
  it('parses only real calendar dates', () => {
    expect(parseCalendarDate('2007-02-29')).toBeNull();
    expect(parseCalendarDate('2008-13-01')).toBeNull();
    expect(parseCalendarDate('2008-1-01')).toBeNull();
    expect(parseCalendarDate('2004-02-29')?.toISOString()).toBe(
      '2004-02-29T00:00:00.000Z',
    );
  });

  it('turns 16 on the birthday, not the day before', () => {
    expect(ageOn(d('2010-09-28'), d('2026-09-27'))).toBe(15);
    expect(ageOn(d('2010-09-28'), d('2026-09-28'))).toBe(16);
  });

  it('handles leap-day birthdays', () => {
    expect(ageOn(d('2004-02-29'), d('2020-02-28'))).toBe(15);
    expect(ageOn(d('2004-02-29'), d('2020-02-29'))).toBe(16);
  });
});
