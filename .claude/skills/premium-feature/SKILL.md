---
name: premium-feature
description: Use when building or changing anything behind a Tripinly paid entitlement — currently routes along streets — including entitlement checks, free fallbacks and the billing module.
---

# Premium features

## Current premium features

| Feature key | What it unlocks | Free fallback |
|---|---|---|
| `routes` | `GET /routes` and `GET /days/{id}/route`: route lines along streets with places along the way | None on the server (403 `PREMIUM_REQUIRED`); the app draws curved direction lines between stops |

## Rules

- Check entitlements **server-side** with `EntitlementService.has(userId, feature)`. Never trust a client flag or header.
- `GET /me` returns the user's active entitlements so the client can show or hide paid UI, but the server decides.
- When a premium path is requested without the entitlement, **fall back to the free behaviour** and return `mode: "straight_line"` (for optimize) — don't error — unless the endpoint is premium-only, in which case return `PREMIUM_REQUIRED` (402-style semantics via 403 + code).
- Premium status of the **caller** counts, not the trip owner's (an editor with premium can optimize a shared trip).
- Cache entitlement lookups for ≤ 60 s; invalidate on billing webhook.

## Billing: RevenueCat (decided 2026-09-28)

- Purchases happen in the apps through the RevenueCat SDK. The client calls `Purchases.logIn(<our user UUID>)`, so RevenueCat's `app_user_id` is our user ID.
- RevenueCat entitlement **`tripinly_pro`** unlocks our feature keys (today: `routes`). Products: `monthly`, `yearly`, `lifetime`.
- `POST /v1/billing/revenuecat/webhook` (public, authenticated by comparing the `Authorization` header with `REVENUECAT_WEBHOOK_AUTH` in constant time) upserts `entitlements` rows: `source = revenuecat`, `externalRef` = RevenueCat transaction/original ID, `expiresAt` from the event, **`null` for lifetime** (never expires). Treat events as idempotent and out-of-order safe: re-fetch the subscriber with `REVENUECAT_API_KEY` (`GET /v1/subscribers/{app_user_id}`) and write the resulting state rather than applying deltas.
- Staging accepts `SANDBOX` events; production ignores them.
- Account deletion also deletes the RevenueCat customer (`DELETE /v1/subscribers/{app_user_id}`), see the `account-deletion` skill.
- Until the webhook is live, `EntitlementService` reads the `entitlements` table and has an admin/dev-only way to grant an entitlement for testing.

Route lines and places along the way are **premium** (`routes`); the best order by real travel times is **free for everyone** (product owner, 2026-10-18).

## Adding a new premium feature

Confirm with the user it's premium, add a feature key and a row to the table above, define the free fallback, add tests for with/without entitlement.
