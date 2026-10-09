import {BROWSER_LIVE_LEASES_STORE} from '@app/platform/browser/browserDocumentConstants';
import {runObjectStoreTransaction} from '@app/platform/browser/browserDocumentIdb';
import type {
    IBrowserDocumentLeaseDependency,
    IBrowserDocumentLiveLease,
} from '@app/platform/browser/browserDocumentTypes';
import {BROWSER_DOCUMENT_LIVE_LEASE_SCHEMA} from '@app/platform/browser/browserDocumentTypes';
import * as v from 'valibot';

function leaseId(ownerId: string) {
    return `owner:${ownerId}`;
}

function decodeLease(value: unknown): IBrowserDocumentLiveLease | null {
    const result = v.safeParse(BROWSER_DOCUMENT_LIVE_LEASE_SCHEMA, value, {abortEarly: true});
    return result.success ? result.output : null;
}

const LEASE_OWNER_LOCK_PREFIX = 'evb-viewer:browser-lease-owner:';

function leaseOwnerLockName(ownerId: string) {
    return `${LEASE_OWNER_LOCK_PREFIX}${ownerId}`;
}

interface ILockManager {
    request<T>(
        name: string,
        options: {
            mode: 'exclusive';
            ifAvailable?: boolean;
            signal?: AbortSignal
        },
        callback: (lock: unknown) => Promise<T>,
    ): Promise<T>;
    query(): Promise<{held?: Array<{name?: unknown}>}>;
}

function resolveLockManager() {
    if (typeof navigator === 'undefined') {
        return null;
    }
    const locks = (navigator as Navigator & {locks?: ILockManager}).locks;
    return typeof locks?.request === 'function' && typeof locks.query === 'function'
        ? locks
        : null;
}

// The owner id this context publishes leases for, and its lock.
let ownerLock: {
    ownerId: string;
    held: boolean;
    granted: Promise<void>;
    release: AbortController;
} | null = null;

// The lock is what makes a lease's owner observable. The agent releases it when
// the window closes, crashes, or is killed, which is the only death signal a
// browser gives us; a quiet heartbeat is not one, since a throttled or frozen
// tab looks identical to a dead one. A context holds the lock of the one owner
// id it speaks for until it takes another id, and then releases it or withdraws
// its request, so a lock always belongs to the context that owns its id. The
// result settles once the lock is granted, or fails if the id is given up first.
export function holdLeaseOwnerLock(ownerId: string) {
    const locks = resolveLockManager();
    if (!locks) {
        return Promise.resolve();
    }
    if (ownerLock?.ownerId === ownerId) {
        return ownerLock.granted;
    }
    ownerLock?.release.abort();
    const release = new AbortController();
    const released = new Promise<void>(resolveReleased => release.signal.addEventListener('abort', () => resolveReleased()));
    const lock = {
        ownerId,
        held: false,
        granted: Promise.resolve(),
        release,
    };
    lock.granted = new Promise<void>((resolveGranted, rejectGranted) => {
        locks.request(
            leaseOwnerLockName(ownerId),
            {
                mode: 'exclusive',
                signal: release.signal,
            },
            () => {
                lock.held = true;
                resolveGranted();
                return released;
            },
        ).catch(rejectGranted);
    });
    // A request withdrawn before its grant rejects; a save waiting for it fails.
    lock.granted.catch(() => undefined);
    ownerLock = lock;
    return lock.granted;
}

// Whether this context holds the owner's lock, or null where the browser has no
// lock manager to tell.
export function holdsLeaseOwnerLock(ownerId: string) {
    return resolveLockManager() ? ownerLock?.ownerId === ownerId && ownerLock.held : null;
}

export async function saveBrowserDocumentLiveLease(
    ownerId: string,
    expectedGeneration: number,
    status: IBrowserDocumentLiveLease['status'],
    protectedDependencies: IBrowserDocumentLeaseDependency[],
) {
    // Take the liveness lock before publishing, so no sweep can observe a lease
    // whose owner has not yet become observable. A context without an owner id
    // takes this one; it never speaks for an id it does not own.
    if (ownerLock && ownerLock.ownerId !== ownerId) {
        throw new Error(`This browser context does not own lease owner ${ownerId}.`);
    }
    await holdLeaseOwnerLock(ownerId);
    // A context that holds the owner's lock replaces any lease its id has when
    // it creates one: no other live context can have written it, so it is its
    // own or a previous page's, as after a reload. Without a lock manager only
    // a dead lease is replaced.
    const replacesLease = expectedGeneration === 0 && ownerLock !== null;
    const result = await runObjectStoreTransaction<IBrowserDocumentLiveLease | null>(
        BROWSER_LIVE_LEASES_STORE,
        'readwrite',
        (store, setResult) => {
            const request = store.get(leaseId(ownerId));
            request.onsuccess = () => {
                const current = decodeLease(request.result);
                const expected = replacesLease || (current?.status === 'dead' && expectedGeneration === 0)
                    ? current?.generation ?? 0
                    : expectedGeneration;
                if ((current?.generation ?? 0) !== expected) {
                    setResult(null);
                    return;
                }
                const next: IBrowserDocumentLiveLease = {
                    id: leaseId(ownerId),
                    ownerId,
                    generation: (current?.generation ?? 0) + 1,
                    leaseRevision: (current?.leaseRevision ?? 0) + 1,
                    status,
                    heartbeatAt: Date.now(),
                    protectedDependencies: Array.from(new Map(
                        protectedDependencies.map(dependency => [
                            `${dependency.ref}::${dependency.chunkGeneration ?? ''}`,
                            dependency,
                        ]),
                    ).values()),
                };
                store.put(next);
                setResult(next);
            };
        },
    );
    if (!result) throw new Error('IndexedDB browser live lease mutation did not commit.');
    return result;
}

export async function createBrowserDocumentLiveLease(
    ownerId: string,
    protectedDependencies: IBrowserDocumentLeaseDependency[] = [],
) {
    return saveBrowserDocumentLiveLease(ownerId, 0, 'active', protectedDependencies);
}

export async function releaseBrowserDocumentLiveLease(ownerId: string, generation: number) {
    return saveBrowserDocumentLiveLease(ownerId, generation, 'dead', []);
}

export async function setBrowserDocumentLiveLeaseSuspended(
    ownerId: string,
    generation: number,
    suspended: boolean,
    protectedDependencies: IBrowserDocumentLeaseDependency[],
) {
    return saveBrowserDocumentLiveLease(ownerId, generation, suspended ? 'suspended' : 'active', protectedDependencies);
}

// The owners whose context is alive, or null where the browser has no lock
// manager to tell.
export async function loadLiveLeaseOwnerIds() {
    const locks = resolveLockManager();
    if (!locks) {
        return null;
    }
    return new Set(((await locks.query()).held ?? []).flatMap(({name}) => (
        typeof name === 'string' && name.startsWith(LEASE_OWNER_LOCK_PREFIX)
            ? [name.slice(LEASE_OWNER_LOCK_PREFIX.length)]
            : []
    )));
}

type TLeaseOwnerLock = 'acquired' | 'held' | 'unsupported';

// Runs `use` with what the browser can prove about an owner's liveness:
// 'acquired' means this context holds the owner's lock until `use` settles,
// which no live owner allows; 'held' means another context holds it, as a
// frozen or throttled owner does; 'unsupported' means it cannot tell.
export async function withLeaseOwnerLock<T>(ownerId: string, use: (lock: TLeaseOwnerLock) => Promise<T>) {
    const locks = resolveLockManager();
    if (!locks) {
        return use('unsupported');
    }
    return locks.request(
        leaseOwnerLockName(ownerId),
        {
            mode: 'exclusive',
            ifAvailable: true,
        },
        lock => use(lock ? 'acquired' : 'held'),
    );
}

// A live lease protects its refs until its owner marks it dead. A window that
// crashes never gets to do that, so without reclamation one lost tab pins its
// working copy, its source and every chunk in IndexedDB for the lifetime of the
// origin.
//
// An owner is alive exactly while it holds its lease lock. That is proof, not
// inference: the browser releases the lock itself when the context goes away,
// and it keeps holding it while the tab is merely frozen or throttled. A lease
// whose lock nobody holds therefore has no owner left to speak for it, and its
// refs are released in the same sweep.
export async function reclaimOrphanedBrowserDocumentLiveLeases() {
    const liveOwnerIds = await loadLiveLeaseOwnerIds();
    if (!liveOwnerIds) {
        return;
    }
    await runObjectStoreTransaction<null>(
        BROWSER_LIVE_LEASES_STORE,
        'readwrite',
        (store) => {
            const request = store.getAll();
            request.onsuccess = () => {
                const leases = (Array.isArray(request.result) ? request.result : [])
                    .flatMap(value => {
                        const lease = decodeLease(value);
                        return lease ? [lease] : [];
                    });
                for (const lease of leases) {
                    if (lease.status === 'dead' || liveOwnerIds.has(lease.ownerId)) {
                        continue;
                    }
                    store.put({
                        ...lease,
                        generation: lease.generation + 1,
                        leaseRevision: lease.leaseRevision + 1,
                        status: 'dead',
                        protectedDependencies: [],
                    } satisfies IBrowserDocumentLiveLease);
                }
            };
        },
    );
}
