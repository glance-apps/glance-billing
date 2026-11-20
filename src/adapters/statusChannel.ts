// The status channel (0.2.4): entitlement readings the native layer PUSHES,
// as opposed to the readings an adapter pulls on its own schedule. The iOS
// shells push one whenever RevenueCat reports updated customer info (its
// PurchasesDelegate), so an entitlement that arrives outside the purchase flow
// (a purchase whose post to RevenueCat was retried, an Ask to Buy approved
// later, an entitlement transferred back from another device) unlocks the app
// when it happens rather than at the next foreground.
//
// ACTIVE ONLY. A pushed reading can rescue an entitlement and never revoke
// one. Both Apple platforms write to the same RevenueCat project under
// different anonymous user ids, so the Mac app posting its receipt can move
// the entitlement off the iPhone's customer for a while; a push that applied
// inactive readings would turn that into a downgrade on a paying customer's
// phone. Revocation stays with the pulled readings and the engine's downgrade
// hold. The filter lives here, in the package, so no native implementation
// can get it wrong.

import type { StatusReading } from '../types.js';

/**
 * The pushed payload as an active reading, or null when it is anything else:
 * inactive, indeterminate, malformed, or not JSON. Only `active === true`
 * counts; no other flag on the payload is carried through.
 */
export function activeOnlyReading(payload: unknown): StatusReading | null {
  let data: unknown = payload;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const { active, productId } = data as { active?: unknown; productId?: unknown };
  if (active !== true) return null;
  return {
    active: true,
    productId: typeof productId === 'string' && productId !== '' ? productId : null,
  };
}
