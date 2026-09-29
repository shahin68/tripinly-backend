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
