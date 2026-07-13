// Electron renderer adapter: StoreKit purchases + RevenueCat REST entitlement
// checks live in the MAIN process (see ../electron-main); the renderer talks
// to them over IPC. Status is therefore ASYNC — this adapter keeps a
// localStorage mirror of the last applied reading so the engine has a
// synchronous last-known-good state at cold launch, before the first IPC
// answer arrives.
//
// The main-process check can legitimately return `indeterminate: true` (no
// App Store receipt materialized yet — very common on a cold launch — or a
// network/RevenueCat failure). The engine ignores those, which is exactly why
// this path never flashes the wall on an entitled install.
import { SafeStorage } from '../storage.js';
export function createElectronRendererAdapter(opts) {
    const { api } = opts;
    const storage = new SafeStorage(opts.storage ?? undefined);
    const statusCacheKey = opts.statusCacheKey ?? 'glance-billing.electron-status';
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
    const applyPricesPayload = (apply, p) => {
        apply.setPrices({ yearly: p.yearly ?? null, lifetime: p.lifetime ?? null });
        if (typeof p.yearlyTrialDays === 'number' && p.yearlyTrialDays > 0) {
            apply.setTrial({ days: p.yearlyTrialDays });
        }
    };
    return {
        platform: 'electron',
        cachedReads: false,
        readCachedStatus,
        checkStatus: () => api.subscriptionStatus(),
        // Prices arrive async (push at startup + pull on mount) — the sync read
        // must return nulls, never clobber already-delivered prices.
        readPrices: () => ({ yearly: null, lifetime: null }),
        readTrial: () => ({ eligible: true, days: null }),
        onMount(apply) {
            // The engine's gate ignores indeterminate results (main process couldn't
            // verify), applies active instantly, and holds a determinate inactive
            // for the grace window before locking — so an entitled install never
            // flashes the wall.
            api.subscriptionStatus().then(apply.applyStatus).catch(() => { });
            // PULL cached prices in addition to listening for the startup push. The
            // push can fire before the renderer registers its listener (Electron
            // drops renderer-directed messages sent before a listener exists), which
            // historically left the price stuck on "Loading…". The pull recovers
            // prices already fetched; if the fetch hasn't finished yet, the push
            // still delivers them.
            api.subscriptionPrices?.().then((p) => {
                if (p && (p.yearly || p.lifetime))
                    applyPricesPayload(apply, p);
            }).catch(() => { });
        },
        refresh(apply) {
            api.subscriptionStatus().then(apply.applyStatus).catch(() => { });
        },
        purchase(productId) {
            api.subscriptionPurchase(productId).catch(() => { });
        },
        restore() {
            // Settlement arrives via the event push: 'restore_complete_active' or
            // 'restore_complete' (dual-path settled in the main process).
            api.subscriptionRestore().catch(() => { });
        },
        bindEvents(apply) {
            const unsubEvents = api.onSubscriptionEvent((ev) => apply.emitBillingEvent(ev));
            const unsubPrices = api.onSubscriptionPricesReady((p) => applyPricesPayload(apply, p));
            return () => { unsubEvents(); unsubPrices(); };
        },
        persistStatusCache(reading) {
            try {
                storage.setItem(statusCacheKey, JSON.stringify(reading));
            }
            catch {
                /* best-effort mirror */
            }
        },
    };
}
