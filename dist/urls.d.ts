/**
 * Google Play subscription-management deep link. With a productId it opens
 * that subscription's management screen directly; without, the account's
 * subscription list.
 */
export declare function playManageSubscriptionUrl(packageName: string, productId?: string): string;
/** Apple subscription-management page (App Store / Mac App Store accounts). */
export declare function appleManageSubscriptionUrl(): string;
