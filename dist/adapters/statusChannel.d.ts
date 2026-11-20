import type { StatusReading } from '../types.js';
/**
 * The pushed payload as an active reading, or null when it is anything else:
 * inactive, indeterminate, malformed, or not JSON. Only `active === true`
 * counts; no other flag on the payload is carried through.
 */
export declare function activeOnlyReading(payload: unknown): StatusReading | null;
