/**
 * Wraps a StorageLike so that quota errors, privacy-mode failures, and a
 * missing backend can never throw into engine code paths. Falls back to an
 * in-memory map when no backend is available (SSR, tests, headless).
 */
export class SafeStorage {
    backend;
    memory = new Map();
    constructor(backend) {
        let resolved = backend ?? null;
        if (resolved === null) {
            try {
                const g = globalThis;
                resolved = g.localStorage ?? null;
            }
            catch {
                resolved = null;
            }
        }
        this.backend = resolved;
    }
    getItem(key) {
        try {
            if (this.backend)
                return this.backend.getItem(key);
        }
        catch {
            /* fall through to memory */
        }
        return this.memory.get(key) ?? null;
    }
    setItem(key, value) {
        try {
            if (this.backend) {
                this.backend.setItem(key, value);
                return;
            }
        }
        catch {
            /* fall through to memory */
        }
        this.memory.set(key, value);
    }
    removeItem(key) {
        try {
            if (this.backend) {
                this.backend.removeItem(key);
                return;
            }
        }
        catch {
            /* fall through to memory */
        }
        this.memory.delete(key);
    }
}
