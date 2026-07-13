import type { BillingAdapter } from './types.js';
import type { BillingEvent, StatusReading, StorageLike } from '../types.js';
/** Prices payload pushed/pulled over IPC. */
export interface ElectronPricesPayload {
    yearly: string | null;
    lifetime: string | null;
    yearlyTrialDays?: number | null;
}
/** The preload-exposed IPC surface this adapter drives. */
export interface ElectronBillingApi {
    subscriptionStatus(): Promise<StatusReading>;
    subscriptionPurchase(productId: string): Promise<void>;
    subscriptionRestore(): Promise<void>;
    subscriptionPrices?(): Promise<ElectronPricesPayload | null>;
    onSubscriptionEvent(cb: (event: BillingEvent | string) => void): () => void;
    onSubscriptionPricesReady(cb: (prices: ElectronPricesPayload) => void): () => void;
}
export interface ElectronRendererAdapterOptions {
    api: ElectronBillingApi;
    /**
     * localStorage key for the status mirror. Apps migrating an existing
     * integration MUST pass their legacy key so installed users keep their
     * cached last-known-good entitlement across the update.
     */
    statusCacheKey?: string;
    storage?: StorageLike | null;
}
export declare function createElectronRendererAdapter(opts: ElectronRendererAdapterOptions): BillingAdapter;
