// iOS adapter: RevenueCat SDK (StoreKit 2 backend) behind a synchronous
// WKURLSchemeHandler bridge. Bridge calls return RevenueCat's CACHED customer
// info so the JS thread never blocks; the native layer refreshes in the
// background and self-heals entitlement transfers (syncPurchases) on its own.
// Purchase/restore outcomes arrive via the shared window event global.
export function createIOSWebViewAdapter(opts) {
    const { bridge, products } = opts;
    const eventGlobal = opts.eventGlobal ?? '__billingEvent';
    const mountRereadMs = opts.timings?.mountRereadMs ?? 3000;
    const refreshSettleMs = opts.timings?.refreshSettleMs ?? 2000;
    const readCachedStatus = () => {
        try {
            return JSON.parse(bridge.getSubscriptionStatus());
        }
        catch {
            return { active: false, productId: null };
        }
    };
    const readPrices = () => {
        try {
            const p = JSON.parse(bridge.getProductPrices());
            return { yearly: p.yearly || null, lifetime: p.lifetime || null };
        }
        catch {
            return { yearly: null, lifetime: null };
        }
    };
    const readTrial = () => {
        let eligible = true;
        try {
            const data = JSON.parse(bridge.getTrialEligibility());
            // Only treat as ineligible when the bridge explicitly returns false.
            eligible = data?.[products.yearly] !== false;
        }
        catch {
            eligible = true;
        }
        let days = null;
        try {
            const p = JSON.parse(bridge.getProductPrices());
            days = typeof p.yearlyTrialDays === 'number' && p.yearlyTrialDays > 0
                ? p.yearlyTrialDays
                : null;
        }
        catch {
            days = null;
        }
        return { eligible, days };
    };
    return {
        platform: 'ios',
        cachedReads: true,
        readCachedStatus,
        checkStatus: () => Promise.resolve(readCachedStatus()),
        readPrices,
        readTrial,
        onMount(apply) {
            // RevenueCat caches status; re-read after a short delay so it has had
            // time to refresh from its background network call.
            setTimeout(() => {
                apply.applyStatus(readCachedStatus());
                apply.setPrices(readPrices());
                apply.setTrial(readTrial());
            }, mountRereadMs);
        },
        refresh(apply) {
            setTimeout(() => {
                apply.applyStatus(readCachedStatus());
                apply.setPrices(readPrices());
            }, refreshSettleMs);
        },
        purchase(productId) {
            bridge.purchase?.(productId);
        },
        restore() {
            // Result fires via the event global: 'restore_complete_active' or
            // 'restore_complete', both as status 'cancelled'.
            bridge.restorePurchases?.();
        },
        bindEvents(apply) {
            const w = globalThis;
            w[eventGlobal] = (ev) => apply.emitBillingEvent(ev);
            return () => { delete w[eventGlobal]; };
        },
    };
}
