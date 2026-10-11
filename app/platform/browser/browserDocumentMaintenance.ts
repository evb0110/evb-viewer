import {
    BROWSER_CHUNK_WRITE_YIELD_EVERY,
    BROWSER_DOCUMENT_CHUNK_SIZE,
    DOCUMENTS_STORE,
    DOCUMENT_CHUNKS_STORE,
    BROWSER_TRANSFER_AUTHORITY_STORE,
} from '@app/platform/browser/browserDocumentConstants';
import { uniq } from 'es-toolkit/array';
import { buildRecentFilesFromPersistedRecords } from '@app/platform/browser/buildRecentFilesFromPersistedRecords';
import {
    collectChunkIndicesByRef,
    countSourceDependents,
    isChunkedRecordMissingChunks,
    shouldRemovePersistedRecord,
    toPersistedDocumentRecord,
} from '@app/platform/browser/browserDocumentRecords';
import {
    loadAllRecordKeysAvailability,
    loadRecordAvailability,
} from '@app/platform/browser/browserDocumentIdb';
import {
    createChunkKey,
    loadAllChunkKeysAvailability,
    parseChunkKey,
} from '@app/platform/browser/browserDocumentChunks';
import {
    pruneRecentFiles,
    tryHasRecentFilesStorageSnapshot,
    tryReadRecentFilesFromStorage,
    writeRecentFilesToStorage,
    runSerializedRecentFilesStorageMutation,
} from '@app/platform/browser/browserRecentFilesStore';
import {
    admitBrowserMaintenance,
    hasActivePendingChunkGeneration,
    isRecentlyCreatedChunkGeneration,
    liveLeaseProtectsChunk,
} from '@app/platform/browser/browserDocumentAdmission';
import type {
    IBrowserDocumentEntry,
    IBrowserPersistedDocumentRecord,
} from '@app/platform/browser/browserDocumentTypes';
import type { IBrowserPersistedDocumentRecordsLoadResult } from '@app/platform/browser/browserPersistedDocumentRecordsLoadResult';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import { reclaimOrphanedBrowserDocumentLiveLeases } from '@app/platform/browser/browserDocumentLeaseStore';
import {BrowserLogger} from '@app/utils/browserLogger';

export interface IBrowserDocumentMaintenanceHooks {readonly beforeDestructiveTransaction?: () => Promise<void>;}

function isBrokenChunkedRecord(
    record: IBrowserPersistedDocumentRecord,
    chunkIndicesByRef: Map<string, Set<number>>,
) {
    return (
        record.storageMode === 'chunked'
        && record.fileSize > 0
        && (
            (record.chunkCount ?? 0) <= 0
            || (record.chunkCount ?? 0) !== Math.ceil(record.fileSize / Math.max(1, record.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE))
            || isChunkedRecordMissingChunks(record, chunkIndicesByRef)
        )
    );
}

export async function loadBrowserPersistedDocumentRecordsResult(): Promise<IBrowserPersistedDocumentRecordsLoadResult> {
    const rawKeysResult = await loadAllRecordKeysAvailability();
    if (!rawKeysResult.available) {
        return {
            available: false,
            records: [],
        };
    }

    const rawKeys = rawKeysResult.value;
    if (!Array.isArray(rawKeys)) {
        return {
            available: true,
            records: [],
        };
    }

    const records: IBrowserPersistedDocumentRecord[] = [];
    for (const key of rawKeys) {
        if (typeof key !== 'string') {
            continue;
        }
        const recordResult = await loadRecordAvailability(key);
        if (!recordResult.available) {
            return {
                available: false,
                records: [],
            };
        }
        const record = toPersistedDocumentRecord(recordResult.value);
        if (!record) {
            continue;
        }
        records.push({
            ...record,
            data: new Uint8Array(),
        });
        if (records.length % BROWSER_CHUNK_WRITE_YIELD_EVERY === 0) {
            await yieldToBrowser();
        }
    }

    return {
        available: true,
        records,
    };
}

export async function sweepBrowserDocumentMaintenance(
    entries: Map<string, IBrowserDocumentEntry>,
    hooks: IBrowserDocumentMaintenanceHooks = {},
) {
    // Retire the leases of owners that no longer exist before reading
    // protection, so a crashed window cannot pin its records forever.
    await reclaimOrphanedBrowserDocumentLiveLeases().catch(() => undefined);
    const {
        available,
        records,
    } = await loadBrowserPersistedDocumentRecordsResult();
    if (!available) {
        return;
    }
    const pendingRefs = new Set<string>(Array.from(entries.values())
        .filter((entry) => Boolean(entry.pendingLoad))
        .map((entry) => entry.ref));
    const recordsByRef = new Map(records.map((record) => [
        record.ref,
        record,
    ]));
    const pendingChunkGenerationsByRef = new Map(
        records
            .filter(hasActivePendingChunkGeneration)
            .flatMap(record => record.pendingChunkGeneration
                ? [[
                    record.ref,
                    record.pendingChunkGeneration,
                ] as const]
                : []),
    );
    const rawChunkKeysResult = await loadAllChunkKeysAvailability();
    if (!rawChunkKeysResult.available) {
        return;
    }
    const rawChunkKeys = rawChunkKeysResult.value;
    const chunkKeys = Array.isArray(rawChunkKeys)
        ? rawChunkKeys.flatMap((key) => {
            const parsedKey = typeof key === 'string' ? parseChunkKey(key) : null;
            return parsedKey ? [parsedKey] : [];
        })
        : [];
    const storedRecentFiles = tryReadRecentFilesFromStorage();
    const currentRecentFiles = tryHasRecentFilesStorageSnapshot()
        && storedRecentFiles
        ? storedRecentFiles
        : buildRecentFilesFromPersistedRecords(records);
    const recentRefs = new Set<string>(currentRecentFiles.map((file) => file.originalPath));
    const sourceDependentCounts = countSourceDependents(records);
    const refsToRemove = records
        .filter((record) => shouldRemovePersistedRecord(
            record,
            recentRefs,
            sourceDependentCounts,
        ))
        .filter((record) => !pendingRefs.has(record.ref))
        .filter(record => !hasActivePendingChunkGeneration(record))
        .map(record => record.ref);
    const chunkIndicesByRef = collectChunkIndicesByRef(chunkKeys);
    const brokenChunkRefs = records
        .filter((record) => isBrokenChunkedRecord(record, chunkIndicesByRef))
        .filter((record) => !pendingRefs.has(record.ref))
        .filter(record => !hasActivePendingChunkGeneration(record))
        .map((record) => record.ref);
    const refsToRemoveSet = new Set([
        ...refsToRemove,
        ...brokenChunkRefs,
    ]);
    if (refsToRemoveSet.size === 0 && chunkKeys.length === 0) {
        return;
    }

    await hooks.beforeDestructiveTransaction?.();

    const deletedRefs = await admitBrowserMaintenance('readwrite', (authorities, transaction) => {
        if (!authorities) {
            return new Set<string>();
        }
        // Recent Files at admission, read after the documents lock: a
        // touch admitted before this transaction is already visible.
        const recentFilesAtAdmission = tryHasRecentFilesStorageSnapshot()
            ? tryReadRecentFilesFromStorage()
            : currentRecentFiles;
        let transactionRecentRefs = recentRefs;
        if (recentFilesAtAdmission) {
            const {
                recentFiles,
                evictedRefs,
            } = pruneRecentFiles(recentFilesAtAdmission);
            let recentFilesForDecision = recentFiles;
            if (evictedRefs.length > 0 || recentFiles.length !== recentFilesAtAdmission.length) {
                let recentFilesPersisted = false;
                try {
                    recentFilesPersisted = writeRecentFilesToStorage(recentFiles);
                } catch (error) {
                    BrowserLogger.warn(
                        'browser-document-maintenance',
                        'Recent Files persistence failed during destructive admission',
                        error,
                    );
                }
                if (!recentFilesPersisted) {
                    // A failed localStorage write cannot authorize eviction.
                    recentFilesForDecision = recentFilesAtAdmission;
                }
            }
            transactionRecentRefs = new Set(
                recentFilesForDecision.map((file) => file.originalPath),
            );
        }
        const transactionRecordsByRef = new Map(authorities.documents.map(record => [
            record.ref,
            record,
        ]));
        const transactionPendingChunkGenerationsByRef = new Map(
            authorities.documents
                .filter(hasActivePendingChunkGeneration)
                .flatMap(record => record.pendingChunkGeneration
                    ? [[
                        record.ref,
                        record.pendingChunkGeneration,
                    ] as const]
                    : []),
        );
        const transactionBrokenChunkRefs = new Set(
            authorities.documents
                .filter(record => (
                    brokenChunkRefs.includes(record.ref)
                    && isBrokenChunkedRecord(record, chunkIndicesByRef)
                ))
                .map(record => record.ref),
        );
        const isUnprotected = (record: IBrowserPersistedDocumentRecord) => !authorities.recoveryLeasedRefs.has(record.ref) && !authorities.liveLeases.leasedRefs.has(record.ref)
            && !authorities.transfers.leasedRefs.has(record.ref) && !transactionPendingChunkGenerationsByRef.has(record.ref) && !pendingRefs.has(record.ref);
        const allSourceDependentCounts = countSourceDependents(authorities.documents);
        // A working copy this sweep deletes keeps nothing, so its source may go in the same pass.
        const sweptWorkingRefs = new Set(authorities.documents
            .filter(record => record.kind === 'working' && isUnprotected(record) && shouldRemovePersistedRecord(record, transactionRecentRefs, allSourceDependentCounts))
            .map(record => record.ref));
        const transactionSourceDependentCounts = countSourceDependents(authorities.documents.filter(record => !sweptWorkingRefs.has(record.ref)));
        const transactionRefsToRemove = authorities.documents
            .filter(record => isUnprotected(record) && shouldRemovePersistedRecord(record, transactionRecentRefs, transactionSourceDependentCounts))
            .map(record => record.ref);
        const finalRefs = new Set([
            ...transactionRefsToRemove,
            ...Array.from(transactionBrokenChunkRefs)
                .filter(ref => !authorities.recoveryLeasedRefs.has(ref))
                .filter(ref => !authorities.liveLeases.leasedRefs.has(ref))
                .filter(ref => !authorities.transfers.leasedRefs.has(ref)),
        ]);
        authorities.transfers.settledIds.forEach(id => transaction.objectStore(BROWSER_TRANSFER_AUTHORITY_STORE).delete(id));
        finalRefs.forEach(ref => transaction.objectStore(DOCUMENTS_STORE).delete(ref));
        const chunksStore = transaction.objectStore(DOCUMENT_CHUNKS_STORE);
        for (const chunkKey of chunkKeys) {
            if (pendingRefs.has(chunkKey.ref)) continue;
            if (liveLeaseProtectsChunk(
                authorities.liveLeases,
                chunkKey.ref,
                chunkKey.generation,
            )) continue;
            if (liveLeaseProtectsChunk(authorities.transfers, chunkKey.ref, chunkKey.generation)) continue;
            const pendingGeneration = transactionPendingChunkGenerationsByRef.get(chunkKey.ref)
                ?? pendingChunkGenerationsByRef.get(chunkKey.ref);
            if (pendingGeneration === chunkKey.generation) continue;
            const record = transactionRecordsByRef.get(chunkKey.ref)
                ?? recordsByRef.get(chunkKey.ref);
            const shouldDelete = !record
                || finalRefs.has(chunkKey.ref)
                || record.storageMode !== 'chunked'
                || chunkKey.generation !== (record.chunkGeneration ?? undefined)
                || chunkKey.index >= (record.chunkCount ?? 0);
            if (shouldDelete && !isRecentlyCreatedChunkGeneration(chunkKey.generation)) {
                chunksStore.delete(createChunkKey(
                    chunkKey.ref,
                    chunkKey.index,
                    chunkKey.generation,
                ));
            }
        }
        return finalRefs;
    });
    if (!deletedRefs) {
        throw new Error('IndexedDB document delete did not commit.');
    }
    deletedRefs.forEach(ref => entries.delete(ref));
    if (deletedRefs.size > 0) {
        await runSerializedRecentFilesStorageMutation(currentFiles => ({
            files: currentFiles.filter(candidate => !deletedRefs.has(candidate.originalPath)),
            value: undefined,
        })).catch(error => {
            BrowserLogger.warn(
                'browser-document-maintenance',
                'Recent Files cleanup failed after document deletion',
                error,
            );
        });
    }
}

export async function cleanupBrowserEvictedRecentRefs(
    refs: string[],
    cleanupRef: (ref: string) => Promise<void>,
) {
    const uniqueRefs = uniq(refs.filter(ref => ref.length > 0));
    if (uniqueRefs.length === 0) {
        return;
    }

    await Promise.allSettled(
        uniqueRefs.map(async (ref) => {
            await cleanupRef(ref);
        }),
    );
}
