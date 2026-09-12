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

export async function saveBrowserDocumentLiveLease(
    ownerId: string,
    expectedGeneration: number,
    status: IBrowserDocumentLiveLease['status'],
    protectedDependencies: IBrowserDocumentLeaseDependency[],
) {
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
