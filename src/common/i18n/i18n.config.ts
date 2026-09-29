import { join } from 'node:path';
import { AcceptLanguageResolver, I18nModule } from 'nestjs-i18n';
import { FALLBACK_LANGUAGE } from '../errors/all-exceptions.filter';

/** Launch languages (default in docs/knowledge/09-open-questions.md, "Supported languages at launch"). */
export const SUPPORTED_LANGUAGES = ['en', 'de', 'hu'] as const;

/**
 * Translations live in i18n/<lang>/*.json at the repository root, next to src/
 * and dist/, so the same relative path works from both.
 */
export const I18N_PATH = join(__dirname, '..', '..', '..', 'i18n');

export const i18nModule = I18nModule.forRoot({
  fallbackLanguage: FALLBACK_LANGUAGE,
  fallbacks: {
    'en-*': 'en',
    'de-*': 'de',
    'hu-*': 'hu',
  },
  loaderOptions: {
    path: I18N_PATH,
    watch: false,
  },
  // Stage 2 adds a resolver for the signed-in user's saved locale after this one.
  resolvers: [AcceptLanguageResolver],
});
