// Capacitor adapter: drives the BillingBridge Capacitor plugin shipped in this
// package's android/ directory (Play Billing direct — no RevenueCat, same as
// the Android WebView integration it was ported from).
//
// Capacitor plugin calls are Promise-based, so — like Electron — this adapter
// has no synchronous native read. It keeps a localStorage mirror of the last
// applied reading for cold-launch state, and the engine's last-active hint +
// provisional unlock cover the first paint. `cachedReads` is therefore false.
//
// This adapter is written against the plugin contract in android/ and the
// integration guide in README.md. It has not yet shipped in a production app;
// the WebView adapters have.
//
// Two native capabilities are opt-in (0.2.4), so a plugin that predates them,
// the Android one in this package included, drives this adapter exactly as
// 0.2.3 did:
//
// - REFRESH COMPLETION. A plugin whose initialize() resolves
//   `{ refreshReportsCompletion: true }` promises that refresh() resolves only
//   once its re-query has finished and getStatus() reflects it. Restore and
//   the foreground refresh then read when the work is done, instead of after
//   restoreSettleMs / refreshSettleMs, which were guesses at how long it
//   takes. A slow sync used to be read before it finished, and Restore told a
//   paying customer it had found nothing. Without the flag the timers decide,
//   as before. The mount sequence is unchanged either way (see onMount).
// - STATUS PUSHES. A 'billingStatus' event carrying `{ active, productId }` is
//   applied as a status reading, ACTIVE ONLY (see ./statusChannel.ts). A
//   plugin that never emits it changes nothing.
import { SafeStorage } from '../storage.js';
import { activeOnlyReading } from './statusChannel.js';
export function createCapacitorAdapter(opts) {
    const { plugin, products } = opts;
    const storage = new SafeStorage(opts.storage ?? undefined);
    const statusCacheKey = opts.statusCacheKey ?? 'glance-billing.capacitor-status';
    const restoreSettleMs = opts.timings?.restoreSettleMs ?? 4000;
    const refreshSettleMs = opts.timings?.refreshSettleMs ?? 2000;
    const mountRereadMs = opts.timings?.mountRereadMs ?? 3000;
    const refreshCompletionCapMs = opts.timings?.refreshCompletionCapMs ?? 30_000;
    // Learned from initialize(); false until it says otherwise, so a restore
    // tapped before it resolves, and every plugin that never says, keeps the
    // 0.2.3 timers.
    let refreshReportsCompletion = false;
    Promise.resolve(plugin.initialize({
        yearlyProductId: products.yearly,
        lifetimeProductId: products.lifetime,
    })).then((result) => {
        refreshReportsCompletion = !!result && result.refreshReportsCompletion === true;
    }).catch(() => { });
    /**
     * Run `read` once the refresh `kick` has done its work. A plugin that
     * reports completion is read when kick settles (resolved or rejected: either
     * way the native work is over), capped by refreshCompletionCapMs; any other
     * plugin is read after `legacySettleMs`, exactly as in 0.2.3.
     */
    const whenRefreshed = (kick, legacySettleMs, read) => {
        if (!refreshReportsCompletion) {
            kick.catch(() => { });
            setTimeout(read, legacySettleMs);
            return;
        }
        let done = false;
        const settle = () => {
            if (done)
                return;
            done = true;
            clearTimeout(cap);
            read();
        };
        const cap = setTimeout(settle, refreshCompletionCapMs);
        kick.then(settle, settle);
    };
    const readCachedStatus = () => {
        try {
            const raw = storage.getItem(statusCacheKey);
            if (raw)
                return JSON.parse(raw);
        }
        catch {
            /* fall through */
        }
        return { active: false, productId: null };
    };
    const checkStatus = async () => {
        const s = await plugin.getStatus();
        return { active: !!s.active, productId: s.productId ?? null };
    };
    const fetchTrial = async () => {
        let eligible = true;
        try {
            const data = await plugin.getTrialEligibility();
            eligible = data?.[products.yearly] !== false;
        }
        catch {
            eligible = true;
        }
        let days = null;
        try {
            const p = await plugin.getProductPrices();
            days = typeof p.yearlyTrialDays === 'number' && p.yearlyTrialDays > 0
                ? p.yearlyTrialDays
                : null;
        }
        catch {
            days = null;
        }
        return { eligible, days };
    };
    const pushPricesAndTrial = (apply) => {
        plugin.getProductPrices().then((p) => {
            apply.setPrices({ yearly: p.yearly ?? null, lifetime: p.lifetime ?? null });
        }).catch(() => { });
        fetchTrial().then((t) => apply.setTrial(t)).catch(() => { });
    };
    return {
        platform: 'capacitor',
        cachedReads: false,
        readCachedStatus,
        checkStatus,
        readPrices: () => ({ yearly: null, lifetime: null }),
        readTrial: () => ({ eligible: true, days: null }),
        onMount(apply) {
            // Deliberately NOT completion-aware: the mount sequence stays exactly
            // two status reads (now and at mountRereadMs). The iOS plugin's Debug
            // `-GlanceBillingStartLocked` override counts those two reads to open
            // the app at the paywall; a third mount read would unlock it by itself.
            plugin.refresh().catch(() => { });
            checkStatus().then(apply.applyStatus).catch(() => { });
            setTimeout(() => {
                checkStatus().then(apply.applyStatus).catch(() => { });
                pushPricesAndTrial(apply);
            }, mountRereadMs);
        },
        refresh(apply) {
            whenRefreshed(plugin.refresh(), refreshSettleMs, () => {
                checkStatus().then(apply.applyStatus).catch(() => { });
                plugin.getProductPrices().then((p) => {
                    apply.setPrices({ yearly: p.yearly ?? null, lifetime: p.lifetime ?? null });
                }).catch(() => { });
            });
        },
        purchase(productId) {
            plugin.purchase({ productId }).catch(() => { });
        },
        restore(apply) {
            // Play Billing has no restore API — a re-query IS the restore. Same
            // settle pattern as the WebView Android adapter, including the
            // 'restore_complete_active' contract. The read happens once the native
            // re-query has finished when the plugin reports that, otherwise after
            // restoreSettleMs.
            const kick = plugin.refresh();
            apply.setLoading(true);
            whenRefreshed(kick, restoreSettleMs, () => {
                checkStatus()
                    .then((s) => {
                    apply.applyStatus(s);
                    apply.setLoading(false);
                    apply.emitBillingEvent({
                        status: 'cancelled',
                        code: 0,
                        message: s.active ? 'restore_complete_active' : 'restore_complete',
                        productId: s.active ? (s.productId ?? '') : '',
                    });
                })
                    .catch(() => {
                    apply.setLoading(false);
                    apply.emitBillingEvent({
                        status: 'cancelled', code: 0, message: 'restore_complete', productId: '',
                    });
                });
            });
        },
        bindEvents(apply) {
            let removed = false;
            const removeFns = [];
            const hold = (registration) => {
                Promise.resolve(registration)
                    .then((handle) => {
                    removeFns.push(handle.remove);
                    if (removed)
                        void handle.remove();
                })
                    .catch(() => { });
            };
            hold(plugin.addListener('billingEvent', (ev) => apply.emitBillingEvent(ev)));
            // Pushed readings go to the gate, never through emitBillingEvent: they
            // are not purchase outcomes, so they must not touch the paywall's event
            // state, a restore spinner, or an in-flight purchase's timeout.
            hold(plugin.addListener('billingStatus', (update) => {
                const reading = activeOnlyReading(update);
                if (reading)
                    apply.applyStatus(reading);
            }));
            return () => {
                removed = true;
                for (const remove of removeFns)
                    void remove();
            };
        },
        persistStatusCache(reading) {
            try {
                storage.setItem(statusCacheKey, JSON.stringify(reading));
            }
            catch {
                /* best-effort mirror */
            }
        },
        consumeTestPurchase: typeof plugin.consumeTestPurchase === 'function'
            ? () => { void plugin.consumeTestPurchase?.(); }
            : undefined,
    };
}
