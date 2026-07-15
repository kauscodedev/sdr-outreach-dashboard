/**
 * Competitor seed list for the signals engine — normalization hints only. The extraction prompt
 * maps mentions onto these canonical names when they match; unknown competitor names pass
 * through as-is (expect to promote recurring ones into this list over time). Maintained by GTM.
 */
export const COMPETITOR_SEEDS = [
  "Impel", // incl. SpinCar (acquired)
  "Glo3D",
  "CarCutter",
  "Fyusion",
  "EVOX",
  "HomeNet",
  "Dealer Specialties",
  "Cox Automotive",
  "Dealer.com",
  "PhotoUp",
  "in-house photographer", // the do-it-ourselves alternative — worth tracking like a competitor
] as const;
