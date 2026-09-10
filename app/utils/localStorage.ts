interface IStorageLike {
    getItem?: (key: string) => string | null;
    setItem?: (key: string, value: string) => void;
}

export type TLocalStorageReadResult =
    | {
        status: 'present';
        value: string
    }
    | {status: 'absent'}
    | {
        status: 'unavailable';
        error: Error
    };

function getLocalStorageSafe(): IStorageLike | null {
    if (typeof window === 'undefined') {
        return null;
    }

    try {
        const storage: unknown = Reflect.get(window, 'localStorage');
        return typeof storage === 'object' && storage !== null
            ? storage
            : null;
    } catch {
        return null;
    }
}

export function readLocalStorageItem(key: string): TLocalStorageReadResult {
    const storage = getLocalStorageSafe();
    if (!storage || typeof storage.getItem !== 'function') {
        return {
            status: 'unavailable',
            error: new Error('localStorage is unavailable'),
        };
    }

    try {
        const value = storage.getItem(key);
        return value === null
            ? {status: 'absent'}
            : {
                status: 'present',
                value,
            };
    } catch (error) {
        return {
            status: 'unavailable',
            error: error instanceof Error ? error : new Error(String(error)),
        };
    }
}

export function safeGetLocalStorageItem(key: string) {
    const result = readLocalStorageItem(key);
    return result.status === 'present' ? result.value : null;
}

export function safeSetLocalStorageItem(key: string, value: string) {
    const storage = getLocalStorageSafe();
    if (!storage || typeof storage.setItem !== 'function') {
        return false;
    }

    try {
        storage.setItem(key, value);
        return true;
    } catch {
        // Best-effort write only.
        return false;
    }
}
