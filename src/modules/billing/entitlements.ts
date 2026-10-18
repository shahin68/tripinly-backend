/** Paid feature keys (premium-feature skill). RevenueCat's `tripinly_pro` unlocks all of them. */
export const PremiumFeature = {
  /** Routes along streets with places along the way (day and A→B). */
  ROUTES: 'routes',
} as const;

export type PremiumFeatureKey =
  (typeof PremiumFeature)[keyof typeof PremiumFeature];

export const PREMIUM_FEATURES: readonly PremiumFeatureKey[] =
  Object.values(PremiumFeature);
