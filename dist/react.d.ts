import { type EngineConfig } from './engine.js';
import type { BillingEvent, EntitlementSource, Prices } from './types.js';
export interface UseBillingResult {
    /** Entitlement only. For UI gating prefer `isUnlocked`. */
    isPro: boolean;
    /** True when this install is subject to the paywall at all. */
    gated: boolean;
    /** Ungated, entitled, or reviewer-unlocked. */
    isUnlocked: boolean;
    /** Why the install is (or isn't) unlocked — for settings surfaces. */
    entitlementSource: EntitlementSource;
    productId: string | null;
    prices: Prices;
    trialEligible: boolean;
    /** Store-reported trial length in days; null = unknown → show generic copy. */
    trialDays: number | null;
    isLoading: boolean;
    billingEvent: BillingEvent | null;
    isReviewerUnlocked: boolean;
    canConsumeTestPurchase: boolean;
    subscribe: (productId: string) => void;
    restore: () => void;
    refresh: () => void;
    consumeTestPurchase: () => void;
    clearBillingEvent: () => void;
    setReviewerUnlocked: (input: string) => Promise<boolean>;
    billingErrorMessage: (code: number) => string;
}
/**
 * React binding for the billing engine.
 *
 * `createConfig` runs once per mounted component; the engine instance is
 * stable for the component's lifetime (StrictMode-safe: start/stop are
 * idempotent and re-entrant). Platform detection and adapter construction
 * belong in the app, module-level, so the same adapter feeds every mount.
 */
export declare function useBilling(createConfig: () => EngineConfig): UseBillingResult;
