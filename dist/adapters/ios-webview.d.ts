import type { BillingAdapter } from './types.js';
import type { ProductIds } from '../types.js';
/**
 * The subset of the native bridge (`window.<AppName>Native`) used for billing.
 * All string returns are JSON.
 */
export interface IOSBillingBridge {
    /** `{"active":bool,"productId":string|null}` from RevenueCat's cache. */
    getSubscriptionStatus(): string;
    /** `{"yearly":string|null,"lifetime":string|null,"yearlyTrialDays":number|null}` */
    getProductPrices(): string;
    /** `{"<yearlyProductId>":bool}` */
    getTrialEligibility(): string;
    purchase?(productId: string): void;
    restorePurchases?(): void;
}
export interface IOSWebViewAdapterOptions {
    bridge: IOSBillingBridge;
    products: ProductIds;
    eventGlobal?: string;
    /**
     * Window global the shell calls with a pushed entitlement reading,
     * `{"active":bool,"productId":string|null}` (object or JSON string). Only an
     * active reading is ever applied.
     */
    statusGlobal?: string;
    timings?: {
        /** Mount: RevenueCat caches status; re-read after this delay so it has
         * had time to refresh from its background network call. */
        mountRereadMs?: number;
        refreshSettleMs?: number;
    };
}
export declare function createIOSWebViewAdapter(opts: IOSWebViewAdapterOptions): BillingAdapter;
