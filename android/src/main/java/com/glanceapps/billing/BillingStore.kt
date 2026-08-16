package com.glanceapps.billing

import android.content.Context
import android.content.SharedPreferences

/**
 * The module's own persisted billing state: the status/price cache the
 * JS-facing plugin answers from, plus the durable pending-acknowledgement
 * record and its diagnostics.
 *
 * This is the package equivalent of the host app's data store (dayGLANCE's
 * `SharedDataStore`). It exists as a separate class rather than as private
 * fields on [PlayBillingCore] because [AckRetryWorker] runs without a core
 * instance — WorkManager may execute it long after the activity, the plugin
 * and the core are gone — and it must read and settle the same record.
 *
 * NO PER-APP NAMESPACING, deliberately. SharedPreferences files live in the
 * app's own sandbox, so lastGLANCE and lifeGLANCE each get their own copy of
 * `glance_billing_cache` and cannot collide; the file name is also distinct
 * from either app's own preferences. Namespacing keys per consuming app would
 * buy nothing and would break the 0.2.1 → 0.2.2 upgrade below.
 *
 * KEY NAMES ARE FROZEN. They are exactly the strings 0.2.1 wrote, so an app
 * upgrading to 0.2.2 keeps its cached entitlement and does not show a
 * subscription wall to a paying user on first launch after the update.
 *
 * Always constructed with an application context (see [PlayBillingCore]).
 */
internal class BillingStore(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ── Status / price cache (0.2.1 keys, unchanged) ──────────────────────────

    var subscriptionActive: Boolean
        get() = prefs.getBoolean(KEY_ACTIVE, false)
        set(value) = prefs.edit().putBoolean(KEY_ACTIVE, value).apply()

    var subscriptionProductId: String?
        get() = prefs.getString(KEY_PRODUCT_ID, null)
        set(value) = prefs.edit().run {
            if (value == null) remove(KEY_PRODUCT_ID) else putString(KEY_PRODUCT_ID, value)
            apply()
        }

    var subscriptionToken: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().run {
            if (value == null) remove(KEY_TOKEN) else putString(KEY_TOKEN, value)
            apply()
        }

    var priceAnnual: String?
        get() = prefs.getString(KEY_PRICE_ANNUAL, null)
        set(value) = prefs.edit().putString(KEY_PRICE_ANNUAL, value).apply()

    var priceLifetime: String?
        get() = prefs.getString(KEY_PRICE_LIFETIME, null)
        set(value) = prefs.edit().putString(KEY_PRICE_LIFETIME, value).apply()

    var trialEligibleAnnual: Boolean
        get() = prefs.getBoolean(KEY_TRIAL_ELIGIBLE, true)
        set(value) = prefs.edit().putBoolean(KEY_TRIAL_ELIGIBLE, value).apply()

    var trialDaysAnnual: Int
        get() = prefs.getInt(KEY_TRIAL_DAYS, -1)
        set(value) = prefs.edit().putInt(KEY_TRIAL_DAYS, value).apply()

    // ── Pending acknowledgement (new in 0.2.2) ───────────────────────────────
    //
    // The durable obligation. Written the moment an ack fails; cleared only by
    // a success, a terminal response, or the three-day window expiring. This
    // record — not WorkManager's own state — is the single source of truth for
    // WHAT still needs acknowledging, which is why scheduling is idempotent.

    var pendingAckToken: String?
        get() = prefs.getString(KEY_PENDING_ACK_TOKEN, null)
        set(value) = prefs.edit().run {
            if (value == null) remove(KEY_PENDING_ACK_TOKEN) else putString(KEY_PENDING_ACK_TOKEN, value)
            apply()
        }

    var pendingAckProductId: String?
        get() = prefs.getString(KEY_PENDING_ACK_PRODUCT_ID, null)
        set(value) = prefs.edit().run {
            if (value == null) remove(KEY_PENDING_ACK_PRODUCT_ID) else putString(KEY_PENDING_ACK_PRODUCT_ID, value)
            apply()
        }

    /** Epoch ms of the FIRST failed ack for the pending token — anchors the window. */
    var pendingAckFirstFailedAt: Long
        get() = prefs.getLong(KEY_PENDING_ACK_FIRST_FAILED_AT, 0L)
        set(value) = prefs.edit().putLong(KEY_PENDING_ACK_FIRST_FAILED_AT, value).apply()

    var pendingAckAttempts: Int
        get() = prefs.getInt(KEY_PENDING_ACK_ATTEMPTS, 0)
        set(value) = prefs.edit().putInt(KEY_PENDING_ACK_ATTEMPTS, value).apply()

    // ── Acknowledgement diagnostics ──────────────────────────────────────────
    //
    // Evidence kept after the pending record is cleared, so a give-up can be
    // explained after the fact. lastAckOutcome: "success" | "retrying" |
    // "gave_up_terminal" | "gave_up_window". Kotlin-side only in 0.2.2 — these
    // reach logcat and survive in prefs, but no plugin method exposes them to
    // JS yet.

    var lastAckOutcome: String?
        get() = prefs.getString(KEY_LAST_ACK_OUTCOME, null)
        set(value) = prefs.edit().putString(KEY_LAST_ACK_OUTCOME, value).apply()

    var lastAckFailureCode: Int
        get() = prefs.getInt(KEY_LAST_ACK_FAILURE_CODE, 0)
        set(value) = prefs.edit().putInt(KEY_LAST_ACK_FAILURE_CODE, value).apply()

    var lastAckFailureAt: Long
        get() = prefs.getLong(KEY_LAST_ACK_FAILURE_AT, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_ACK_FAILURE_AT, value).apply()

    var lastAckSuccessAt: Long
        get() = prefs.getLong(KEY_LAST_ACK_SUCCESS_AT, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_ACK_SUCCESS_AT, value).apply()

    /** Clears the cached entitlement in one write (status wall reappears immediately). */
    fun clearSubscription() {
        prefs.edit()
            .putBoolean(KEY_ACTIVE, false)
            .remove(KEY_PRODUCT_ID)
            .remove(KEY_TOKEN)
            .apply()
    }

    companion object {
        private const val PREFS = "glance_billing_cache"

        // 0.2.1 keys — do not rename (see class header).
        private const val KEY_ACTIVE = "subscription_active"
        private const val KEY_PRODUCT_ID = "subscription_product_id"
        private const val KEY_TOKEN = "subscription_token"
        private const val KEY_PRICE_ANNUAL = "price_annual"
        private const val KEY_PRICE_LIFETIME = "price_lifetime"
        private const val KEY_TRIAL_ELIGIBLE = "trial_eligible_annual"
        private const val KEY_TRIAL_DAYS = "trial_days_annual"

        // 0.2.2 additions.
        private const val KEY_PENDING_ACK_TOKEN = "pending_ack_token"
        private const val KEY_PENDING_ACK_PRODUCT_ID = "pending_ack_product_id"
        private const val KEY_PENDING_ACK_FIRST_FAILED_AT = "pending_ack_first_failed_at"
        private const val KEY_PENDING_ACK_ATTEMPTS = "pending_ack_attempts"
        private const val KEY_LAST_ACK_OUTCOME = "last_ack_outcome"
        private const val KEY_LAST_ACK_FAILURE_CODE = "last_ack_failure_code"
        private const val KEY_LAST_ACK_FAILURE_AT = "last_ack_failure_at"
        private const val KEY_LAST_ACK_SUCCESS_AT = "last_ack_success_at"
    }
}
