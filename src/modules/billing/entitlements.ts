/** Paid feature keys (premium-feature skill). RevenueCat's `tripinly_pro` unlocks all of them. */
export const PremiumFeature = {
  /** Best route by real travel times (openrouteservice matrix). */
  BEST_ROUTE_REALTIME: 'best_route_realtime',
} as const;

export type PremiumFeatureKey =
  (typeof PremiumFeature)[keyof typeof PremiumFeature];

export const PREMIUM_FEATURES: readonly PremiumFeatureKey[] =
  Object.values(PremiumFeature);
