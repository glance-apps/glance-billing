package com.glanceapps.billing

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryPurchasesParams
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

/**
 * WorkManager retry lane for Google Play purchase acknowledgement.
 *
 * Google refunds any purchase not acknowledged within three days. The pending
 * record in [BillingStore] (written the moment an ack fails, see
 * [recordFailureAndSchedule]) is the durable obligation; this worker drains it.
 * WorkManager persists the job across process death and device reboot, waits
 * for connectivity (NetworkType.CONNECTED), and drives the exponential backoff
 * (Result.retry) — which is exactly the coverage the failure needs: the user
 * closing the app right after a failed ack, and not reopening it for days, is
 * the scenario the three-day refund punishes.
 *
 * DELIBERATELY INDEPENDENT of [PlayBillingCore]'s shared BillingClient: this
 * worker constructs its own short-lived client per attempt and always closes
 * it, and it never goes through the core's `client()` accessor. It runs when
 * the activity, the Capacitor plugin instance and the core may all be gone, so
 * a lane that leaned on the shared instance would be leaning on an object with
 * a lifecycle it does not control.
 *
 * Everything here is built on an APPLICATION context. WorkManager can execute
 * this long after the BridgeActivity that started it was destroyed; holding
 * that activity would leak it (see the context note in [PlayBillingCore]).
 *
 * Decisions (what is success, what is terminal, when to stop) live in the pure
 * [AckRetryPolicy]; this file is wiring. Entitlement is NEVER touched here:
 * acknowledgement is an obligation to Google, not a condition of service, and
 * the cached active flag is owned by the purchase/query paths.
 */
class AckRetryWorker(
    private val appContext: Context,
    workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {

    companion object {
        private const val TAG = "GlanceBilling"
        const val UNIQUE_WORK_NAME = "glance-billing-ack-retry"

        /**
         * Enqueue the retry chain. ExistingWorkPolicy.KEEP so a chain already
         * mid-backoff keeps its position (the pending record in [BillingStore]
         * is the single source of truth for WHAT to acknowledge — the running
         * chain reads it at attempt time, so scheduling is idempotent and safe
         * to call as a backstop from queryPurchases).
         */
        fun schedule(context: Context) {
            val request = OneTimeWorkRequestBuilder<AckRetryWorker>()
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(UNIQUE_WORK_NAME, ExistingWorkPolicy.KEEP, request)
        }

        /**
         * Record a failed acknowledge attempt and make sure the retry chain is
         * scheduled. Called from [PlayBillingCore]'s ack callback (both the
         * purchase-time ack and the on-foreground re-ack) and from this worker.
         * A failure for a NEW token replaces the record and re-anchors the
         * window; repeat failures for the same token only bump the attempt
         * count, so firstFailedAt keeps measuring from the first failure.
         */
        internal fun recordFailureAndSchedule(
            context: Context,
            store: BillingStore,
            token: String,
            productId: String?,
            responseCode: Int,
            nowMs: Long = System.currentTimeMillis(),
        ) {
            if (store.pendingAckToken != token) {
                store.pendingAckToken = token
                store.pendingAckProductId = productId
                store.pendingAckFirstFailedAt = nowMs
                store.pendingAckAttempts = 1
            } else {
                store.pendingAckAttempts = store.pendingAckAttempts + 1
            }
            store.lastAckOutcome = "retrying"
            store.lastAckFailureCode = responseCode
            store.lastAckFailureAt = nowMs
            Log.w(
                TAG,
                "acknowledgePurchase failed: code=$responseCode token=…${token.takeLast(8)} " +
                    "attempt=${store.pendingAckAttempts} — retry scheduled " +
                    "(Play refunds unacknowledged purchases after 3 days)"
            )
            schedule(context)
        }

        /**
         * Record a successful acknowledgement (first try or retry) and clear
         * any matching pending record. Success for a DIFFERENT token leaves an
         * unrelated pending record alone.
         */
        internal fun recordSuccess(store: BillingStore, token: String) {
            if (store.pendingAckToken == token) clearPending(store)
            store.lastAckOutcome = "success"
            store.lastAckSuccessAt = System.currentTimeMillis()
        }

        private fun clearPending(store: BillingStore) {
            store.pendingAckToken = null
            store.pendingAckProductId = null
            store.pendingAckFirstFailedAt = 0L
            store.pendingAckAttempts = 0
        }

        private fun giveUp(store: BillingStore, outcome: String, token: String, attempts: Int) {
            clearPending(store)
            store.lastAckOutcome = outcome
            Log.w(
                TAG,
                "acknowledgePurchase given up ($outcome): token=…${token.takeLast(8)} after $attempts attempt(s) — " +
                    "evidence kept in billing diagnostics"
            )
        }
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val store = BillingStore(appContext)
        val token = store.pendingAckToken ?: return@withContext Result.success()
        val firstFailedAt = store.pendingAckFirstFailedAt
        val now = System.currentTimeMillis()

        // Own short-lived client — see the class header. The listener is
        // required by the builder but purchases never arrive through a worker.
        val client = BillingClient.newBuilder(appContext)
            .setListener { _, _ -> }
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .build()
        try {
            val setup = connect(client)
            if (setup.responseCode != BillingClient.BillingResponseCode.OK) {
                return@withContext when (AckRetryPolicy.decideConnectionFailure(firstFailedAt, now)) {
                    AckRetryPolicy.Decision.GIVE_UP_WINDOW -> {
                        giveUp(store, "gave_up_window", token, store.pendingAckAttempts)
                        Result.success()
                    }
                    else -> {
                        // Connection failures are never terminal (policy): count
                        // the attempt and let WorkManager's backoff space the next.
                        recordFailureAndSchedule(appContext, store, token,
                            store.pendingAckProductId, setup.responseCode, now)
                        Result.retry()
                    }
                }
            }

            // Authoritative check first: a fresh query saying isAcknowledged
            // wins over any response code (the conservative idempotence rule —
            // double-ack handling must treat "already acknowledged" as success,
            // never as an error to retry forever).
            val alreadyAcked = queryAllPurchases(client)
                .firstOrNull { it.purchaseToken == token }?.isAcknowledged == true

            val ackCode = if (alreadyAcked) AckRetryPolicy.OK else acknowledge(client, token)

            when (AckRetryPolicy.decide(ackCode, alreadyAcked, firstFailedAt, now)) {
                AckRetryPolicy.Decision.SUCCESS -> {
                    val attempts = store.pendingAckAttempts
                    recordSuccess(store, token)
                    Log.w(TAG, "acknowledgePurchase recovered on retry: token=…${token.takeLast(8)} after $attempts failed attempt(s)")
                    Result.success()
                }
                AckRetryPolicy.Decision.GIVE_UP_TERMINAL -> {
                    giveUp(store, "gave_up_terminal", token, store.pendingAckAttempts)
                    Result.success()
                }
                AckRetryPolicy.Decision.GIVE_UP_WINDOW -> {
                    giveUp(store, "gave_up_window", token, store.pendingAckAttempts)
                    Result.success()
                }
                AckRetryPolicy.Decision.RETRY -> {
                    recordFailureAndSchedule(appContext, store, token,
                        store.pendingAckProductId, ackCode, now)
                    Result.retry()
                }
            }
        } finally {
            runCatching { client.endConnection() }
        }
    }

    private suspend fun connect(client: BillingClient): BillingResult =
        suspendCancellableCoroutine { cont ->
            val resumed = AtomicBoolean(false)
            client.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(result: BillingResult) {
                    if (resumed.compareAndSet(false, true)) cont.resume(result)
                }
                override fun onBillingServiceDisconnected() {
                    // A later attempt gets a fresh client; nothing to do here.
                }
            })
        }

    private suspend fun queryAllPurchases(client: BillingClient): List<Purchase> {
        val subs = queryPurchasesForType(client, BillingClient.ProductType.SUBS)
        val inapp = queryPurchasesForType(client, BillingClient.ProductType.INAPP)
        return subs + inapp
    }

    private suspend fun queryPurchasesForType(client: BillingClient, productType: String): List<Purchase> =
        suspendCancellableCoroutine { cont ->
            client.queryPurchasesAsync(
                QueryPurchasesParams.newBuilder().setProductType(productType).build()
            ) { _, purchases -> cont.resume(purchases) }
        }

    private suspend fun acknowledge(client: BillingClient, token: String): Int =
        suspendCancellableCoroutine { cont ->
            val params = AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build()
            client.acknowledgePurchase(params) { result -> cont.resume(result.responseCode) }
        }
}
