// Android adapter: Google Play Billing via a synchronous WebView JS interface.
//
// NOTE this platform does NOT use RevenueCat at all — the native layer talks
// to Play Billing directly and caches results in SharedPreferences, which the
// injected bridge object reads synchronously. Purchase/restore outcomes are
// delivered via the shared window event global (default '__billingEvent').
export function createAndroidWebViewAdapter(opts) {
    const { bridge, products } = opts;
    const eventGlobal = opts.eventGlobal ?? '__billingEvent';
    const mountTrialRereadMs = opts.timings?.mountTrialRereadMs ?? 3000;
    const refreshSettleMs = opts.timings?.refreshSettleMs ?? 2000;
    const restoreSettleMs = opts.timings?.restoreSettleMs ?? 4000;
    const readCachedStatus = () => {
        try {
            return JSON.parse(bridge.getStatus());
        }
        catch {
            return { active: false, productId: null };
        }
    };
    const readPrices = () => {
        try {
            const p = JSON.parse(bridge.getProductPrices());
            // The bridge returns { annual, lifetime } — remap annual→yearly for the
            // unified shape.
            return { yearly: p.annual || null, lifetime: p.lifetime || null };
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
            days = typeof p.annualTrialDays === 'number' && p.annualTrialDays > 0
                ? p.annualTrialDays
                : null;
        }
        catch {
            days = null;
        }
        return { eligible, days };
    };
    return {
        platform: 'android',
        cachedReads: true,
        readCachedStatus,
        checkStatus: () => Promise.resolve(readCachedStatus()),
        readPrices,
        readTrial,
        onMount(apply) {
            bridge.refresh?.();
            // Re-read trial eligibility after a delay — the native billing client
            // queries Play async, so the initial read may predate the result.
            setTimeout(() => { apply.setTrial(readTrial()); }, mountTrialRereadMs);
        },
        refresh(apply) {
            bridge.refresh?.();
            setTimeout(() => {
                apply.applyStatus(readCachedStatus());
                apply.setPrices(readPrices());
            }, refreshSettleMs);
        },
        purchase(productId) {
            bridge.purchase?.(productId);
        },
        restore(apply) {
            // Play Billing has no restore API — a re-query IS the restore. Kick it,
            // give it time to settle, then re-read and emit the shared settle event.
            // A re-read that shows an active entitlement settles as
            // 'restore_complete_active' so the engine unlocks optimistically —
            // matching the iOS/Electron contract (historically Android only ever
            // emitted 'restore_complete' and relied on the status re-read alone).
            bridge.refresh?.();
            apply.setLoading(true);
            setTimeout(() => {
                const s = readCachedStatus();
                apply.applyStatus(s);
                apply.setPrices(readPrices());
                apply.setLoading(false);
                apply.emitBillingEvent({
                    status: 'cancelled', // mirrors the shared restore pattern: spinner clears, no "new purchase" UI
                    code: 0,
                    message: s.active ? 'restore_complete_active' : 'restore_complete',
                    productId: s.active ? (s.productId ?? '') : '',
                });
            }, restoreSettleMs);
        },
        bindEvents(apply) {
            const w = globalThis;
            w[eventGlobal] = (ev) => apply.emitBillingEvent(ev);
            return () => { delete w[eventGlobal]; };
        },
        consumeTestPurchase: typeof bridge.consumeTestPurchase === 'function'
            ? () => bridge.consumeTestPurchase?.()
            : undefined,
    };
}
