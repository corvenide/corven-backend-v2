// Where the SDK keeps the refresh token between page loads. The access
// token only ever lives in memory.

export interface TokenStorage {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
}

export function memoryStorage(): TokenStorage {
    const map = new Map<string, string>();
    return {
        get: (k) => map.get(k) ?? null,
        set: (k, v) => void map.set(k, v),
        remove: (k) => void map.delete(k),
    };
}

/** localStorage when available (private mode and some iframes throw), else memory. */
export function browserStorage(): TokenStorage {
    const fallback = memoryStorage();
    const ls = (): Storage | null => {
        try {
            return typeof window !== 'undefined' ? window.localStorage : null;
        } catch {
            return null;
        }
    };
    return {
        get(k) {
            try {
                return ls()?.getItem(k) ?? fallback.get(k);
            } catch {
                return fallback.get(k);
            }
        },
        set(k, v) {
            try {
                const s = ls();
                if (s) s.setItem(k, v);
                else fallback.set(k, v);
            } catch {
                fallback.set(k, v);
            }
        },
        remove(k) {
            fallback.remove(k);
            try {
                ls()?.removeItem(k);
            } catch {
                /* ignore */
            }
        },
    };
}
