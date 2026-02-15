interface IStorageLike {
    getItem?: (key: string) => string | null;
    setItem?: (key: string, value: string) => void;
}

function getLocalStorageSafe(): IStorageLike | null {
    if (typeof window === 'undefined') {
        return null;
    }
    const storage = (window as Window & { localStorage?: IStorageLike }).localStorage;
    return storage ?? null;
}

export function safeGetLocalStorageItem(key: string): string | null {
    const storage = getLocalStorageSafe();
    if (!storage || typeof storage.getItem !== 'function') {
        return null;
    }

    try {
        return storage.getItem(key);
    } catch {
        return null;
    }
}

export function safeSetLocalStorageItem(key: string, value: string) {
    const storage = getLocalStorageSafe();
    if (!storage || typeof storage.setItem !== 'function') {
        return;
    }

    try {
        storage.setItem(key, value);
    } catch {
        // Best-effort write only.
    }
}
