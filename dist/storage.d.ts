import type { StorageLike } from './types.js';
/**
 * Wraps a StorageLike so that quota errors, privacy-mode failures, and a
 * missing backend can never throw into engine code paths. Falls back to an
 * in-memory map when no backend is available (SSR, tests, headless).
 */
export declare class SafeStorage implements StorageLike {
    private readonly backend;
    private readonly memory;
    constructor(backend?: StorageLike | null);
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
