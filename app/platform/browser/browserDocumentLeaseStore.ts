import {BROWSER_LIVE_LEASES_STORE} from '@app/platform/browser/browserDocumentConstants';
import {runObjectStoreTransaction} from '@app/platform/browser/browserDocumentIdb';
import type {
    IBrowserDocumentLeaseDependency,
    IBrowserDocumentLiveLease,
} from '@app/platform/browser/browserDocumentTypes';

function leaseId(ownerId: string) {
    return `owner:${ownerId}`;
}

function isLease(value: unknown): value is IBrowserDocumentLiveLease {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value as Partial<IBrowserDocumentLiveLease>;
    return typeof record.id === 'string'
        && typeof record.ownerId === 'string'
        && typeof record.generation === 'number'
        && typeof record.leaseRevision === 'number'
        && (record.status === 'active' || record.status === 'suspended' || record.status === 'dead')
        && typeof record.heartbeatAt === 'number'
        && Array.isArray(record.protectedDependencies);
}

function leaseOwnerLockName(ownerId: string) {
    return `evb-viewer:browser-lease-owner:${ownerId}`;
}

interface ILockManager {
    request(name: string, options: {mode: 'exclusive'}, callback: () => Promise<never>): Promise<unknown>;
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

const heldOwnerLocks = new Set<string>();

// The lock is what makes a lease's owner observable. The agent releases it when
// the window closes, crashes, or is killed, which is the only death signal a
// browser gives us; a quiet heartbeat is not one, since a throttled or frozen
// tab looks identical to a dead one. The promise is never resolved, so the lock
// is held for the lifetime of the context.
async function holdLeaseOwnerLock(ownerId: string) {
    if (heldOwnerLocks.has(ownerId)) {
        return;
    }
    const locks = resolveLockManager();
    if (!locks) {
        return;
    }
    heldOwnerLocks.add(ownerId);
    await new Promise<void>((granted) => {
        void locks.request(
            leaseOwnerLockName(ownerId),
            {mode: 'exclusive'},
            () => {
                granted();
                return new Promise<never>(() => {});
            },
        );
    });
}

export async function saveBrowserDocumentLiveLease(
    ownerId: string,
    expectedGeneration: number,
    status: IBrowserDocumentLiveLease['status'],
    protectedDependencies: IBrowserDocumentLeaseDependency[],
) {
    // Take the liveness lock before publishing, so no sweep can observe a lease
    // whose owner has not yet become observable.
    await holdLeaseOwnerLock(ownerId);
    const result = await runObjectStoreTransaction<IBrowserDocumentLiveLease | null>(
        BROWSER_LIVE_LEASES_STORE,
        'readwrite',
        (store, setResult) => {
            const request = store.get(leaseId(ownerId));
            request.onsuccess = () => {
                const current = isLease(request.result) ? request.result : null;
                const expected = current?.status === 'dead' && expectedGeneration === 0
                    ? current.generation
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
    const locks = resolveLockManager();
    if (!locks) {
        return;
    }
    const heldNames = new Set(
        ((await locks.query()).held ?? [])
            .map(lock => lock.name)
            .filter((name): name is string => typeof name === 'string'),
    );
    await runObjectStoreTransaction<null>(
        BROWSER_LIVE_LEASES_STORE,
        'readwrite',
        (store) => {
            const request = store.getAll();
            request.onsuccess = () => {
                const leases = (Array.isArray(request.result) ? request.result : []).filter(isLease);
                for (const lease of leases) {
                    if (lease.status === 'dead' || heldNames.has(leaseOwnerLockName(lease.ownerId))) {
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
