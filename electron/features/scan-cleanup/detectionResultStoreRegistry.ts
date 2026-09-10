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
}

interface IRegisteredStore extends IScanCleanupDetectionResultStoreLease {expiry: ReturnType<typeof setTimeout>;}

const RESULT_STORE_HANDOFF_TTL_MS = 10 * 60 * 1000;
const registeredStores = new Map<string, IRegisteredStore>();

function closeStore(store: IRegisteredStore) {
    clearTimeout(store.expiry);
    return store.resultStore.close().catch(() => undefined);
}

/** Register one completed document-scale result store for the next run. */
export function registerScanCleanupDetectionResultStore(input: Omit<
    IScanCleanupDetectionResultStoreLease,
    'storeId'
>) {
    const storeId = `scan-cleanup-results-${randomUUID()}`;
    const registered: IRegisteredStore = {
        ...input,
        expiry: setTimeout(() => {
            const current = registeredStores.get(storeId);
            if (current === registered) {
                registeredStores.delete(storeId);
                void closeStore(registered);
            }
        }, RESULT_STORE_HANDOFF_TTL_MS),
        storeId,
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
    registeredStores.delete(storeId);
    clearTimeout(registered.expiry);
    return registered;
}

/** Release a still-unclaimed store when its owning service is disposed. */
async function releaseScanCleanupDetectionResultStore(storeId: string) {
    const registered = registeredStores.get(storeId);
    if (registered === undefined) {
        return;
    }
    registeredStores.delete(storeId);
    await closeStore(registered);
}

/** Close all stores registered by one preview service. */
export async function releaseScanCleanupDetectionResultStores(storeIds: Iterable<string>) {
    await Promise.all([...new Set(storeIds)].map(storeId => releaseScanCleanupDetectionResultStore(storeId)));
}
