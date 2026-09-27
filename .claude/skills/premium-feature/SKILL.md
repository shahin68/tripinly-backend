---
name: premium-feature
description: Use when building or changing anything behind a Tripinly paid entitlement — currently best route with real travel times — including entitlement checks, free fallbacks and the billing module.
---

# Premium features

## Current premium features

| Feature key | What it unlocks | Free fallback |
|---|---|---|
| `best_route_realtime` | `POST /days/{id}/optimize` using real travel times (openrouteservice matrix), returns `savedMinutes` | Straight-line ordering (nearest neighbour from the first marker, then 2-opt improvement), no time estimate |

## Rules

- Check entitlements **server-side** with `EntitlementService.has(userId, feature)`. Never trust a client flag or header.
- `GET /me` returns the user's active entitlements so the client can show or hide paid UI, but the server decides.
- When a premium path is requested without the entitlement, **fall back to the free behaviour** and return `mode: "straight_line"` (for optimize) — don't error — unless the endpoint is premium-only, in which case return `PREMIUM_REQUIRED` (402-style semantics via 403 + code).
- Premium status of the **caller** counts, not the trip owner's (an editor with premium can optimize a shared trip).
- Cache entitlement lookups for ≤ 60 s; invalidate on billing webhook.

## Before building billing

**Stop and ask the user** about how purchases are made (see `09-open-questions.md` #1; RevenueCat is recommended but not confirmed). Don't wire a payment provider on your own.

Until then:
- Implement `EntitlementService` backed by the `entitlements` table, plus an admin/dev-only way to grant an entitlement for testing.
- Build best route fully (free and premium paths) following the `routing` skill.

Route lines and places along the way are **free for everyone**; only reordering by real travel time is premium.

## Adding a new premium feature

Confirm with the user it's premium, add a feature key and a row to the table above, define the free fallback, add tests for with/without entitlement.
