export interface EngineTimings {
    /**
     * ANTI-FLASH downgrade grace (milliseconds) — NOT the offline-expiry grace.
     *
     * A paying user must never see the paywall, even for a second. Entitlement
     * reads can transiently report inactive on an entitled install (RevenueCat's
     * transfer behavior moves a shared entitlement to whichever device validated
     * last; store caches lag), and the native layers self-heal within a few
     * seconds. So status transitions are asymmetric: inactive→active applies
     * INSTANTLY, while active→inactive is held for this window and only applied
     * if no recovery (an active read or a purchase/restore event) lands first.
     * A genuinely lapsed subscription still locks — just this many ms later.
     */
    downgradeGraceMs: number;
    /** Clears the purchase spinner if the platform bridge never fires an event. */
    purchaseTimeoutMs: number;
    /**
     * Post-purchase/restore re-read schedule. The store cache can briefly lag
     * right after a confirmed purchase (StoreKit sandbox especially), so the
     * engine re-reads on these delays and applies ONLY active results — a
     * lagging cache right after someone paid must not even start a downgrade
     * countdown.
     */
    reconcileDelaysMs: number[];
}
export declare const DEFAULT_TIMINGS: EngineTimings;
export interface StorageKeys {
    /**
     * Persisted "this install has been entitled" hint, so a stale native cache
     * at cold launch can't flash the wall at first paint — the install starts
     * provisionally unlocked and the downgrade grace window confirms or clears
     * it. Apps migrating an existing integration MUST pass their legacy key so
     * installed users keep their hint across the update.
     */
    lastActive: string;
    /** SHA-256 hash of a previously validated reviewer code. */
    reviewerUnlock: string;
}
export declare const DEFAULT_STORAGE_KEYS: StorageKeys;
