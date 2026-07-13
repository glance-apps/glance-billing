/**
 * Derives the reviewer bypass code for [period] (default: the current UTC
 * month). The default period expression intentionally reads the clock via
 * `new Date().toISOString()` so callers that pin the clock for previews keep
 * working.
 */
export declare function deriveReviewerCode(secret: string, period?: string): Promise<string>;
export declare function sha256Hex(text: string): Promise<string>;
