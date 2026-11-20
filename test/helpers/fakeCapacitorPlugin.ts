// A scriptable BillingBridge plugin for the Capacitor adapter tests.
//
// Two native shapes matter:
//
// - 'android' (and the iOS plugin before 0.2.4): initialize() and refresh()
//   resolve immediately with nothing; the re-query refresh() starts lands in
//   the status cache some time later, and nothing says when. Play's
//   queryPurchases is async this way (BillingBridgePlugin.kt resolves refresh
//   before PlayBillingCore.queryPurchases finishes).
// - 'completion': initialize() resolves { refreshReportsCompletion: true } and
//   each refresh() resolves only when the test settles it, the way the iOS
//   plugin reports its RevenueCat re-query from 0.2.4.
//
// Every call is logged with the fake clock's time, so two adapters driven
// through the same script can be compared call for call.

import type {
  CapacitorBillingEvents,
  CapacitorBillingPlugin,
  CapacitorInitializeResult,
} from '../../src/adapters/capacitor.js';

type Status = { active: boolean; productId: string | null };

export interface FakePluginOptions {
  shape: 'android' | 'completion';
  /** Android shape: ms after a refresh() kick before the status cache changes. */
  queryLatencyMs?: number;
  initialStatus?: Status;
}

export function fakeCapacitorPlugin(opts: FakePluginOptions) {
  let status: Status = opts.initialStatus ?? { active: false, productId: null };
  // What the native store will report once the next re-query lands.
  let truth: Status = status;
  let queryLatencyMs = opts.queryLatencyMs ?? 0;
  const log: string[] = [];
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const pendingRefreshes: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  const note = (entry: string) => log.push(`${Date.now()} ${entry}`);

  const plugin: CapacitorBillingPlugin = {
    initialize(o) {
      note(`initialize ${o.yearlyProductId} ${o.lifetimeProductId}`);
      const result: CapacitorInitializeResult | void =
        opts.shape === 'completion' ? { refreshReportsCompletion: true } : undefined;
      return Promise.resolve(result);
    },
    getStatus() {
      note(`getStatus -> ${JSON.stringify(status)}`);
      return Promise.resolve({ ...status });
    },
    refresh() {
      note('refresh');
      if (opts.shape === 'android') {
        const landing = truth;
        setTimeout(() => { status = landing; }, queryLatencyMs);
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => { pendingRefreshes.push({ resolve, reject }); });
    },
    purchase(o) {
      note(`purchase ${o.productId}`);
      return Promise.resolve();
    },
    getProductPrices() {
      note('getProductPrices');
      return Promise.resolve({ yearly: '$10', lifetime: '$30', yearlyTrialDays: 7 });
    },
    getTrialEligibility() {
      note('getTrialEligibility');
      return Promise.resolve({ app_pro_annual: true });
    },
    addListener<E extends keyof CapacitorBillingEvents>(
      eventName: E,
      listener: (event: CapacitorBillingEvents[E]) => void,
    ) {
      note(`addListener ${eventName}`);
      const set = listeners.get(eventName) ?? new Set();
      const fn = listener as (data: unknown) => void;
      set.add(fn);
      listeners.set(eventName, set);
      return Promise.resolve({
        remove: () => {
          note(`removeListener ${eventName}`);
          set.delete(fn);
          return Promise.resolve();
        },
      });
    },
  };

  return {
    plugin,
    log,
    /** Android shape: how long the next re-queries take to land. */
    setQueryLatency(ms: number) { queryLatencyMs = ms; },
    /** What the store will report once a re-query lands. */
    setTruth(s: Status) { truth = s; },
    /** Change the cached status directly (a re-query that already landed). */
    setStatus(s: Status) { status = s; truth = s; },
    /** Completion shape: finish the oldest outstanding refresh, landing `truth` first. */
    finishRefresh(outcome: 'resolve' | 'reject' = 'resolve') {
      const next = pendingRefreshes.shift();
      if (!next) throw new Error('no refresh outstanding');
      status = truth;
      if (outcome === 'resolve') next.resolve(); else next.reject(new Error('native refresh failed'));
    },
    outstandingRefreshes: () => pendingRefreshes.length,
    emit(eventName: string, data: unknown) {
      note(`emit ${eventName} ${JSON.stringify(data)}`);
      for (const fn of listeners.get(eventName) ?? []) fn(data);
    },
    listenerCount: (eventName: string) => listeners.get(eventName)?.size ?? 0,
  };
}

/** In-memory StorageLike that counts writes. */
export class CountingStorage {
  map = new Map<string, string>();
  writes: string[] = [];
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.writes.push(k); this.map.set(k, v); }
  removeItem(k: string) { this.writes.push(`-${k}`); this.map.delete(k); }
}
