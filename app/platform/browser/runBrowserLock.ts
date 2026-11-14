function lockManager() {
    return typeof navigator === 'undefined' ? undefined : navigator.locks as LockManager | undefined;
}

const localQueues = new Map<string, Promise<unknown>>();

/** Runs `operation` while holding the exclusive lock `name`; without Web Locks, one at a time in this context. */
export function runBrowserLock<T>(name: string, operation: () => Promise<T>, signal?: AbortSignal) {
    const locks = lockManager();
    if (!locks) {
        const result = (localQueues.get(name) ?? Promise.resolve()).then(operation);
        localQueues.set(name, result.catch(() => undefined));
        return result;
    }
    return locks.request(name, {
        mode: 'exclusive',
        ...(signal ? {signal} : {}),
    }, operation);
}

/**
 * Holds the exclusive lock `name` until the returned function releases it: at once when no other context
 * holds it, or after waiting up to `waitMs`. `null` when it stays held elsewhere. Without Web Locks every
 * request succeeds, as `runBrowserLock` runs unlocked there.
 */
export function holdBrowserLock(name: string, waitMs = 0): Promise<(() => void) | null> {
    const locks = lockManager();
    if (!locks) return Promise.resolve(() => undefined);
    return new Promise((resolve, reject) => {
        let release = () => undefined as void;
        const held = new Promise<void>(resolveHeld => {
            release = resolveHeld;
        });
        const options: LockOptions = waitMs > 0 ? {signal: AbortSignal.timeout(waitMs)} : {ifAvailable: true};
        locks.request(name, options, lock => {
            resolve(lock ? release : null);
            return lock ? held : undefined;
        }).catch((error: unknown) => {
            if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) resolve(null);
            else reject(error);
        });
    });
}

/** The names of the locks any context of this origin holds; `null` without Web Locks, when nothing is known. */
export async function heldBrowserLockNames() {
    const locks = lockManager();
    if (!locks) return null;
    const {held = []} = await locks.query();
    return new Set(held.flatMap(lock => lock.name ? [lock.name] : []));
}
