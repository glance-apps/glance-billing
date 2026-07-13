import type { BillingAdapter } from './types.js';
import type { ProductIds } from '../types.js';
/**
 * The JS interface the native Android shell injects into the WebView
 * (`window.<AppName>Billing`). All string returns are JSON.
 */
export interface AndroidBillingBridge {
    /** `{"active":bool,"productId":string}` — cached, safe on the JS thread. */
    getStatus(): string;
    /** Re-queries Play in the background; read getStatus() again after a delay. */
    refresh?(): void;
    /** Launches the Play purchase sheet. Result arrives via the event global. */
    purchase?(productId: string): void;
    /** `{"annual":string,"lifetime":string,"annualTrialDays":number|null}` */
    getProductPrices(): string;
    /** `{"<yearlyProductId>":bool}` */
    getTrialEligibility(): string;
    /** Debug builds only. */
    consumeTestPurchase?(): void;
}
export interface AndroidWebViewAdapterOptions {
    bridge: AndroidBillingBridge;
    products: ProductIds;
    /** Window property the native layer invokes with terminal events. */
    eventGlobal?: string;
    timings?: {
        /** Mount: trial eligibility is re-read after this delay — the native
         * billing client queries Play async, so the initial read may predate the
         * authoritative result. */
        mountTrialRereadMs?: number;
        /** Refresh: how long to give the native re-query before re-reading. */
        refreshSettleMs?: number;
        /** Restore: how long to give the native re-query before settling. */
        restoreSettleMs?: number;
    };
}
export declare function createAndroidWebViewAdapter(opts: AndroidWebViewAdapterOptions): BillingAdapter;
