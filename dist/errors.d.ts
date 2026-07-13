/**
 * Maps a billing error code to a user-facing string.
 * Returns a generic message for unknown codes.
 * Code 2 = SKErrorPaymentCancelled (macOS) / user cancelled — should not
 * surface as an error message (handled as 'cancelled' status upstream).
 */
export declare function billingErrorMessage(code: number): string;
