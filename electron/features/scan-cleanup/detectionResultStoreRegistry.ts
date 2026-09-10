import {randomUUID} from 'node:crypto';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';

/**
 * A renderer only receives this opaque id. The result store itself stays in
 * the main process until the final-run service turns it into a worker-safe
 * file descriptor.
 */
export interface IScanCleanupDetectionResultStoreLease {
    detectionSignature: string;
    documentRevision: string;
    ownerId: string;
    resultStore: IScanCleanupDetectionResultStore;
    sourcePdfPath: string;
    storeId: string;
    release(): Promise<void>;
}

interface IRegisteredStore extends Omit<IScanCleanupDetectionResultStoreLease, 'release'> {
    borrowers: number;
    closed: boolean;
    expiry: ReturnType<typeof setTimeout>;
    retired: boolean;
}

const RESULT_STORE_HANDOFF_TTL_MS = 10 * 60 * 1000;
const registeredStores = new Map<string, IRegisteredStore>();

function closeStore(store: IRegisteredStore) {
    if (store.closed) {
        return Promise.resolve();
    }
    store.closed = true;
    clearTimeout(store.expiry);
    return store.resultStore.close().catch(() => undefined);
}

function closeIfRetired(store: IRegisteredStore) {
    return store.retired && store.borrowers === 0 ? closeStore(store) : Promise.resolve();
}

/** Register one completed document-scale result store for the next run. */
export function registerScanCleanupDetectionResultStore(input: Omit<
    IScanCleanupDetectionResultStoreLease,
    'release' | 'storeId'
>) {
    const storeId = `scan-cleanup-results-${randomUUID()}`;
    const registered: IRegisteredStore = {
        ...input,
        borrowers: 0,
        closed: false,
        expiry: setTimeout(() => {
            const current = registeredStores.get(storeId);
            if (current === registered) {
                registeredStores.delete(storeId);
                registered.retired = true;
                void closeIfRetired(registered);
            }
        }, RESULT_STORE_HANDOFF_TTL_MS),
        storeId,
        retired: false,
    };
    registered.expiry.unref();
    registeredStores.set(storeId, registered);
    return storeId;
}

/** Claim a store only for the owner and document that produced it. */
export function claimScanCleanupDetectionResultStore(
    storeId: string,
    owner: Pick<IScanCleanupDetectionResultStoreLease, 'detectionSignature' | 'documentRevision' | 'ownerId' | 'sourcePdfPath'>,
): IScanCleanupDetectionResultStoreLease | null {
    const registered = registeredStores.get(storeId);
    if (
        registered === undefined
        || registered.documentRevision !== owner.documentRevision
        || registered.ownerId !== owner.ownerId
        || registered.sourcePdfPath !== owner.sourcePdfPath
        || registered.detectionSignature !== owner.detectionSignature
    ) {
        return null;
    }
    registered.borrowers += 1;
    let released = false;
    return {
        ...registered,
        release: async () => {
            if (released) {
                return;
            }
            released = true;
            registered.borrowers -= 1;
            await closeIfRetired(registered);
        },
    };
}

/** Release a still-unclaimed store when its owning service is disposed. */
async function releaseScanCleanupDetectionResultStore(storeId: string) {
    const registered = registeredStores.get(storeId);
    if (registered === undefined) {
        return;
    }
    registeredStores.delete(storeId);
    registered.retired = true;
    await closeIfRetired(registered);
}

/** Close all stores registered by one preview service. */
export async function releaseScanCleanupDetectionResultStores(storeIds: Iterable<string>) {
    await Promise.all([...new Set(storeIds)].map(storeId => releaseScanCleanupDetectionResultStore(storeId)));
}
