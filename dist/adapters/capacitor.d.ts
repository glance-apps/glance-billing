import type { BillingAdapter } from './types.js';
import type { BillingEvent, ProductIds, StorageLike } from '../types.js';
/** What initialize() may resolve with: the native capabilities it supports. */
export interface CapacitorInitializeResult {
    /**
     * refresh() resolves only once its re-query has finished, and a refresh()
     * that overlaps one already running resolves no earlier than that one does.
     */
    refreshReportsCompletion?: boolean;
}
/** A pushed entitlement reading. Only `active: true` is ever applied. */
export interface CapacitorStatusUpdate {
    active: boolean;
    productId: string | null;
}
/** The events a BillingBridge plugin can emit, by name. */
export interface CapacitorBillingEvents {
    billingEvent: BillingEvent;
    billingStatus: CapacitorStatusUpdate;
}
/** The Capacitor plugin surface (registerPlugin<CapacitorBillingPlugin>('BillingBridge')). */
export interface CapacitorBillingPlugin {
    initialize(options: {
        yearlyProductId: string;
        lifetimeProductId: string;
    }): Promise<CapacitorInitializeResult | void>;
    getStatus(): Promise<{
        active: boolean;
        productId: string | null;
    }>;
    /** See CapacitorInitializeResult.refreshReportsCompletion for when it resolves. */
    refresh(): Promise<void>;
    purchase(options: {
        productId: string;
    }): Promise<void>;
    getProductPrices(): Promise<{
        yearly: string | null;
        lifetime: string | null;
        yearlyTrialDays?: number | null;
    }>;
    getTrialEligibility(): Promise<Record<string, boolean>>;
    consumeTestPurchase?(): Promise<void>;
    addListener<E extends keyof CapacitorBillingEvents>(eventName: E, listener: (event: CapacitorBillingEvents[E]) => void): Promise<{
        remove: () => Promise<void>;
    }> | {
        remove: () => Promise<void>;
    };
}
export interface CapacitorAdapterOptions {
    plugin: CapacitorBillingPlugin;
    products: ProductIds;
    statusCacheKey?: string;
    storage?: StorageLike | null;
    timings?: {
        /**
         * Restore: how long to give the native re-query before settling. Used only
         * when the plugin does not report refresh completion.
         */
        restoreSettleMs?: number;
        /**
         * Refresh: how long to give the native re-query before re-reading. Used
         * only when the plugin does not report refresh completion.
         */
        refreshSettleMs?: number;
        /** Mount: trial/prices re-read delay after the refresh kick. */
        mountRereadMs?: number;
        /**
         * When the plugin reports refresh completion: the longest a restore or
         * refresh waits for it before reading anyway. A safety net for a native
         * call that never settles, not a guess at how long one takes; it stays
         * under the paywalls' 45 s restore give-up so a restore still concludes.
         */
        refreshCompletionCapMs?: number;
    };
}
export declare function createCapacitorAdapter(opts: CapacitorAdapterOptions): BillingAdapter;
