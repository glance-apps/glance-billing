import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { BillingEngine } from './engine.js';
import { billingErrorMessage } from './errors.js';
/**
 * React binding for the billing engine.
 *
 * `createConfig` runs once per mounted component; the engine instance is
 * stable for the component's lifetime (StrictMode-safe: start/stop are
 * idempotent and re-entrant). Platform detection and adapter construction
 * belong in the app, module-level, so the same adapter feeds every mount.
 */
export function useBilling(createConfig) {
    const engineRef = useRef(null);
    if (engineRef.current === null) {
        engineRef.current = new BillingEngine(createConfig());
    }
    const engine = engineRef.current;
    const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
    useEffect(() => {
        engine.start();
        return () => engine.stop();
    }, [engine]);
    const actions = useMemo(() => ({
        subscribe: (productId) => engine.purchase(productId),
        restore: () => engine.restore(),
        refresh: () => engine.refresh(),
        consumeTestPurchase: () => engine.consumeTestPurchase(),
        clearBillingEvent: () => engine.clearBillingEvent(),
        setReviewerUnlocked: (input) => engine.setReviewerUnlocked(input),
    }), [engine]);
    return {
        isPro: snapshot.isPro,
        gated: snapshot.gated,
        isUnlocked: snapshot.isUnlocked,
        entitlementSource: snapshot.entitlementSource,
        productId: snapshot.productId,
        prices: snapshot.prices,
        trialEligible: snapshot.trial.eligible,
        trialDays: snapshot.trial.days,
        isLoading: snapshot.isLoading,
        billingEvent: snapshot.billingEvent,
        isReviewerUnlocked: snapshot.reviewerUnlocked,
        canConsumeTestPurchase: snapshot.canConsumeTestPurchase,
        ...actions,
        billingErrorMessage,
    };
}
