---
name: add-endpoint
description: Use when adding or changing any Tripinly REST endpoint — DTOs, validation, auth, access checks, OpenAPI docs, error codes, tests and client handoff.
---

# Add or change a REST endpoint

## Before coding

1. Find the endpoint in `docs/knowledge/04-api-spec.md`. If it isn't there, propose the method, path, request and response to the user first (or confirm it's an internal/engineering-only addition).
2. Read the rules that apply in `02-domain-rules.md` (visibility, blocking, copying, premium…).
3. Decide the owning module (see `CLAUDE.md` module list). Don't put trip logic in `users`, etc.

## Build

1. **Request DTO** with `class-validator` decorators; strict limits on string lengths, array sizes, enums. Coordinates: `lat` −90..90, `lng` −180..180.
2. **Response DTO** — never return Prisma models directly. Omit internal fields (`birthDate` of others, storage keys, `hiddenAt`, emails).
3. **Controller**: route under `/v1`, `@ApiTags`, `@ApiOperation`, `@ApiOkResponse`/`@ApiCreatedResponse` with the DTO type, documented error responses. Auth guard on by default; public routes use the explicit `@Public()` decorator. Admin routes use `@Roles('admin')`.
4. **Service**: load the parent resource, run `TripAccessService` for trip-scoped data (see `trip-access` skill), apply block checks, then do the work in a transaction if it touches more than one row.
5. **Errors**: throw the shared `DomainError(code, httpStatus, details?)`. New codes go into the error-code list in `04-api-spec.md` and every i18n `errors.json`.
6. **Side effects**: emit a domain event (`this.events.emit('marker.created', …)`) after the transaction commits. Don't call the gateway, FCM or email from the request path.
7. **Lists**: cursor pagination (`{ items, nextCursor }`), stable ordering with a tiebreaker on `id`, max `limit` 50, blocked users filtered, hidden (`hiddenAt`) content filtered for non-admins.
8. **Rate limit** writes that could be abused (comments, likes, reports, uploads, search).

## Test

Integration test (Supertest + Testcontainers) covering at least:
- happy path and response shape
- 401 without a token, `ONBOARDING_INCOMPLETE` for a non-onboarded user
- 404 for a private trip the caller isn't a member of
- block in both directions
- validation failure returns `VALIDATION_FAILED` with field details
- idempotency for likes / repeated calls where relevant

## Finish

1. Regenerate the OpenAPI document and check the diff looks as intended (no accidental breaking change).
2. Update `04-api-spec.md` if the endpoint is new or its contract changed.
3. In your report, list for the client team: path, request/response changes, new error codes, and any realtime events it triggers.
