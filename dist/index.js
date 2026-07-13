// @glance-apps/billing — shared entitlement engine and store-billing adapters
// for the GLANCE family of apps.
//
// Entry points:
//   .               — engine, types, adapters, reviewer helpers (this file)
//   ./react         — useBilling React hook
//   ./electron-main — main-process StoreKit + RevenueCat REST module
//   ./capacitor     — Capacitor plugin adapter (pairs with android/ source)
export * from './types.js';
export { BillingEngine } from './engine.js';
export { DEFAULT_TIMINGS, DEFAULT_STORAGE_KEYS, } from './config.js';
export { SafeStorage } from './storage.js';
export { deriveReviewerCode, sha256Hex } from './reviewer.js';
export { billingErrorMessage } from './errors.js';
export { playManageSubscriptionUrl, appleManageSubscriptionUrl } from './urls.js';
export { createAndroidWebViewAdapter, } from './adapters/android-webview.js';
export { createIOSWebViewAdapter, } from './adapters/ios-webview.js';
export { createElectronRendererAdapter, } from './adapters/electron-renderer.js';
