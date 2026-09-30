import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_CODES } from '../errors/error-codes';
import { I18N_PATH, SUPPORTED_LANGUAGES } from './i18n.config';

describe('error translations', () => {
  it.each(SUPPORTED_LANGUAGES)(
    '%s has a non-empty message for every error code',
    (lang) => {
      const messages = JSON.parse(
        readFileSync(join(I18N_PATH, lang, 'errors.json'), 'utf8'),
      ) as Record<string, string>;
      const missing = ERROR_CODES.filter((code) => !messages[code]?.trim());
      expect(missing).toEqual([]);
      expect(Object.keys(messages).sort()).toEqual([...ERROR_CODES].sort());
    },
  );
});

/** Every key path in a translation file, with plural forms as leaves. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe.each(['push', 'email', 'export'])('%s translations', (file) => {
  const read = (lang: string) =>
    JSON.parse(readFileSync(join(I18N_PATH, lang, `${file}.json`), 'utf8'));
  const english = keyPaths(read('en')).sort();

  it.each(SUPPORTED_LANGUAGES)('%s has the same keys as English', (lang) => {
    expect(keyPaths(read(lang)).sort()).toEqual(english);
  });
});
