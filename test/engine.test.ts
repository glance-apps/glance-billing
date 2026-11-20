// Engine semantics tests. Each block encodes a rule that was added to the
// original integration in response to a real field failure — if one of these
// starts failing after a refactor, the refactor almost certainly reintroduced
// a shipped bug.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingEngine, type EngineConfig } from '../src/engine.js';
import type { BillingAdapter } from '../src/adapters/types.js';
import type { StatusReading, StorageLike } from '../src/types.js';
import { BILLING_CODE_PENDING, BILLING_CODE_UNCONFIRMED } from '../src/errors.js';
import * as index from '../src/index.js';

class MemStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

interface FakeAdapterOptions {
  cached?: StatusReading;
  checkResults?: StatusReading[];
}

function makeAdapter(opts: FakeAdapterOptions = {}) {
  let cached: StatusReading = opts.cached ?? { active: false, productId: null };
  const checkQueue = [...(opts.checkResults ?? [])];
  const persisted: StatusReading[] = [];
  const adapter: BillingAdapter & {
    setCached(s: StatusReading): void;
    persisted: StatusReading[];
    purchases: string[];
  } = {
    platform: 'android',
    cachedReads: true,
    purchases: [],
    persisted,
    setCached(s) { cached = s; },
    readCachedStatus: () => cached,
    checkStatus: () => Promise.resolve(checkQueue.length ? checkQueue.shift()! : cached),
    readPrices: () => ({ yearly: '$1', lifetime: '$2' }),
    readTrial: () => ({ eligible: true, days: 14 }),
    onMount: () => {},
    refresh: () => {},
    purchase(id) { adapter.purchases.push(id); },
    restore: () => {},
    bindEvents: () => () => {},
    persistStatusCache: (r) => { persisted.push(r); },
  };
  return adapter;
}

function makeEngine(adapter: BillingAdapter | null, extra: Partial<EngineConfig> = {}) {
  const storage = (extra.storage as MemStorage | undefined) ?? new MemStorage();
  const engine = new BillingEngine({ adapter, storage, ...extra });
  return { engine, storage };
}

const GRACE = 12_000;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('asymmetric downgrade grace (anti-flash)', () => {
  it('applies inactive→active instantly', () => {
    const adapter = makeAdapter();
    const { engine } = makeEngine(adapter);
    engine.start();
    expect(engine.getSnapshot().isPro).toBe(false);
    engine.applyStatus({ active: true, productId: 'p1' });
    expect(engine.getSnapshot().isPro).toBe(true);
    expect(engine.getSnapshot().productId).toBe('p1');
  });

  it('holds active→inactive for the grace window, then locks', () => {
    const adapter = makeAdapter({ cached: { active: true, productId: 'p1' } });
    const { engine } = makeEngine(adapter);
    engine.start();
    expect(engine.getSnapshot().isPro).toBe(true);

    engine.applyStatus({ active: false, productId: null });
    expect(engine.getSnapshot().isPro).toBe(true); // still unlocked — held

    vi.advanceTimersByTime(GRACE - 1);
    expect(engine.getSnapshot().isPro).toBe(true);

    vi.advanceTimersByTime(1);
    expect(engine.getSnapshot().isPro).toBe(false); // genuinely lapsed → locks
  });

  it('an active reading during the hold cancels the downgrade', () => {
    const adapter = makeAdapter({ cached: { active: true, productId: 'p1' } });
    const { engine } = makeEngine(adapter);
    engine.start();

    engine.applyStatus({ active: false, productId: null });
    vi.advanceTimersByTime(GRACE / 2);
    engine.applyStatus({ active: true, productId: 'p1' }); // self-heal wins
    vi.advanceTimersByTime(GRACE * 2);
    expect(engine.getSnapshot().isPro).toBe(true);
  });

  it('ignores indeterminate readings outright — forever, when offline grace is off', () => {
    const adapter = makeAdapter({ cached: { active: true, productId: 'p1' } });
    const { engine } = makeEngine(adapter);
    engine.start();

    engine.applyStatus({ active: false, productId: null, indeterminate: true });
    vi.advanceTimersByTime(365 * 86_400_000); // a year of indeterminate = still unlocked
    expect(engine.getSnapshot().isPro).toBe(true);
  });

  it('a second inactive reading does not restart a pending hold', () => {
    const adapter = makeAdapter({ cached: { active: true, productId: 'p1' } });
    const { engine } = makeEngine(adapter);
    engine.start();

    engine.applyStatus({ active: false, productId: null });
    vi.advanceTimersByTime(GRACE - 1000);
    engine.applyStatus({ active: false, productId: null }); // must not extend the hold
    vi.advanceTimersByTime(1000);
    expect(engine.getSnapshot().isPro).toBe(false);
  });

  it('persists the last-active hint on unlock and clears it on confirmed lock', () => {
    const storage = new MemStorage();
    const adapter = makeAdapter();
    const { engine } = makeEngine(adapter, { storage });
    engine.start();

    engine.applyStatus({ active: true, productId: 'p1' });
    expect(storage.getItem('glance-billing.last-active')).toContain('"p1"');

    engine.applyStatus({ active: false, productId: null });
    vi.advanceTimersByTime(GRACE);
    expect(storage.getItem('glance-billing.last-active')).toBeNull();
    expect(adapter.persisted.at(-1)).toEqual({ active: false, productId: null });
  });
});

describe('provisional cold-launch unlock', () => {
  it('starts provisionally unlocked when the hint exists and the cache is stale-inactive', () => {
    const storage = new MemStorage();
    storage.setItem('glance-billing.last-active', JSON.stringify({ productId: 'p1' }));
    const adapter = makeAdapter({ cached: { active: false, productId: null } });
    const { engine } = makeEngine(adapter, { storage });

    expect(engine.getSnapshot().isPro).toBe(true); // no flash at first paint
    engine.start();

    // Cache still inactive at confirmation time → confirm applies inactive
    // through the gate → held for one more grace window, then locks.
    vi.advanceTimersByTime(GRACE);       // confirmation re-read fires
    expect(engine.getSnapshot().isPro).toBe(true);
    vi.advanceTimersByTime(GRACE);       // downgrade hold elapses
    expect(engine.getSnapshot().isPro).toBe(false);
  });

  it('confirms the provisional unlock when the cache recovers', () => {
    const storage = new MemStorage();
    storage.setItem('glance-billing.last-active', JSON.stringify({ productId: 'p1' }));
    const adapter = makeAdapter({ cached: { active: false, productId: null } });
    const { engine } = makeEngine(adapter, { storage });
    engine.start();

    adapter.setCached({ active: true, productId: 'p1' }); // native self-heal landed
    vi.advanceTimersByTime(GRACE);
    expect(engine.getSnapshot().isPro).toBe(true);
    vi.advanceTimersByTime(GRACE * 3);
    expect(engine.getSnapshot().isPro).toBe(true);
  });

  it('fresh install (no hint): locked immediately, no provisional unlock', () => {
    const adapter = makeAdapter();
    const { engine } = makeEngine(adapter);
    expect(engine.getSnapshot().isPro).toBe(false);
  });

  it('accepts legacy hints without verifiedAt (pre-migration installs)', () => {
    const storage = new MemStorage();
    storage.setItem('glance-billing.last-active', JSON.stringify({ productId: 'legacy' }));
    const adapter = makeAdapter();
    const { engine } = makeEngine(adapter, { storage, offlineGraceDays: 30 });
    expect(engine.getSnapshot().isPro).toBe(true);
    expect(engine.getSnapshot().productId).toBe('legacy');
  });
});

describe('optimistic unlock on validated events', () => {
  it("unlocks instantly on a 'success' purchase event and cancels a pending downgrade", () => {
    const adapter = makeAdapter({ cached: { active: true, productId: 'p1' } });
    const { engine, storage } = makeEngine(adapter);
    engine.start();

    engine.applyStatus({ active: false, productId: null }); // stale read → hold
    engine['applyCallbacks'].emitBillingEvent({ status: 'success', code: 0, message: 'ok', productId: 'p2' });
    vi.advanceTimersByTime(GRACE * 2);
    expect(engine.getSnapshot().isPro).toBe(true);
    expect(engine.getSnapshot().productId).toBe('p2');
    expect((storage as MemStorage).getItem('glance-billing.last-active')).toContain('"p2"');
  });

  it("unlocks on 'restore_complete_active' but not on 'restore_complete'", () => {
    const adapter = makeAdapter();
    const { engine } = makeEngine(adapter);
    engine.start();

    engine['applyCallbacks'].emitBillingEvent({
      status: 'cancelled', code: 0, message: 'restore_complete', productId: '',
    });
    expect(engine.getSnapshot().isPro).toBe(false);

    engine['applyCallbacks'].emitBillingEvent({
      status: 'cancelled', code: 0, message: 'restore_complete_active', productId: 'p1',
    });
    expect(engine.getSnapshot().isPro).toBe(true);
  });

  it("a successful test-consume ('consumed') locks IMMEDIATELY — no anti-flash hold", () => {
    const storage = new MemStorage();
    const adapter = makeAdapter({ cached: { active: true, productId: 'p_lifetime' } });
    const { engine } = makeEngine(adapter, { storage });
    engine.start();
    expect(engine.getSnapshot().isPro).toBe(true);

    engine['applyCallbacks'].emitBillingEvent({
      status: 'consumed', code: 0, message: 'test_consume', productId: 'p_lifetime',
    });
    // Deliberate revocation: wall must be showable NOW, not after the grace.
    expect(engine.getSnapshot().isPro).toBe(false);
    expect(storage.getItem('glance-billing.last-active')).toBeNull();
    expect(adapter.persisted.at(-1)).toEqual({ active: false, productId: null });
  });

  it("'consume_failed' changes nothing", () => {
    const adapter = makeAdapter({ cached: { active: true, productId: 'p_lifetime' } });
    const { engine } = makeEngine(adapter);
    engine.start();
    engine['applyCallbacks'].emitBillingEvent({
      status: 'consume_failed', code: 0, message: 'no_token', productId: '',
    });
    expect(engine.getSnapshot().isPro).toBe(true);
    expect(engine.getSnapshot().billingEvent).toMatchObject({ status: 'consume_failed' });
  });

  it('accepts string payloads (native bridges pass JSON strings)', () => {
    const adapter = makeAdapter();
    const { engine } = makeEngine(adapter);
    engine.start();
    engine['applyCallbacks'].emitBillingEvent(
      '{"status":"success","code":0,"message":"ok","productId":"p9"}',
    );
    expect(engine.getSnapshot().isPro).toBe(true);
    expect(engine.getSnapshot().productId).toBe('p9');
  });
});

describe('reconcile after purchase/restore', () => {
  it('applies only ACTIVE reconcile reads — a lagging cache cannot start a countdown', async () => {
    // Cache lags: first two re-reads inactive, third active with the real id.
    const adapter = makeAdapter({
      cached: { active: false, productId: null },
      checkResults: [
        { active: false, productId: null },
        { active: false, productId: null },
        { active: true, productId: 'real-id' },
      ],
    });
    const { engine } = makeEngine(adapter);
    engine.start();

    engine['applyCallbacks'].emitBillingEvent({ status: 'success', code: 0, message: 'ok', productId: '' });
    expect(engine.getSnapshot().isPro).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);   // all three reconcile reads fire
    expect(engine.getSnapshot().isPro).toBe(true);            // inactive reads discarded
    expect(engine.getSnapshot().productId).toBe('real-id');   // active read fills productId
    await vi.advanceTimersByTimeAsync(GRACE * 2);
    expect(engine.getSnapshot().isPro).toBe(true);            // and no countdown ever started
  });
});

describe('purchase timeout', () => {
  it('fires a synthetic cancelled/timeout event if the bridge never answers', () => {
    const adapter = makeAdapter();
    const { engine } = makeEngine(adapter);
    engine.start();

    engine.purchase('p1');
    expect(adapter.purchases).toEqual(['p1']);
    vi.advanceTimersByTime(60_000);
    expect(engine.getSnapshot().billingEvent).toMatchObject({
      status: 'cancelled', code: -1, message: 'timeout', productId: 'p1',
    });
  });

  it('does not fire when a real event arrived first', () => {
    const adapter = makeAdapter();
    const { engine } = makeEngine(adapter);
    engine.start();

    engine.purchase('p1');
    engine['applyCallbacks'].emitBillingEvent({ status: 'error', code: 6, message: 'network', productId: 'p1' });
    vi.advanceTimersByTime(60_000);
    expect(engine.getSnapshot().billingEvent).toMatchObject({ status: 'error', code: 6 });
  });
});

describe('offline-expiry grace (config-gated, OFF by default)', () => {
  it('when enabled: an expired hint stops granting the provisional unlock', () => {
    const now = Date.now();
    const storage = new MemStorage();
    storage.setItem('glance-billing.last-active', JSON.stringify({
      productId: 'p1', verifiedAt: now - 31 * 86_400_000,
    }));
    const adapter = makeAdapter();
    const { engine } = makeEngine(adapter, { storage, offlineGraceDays: 30, now: () => now });
    expect(engine.getSnapshot().isPro).toBe(false);
  });

  it('when enabled: indeterminate on an unlocked install with an expired hint escalates to the downgrade hold', () => {
    const now = Date.now();
    const storage = new MemStorage();
    storage.setItem('glance-billing.last-active', JSON.stringify({
      productId: 'p1', verifiedAt: now - 31 * 86_400_000,
    }));
    const adapter = makeAdapter({ cached: { active: true, productId: 'p1' } });
    const { engine } = makeEngine(adapter, { storage, offlineGraceDays: 30, now: () => now });
    engine.start();

    engine.applyStatus({ active: false, productId: null, indeterminate: true });
    expect(engine.getSnapshot().isPro).toBe(true);   // still anti-flash-held
    vi.advanceTimersByTime(GRACE);
    expect(engine.getSnapshot().isPro).toBe(false);  // offline grace expired → locks
  });

  it('when enabled: a fresh hint keeps the fail-open behavior', () => {
    const now = Date.now();
    const storage = new MemStorage();
    storage.setItem('glance-billing.last-active', JSON.stringify({
      productId: 'p1', verifiedAt: now - 5 * 86_400_000,
    }));
    const adapter = makeAdapter({ cached: { active: true, productId: 'p1' } });
    const { engine } = makeEngine(adapter, { storage, offlineGraceDays: 30, now: () => now });
    engine.start();

    engine.applyStatus({ active: false, productId: null, indeterminate: true });
    vi.advanceTimersByTime(GRACE * 4);
    expect(engine.getSnapshot().isPro).toBe(true);
  });
});

describe('ungated (no adapter — web/PWA/dev)', () => {
  it('is not gated, reports isUnlocked, and all actions are no-ops', () => {
    const { engine } = makeEngine(null);
    engine.start();
    const snap = engine.getSnapshot();
    expect(snap.gated).toBe(false);
    expect(snap.isPro).toBe(false);      // entitlement is separate from gating
    expect(snap.isUnlocked).toBe(true);
    engine.purchase('x');
    engine.restore();
    expect(engine.getSnapshot().billingEvent).toBeNull();
  });
});

describe("'pending' purchase outcome (0.2.4)", () => {
  it('changes no entitlement in either direction, and ends the purchase spinner like any outcome', () => {
    const locked = makeEngine(makeAdapter());
    locked.engine.start();
    locked.engine.purchase('p1');
    locked.engine['applyCallbacks'].emitBillingEvent({ status: 'pending', code: BILLING_CODE_PENDING, message: 'deferred', productId: 'p1' });
    expect(locked.engine.getSnapshot().isPro).toBe(false);
    expect(locked.engine.getSnapshot().billingEvent).toMatchObject({ status: 'pending', code: BILLING_CODE_PENDING });
    vi.advanceTimersByTime(60_000);
    // The purchase timeout was cleared by the outcome: no synthetic 'timeout'.
    expect(locked.engine.getSnapshot().billingEvent).toMatchObject({ status: 'pending' });

    const unlocked = makeEngine(makeAdapter({ cached: { active: true, productId: 'p1' } }));
    unlocked.engine.start();
    unlocked.engine['applyCallbacks'].emitBillingEvent({ status: 'pending', code: BILLING_CODE_UNCONFIRMED, message: '', productId: 'p1' });
    vi.advanceTimersByTime(GRACE * 2);
    expect(unlocked.engine.getSnapshot().isPro).toBe(true);
  });

  it('the pending codes sit outside the Play response-code space and are exported', () => {
    expect(BILLING_CODE_PENDING).not.toBe(BILLING_CODE_UNCONFIRMED);
    for (const code of [BILLING_CODE_PENDING, BILLING_CODE_UNCONFIRMED]) {
      expect(code < -3 || code > 12).toBe(true);
    }
    expect(index.BILLING_CODE_PENDING).toBe(BILLING_CODE_PENDING);
    expect(index.BILLING_CODE_UNCONFIRMED).toBe(BILLING_CODE_UNCONFIRMED);
  });
});

describe('a repeated active reading is a no-op (0.2.4, ruling 7)', () => {
  it('no notification, no status-cache write, no hint rewrite', () => {
    const storage = new MemStorage();
    const adapter = makeAdapter();
    const { engine } = makeEngine(adapter, { storage });
    engine.start();
    engine.applyStatus({ active: true, productId: 'p1' });
    const hint = storage.getItem('glance-billing.last-active');
    let notifications = 0;
    engine.subscribe(() => { notifications += 1; });
    const snapshot = engine.getSnapshot();

    vi.advanceTimersByTime(5000);
    engine.applyStatus({ active: true, productId: 'p1' });
    engine.applyStatus({ active: true, productId: 'p1' });

    expect(notifications).toBe(0);
    expect(engine.getSnapshot()).toBe(snapshot); // same object: React sees no change
    expect(adapter.persisted).toHaveLength(1);
    expect(storage.getItem('glance-billing.last-active')).toBe(hint);
  });

  it('a different product is a change, and is applied', () => {
    const adapter = makeAdapter();
    const { engine } = makeEngine(adapter);
    engine.start();
    engine.applyStatus({ active: true, productId: 'p1' });
    engine.applyStatus({ active: true, productId: 'p2' });
    expect(engine.getSnapshot().productId).toBe('p2');
    expect(adapter.persisted).toHaveLength(2);
  });

  it('a provisional cold-launch unlock is replaced by the first real active reading', () => {
    const storage = new MemStorage();
    storage.setItem('glance-billing.last-active', JSON.stringify({ productId: 'p1', verifiedAt: 0 }));
    const adapter = makeAdapter();
    const { engine } = makeEngine(adapter, { storage });
    engine.start();
    expect(engine.getSnapshot().status.provisional).toBe(true);
    engine.applyStatus({ active: true, productId: 'p1' });
    expect(engine.getSnapshot().status.provisional).toBeUndefined();
    expect(adapter.persisted).toHaveLength(1);
  });

  it('an identical active reading still cancels a pending downgrade', () => {
    const { engine } = makeEngine(makeAdapter());
    engine.start();
    engine.applyStatus({ active: true, productId: 'p1' });
    engine.applyStatus({ active: false, productId: null });
    vi.advanceTimersByTime(GRACE / 2);
    engine.applyStatus({ active: true, productId: 'p1' });
    vi.advanceTimersByTime(GRACE * 2);
    expect(engine.getSnapshot().isPro).toBe(true);
  });

  it('with offline grace ON, every verification still refreshes verifiedAt (it anchors the grace)', () => {
    const storage = new MemStorage();
    let now = 1_000;
    const { engine } = makeEngine(makeAdapter(), { storage, offlineGraceDays: 7, now: () => now });
    engine.start();
    engine.applyStatus({ active: true, productId: 'p1' });
    now = 86_400_000 * 3;
    engine.applyStatus({ active: true, productId: 'p1' });
    expect(JSON.parse(storage.getItem('glance-billing.last-active')!).verifiedAt).toBe(86_400_000 * 3);
  });

  it('writes the hint when it is missing, even for an unchanged reading', () => {
    const storage = new MemStorage();
    const { engine } = makeEngine(makeAdapter({ cached: { active: true, productId: 'p1' } }), { storage });
    engine.start(); // unlocked from the native cache: applyStatus never ran, no hint yet
    expect(storage.getItem('glance-billing.last-active')).toBeNull();
    engine.applyStatus({ active: true, productId: 'p1' });
    expect(storage.getItem('glance-billing.last-active')).toContain('"p1"');
  });
});
