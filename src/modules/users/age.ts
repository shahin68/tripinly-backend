export {
  parseCalendarDate,
  toCalendarDate,
} from '../../common/dates/calendar-date';

export const MINIMUM_AGE = 16;

/** Whole years between birth date and today (both calendar dates in UTC). */
export function ageOn(birthDate: Date, today: Date): number {
  let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < birthDate.getUTCMonth() ||
    (today.getUTCMonth() === birthDate.getUTCMonth() &&
      today.getUTCDate() < birthDate.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}
