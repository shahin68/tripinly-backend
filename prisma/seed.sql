-- Local development only: placeholder legal documents so onboarding can finish.
-- Real documents are published per environment (see docs/knowledge/07-security-and-gdpr.md).
INSERT INTO "legal_documents" ("id", "documentType", "version", "locale", "url", "publishedAt", "requiresReconsent")
VALUES
  (gen_random_uuid(), 'terms',     'dev-1', 'en', 'https://example.com/legal/terms/en',     '2026-01-01T00:00:00Z', true),
  (gen_random_uuid(), 'terms',     'dev-1', 'de', 'https://example.com/legal/terms/de',     '2026-01-01T00:00:00Z', true),
  (gen_random_uuid(), 'terms',     'dev-1', 'hu', 'https://example.com/legal/terms/hu',     '2026-01-01T00:00:00Z', true),
  (gen_random_uuid(), 'privacy',   'dev-1', 'en', 'https://example.com/legal/privacy/en',   '2026-01-01T00:00:00Z', true),
  (gen_random_uuid(), 'privacy',   'dev-1', 'de', 'https://example.com/legal/privacy/de',   '2026-01-01T00:00:00Z', true),
  (gen_random_uuid(), 'privacy',   'dev-1', 'hu', 'https://example.com/legal/privacy/hu',   '2026-01-01T00:00:00Z', true),
  (gen_random_uuid(), 'marketing', 'dev-1', 'en', 'https://example.com/legal/marketing/en', '2026-01-01T00:00:00Z', true)
ON CONFLICT ("documentType", "version", "locale") DO NOTHING;
