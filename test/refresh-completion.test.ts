// The 0.2.4 refresh() completion contract: a plugin whose initialize()
// resolves { refreshReportsCompletion: true } is read when its refresh() has
// actually finished, not after the 4000 ms restore / 2000 ms foreground
// guesses. The guess is what told a paying customer "No previous purchase
// found" when a RevenueCat sync took longer than four seconds.
//
// Plugins that do not opt in keep the 0.2.3 timers (android-unchanged.test.ts
// proves that call for call).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingEngine } from '../src/engine.js';
import { createCapacitorAdapter } from '../src/adapters/capacitor.js';
import { CountingStorage, fakeCapacitorPlugin } from './helpers/fakeCapacitorPlugin.js';

const PRODUCTS = { yearly: 'app_pro_annual', lifetime: 'app_pro_lifetime' };
const INACTIVE = { active: false, productId: null };
const ANNUAL = { active: true, productId: 'app_pro_annual' };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

/** A locked install on a completion-reporting plugin, past its mount reads. */
async function lockedInstall() {
  const fake = fakeCapacitorPlugin({ shape: 'completion', initialStatus: INACTIVE });
  const storage = new CountingStorage();
  const adapter = createCapacitorAdapter({ plugin: fake.plugin, products: PRODUCTS, storage });
  const engine = new BillingEngine({ adapter, storage, products: PRODUCTS });
  engine.start();
  await vi.advanceTimersByTimeAsync(5000);
  fake.finishRefresh(); // the mount's own refresh
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(0); // times below are from the tap
  const events: string[] = [];
  engine.subscribe(() => {
    const ev = engine.getSnapshot().billingEvent;
    const tag = ev ? `${Date.now()} ${ev.status}/${ev.message}` : null;
    if (tag && events.at(-1) !== tag) events.push(tag);
  });
  return { fake, engine, events };
}

const statusReads = (log: string[]) => log.filter((l) => / getStatus /.test(l));

describe('restore on a plugin that reports completion', () => {
  it('a sync slower than the old 4 s guess resolves on completion: entitled, never "nothing found"', async () => {
    const { fake, engine, events } = await lockedInstall();
    fake.setTruth(ANNUAL); // the sync will find the purchase, eventually

    engine.restore();
    expect(engine.getSnapshot().isLoading).toBe(true);

    await vi.advanceTimersByTimeAsync(4000);  // where 0.2.3 read, and found nothing
    expect(events).toEqual([]);
    expect(engine.getSnapshot().isLoading).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);  // the sync takes 9 s in all
    fake.finishRefresh();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual(['9000 cancelled/restore_complete_active']);
    expect(engine.getSnapshot().isUnlocked).toBe(true);
    expect(engine.getSnapshot().isLoading).toBe(false);
  });

  it('a fast sync is read as soon as it finishes, not held to 4 s', async () => {
    const { fake, engine, events } = await lockedInstall();
    fake.setTruth(ANNUAL);
    engine.restore();
    await vi.advanceTimersByTimeAsync(300);
    fake.finishRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['300 cancelled/restore_complete_active']);
  });

  it('nothing owned: "restore_complete", once the sync has actually finished', async () => {
    const { fake, engine, events } = await lockedInstall();
    engine.restore();
    await vi.advanceTimersByTimeAsync(7000);
    expect(events).toEqual([]);
    fake.finishRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['7000 cancelled/restore_complete']);
  });

  it('a refresh that fails natively is read at once: the work is over either way', async () => {
    const { fake, engine, events } = await lockedInstall();
    engine.restore();
    await vi.advanceTimersByTimeAsync(1000);
    fake.finishRefresh('reject');
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['1000 cancelled/restore_complete']);
    expect(engine.getSnapshot().isLoading).toBe(false);
  });

  it('a refresh that never settles is read at the 30 s cap, so the restore still concludes inside the 45 s give-up', async () => {
    const { engine, events } = await lockedInstall();
    engine.restore();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(['30000 cancelled/restore_complete']);
    expect(engine.getSnapshot().isLoading).toBe(false);
  });

  it('a late completion after the cap does not settle the restore twice', async () => {
    const { fake, engine, events } = await lockedInstall();
    engine.restore();
    await vi.advanceTimersByTimeAsync(30_000);
    fake.finishRefresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toEqual(['30000 cancelled/restore_complete']);
  });
});

describe('foreground refresh on a plugin that reports completion', () => {
  it('re-reads when the refresh finishes, not at 2 s', async () => {
    const { fake, engine } = await lockedInstall();
    fake.setTruth(ANNUAL);
    const readsBefore = statusReads(fake.log).length;

    engine.refresh();
    await vi.advanceTimersByTimeAsync(2000);
    expect(statusReads(fake.log).length).toBe(readsBefore); // no 2 s guess
    expect(engine.getSnapshot().isUnlocked).toBe(false);

    await vi.advanceTimersByTimeAsync(4000);
    fake.finishRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(statusReads(fake.log).length).toBe(readsBefore + 1);
    expect(engine.getSnapshot().isUnlocked).toBe(true);
  });
});

describe('what stays on the timers', () => {
  it('the mount is still exactly two status reads, at 0 and 3000 ms (the Debug StartLocked harness counts them)', async () => {
    const fake = fakeCapacitorPlugin({ shape: 'completion', initialStatus: INACTIVE });
    const adapter = createCapacitorAdapter({ plugin: fake.plugin, products: PRODUCTS, storage: new CountingStorage() });
    const engine = new BillingEngine({ adapter, storage: new CountingStorage(), products: PRODUCTS });
    engine.start();
    await vi.advanceTimersByTimeAsync(1000);
    fake.finishRefresh(); // the mount refresh finishes early ...
    await vi.advanceTimersByTimeAsync(20_000);
    // ... and is not read: only the two mount reads happen.
    expect(statusReads(fake.log).map((l) => l.split(' ')[0])).toEqual(['0', '3000']);
  });

  it('a restore tapped before initialize() has answered falls back to the 4 s settle', async () => {
    const fake = fakeCapacitorPlugin({ shape: 'completion', initialStatus: INACTIVE });
    const adapter = createCapacitorAdapter({ plugin: fake.plugin, products: PRODUCTS, storage: new CountingStorage() });
    const loading: boolean[] = [];
    // Synchronously after construction: the initialize() promise has not resolved.
    adapter.restore({
      applyStatus: () => {}, setPrices: () => {}, setTrial: () => {},
      setLoading: (l) => loading.push(l), emitBillingEvent: () => {},
    });
    await vi.advanceTimersByTimeAsync(3999);
    expect(loading).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1);
    expect(loading).toEqual([true, false]);
  });

  it('only an explicit refreshReportsCompletion: true opts in', async () => {
    for (const result of [undefined, {}, { refreshReportsCompletion: 'yes' }, { refreshReportsCompletion: 1 }]) {
      const fake = fakeCapacitorPlugin({ shape: 'completion', initialStatus: INACTIVE });
      const plugin = { ...fake.plugin, initialize: () => Promise.resolve(result as never) };
      const adapter = createCapacitorAdapter({ plugin, products: PRODUCTS, storage: new CountingStorage() });
      await vi.advanceTimersByTimeAsync(0);
      const loading: boolean[] = [];
      adapter.restore({
        applyStatus: () => {}, setPrices: () => {}, setTrial: () => {},
        setLoading: (l) => loading.push(l), emitBillingEvent: () => {},
      });
      await vi.advanceTimersByTimeAsync(4000); // its refresh never settles; the timer decides
      expect(loading).toEqual([true, false]);
    }
  });
});
