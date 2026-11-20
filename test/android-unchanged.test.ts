// Ruling 4 of the 0.2.4 design: the Capacitor adapter is shared with Play
// Android, so the Android path must come out of 0.2.4 behaviorally unchanged.
// Demonstrated, not asserted: the same script drives the 0.2.3 adapter and
// engine (verbatim copies in test/fixtures) and the current ones against an
// Android-shaped plugin, and the two runs are compared call for call.
//
// The Android plugin resolves initialize() with nothing and refresh() before
// its query lands, so it never opts into refresh completion and never emits
// 'billingStatus'. The one difference allowed below is that 0.2.4 registers a
// listener for that event, which an Android plugin never fires.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapacitorAdapter } from '../src/adapters/capacitor.js';
import { BillingEngine } from '../src/engine.js';
import { createCapacitorAdapter as createCapacitorAdapter023 } from './fixtures/capacitor-0.2.3.js';
import { BillingEngine as BillingEngine023 } from './fixtures/engine-0.2.3.js';
import type { ApplyCallbacks, BillingAdapter } from '../src/adapters/types.js';
import { CountingStorage, fakeCapacitorPlugin } from './helpers/fakeCapacitorPlugin.js';

const PRODUCTS = { yearly: 'app_pro_annual', lifetime: 'app_pro_lifetime' };
const INACTIVE = { active: false, productId: null };
const ANNUAL = { active: true, productId: 'app_pro_annual' };

type AdapterFactory = typeof createCapacitorAdapter;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

const ONLY_NEW = / (addListener|removeListener) billingStatus$/;

/** Drives an adapter directly, logging every plugin call and every callback. */
async function adapterScript(create: AdapterFactory) {
  vi.clearAllTimers();
  vi.setSystemTime(0);
  const fake = fakeCapacitorPlugin({ shape: 'android', queryLatencyMs: 1500, initialStatus: INACTIVE });
  const storage = new CountingStorage();
  const adapter = create({ plugin: fake.plugin, products: PRODUCTS, storage });
  const at = (entry: string) => fake.log.push(`${Date.now()} ${entry}`);
  const apply: ApplyCallbacks = {
    applyStatus: (r) => at(`applyStatus ${JSON.stringify(r)}`),
    setPrices: (p) => at(`setPrices ${JSON.stringify(p)}`),
    setTrial: (t) => at(`setTrial ${JSON.stringify(t)}`),
    setLoading: (l) => at(`setLoading ${l}`),
    emitBillingEvent: (e) => at(`emitBillingEvent ${JSON.stringify(e)}`),
  };

  const unbind = adapter.bindEvents(apply);
  adapter.onMount(apply);
  await vi.advanceTimersByTimeAsync(5000);

  // The store becomes entitled; the app comes back to the foreground.
  fake.setTruth(ANNUAL);
  adapter.refresh(apply);
  await vi.advanceTimersByTimeAsync(5000);

  // A purchase, its success event, and the gate persisting the reading.
  adapter.purchase(PRODUCTS.lifetime);
  fake.emit('billingEvent', { status: 'success', code: 0, message: '', productId: PRODUCTS.lifetime });
  adapter.persistStatusCache!({ active: true, productId: PRODUCTS.lifetime });
  at(`readCachedStatus ${JSON.stringify(adapter.readCachedStatus())}`);
  await vi.advanceTimersByTimeAsync(100);

  // Restore whose query lands inside the settle window: finds the entitlement.
  fake.setStatus(INACTIVE);
  fake.setTruth(ANNUAL);
  adapter.restore(apply);
  await vi.advanceTimersByTimeAsync(6000);

  // Restore with nothing owned.
  fake.setStatus(INACTIVE);
  adapter.restore(apply);
  await vi.advanceTimersByTimeAsync(6000);

  // Restore whose query is SLOWER than the settle window. On Android the
  // timer still decides, as it did in 0.2.3; this is not the iOS fix.
  fake.setQueryLatency(5000);
  fake.setTruth(ANNUAL);
  adapter.restore(apply);
  await vi.advanceTimersByTimeAsync(8000);

  unbind();
  await vi.advanceTimersByTimeAsync(0);
  return { log: fake.log, storage: Object.fromEntries(storage.map) };
}

describe('Android through the shared Capacitor adapter: unchanged from 0.2.3', () => {
  it('makes the same plugin calls and callbacks, at the same times, as the 0.2.3 adapter', async () => {
    const before = await adapterScript(createCapacitorAdapter023 as unknown as AdapterFactory);
    const after = await adapterScript(createCapacitorAdapter);

    // The script exercised the timers this depends on: the foreground read
    // 2000 ms after its kick, a restore settled 4000 ms after its kick, and a
    // restore whose query (5000 ms) outlasts the settle window and is still
    // decided by the timer on Android.
    expect(before.log).toContain('7000 applyStatus {"active":true,"productId":"app_pro_annual"}');
    expect(before.log).toContain(
      '14100 emitBillingEvent {"status":"cancelled","code":0,"message":"restore_complete_active","productId":"app_pro_annual"}');
    expect(before.log).toContain(
      '26100 emitBillingEvent {"status":"cancelled","code":0,"message":"restore_complete","productId":""}');

    expect(after.log.filter((l) => !ONLY_NEW.test(l))).toEqual(before.log);
    expect(after.storage).toEqual(before.storage);
    // The only addition: a listener for an event the Android plugin never sends.
    expect(after.log.filter((l) => ONLY_NEW.test(l))).toEqual([
      '0 addListener billingStatus',
      '30100 removeListener billingStatus',
    ]);
  });

  it('end to end through the engine: the same states, in the same order, at the same times', async () => {
    async function engineScript(
      Engine: typeof BillingEngine,
      create: AdapterFactory,
    ) {
      vi.clearAllTimers();
      vi.setSystemTime(0);
      const fake = fakeCapacitorPlugin({ shape: 'android', queryLatencyMs: 1500, initialStatus: INACTIVE });
      const storage = new CountingStorage();
      const adapter: BillingAdapter = create({ plugin: fake.plugin, products: PRODUCTS, storage });
      const engine = new Engine({ adapter, storage, products: PRODUCTS });
      const states: string[] = [];
      let notifications = 0;
      engine.subscribe(() => {
        notifications += 1;
        const s = engine.getSnapshot();
        const state = JSON.stringify({
          isPro: s.isPro, isUnlocked: s.isUnlocked, productId: s.productId, source: s.entitlementSource,
          isLoading: s.isLoading, prices: s.prices, trial: s.trial,
          event: s.billingEvent && { status: s.billingEvent.status, message: s.billingEvent.message, productId: s.billingEvent.productId },
        });
        if (states.at(-1)?.endsWith(state) !== true) states.push(`${Date.now()} ${state}`);
      });

      engine.start();
      await vi.advanceTimersByTimeAsync(5000);
      fake.setTruth(ANNUAL);
      engine.refresh();
      await vi.advanceTimersByTimeAsync(5000);
      engine.purchase(PRODUCTS.lifetime);
      fake.emit('billingEvent', { status: 'success', code: 0, message: '', productId: PRODUCTS.lifetime });
      await vi.advanceTimersByTimeAsync(5000);           // the post-purchase re-reads
      engine.restore();
      await vi.advanceTimersByTimeAsync(6000);
      fake.setStatus(INACTIVE);
      engine.refresh();                                   // a lapsed entitlement
      await vi.advanceTimersByTimeAsync(20_000);          // ... held 12 s, then locked
      engine.stop();

      const hint = JSON.parse(storage.map.get('glance-billing.last-active') ?? 'null');
      return { states, notifications, storage: Object.fromEntries(storage.map), hint, writes: storage.writes.length };
    }

    const before = await engineScript(BillingEngine023 as unknown as typeof BillingEngine, createCapacitorAdapter023 as unknown as AdapterFactory);
    const after = await engineScript(BillingEngine, createCapacitorAdapter);

    // The script went through unlock, purchase, restore and a confirmed lock.
    expect(before.states.some((s) => s.includes('"isPro":true'))).toBe(true);
    expect(before.states.at(-1)).toContain('"isPro":false');

    expect(after.states).toEqual(before.states);
    expect(after.storage).toEqual(before.storage);
    // 0.2.4 drops the notifications and writes that repeated an identical
    // active reading (ruling 7); it never adds any.
    expect(after.notifications).toBeLessThanOrEqual(before.notifications);
    expect(after.writes).toBeLessThanOrEqual(before.writes);
  });
});
