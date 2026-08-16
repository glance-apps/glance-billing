package com.glanceapps.billing

import android.app.Activity
import android.content.Context
import android.util.Log
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import java.time.Period
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Google Play Billing core for GLANCE apps, decoupled from any single app:
 * product IDs are injected via [configure], and results are cached in this
 * module's own [BillingStore] so the JS-facing plugin can answer instantly.
 *
 * Ported from a production Play Billing integration. Load-bearing details,
 * each of which was tuned or fixed against real Play behavior — preserve them:
 *
 * - The annual price is read from the INFINITE_RECURRING pricing phase
 *   (recurrenceMode 1), not the first phase — the first phase may be the
 *   free-trial (zero-price) phase.
 * - Trial detection: Play only surfaces a zero-price phase while the user is
 *   still eligible; absence of one means the trial has been used. The trial
 *   LENGTH comes from that phase's ISO-8601 billingPeriod — never hardcode it.
 * - queryPurchases checks SUBS first, then INAPP — an active subscription
 *   wins over a stale one-time record.
 * - Purchases must be acknowledged or Play refunds them after three days.
 *   A failed ack is persisted and retried by [AckRetryWorker]; entitlement is
 *   never gated on the outcome.
 * - consumeTestPurchase queries INAPP directly rather than trusting the
 *   cached token: when an annual test subscription is active the cached token
 *   is the SUBS token (SUBS has priority), which would leave the lifetime
 *   INAPP token unconsumed.
 *
 * The annual plan must be a Play SUBS product; the lifetime plan an INAPP
 * (one-time) product.
 *
 * ── Lifecycle ────────────────────────────────────────────────────────────
 *
 * [connect] is called from the plugin's `handleOnStart` on EVERY foreground
 * and is idempotent; [destroy] is called from `handleOnDestroy` and nowhere
 * else. Nothing happens on `handleOnStop` beyond dropping the activity
 * reference — the connection is deliberately kept alive across backgrounding.
 * A BillingClient is dead forever after endConnection() (device-confirmed:
 * "Client was already closed and can't be reused"), and the old
 * close-on-onStop lifecycle left every billing operation in the process
 * silently no-opping after the first background/foreground cycle.
 *
 * The shared client lives behind [client], the single accessor that replaces
 * a CLOSED instance before handing anything out (decision table in
 * [BillingConnectionPolicy]) — reuse of a closed client is impossible by
 * construction, not avoided by convention. [AckRetryWorker] deliberately does
 * NOT go through this accessor: its retry lane owns a short-lived client per
 * attempt precisely so it never depends on the shared instance's lifecycle.
 *
 * ── Why this class holds an application context ──────────────────────────
 *
 * DELIBERATE, and different from the app-side implementation this was ported
 * from. Capacitor's `Plugin.getContext()` returns the BridgeActivity, and a
 * plugin-scoped object outlives that activity: neither consuming app declares
 * `android:configChanges`, so every rotation, dark-mode toggle, locale change,
 * font-size change and multi-window resize destroys the activity and builds a
 * new Bridge, plugin and core. The BillingClient, the SharedPreferences
 * handle and every WorkManager enqueue therefore take [appContext], never the
 * activity. Holding the activity here would leak one per recreation — quietly,
 * with no crash and nothing in logcat, which is exactly why it is called out
 * rather than left to be inferred.
 *
 * [activity] is the one deliberate exception: it is needed to launch the Play
 * sheet, is set on foreground and cleared on background, and is never used to
 * build anything long-lived.
 */
class PlayBillingCore(context: Context) {

    companion object {
        private const val TAG = "GlanceBilling"
    }

    /**
     * Application context — see the class header. Everything long-lived
     * (client, store, WorkManager) is built from this, never from the
     * BridgeActivity the plugin hands in.
     */
    private val appContext: Context = context.applicationContext

    private val store = BillingStore(appContext)
    private val scope = CoroutineScope(Dispatchers.IO)

    var activity: Activity? = null
    private var yearlyProductId: String? = null
    private var lifetimeProductId: String? = null
    private var debugLogging = false

    /** Tracks the product currently going through the purchase flow for error reporting. */
    private var pendingProductId: String? = null

    /**
     * Fires for every terminal purchase-flow outcome.
     * status: "success" | "cancelled" | "error"; code: BillingResponseCode.
     */
    var onBillingEvent: ((status: String, code: Int, message: String, productId: String?) -> Unit)? = null

    /** Called once after the first queryPurchases() completes (splash gating). */
    var onPurchasesQueried: (() -> Unit)? = null

    // Purchase-flow details (tokens, offer tokens) must never reach logcat in
    // release builds; callers opt in to debug logging explicitly.
    private fun logd(msg: String) {
        if (debugLogging) Log.d(TAG, msg)
    }

    private val purchasesUpdatedListener = PurchasesUpdatedListener { result, purchases ->
        logd("purchasesUpdatedListener: code=${result.responseCode} msg='${result.debugMessage}' purchases=${purchases?.size ?: "null"}")
        when {
            result.responseCode == BillingClient.BillingResponseCode.OK && !purchases.isNullOrEmpty() -> {
                for (purchase in purchases) handlePurchase(purchase)
            }
            result.responseCode == BillingClient.BillingResponseCode.USER_CANCELED -> {
                onBillingEvent?.invoke("cancelled", result.responseCode, result.debugMessage, pendingProductId)
            }
            result.responseCode == BillingClient.BillingResponseCode.OK -> {
                // OK but no purchases — the Play sheet was dismissed without completing.
                onBillingEvent?.invoke("cancelled", result.responseCode, result.debugMessage, pendingProductId)
            }
            else -> {
                onBillingEvent?.invoke("error", result.responseCode, result.debugMessage, pendingProductId)
            }
        }
    }

    /**
     * The ONLY reference to the shared BillingClient, and it is never touched
     * directly — every use goes through [client]. Lazily built, so a core that
     * is constructed but never configured (the plugin builds one in `load()`,
     * before JS calls initialize) never constructs a client either.
     */
    private var billingClient: BillingClient? = null

    /**
     * Single accessor for the shared client. Consults
     * [BillingConnectionPolicy.clientAction]: a CLOSED instance (dead forever,
     * per Play's documentation and the device-confirmed warning) is replaced
     * with a fresh one before anything is handed out, which makes the closed
     * object unreachable. Synchronized because billing entry points span the
     * main thread (handleOnStart/handleOnDestroy) and the WebView's JS thread
     * (the plugin's @PluginMethod calls).
     *
     * A fresh instance starts DISCONNECTED and holds no service binding until
     * startConnection — so an accessor hit after [destroy] (e.g. a late JS
     * bridge call during teardown) creates only an inert object, never a leak.
     */
    @Synchronized
    private fun client(): BillingClient {
        val held = billingClient
        if (held != null &&
            BillingConnectionPolicy.clientAction(held.connectionState) ==
                BillingConnectionPolicy.ClientAction.REUSE
        ) {
            return held
        }
        val fresh = BillingClient.newBuilder(appContext)
            .setListener(purchasesUpdatedListener)
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            // PBL 8: service drops (Play killing the binding while we hold the
            // client) reconnect themselves instead of waiting for the next
            // foreground connect().
            .enableAutoServiceReconnection()
            .build()
        billingClient = fresh
        return fresh
    }

    fun configure(yearly: String, lifetime: String, enableDebugLogging: Boolean) {
        yearlyProductId = yearly
        lifetimeProductId = lifetime
        debugLogging = enableDebugLogging
    }

    val isConfigured: Boolean get() = yearlyProductId != null && lifetimeProductId != null

    // ── Cached state (read by the plugin on the JS thread — always fast) ──────

    val cachedActive: Boolean get() = store.subscriptionActive
    val cachedProductId: String? get() = store.subscriptionProductId
    val cachedPriceAnnual: String? get() = store.priceAnnual
    val cachedPriceLifetime: String? get() = store.priceLifetime
    val cachedTrialEligible: Boolean get() = store.trialEligibleAnnual
    val cachedTrialDays: Int get() = store.trialDaysAnnual

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Idempotent foreground connect — called from the plugin's `handleOnStart`
     * on every foreground. [BillingConnectionPolicy.connectAction] decides: a
     * live connection skips straight to the queries (keep-alive), an in-flight
     * connection is left to finish (its setup callback runs the queries), and
     * only a disconnected client actually starts a connection.
     *
     * Either path ends with [queryPurchases] running on THIS foreground. That
     * is not belt-and-braces: under keep-alive the client stays connected
     * across backgrounding, so onBillingSetupFinished no longer fires per
     * foreground. Without the already-connected path running the queries
     * itself, the fix would trade "billing dead after backgrounding" for
     * "billing alive but never refreshing" — which passes a naive logcat
     * check and still breaks restores, entitlement refresh and the
     * re-acknowledgement lane.
     */
    fun connect() {
        val client = client()
        when (BillingConnectionPolicy.connectAction(client.connectionState)) {
            BillingConnectionPolicy.ConnectAction.ALREADY_CONNECTED -> {
                queryPurchases()
                queryProductPrices()
            }
            BillingConnectionPolicy.ConnectAction.WAIT -> {
                // startConnection already in flight; its onBillingSetupFinished
                // will run the queries. Stacking another does nothing useful.
            }
            BillingConnectionPolicy.ConnectAction.CONNECT -> {
                client.startConnection(object : BillingClientStateListener {
                    override fun onBillingSetupFinished(result: BillingResult) {
                        if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                            queryPurchases()
                            queryProductPrices()
                        }
                    }
                    override fun onBillingServiceDisconnected() {
                        // enableAutoServiceReconnection re-establishes the
                        // service connection on this same instance; the next
                        // handleOnStart's connect() is the backstop.
                    }
                })
            }
        }
    }

    /**
     * Final teardown for THIS core instance — the plugin's `handleOnDestroy`
     * only, never `handleOnStop`. Required, not cleanup: neither consuming app
     * declares `android:configChanges`, so the activity is recreated on every
     * rotation, dark-mode toggle, locale change, font-size change and
     * multi-window resize, and each recreation builds a new Bridge, plugin and
     * core. The old binding used to be released by onStop's disconnect purely
     * by accident; without this, every recreation would leak a binding — in
     * ordinary use, not in an edge case.
     *
     * Under the accessor invariant each client is closed at most once, and
     * only here — which is also why the "Receiver is not registered" warning
     * (a second endConnection on an already-closed client) should never
     * appear. Deliberately does not construct: closing nothing is fine.
     */
    @Synchronized
    fun destroy() {
        billingClient?.endConnection()
        billingClient = null
        activity = null
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    private suspend fun queryPurchasesForType(client: BillingClient, productType: String): List<Purchase> =
        suspendCancellableCoroutine { cont ->
            client.queryPurchasesAsync(
                QueryPurchasesParams.newBuilder().setProductType(productType).build()
            ) { _, purchases -> cont.resume(purchases) }
        }

    fun queryPurchases() {
        val client = client()
        if (!client.isReady) return
        scope.launch {
            val activeSub = queryPurchasesForType(client, BillingClient.ProductType.SUBS)
                .firstOrNull { it.purchaseState == Purchase.PurchaseState.PURCHASED }

            val active = activeSub ?: queryPurchasesForType(client, BillingClient.ProductType.INAPP)
                .firstOrNull { it.purchaseState == Purchase.PurchaseState.PURCHASED }

            if (active != null) {
                if (!active.isAcknowledged) {
                    // Opportunistic re-ack lane: outcome-aware (recorded and
                    // retried on failure via acknowledgePurchase), no longer a
                    // blind extra attempt.
                    acknowledgePurchase(active)
                } else if (store.pendingAckToken == active.purchaseToken) {
                    // Play reports the pending token acknowledged (the retry
                    // worker, a prior blind re-ack, or Play itself caught up):
                    // isAcknowledged from a fresh query is authoritative success.
                    AckRetryWorker.recordSuccess(store, active.purchaseToken)
                    logd("pending ack cleared: Play reports token=…${active.purchaseToken.takeLast(8)} acknowledged")
                }
                store.subscriptionActive = true
                store.subscriptionProductId = active.products.firstOrNull()
                store.subscriptionToken = active.purchaseToken
            } else {
                store.clearSubscription()
            }
            // Backstop: a pending-ack record with no live retry chain (WorkManager
            // state cleared by the OS or the user) gets re-scheduled here. KEEP
            // policy makes this a no-op while the chain is alive. The worker's
            // own query settles a record whose purchase has since vanished
            // (terminal ITEM_NOT_OWNED) or aged out (three-day window).
            if (store.pendingAckToken != null) AckRetryWorker.schedule(appContext)
            onPurchasesQueried?.invoke()
            onPurchasesQueried = null
        }
    }

    /**
     * Fetches prices, trial eligibility, and trial length, caching all of it.
     *
     * Annual (SUBS): the recurring price is the INFINITE_RECURRING phase
     * (recurrenceMode 1). A zero-price phase indicates a free trial — Play
     * only surfaces that offer while the user is still eligible — and its
     * billingPeriod (ISO-8601, e.g. "P14D"/"P2W") is the trial length.
     * Lifetime (INAPP): oneTimePurchaseOfferDetails.formattedPrice.
     */
    fun queryProductPrices() {
        val client = client()
        if (!client.isReady || !isConfigured) return
        val yearly = yearlyProductId ?: return
        val lifetime = lifetimeProductId ?: return

        val subsParams = QueryProductDetailsParams.newBuilder()
            .setProductList(listOf(
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(yearly)
                    .setProductType(BillingClient.ProductType.SUBS)
                    .build()
            ))
            .build()

        val inappParams = QueryProductDetailsParams.newBuilder()
            .setProductList(listOf(
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(lifetime)
                    .setProductType(BillingClient.ProductType.INAPP)
                    .build()
            ))
            .build()

        scope.launch {
            client.queryProductDetailsAsync(subsParams) { result, queryResult ->
                if (result.responseCode != BillingClient.BillingResponseCode.OK) return@queryProductDetailsAsync
                for (details in queryResult.productDetailsList) {
                    if (details.productId != yearly) continue
                    val offerDetails = details.subscriptionOfferDetails ?: continue
                    val price = offerDetails
                        .flatMap { it.pricingPhases.pricingPhaseList }
                        .firstOrNull { it.recurrenceMode == 1 }
                        ?.formattedPrice
                    val trialPhase = offerDetails
                        .flatMap { it.pricingPhases.pricingPhaseList }
                        .firstOrNull { it.priceAmountMicros == 0L }
                    if (price != null) store.priceAnnual = price
                    store.trialEligibleAnnual = trialPhase != null
                    trialPhase?.billingPeriod
                        ?.let { parseIsoPeriodToDays(it) }
                        ?.takeIf { it > 0 }
                        ?.let { store.trialDaysAnnual = it }
                }
            }
            client.queryProductDetailsAsync(inappParams) { result, queryResult ->
                if (result.responseCode != BillingClient.BillingResponseCode.OK) return@queryProductDetailsAsync
                for (details in queryResult.productDetailsList) {
                    val price = details.oneTimePurchaseOfferDetails?.formattedPrice ?: continue
                    if (details.productId == lifetime) store.priceLifetime = price
                }
            }
        }
    }

    /** "P14D" → 14, "P2W" → 14. Months/years approximated (not used for trials in practice). */
    private fun parseIsoPeriodToDays(iso: String): Int? = try {
        val p = Period.parse(iso)
        p.years * 365 + p.months * 30 + p.days
    } catch (_: Exception) {
        null
    }

    // ── Purchase flow ─────────────────────────────────────────────────────────

    fun launchPurchaseFlow(productId: String) {
        val act = activity ?: run {
            Log.w(TAG, "launchPurchaseFlow($productId): activity null")
            onBillingEvent?.invoke("error", BillingClient.BillingResponseCode.DEVELOPER_ERROR, "activity_null", productId)
            return
        }
        val client = client()
        if (!client.isReady) {
            // Reported, not repaired: reconnect-on-tap is a separate queued
            // item (the not-ready purchase UX) and is deliberately not added
            // here.
            Log.w(TAG, "launchPurchaseFlow($productId): client not ready")
            onBillingEvent?.invoke("error", BillingClient.BillingResponseCode.SERVICE_DISCONNECTED, "billing_not_ready", productId)
            return
        }

        pendingProductId = productId
        val productType = if (productId == lifetimeProductId) BillingClient.ProductType.INAPP
                          else BillingClient.ProductType.SUBS

        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(listOf(
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(productId)
                    .setProductType(productType)
                    .build()
            ))
            .build()

        scope.launch {
            client.queryProductDetailsAsync(params) { result, queryResult ->
                logd("launchPurchaseFlow($productId): query code=${result.responseCode} count=${queryResult.productDetailsList.size}")

                if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                    Log.w(TAG, "launchPurchaseFlow($productId): query failed (exit A) code=${result.responseCode}")
                    onBillingEvent?.invoke("error", result.responseCode, result.debugMessage, productId)
                    return@queryProductDetailsAsync
                }
                val details = queryResult.productDetailsList.firstOrNull() ?: run {
                    Log.w(TAG, "launchPurchaseFlow($productId): empty detailsList (exit B)")
                    onBillingEvent?.invoke("error", BillingClient.BillingResponseCode.ITEM_UNAVAILABLE, "product_not_found", productId)
                    return@queryProductDetailsAsync
                }

                val productDetailsParams = BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(details)
                    .apply {
                        if (productType == BillingClient.ProductType.SUBS) {
                            val offerToken = details.subscriptionOfferDetails?.firstOrNull()?.offerToken ?: run {
                                Log.w(TAG, "launchPurchaseFlow($productId): no offerToken (exit C)")
                                onBillingEvent?.invoke("error", BillingClient.BillingResponseCode.ITEM_UNAVAILABLE, "no_offer_token", productId)
                                return@queryProductDetailsAsync
                            }
                            setOfferToken(offerToken)
                        }
                    }
                    .build()

                val flowParams = BillingFlowParams.newBuilder()
                    .setProductDetailsParamsList(listOf(productDetailsParams))
                    .build()

                act.runOnUiThread {
                    val launchResult = client.launchBillingFlow(act, flowParams)
                    logd("launchBillingFlow: code=${launchResult.responseCode}")
                    if (launchResult.responseCode != BillingClient.BillingResponseCode.OK) {
                        onBillingEvent?.invoke("error", launchResult.responseCode, launchResult.debugMessage, productId)
                    }
                    // OK → wait for purchasesUpdatedListener to fire.
                }
            }
        }
    }

    private fun handlePurchase(purchase: Purchase) {
        if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED) return
        if (!purchase.isAcknowledged) acknowledgePurchase(purchase)
        val pid = purchase.products.firstOrNull()
        store.subscriptionActive = true
        store.subscriptionProductId = pid
        store.subscriptionToken = purchase.purchaseToken
        onBillingEvent?.invoke("success", BillingClient.BillingResponseCode.OK, "", pid)
    }

    /**
     * Acknowledge a purchase, with the result recorded rather than discarded.
     * Play refunds any purchase not acknowledged within three days, so a
     * failure here is real money: it is persisted as a pending-ack record and
     * retried by [AckRetryWorker] (WorkManager: survives process death and
     * reboot, waits for connectivity, exponential backoff) until it succeeds,
     * proves terminal, or ages past the three-day window. Entitlement is NOT
     * gated on any of this — the cached active flag is set by the callers
     * before or regardless of the ack outcome, deliberately. A paid but
     * unacknowledged purchase is valid and the user keeps access.
     */
    private fun acknowledgePurchase(purchase: Purchase) {
        val token = purchase.purchaseToken
        val productId = purchase.products.firstOrNull()
        val params = AcknowledgePurchaseParams.newBuilder()
            .setPurchaseToken(token)
            .build()
        client().acknowledgePurchase(params) { result ->
            if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                AckRetryWorker.recordSuccess(store, token)
                logd("acknowledgePurchase OK: token=…${token.takeLast(8)}")
            } else {
                AckRetryWorker.recordFailureAndSchedule(
                    appContext, store, token, productId, result.responseCode
                )
            }
        }
    }

    // ── Test-only consume ────────────────────────────────────────────────────

    fun consumeTestPurchase(onComplete: (success: Boolean) -> Unit) {
        val token = store.subscriptionToken
        // Always clear the local cache so the subscription wall reappears immediately.
        store.clearSubscription()

        val client = client()
        if (!client.isReady) {
            onComplete(true)
            return
        }
        scope.launch {
            // Query INAPP purchases directly rather than relying on the cached
            // token. When an annual test subscription is active, queryPurchases()
            // stores the SUBS token (SUBS has priority), leaving the lifetime
            // INAPP token untouched. Querying INAPP directly ensures the lifetime
            // token is always consumed.
            val inappPurchases = queryPurchasesForType(client, BillingClient.ProductType.INAPP)
            for (purchase in inappPurchases) {
                val p = ConsumeParams.newBuilder().setPurchaseToken(purchase.purchaseToken).build()
                suspendCancellableCoroutine { cont ->
                    client.consumeAsync(p) { result, _ ->
                        logd("consumeAsync INAPP: code=${result.responseCode}")
                        cont.resume(Unit)
                    }
                }
            }
            // Also attempt the originally cached token (may be a SUBS token for an
            // annual test subscription — consumeAsync can succeed on license-tester
            // SUBS tokens).
            if (token != null && inappPurchases.none { it.purchaseToken == token }) {
                val p = ConsumeParams.newBuilder().setPurchaseToken(token).build()
                suspendCancellableCoroutine { cont ->
                    client.consumeAsync(p) { result, _ ->
                        logd("consumeAsync cached token: code=${result.responseCode}")
                        cont.resume(Unit)
                    }
                }
            }
            onComplete(true)
        }
    }
}
