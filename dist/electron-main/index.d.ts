import { BrowserWindow } from 'electron';
export interface ElectronBillingOptions {
    /**
     * Public RevenueCat SDK key for the app's "App Store" RevenueCat app. Under
     * Apple Universal Purchase the iOS and macOS apps share a single RevenueCat
     * App Store app, so the iOS key (and its App Store shared secret) covers the
     * Mac build too — there is no separate macOS app or macOS-specific key.
     */
    rcApiKey: string;
    /** RevenueCat entitlement identifier (e.g. 'pro'). */
    entitlementId: string;
    /** App Store product identifiers. */
    products: {
        yearly: string;
        lifetime: string;
    };
    /**
     * Restore settlement fallback (ms). StoreKit delivers restored purchases
     * through 'transactions-updated', but Electron exposes no "restore finished"
     * callback, so a restore that finds no purchases produces no event at all.
     * This timer settles the nothing-to-restore case.
     */
    restoreFallbackMs?: number;
    /** Filename (in userData) for the lifetime-purchase latch. */
    latchFileName?: string;
    /** Console log tag. */
    logTag?: string;
}
/**
 * Where the 'subscription:event' and 'subscription:prices-ready' pushes go.
 *
 * Pass a GETTER if the app can ever have a different main window than the one
 * it started with: closing destroys the window and reactivation creates a new
 * one, or crash recovery recreates it. The getter is called on every push, so
 * the events follow the current window; return null while there is none.
 *
 * A bare BrowserWindow is still accepted, for an app whose one window lives as
 * long as the process (closing hides it). Once that window is destroyed the
 * pushes are dropped.
 */
export type BillingWindowSource = BrowserWindow | (() => BrowserWindow | null | undefined);
export declare function isMASBuild(): boolean;
export declare function parseEntitlement(subscriber: unknown, entitlementId: string): {
    active: boolean;
    productId: string | null;
} | null;
export declare function registerElectronBilling(window: BillingWindowSource, options: ElectronBillingOptions): void;
