# Changelog

## 0.2.2 — 2026-08-16

Two Android billing defects, both ported from the production integration
`PlayBillingCore` was originally derived from, where both were fixed and
device-confirmed. Consumers on 0.2.1 (lastGLANCE, lifeGLANCE) carry both.

### Fixed: the billing client died after one background cycle

The client was built once in a field initializer, `endConnection()` was called
from the plugin's `handleOnStop`, and `startConnection()` was called on that
same dead instance from `handleOnStart`. A `BillingClient` cannot be reused
after `endConnection()` — device-confirmed with
`W BillingClient: Client was already closed and can't be reused`. After one
background/foreground cycle every billing operation in the process silently
no-opped: restores reported success from the stale cache, purchases errored
with `billing_not_ready`, and `queryPurchases` (entitlement refresh **and** the
re-acknowledgement lane) never ran again until process death.

- `BillingConnectionPolicy.kt` — a pure decision table. CLOSED → RECREATE,
  everything else → REUSE; CONNECTED skips to the queries, CONNECTING waits,
  DISCONNECTED connects.
- The client is now a `private var` reachable only through a `@Synchronized`
  accessor that replaces a CLOSED instance before handing anything out. Reuse
  after close is impossible by construction, not avoided by convention.
- `connect()` is idempotent and runs the queries on **every** foreground,
  including the already-connected path. Under keep-alive
  `onBillingSetupFinished` no longer fires per foreground, so without this the
  fix would trade "billing dead after backgrounding" for "billing alive but
  never refreshing".
- `enableAutoServiceReconnection()` (PBL 8) recovers service drops on the same
  instance.
- `endConnection` moved to destruction only: the public `disconnect()` is now
  `destroy()`, called from the plugin's new `handleOnDestroy` override.
  `handleOnStop` drops the activity reference and nothing else.

### Fixed: failed purchase acknowledgements were discarded

`acknowledgePurchase` ended in `{ /* fire and forget */ }` — no retry, no
logging, no persisted state. Google auto-refunds an unacknowledged purchase
after three days and revokes the entitlement, so a dropped connection right
after a purchase silently cost the user their money if they did not reopen the
app within 72 hours.

- `AckRetryPolicy.kt` — a pure decision module. Success on OK or an
  authoritative `isAcknowledged` from a fresh query; terminal **only** on
  `ITEM_NOT_OWNED` and `DEVELOPER_ERROR`; connection failures never terminal;
  everything else retries until the three-day window closes.
- `AckRetryWorker.kt` — a WorkManager `CoroutineWorker` on unique work with
  `KEEP` policy, network-constrained, exponential backoff. It builds its own
  short-lived client per attempt and never goes through the shared accessor.
- `BillingStore.kt` — the durable pending record plus acknowledgement
  diagnostics, extracted from `PlayBillingCore`'s private companion so the
  worker can read the same preferences without a core instance. Existing 0.2.1
  cache keys are unchanged, so upgrading installs keep their entitlement.
- `queryPurchases()` now clears a pending record when Play reports the token
  acknowledged, and re-schedules the chain if a record outlives its worker.

Entitlement is never gated on acknowledgement: a paid but unacknowledged
purchase is valid and the user keeps access.

### New transitive dependency: WorkManager

`androidx.work:work-runtime-ktx`, fallback `2.9.1`, overridable via
`rootProject.ext.workManagerVersion`. **lifeGLANCE already pins 2.9.1** and is
unaffected; **lastGLANCE gains it**, and with it Room, `androidx.startup` and
Guava's ListenableFuture (~400–600 KB pre-R8, less after shrinking).

Manifest merge also adds WorkManager's initializer and services plus the
`WAKE_LOCK` and `RECEIVE_BOOT_COMPLETED` permissions. Both are normal-level
with no runtime prompt, but **they appear on the Play listing** — worth a
release-note line for a privacy-minded audience.

### Also

- Long-lived objects (client, preferences, WorkManager) now take
  `applicationContext`. Capacitor's `Plugin.getContext()` returns the
  `BridgeActivity`, and neither consuming app declares `android:configChanges`,
  so the activity is destroyed on every rotation, dark-mode toggle, locale or
  font-size change and multi-window resize. Holding it would leak one activity
  per recreation, silently.
- `android/src/test/` with the two policies' JUnit suites. There is no Android
  CI lane in this repo yet — run with `./gradlew :glance-apps-billing:test`
  from a consuming app.

No TypeScript, adapter, or `dist/` changes: this release is Android-only.

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
