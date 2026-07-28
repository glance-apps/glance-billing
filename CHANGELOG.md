# Changelog

## 0.2.0 — 2026-07-28

### Breaking: Android plugin migrated to Google Play Billing Library 8

Google requires all new apps and app updates on Play to use Billing Library
8+ by **Aug 31, 2026**. This release migrates the bundled `BillingBridge`
Android plugin from Billing Library 7.1.1 to **8.3.0**.

- `PlayBillingCore` now uses the Billing 8 `queryProductDetailsAsync`
  callback signature: the second callback parameter is a
  `QueryProductDetailsResult` and the product list is read from its
  `productDetailsList` property. Behavior is unchanged — pricing-phase
  handling, trial detection, purchase flow, and acknowledgment logic are
  untouched.
- `android/build.gradle`: the `playBillingVersion` fallback default is now
  `8.3.0` (was `7.1.1`).
- Verified that no APIs removed in Billing 8 are used: no
  `querySkuDetailsAsync`/`SkuDetails`, no `queryPurchaseHistoryAsync`, no
  parameterless `enablePendingPurchases()`, no
  `ProrationMode`/`setReplaceProrationMode`/`setOldSkuPurchaseToken`, and no
  `enableAlternativeBilling`/`AlternativeBillingListener` usage.

**Action required for consuming apps** (lastGLANCE, dayGLANCE, lifeGLANCE):
set the billing version in your Android `variables.gradle`:

```groovy
ext {
    playBillingVersion = '8.3.0'
}
```

The plugin no longer compiles against Billing 7.x. No JS/TS API changes;
the engine, adapters, and Electron/iOS paths are unaffected.

## 0.1.1

- Fix Windows launch crash: guard StoreKit observer to darwin.

## 0.1.0

- Initial release: shared entitlement engine, WebView/Capacitor/Electron
  adapters, bundled Android `BillingBridge` plugin (Play Billing 7.1.1).
