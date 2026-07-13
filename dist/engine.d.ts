import type { BillingEvent, EntitlementSource, Prices, ProductIds, StatusReading, StorageLike, TrialInfo } from './types.js';
import type { BillingAdapter } from './adapters/types.js';
import { type EngineTimings, type StorageKeys } from './config.js';
export interface EngineConfig {
    /** Platform adapter, or null when the install is not gated (web/PWA/dev). */
    adapter: BillingAdapter | null;
    /** Defaults to localStorage (safe-wrapped). Inject for tests/headless. */
    storage?: StorageLike | null;
    /** Apps migrating an existing integration MUST pass their legacy keys. */
    storageKeys?: Partial<StorageKeys>;
    timings?: Partial<EngineTimings>;
    /**
     * App-specific reviewer-bypass secret. Omit to disable the reviewer unlock
     * entirely (an app hard-gated in a store build should NOT omit it — store
     * review needs a way in; see reviewer.ts).
     */
    reviewerSecret?: string | null;
    /**
     * OFFLINE-EXPIRY GRACE — the `graceDays` concept from
     * paywall-billing-plan.md. A different mechanism from the anti-flash
     * downgrade grace (timings.downgradeGraceMs), and disabled by default.
     *
     * Plan intent: "A paying user is never locked out offline — the grace
     * window absorbs airplane mode, dead zones, and Play outages." When set,
     * an install whose last DETERMINATE-ACTIVE reading is older than this many
     * days stops fail-open behavior: an expired last-active hint no longer
     * grants the provisional cold-launch unlock, and an indeterminate reading
     * on an unlocked install is escalated into the normal downgrade path
     * instead of being ignored. Within the window, behavior is unchanged:
     * indeterminate never re-locks.
     *
     * Two deliberate deltas from the plan's literal rule
     * (`unlocked = … || subExpiresAt + graceDays > now || …`):
     *
     * 1. ANCHOR: days since the last verified-active reading (lastVerifiedAt —
     *    which the plan's own EntitlementState also records), not days past
     *    subscription expiry. Play Billing does not expose a subscription's
     *    expiry client-side (an expired sub simply stops appearing in
     *    queryPurchases), so an expiry-anchored rule is not implementable on
     *    the plan's own primary platform without a backend. The
     *    last-verified anchor covers every backend uniformly.
     * 2. SCOPE: grace applies only while the truth is UNKNOWN (indeterminate
     *    readings / no reading). A DETERMINATE lapsed subscription still
     *    re-locks after the anti-flash hold, exactly as the proven integration
     *    behaves — the plan's literal rule would keep a knowingly-expired
     *    subscription unlocked for graceDays even online, which contradicts
     *    the authoritative shipped behavior this package preserves.
     */
    offlineGraceDays?: number;
    /**
     * Optional product-id hints, used ONLY to classify `entitlementSource`
     * ('lifetime' vs 'subscription') in the snapshot. Without them, any active
     * entitlement classifies as 'subscription'. No purchase/refresh behavior
     * depends on these.
     */
    products?: Partial<ProductIds>;
    /** Clock injection for tests. */
    now?: () => number;
}
export interface EngineState {
    status: StatusReading;
    prices: Prices;
    trial: TrialInfo;
    isLoading: boolean;
    billingEvent: BillingEvent | null;
    reviewerUnlocked: boolean;
}
export interface EngineSnapshot extends EngineState {
    /** True when this install is subject to the paywall at all. */
    gated: boolean;
    /** Entitlement only — does not include the reviewer bypass. */
    isPro: boolean;
    /** The gate the app UI should use: ungated, entitled, or reviewer-unlocked. */
    isUnlocked: boolean;
    /** Why the install is (or isn't) unlocked — see EntitlementSource. */
    entitlementSource: EntitlementSource;
    productId: string | null;
    canConsumeTestPurchase: boolean;
}
type Listener = () => void;
/**
 * Framework-agnostic entitlement engine.
 *
 * Ported from a production three-platform integration; the semantics below
 * are load-bearing and were each added in response to a real field failure:
 *
 * - applyStatus is the single gate for every entitlement reading. Asymmetric
 *   on purpose: active applies INSTANTLY and cancels any pending downgrade;
 *   a determinate inactive on a currently-unlocked install is HELD for the
 *   grace window so native self-heal (receipt re-post, syncPurchases,
 *   purchase/restore events) can win without the wall ever mounting; and
 *   indeterminate readings are ignored outright.
 * - A persisted "this install has been entitled" hint starts a
 *   previously-entitled install provisionally unlocked at first paint even
 *   when the native cache is stale; the same grace window confirms or clears
 *   it. Fresh installs have no hint — the wall shows immediately.
 * - 'success' purchase events and 'restore_complete_active' restores are only
 *   emitted after the platform validates the entitlement, so they unlock
 *   immediately rather than waiting on a possibly-stale cache read (that lag
 *   previously left the paywall up after a completed purchase).
 * - reconcile() re-reads on short delays purely to fill in the accurate
 *   productId, and applies ONLY active results — a lagging store cache right
 *   after someone paid must not even start a downgrade countdown.
 */
export declare class BillingEngine {
    private readonly adapter;
    private readonly storage;
    private readonly keys;
    private readonly timings;
    private readonly reviewerSecret;
    private readonly offlineGraceDays;
    private readonly products;
    private readonly now;
    private state;
    private snapshot;
    private readonly listeners;
    private downgradeTimer;
    private provisionalTimer;
    private purchaseTimer;
    private unbindEvents;
    private visibilityHandler;
    private stopped;
    private started;
    private readonly applyCallbacks;
    constructor(config: EngineConfig);
    private initialStatus;
    private readLastActiveHint;
    private hintGrantsProvisionalUnlock;
    /**
     * The single gate through which every entitlement reading is applied.
     * See the class doc for why it is asymmetric. Do not add call sites that
     * bypass it.
     */
    applyStatus(next: StatusReading | null | undefined): void;
    /**
     * Indeterminate readings are ignored — with one config-gated exception:
     * when offlineGraceDays is set and the last verified-active timestamp has
     * expired, an indeterminate reading on an unlocked install escalates into
     * the normal downgrade path (still subject to the anti-flash hold, still
     * cancelled by any active reading that lands first).
     */
    private onIndeterminate;
    /**
     * Re-read entitlement from the authoritative platform source after a
     * CONFIRMED purchase or restore, purely to fill in the accurate productId.
     * Applies ONLY active results — never re-locks, never starts a countdown.
     */
    private reconcile;
    private handleBillingEvent;
    start(): void;
    stop(): void;
    refresh(): void;
    purchase(productId: string): void;
    restore(): void;
    consumeTestPurchase(): void;
    clearBillingEvent(): void;
    private restoreReviewerUnlock;
    /** Validates input against this month's code; stores its hash on success. */
    setReviewerUnlocked(input: string): Promise<boolean>;
    subscribe: (listener: Listener) => (() => void);
    getSnapshot: () => EngineSnapshot;
    private setState;
    private buildSnapshot;
}
export {};
