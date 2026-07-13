import type { BillingAdapter } from './types.js';
import type { BillingEvent, ProductIds, StorageLike } from '../types.js';
/** The Capacitor plugin surface (registerPlugin<CapacitorBillingPlugin>('BillingBridge')). */
export interface CapacitorBillingPlugin {
    initialize(options: {
        yearlyProductId: string;
        lifetimeProductId: string;
    }): Promise<void>;
    getStatus(): Promise<{
        active: boolean;
        productId: string | null;
    }>;
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
    addListener(eventName: 'billingEvent', listener: (event: BillingEvent) => void): Promise<{
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
        /** Restore: how long to give the native re-query before settling. */
        restoreSettleMs?: number;
        /** Refresh: how long to give the native re-query before re-reading. */
        refreshSettleMs?: number;
        /** Mount: trial/prices re-read delay after the refresh kick. */
        mountRereadMs?: number;
    };
}
export declare function createCapacitorAdapter(opts: CapacitorAdapterOptions): BillingAdapter;
