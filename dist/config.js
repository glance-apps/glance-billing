// Engine tuning constants.
//
// The defaults below were tuned against real store-cache lag in a production
// deployment (RevenueCat entitlement-transfer ping-pong, StoreKit sandbox
// cache staleness, Play Billing async query timing). They are exposed as
// configuration so apps CAN override them, but treat the defaults as the
// battle-tested values — they are tuning, not arbitrary.
export const DEFAULT_TIMINGS = {
    downgradeGraceMs: 12_000,
    purchaseTimeoutMs: 60_000,
    reconcileDelaysMs: [0, 1200, 3000],
};
export const DEFAULT_STORAGE_KEYS = {
    lastActive: 'glance-billing.last-active',
    reviewerUnlock: 'glance-billing.reviewer-unlock',
};
