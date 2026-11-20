// The 0.2.4 status channel: entitlement readings the native layer pushes
// (RevenueCat's PurchasesDelegate on iOS), applied ACTIVE ONLY, through the
// gate and never through the billing-event channel. Each block runs the real
// engine with a real adapter, so what is asserted is what the app sees.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingEngine } from '../src/engine.js';
import { createCapacitorAdapter } from '../src/adapters/capacitor.js';
import { createIOSWebViewAdapter, type IOSBillingBridge } from '../src/adapters/ios-webview.js';
import { activeOnlyReading } from '../src/adapters/statusChannel.js';
import type { BillingAdapter } from '../src/adapters/types.js';
import { CountingStorage, fakeCapacitorPlugin } from './helpers/fakeCapacitorPlugin.js';

const PRODUCTS = { yearly: 'app_pro_annual', lifetime: 'app_pro_lifetime' };
const INACTIVE = { active: false, productId: null };
const ANNUAL = { active: true, productId: 'app_pro_annual' };
const GRACE = 12_000;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).__billingEvent;
  delete (globalThis as Record<string, unknown>).__billingStatus;
});

// ── The two transports, behind one interface ─────────────────────────────────

interface Rig {
  engine: BillingEngine;
  storage: CountingStorage;
  /** What a pulled read of the native cache returns from now on. */
  setNativeStatus(s: { active: boolean; productId: string | null }): void;
  /** The native layer pushes a reading (Capacitor event / window global). */
  push(payload: unknown): void;
  /** The native layer reports a purchase outcome. */
  event(ev: { status: string; code: number; message: string; productId: string }): void;
}

async function capacitorRig(native = INACTIVE, storage = new CountingStorage()): Promise<Rig> {
  const fake = fakeCapacitorPlugin({ shape: 'completion', initialStatus: native });
  const adapter = createCapacitorAdapter({ plugin: fake.plugin, products: PRODUCTS, storage });
  const engine = new BillingEngine({ adapter, storage, products: PRODUCTS });
  engine.start();
  await vi.advanceTimersByTimeAsync(5000); // listeners bound, mount reads done
  return {
    engine, storage,
    setNativeStatus: (s) => fake.setStatus(s),
    push: (p) => fake.emit('billingStatus', p),
    event: (ev) => fake.emit('billingEvent', ev),
  };
}

async function iosWebViewRig(native = INACTIVE, storage = new CountingStorage()): Promise<Rig> {
  let status = native;
  const bridge: IOSBillingBridge = {
    getSubscriptionStatus: () => JSON.stringify(status),
    getProductPrices: () => '{"yearly":"$10","lifetime":"$30","yearlyTrialDays":7}',
    getTrialEligibility: () => '{"app_pro_annual":true}',
    purchase: () => {},
    restorePurchases: () => {},
  };
  const adapter = createIOSWebViewAdapter({ bridge, products: PRODUCTS });
  const engine = new BillingEngine({ adapter, storage, products: PRODUCTS });
  engine.start();
  await vi.advanceTimersByTimeAsync(5000);
  const w = globalThis as Record<string, unknown>;
  return {
    engine, storage,
    setNativeStatus: (s) => { status = s; },
    // The shell calls the global with a JS object literal, guarded the way
    // SubscriptionBridge guards __billingEvent: `if (typeof … === 'function')`.
    push: (p) => (w.__billingStatus as ((p: unknown) => void) | undefined)?.(p),
    event: (ev) => (w.__billingEvent as ((e: unknown) => void) | undefined)?.(ev),
  };
}

const RIGS = [
  ['Capacitor plugin (lastGLANCE, lifeGLANCE)', capacitorRig],
  ['iOS WebView bridge (dayGLANCE)', iosWebViewRig],
] as const;

// ── activeOnlyReading ────────────────────────────────────────────────────────

describe('activeOnlyReading', () => {
  it('passes an active reading through, as a fresh object with only active and productId', () => {
    expect(activeOnlyReading({ active: true, productId: 'p', indeterminate: true, provisional: true }))
      .toEqual({ active: true, productId: 'p' });
    expect(activeOnlyReading('{"active":true,"productId":"p"}')).toEqual({ active: true, productId: 'p' });
    expect(activeOnlyReading({ active: true })).toEqual({ active: true, productId: null });
    expect(activeOnlyReading({ active: true, productId: '' })).toEqual({ active: true, productId: null });
  });

  it('turns everything else into nothing: inactive, indeterminate, truthy-but-not-true, malformed', () => {
    for (const payload of [
      { active: false, productId: null },
      { active: false, productId: 'p' },
      { active: false, indeterminate: true },
      { active: 'true', productId: 'p' },
      { active: 1, productId: 'p' },
      'not json', '{"active":false}', null, undefined, 42, [],
    ]) {
      expect(activeOnlyReading(payload)).toBeNull();
    }
  });
});

// ── The rulings, on both transports ──────────────────────────────────────────

describe.each(RIGS)('status pushes through the %s', (_name, makeRig) => {
  it('an INACTIVE push does not downgrade an unlocked install, now or after the hold', async () => {
    const rig = await makeRig(ANNUAL);
    expect(rig.engine.getSnapshot().isPro).toBe(true);

    rig.push({ active: false, productId: null });
    rig.push({ active: false, indeterminate: true });
    rig.push('{"active":false,"productId":null}');
    expect(rig.engine.getSnapshot().isPro).toBe(true);

    await vi.advanceTimersByTimeAsync(GRACE * 3);
    expect(rig.engine.getSnapshot().isPro).toBe(true);
    expect(rig.engine.getSnapshot().isUnlocked).toBe(true);
  });

  it('an ACTIVE push rescues an install that reads inactive, immediately', async () => {
    const rig = await makeRig(INACTIVE);
    expect(rig.engine.getSnapshot().isUnlocked).toBe(false); // mount reads said inactive

    rig.push({ active: true, productId: 'app_pro_annual' });
    expect(rig.engine.getSnapshot().isUnlocked).toBe(true);
    expect(rig.engine.getSnapshot().productId).toBe('app_pro_annual');
    // ... and it is persisted, so a relaunch starts unlocked.
    expect(rig.storage.map.get('glance-billing.last-active')).toContain('app_pro_annual');
  });

  it('a push is not a purchase outcome: no billing event, and an in-flight purchase keeps its timeout', async () => {
    const rig = await makeRig(INACTIVE);
    rig.engine.purchase('app_pro_annual');

    rig.push({ active: true, productId: 'app_pro_annual' });
    expect(rig.engine.getSnapshot().isUnlocked).toBe(true);
    expect(rig.engine.getSnapshot().billingEvent).toBeNull(); // the paywall's event state is untouched

    // The purchase's own outcome still lands and is still what the UI sees.
    rig.event({ status: 'success', code: 0, message: 'ok', productId: 'app_pro_annual' });
    expect(rig.engine.getSnapshot().billingEvent).toMatchObject({ status: 'success' });
  });

  it('without the purchase outcome, the 60 s purchase timeout still fires: the push did not clear it', async () => {
    const rig = await makeRig(INACTIVE);
    rig.engine.purchase('app_pro_annual');
    rig.push({ active: true, productId: 'app_pro_annual' });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(rig.engine.getSnapshot().billingEvent).toMatchObject({ status: 'cancelled', message: 'timeout' });
    expect(rig.engine.getSnapshot().isUnlocked).toBe(true); // the timeout is UI only; the unlock stands
  });

  it("'success' plus a push for the same purchase: one unlock, no duplicate notification or write", async () => {
    const rig = await makeRig(INACTIVE);
    let notifications = 0;
    rig.engine.subscribe(() => { notifications += 1; });
    const writesBefore = rig.storage.writes.length;

    // The purchase's success event: the unlock, the event itself and, on the
    // cached-read bridge, a price re-read. That is what one purchase costs
    // today; everything after it must add nothing.
    rig.event({ status: 'success', code: 0, message: 'ok', productId: 'app_pro_annual' });
    rig.setNativeStatus(ANNUAL); // RevenueCat's cache has the purchase
    const perPurchase = notifications;
    expect(perPurchase).toBeGreaterThanOrEqual(2);
    const writesAfterUnlock = rig.storage.writes.length;
    expect(writesAfterUnlock).toBeGreaterThan(writesBefore);

    // The delegate's push for the same purchase, then the post-purchase re-reads.
    rig.push({ active: true, productId: 'app_pro_annual' });
    await vi.advanceTimersByTimeAsync(3000);
    rig.push({ active: true, productId: 'app_pro_annual' }); // RevenueCat may repeat it

    expect(notifications).toBe(perPurchase);
    expect(rig.storage.writes.length).toBe(writesAfterUnlock);
    expect(rig.engine.getSnapshot().isUnlocked).toBe(true);
  });

  it('the push first, then the success event: still one unlock', async () => {
    const rig = await makeRig(INACTIVE);
    const unlocks: boolean[] = [];
    rig.engine.subscribe(() => {
      const u = rig.engine.getSnapshot().isUnlocked;
      if (unlocks.at(-1) !== u) unlocks.push(u);
    });

    rig.push({ active: true, productId: 'app_pro_annual' });
    rig.setNativeStatus(ANNUAL);
    const writes = rig.storage.writes.length;
    rig.event({ status: 'success', code: 0, message: 'ok', productId: 'app_pro_annual' });
    await vi.advanceTimersByTimeAsync(3000);

    expect(unlocks).toEqual([true]);
    expect(rig.storage.writes.length).toBe(writes);
    expect(rig.engine.getSnapshot().billingEvent).toMatchObject({ status: 'success' });
  });

  it('a push of cached info at launch, on an install already unlocked, changes nothing', async () => {
    const rig = await makeRig(ANNUAL);
    let notifications = 0;
    rig.engine.subscribe(() => { notifications += 1; });
    const writes = rig.storage.writes.length;

    rig.push({ active: true, productId: 'app_pro_annual' });
    expect(notifications).toBe(0);
    expect(rig.storage.writes.length).toBe(writes);
  });

  it('a push after the engine stopped is dropped', async () => {
    const rig = await makeRig(INACTIVE);
    rig.engine.stop();
    await vi.advanceTimersByTimeAsync(0);
    rig.push({ active: true, productId: 'app_pro_annual' });
    expect(rig.engine.getSnapshot().isPro).toBe(false);
  });
});

describe('unbinding', () => {
  it('Capacitor: both listeners are removed', async () => {
    const fake = fakeCapacitorPlugin({ shape: 'completion' });
    const adapter: BillingAdapter = createCapacitorAdapter({ plugin: fake.plugin, products: PRODUCTS, storage: new CountingStorage() });
    const unbind = adapter.bindEvents({
      applyStatus: () => {}, setPrices: () => {}, setTrial: () => {}, setLoading: () => {}, emitBillingEvent: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.listenerCount('billingEvent')).toBe(1);
    expect(fake.listenerCount('billingStatus')).toBe(1);
    unbind();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.listenerCount('billingEvent')).toBe(0);
    expect(fake.listenerCount('billingStatus')).toBe(0);
  });

  it('iOS WebView: both window globals are removed', () => {
    const adapter = createIOSWebViewAdapter({
      bridge: { getSubscriptionStatus: () => '{}', getProductPrices: () => '{}', getTrialEligibility: () => '{}' },
      products: PRODUCTS,
    });
    const w = globalThis as Record<string, unknown>;
    const unbind = adapter.bindEvents({
      applyStatus: () => {}, setPrices: () => {}, setTrial: () => {}, setLoading: () => {}, emitBillingEvent: () => {},
    });
    expect(typeof w.__billingEvent).toBe('function');
    expect(typeof w.__billingStatus).toBe('function');
    unbind();
    expect(w.__billingEvent).toBeUndefined();
    expect(w.__billingStatus).toBeUndefined();
  });
});
