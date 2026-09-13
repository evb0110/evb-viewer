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
    ownerKey: string;
    borrowers: number;
    closed: boolean;
    expiry: ReturnType<typeof setTimeout> | null;
    retired: boolean;
}

const RESULT_STORE_HANDOFF_TTL_MS = 10 * 60 * 1000;
const registeredStores = new Map<string, IRegisteredStore>();
const currentStoreByOwnerKey = new Map<string, string>();
const openOwners = new Set<string>();

function closeStore(store: IRegisteredStore) {
    if (store.closed) {
        return Promise.resolve();
    }
    store.closed = true;
    if (store.expiry !== null) {
        clearTimeout(store.expiry);
        store.expiry = null;
    }
    return store.resultStore.close().catch(() => undefined);
}

function closeIfRetired(store: IRegisteredStore) {
    return store.retired && store.borrowers === 0 ? closeStore(store) : Promise.resolve();
}

function scheduleExpiry(storeId: string, store: IRegisteredStore) {
    if (store.expiry !== null || store.closed || store.retired) {
        return;
    }
    store.expiry = setTimeout(() => {
        const current = registeredStores.get(storeId);
        if (current !== store) {
            return;
        }
        registeredStores.delete(storeId);
        if (currentStoreByOwnerKey.get(store.ownerKey) === storeId) {
            currentStoreByOwnerKey.delete(store.ownerKey);
        }
        store.expiry = null;
        store.retired = true;
        void closeIfRetired(store);
    }, RESULT_STORE_HANDOFF_TTL_MS);
    store.expiry.unref();
}

/** Keep completed evidence alive while its renderer owner remains open. */
export function retainScanCleanupDetectionResultStoreOwner(ownerId: string) {
    openOwners.add(ownerId);
    for (const store of registeredStores.values()) {
        if (store.ownerId === ownerId && store.expiry !== null) {
            clearTimeout(store.expiry);
            store.expiry = null;
        }
    }
}

/** Register one completed document-scale result store for the next run. */
export function registerScanCleanupDetectionResultStore(input: Omit<
    IScanCleanupDetectionResultStoreLease,
    'release' | 'storeId'
> & {ownerKey: string}) {
    const storeId = `scan-cleanup-results-${randomUUID()}`;
    const previousStoreId = currentStoreByOwnerKey.get(input.ownerKey);
    if (previousStoreId !== undefined) {
        void releaseScanCleanupDetectionResultStore(previousStoreId);
    }
    const registered: IRegisteredStore = {
        ...input,
        borrowers: 0,
        closed: false,
        expiry: null,
        storeId,
        retired: false,
    };
    registeredStores.set(storeId, registered);
    currentStoreByOwnerKey.set(input.ownerKey, storeId);
    if (!openOwners.has(input.ownerId)) {
        scheduleExpiry(storeId, registered);
    }
    return storeId;
}

/** Whether an opaque id still names an unretired registered store. */
export function isScanCleanupDetectionResultStoreRegistered(storeId: string) {
    const registered = registeredStores.get(storeId);
    return registered !== undefined && !registered.closed && !registered.retired;
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
export async function releaseScanCleanupDetectionResultStore(storeId: string) {
    const registered = registeredStores.get(storeId);
    if (registered === undefined) {
        return;
    }
    registeredStores.delete(storeId);
    if (currentStoreByOwnerKey.get(registered.ownerKey) === storeId) {
        currentStoreByOwnerKey.delete(registered.ownerKey);
    }
    registered.retired = true;
    await closeIfRetired(registered);
}

/** Retire the current completed store without closing its renderer owner. */
export async function releaseScanCleanupDetectionResultStoreForOwner(ownerKey: string) {
    const storeId = currentStoreByOwnerKey.get(ownerKey);
    if (storeId === undefined) {
        return;
    }
    await releaseScanCleanupDetectionResultStore(storeId);
}

/** Retire every completed store owned by a renderer session. */
export async function releaseScanCleanupDetectionResultStoreOwner(ownerId: string) {
    openOwners.delete(ownerId);
    await Promise.all(
        [...registeredStores.values()]
            .filter(store => store.ownerId === ownerId)
            .map(store => releaseScanCleanupDetectionResultStore(store.storeId)),
    );
}

/** Close all stores registered by one preview service. */
export async function releaseScanCleanupDetectionResultStores(storeIds: Iterable<string>) {
    await Promise.all([...new Set(storeIds)].map(storeId => releaseScanCleanupDetectionResultStore(storeId)));
}
