# Changelog

## 0.2.1 — 2026-07-28

### Android build config: Kotlin Gradle plugin 2.0.21 → 2.2.20

Build config only — no source or API changes.

billing-ktx 8.3.0 (the plugin's Play Billing dependency since 0.2.0) is
compiled with Kotlin 2.2 metadata and pulls in kotlin-stdlib 2.2.10. A
Kotlin 2.0.x compiler cannot read 2.2 metadata and crashes
`compileReleaseKotlin` with an internal
`IllegalArgumentException: source must not be null`. The module's Kotlin
Gradle plugin pin is now 2.2.20, matching the consuming apps' toolchain.

The AGP classpath stays at 8.7.2 — within KGP 2.2.20's supported AGP range
(7.3.1–8.11.1). `jvmTarget = 17` and `compileSdk 35` fallbacks are
unchanged and fully supported by Kotlin 2.2.

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
