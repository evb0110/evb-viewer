import type {StorageLike} from '@vueuse/core';

interface IStorageLike {
    getItem?: (key: string) => string | null;
    setItem?: (key: string, value: string) => void;
    removeItem?: (key: string) => void;
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

export function safeRemoveLocalStorageItem(key: string) {
    const storage = getLocalStorageSafe();
    if (!storage || typeof storage.removeItem !== 'function') {
        return false;
    }

    try {
        storage.removeItem(key);
        return true;
    } catch {
        return false;
    }
}

/**
 * VueUse storage adapter for optional browser preferences. Each operation
 * resolves the storage lazily so a denied browser getter cannot break setup.
 */
export const safeLocalStorage: StorageLike = {
    getItem: (key: string) => safeGetLocalStorageItem(key),
    setItem: (key: string, value: string) => {
        safeSetLocalStorageItem(key, value);
    },
    removeItem: (key: string) => {
        safeRemoveLocalStorageItem(key);
    },
};

/** Use the native object when available so browser storage events retain identity. */
export function getLocalStorageForVueUse(): StorageLike {
    const storage = getLocalStorageSafe();
    return storage !== null
        && typeof storage.getItem === 'function'
        && typeof storage.setItem === 'function'
        && typeof storage.removeItem === 'function'
        ? storage as StorageLike
        : safeLocalStorage;
}
