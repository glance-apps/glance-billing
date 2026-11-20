/**
 * Codes for a 'pending' billing event (0.2.4). Outside Google Play's
 * BillingResponseCode range (-3..12), which is the code space every other
 * billing event uses, so neither can be mistaken for a Play code.
 *
 * BILLING_CODE_PENDING: the purchase is deferred and nothing has been charged
 * yet (Ask to Buy, a payment that needs approval or extra authentication). It
 * completes later, or never, outside the app's purchase flow.
 *
 * BILLING_CODE_UNCONFIRMED: the store reports the purchase complete, but the
 * entitlement it returned does not include the app's entitlement. A payment
 * may have been taken. The unlock arrives as a status reading if and when the
 * entitlement appears; Restore re-checks on demand.
 *
 * Neither is an error, so billingErrorMessage does not map them; the paywall
 * gives them their own copy.
 */
export const BILLING_CODE_PENDING = 100;
export const BILLING_CODE_UNCONFIRMED = 101;

/**
 * Maps a billing error code to a user-facing string.
 * Returns a generic message for unknown codes.
 * Code 2 = SKErrorPaymentCancelled (macOS) / user cancelled — should not
 * surface as an error message (handled as 'cancelled' status upstream).
 */
export function billingErrorMessage(code: number): string {
  switch (code) {
    case 1:  return 'Product not found. Please try again later.';
    case 3:  return 'Billing is not available on this device.';
    case 4:  return "This subscription isn't available right now. Please try again later.";
    case 6:  return 'Network error. Please check your connection and try again.';
    case 7:  return 'You already own this item.';
    default: return 'Something went wrong with the purchase. Please try again.';
  }
}
