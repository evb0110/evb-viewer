import {
    BROWSER_CHUNK_WRITE_YIELD_EVERY,
    BROWSER_DOCUMENT_CHUNK_SIZE,
    DOCUMENTS_STORE,
    DOCUMENT_CHUNKS_STORE,
    WORKSPACE_RECOVERY_STORE,
} from '@app/platform/browser/browserDocumentConstants';
import { uniq } from 'es-toolkit/array';
import { buildRecentFilesFromPersistedRecords } from '@app/platform/browser/buildRecentFilesFromPersistedRecords';
import {
    collectChunkIndicesByRef,
    countNonWorkingDependents,
    isChunkedRecordMissingChunks,
    shouldRemovePersistedRecord,
    toPersistedDocumentRecord,
} from '@app/platform/browser/browserDocumentRecords';
import {
    loadAllRecordKeysAvailability,
    loadRecordAvailability,
    runObjectStoresTransaction,
} from '@app/platform/browser/browserDocumentIdb';
import {
    createChunkKey,
    loadAllChunkKeysAvailability,
    parseChunkKey,
} from '@app/platform/browser/browserDocumentChunks';
import {
    pruneRecentFiles,
    readRecentFilesFromStorage,
    tryHasRecentFilesStorageSnapshot,
    tryReadRecentFilesFromStorage,
    writeRecentFilesToStorage,
    BROWSER_RECENT_FILES_STORAGE_LOCK_KEY,
    runSerializedRecentFilesStorageMutation,
} from '@app/platform/browser/browserRecentFilesStore';
import type {
    IBrowserDocumentEntry,
    IBrowserPersistedDocumentRecord,
} from '@app/platform/browser/browserDocumentTypes';
import type { IBrowserPersistedDocumentRecordsLoadResult } from '@app/platform/browser/browserPersistedDocumentRecordsLoadResult';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import { loadBrowserWorkspaceRecoveryLeasedRefs } from '@app/platform/browser/browserWorkspaceRecoveryStore';

const BROWSER_STAGED_CHUNK_GRACE_MS = 10 * 60 * 1_000;

export interface IBrowserDocumentMaintenanceHooks {readonly beforeDestructiveTransaction?: () => Promise<void>;}

function isRecentlyCreatedChunkGeneration(generation: string | undefined) {
    if (!generation) {
        return false;
    }
    const timestampPrefix = generation.split('-', 1)[0];
    if (!timestampPrefix) {
        return false;
    }
    const createdAt = Number.parseInt(timestampPrefix, 36);
    if (!Number.isFinite(createdAt)) {
        return false;
    }
    const age = Date.now() - createdAt;
    return age >= 0 && age <= BROWSER_STAGED_CHUNK_GRACE_MS;
}

function hasActivePendingChunkGeneration(record: IBrowserPersistedDocumentRecord) {
    if (!record.pendingChunkGeneration) {
        return false;
    }
    if (typeof record.pendingChunkUpdatedAt === 'number') {
        const age = Date.now() - record.pendingChunkUpdatedAt;
        return age >= 0 && age <= BROWSER_STAGED_CHUNK_GRACE_MS;
    }
    return isRecentlyCreatedChunkGeneration(record.pendingChunkGeneration);
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

export async function loadBrowserPersistedDocumentRecords(): Promise<IBrowserPersistedDocumentRecord[]> {
    return (await loadBrowserPersistedDocumentRecordsResult()).records;
}

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

export function isBrowserRecentFileRef(ref: string) {
    return readRecentFilesFromStorage().some(
        (candidate) => candidate.originalPath === ref,
    );
}

export async function sweepBrowserDocumentMaintenance(
    entries: Map<string, IBrowserDocumentEntry>,
    hooks: IBrowserDocumentMaintenanceHooks = {},
) {
    const recoveryLeasedRefs = await loadBrowserWorkspaceRecoveryLeasedRefs();
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
    const nonWorkingDependentCounts = countNonWorkingDependents(records);
    const refsToRemove = records
        .filter((record) => shouldRemovePersistedRecord(
            record,
            recentRefs,
            nonWorkingDependentCounts,
        ))
        .filter(record => !recoveryLeasedRefs.has(record.ref))
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

    // Include the recovery journal in the destructive transaction. IndexedDB
    // serializes this with checkpoint publication, so the lease read and the
    // corresponding document/chunk deletes cannot race each other.
    const deletedRefs = await runObjectStoresTransaction<Set<string>>(
        [
            WORKSPACE_RECOVERY_STORE,
            DOCUMENTS_STORE,
            DOCUMENT_CHUNKS_STORE,
        ],
        'readwrite',
        (transaction, setResult) => {
            const recoveryStore = transaction.objectStore(WORKSPACE_RECOVERY_STORE);
            const documentsStore = transaction.objectStore(DOCUMENTS_STORE);
            const chunksStore = transaction.objectStore(DOCUMENT_CHUNKS_STORE);
            const recoveriesRead = recoveryStore.getAll();
            const documentsRead = documentsStore.getAll();
            // Recent-file mutations use this same documents-store transaction
            // as their cross-window lock. Do not read localStorage until this
            // request succeeds, otherwise a touch admitted before this
            // destructive transaction can be hidden by the stale snapshot
            // captured above.
            const recentFilesLockRead = documentsStore.get(BROWSER_RECENT_FILES_STORAGE_LOCK_KEY);
            let recoveryReadComplete = false;
            let documentsReadComplete = false;
            let recentFilesLockReadComplete = false;
            let transactionRecentRefs = recentRefs;
            const process = () => {
                if (!recoveryReadComplete || !documentsReadComplete || !recentFilesLockReadComplete) {
                    return;
                }
                const recentFilesAtAdmission = tryHasRecentFilesStorageSnapshot()
                    ? tryReadRecentFilesFromStorage()
                    : currentRecentFiles;
                if (recentFilesAtAdmission) {
                    const {
                        recentFiles,
                        evictedRefs,
                    } = pruneRecentFiles(recentFilesAtAdmission);
                    let recentFilesForDecision = recentFiles;
                    if (evictedRefs.length > 0 || recentFiles.length !== recentFilesAtAdmission.length) {
                        if (!writeRecentFilesToStorage(recentFiles)) {
                            // A failed localStorage write cannot authorize eviction.
                            recentFilesForDecision = recentFilesAtAdmission;
                        }
                    }
                    transactionRecentRefs = new Set(
                        recentFilesForDecision.map((file) => file.originalPath),
                    );
                }
                const leasedRefs = new Set<string>();
                if (Array.isArray(recoveriesRead.result)) {
                    for (const record of recoveriesRead.result) {
                        if (!record || typeof record !== 'object') {
                            continue;
                        }
                        const snapshotRefs = (record as {snapshotRefs?: unknown}).snapshotRefs;
                        if (!Array.isArray(snapshotRefs)) {
                            continue;
                        }
                        for (const ref of snapshotRefs) {
                            if (typeof ref === 'string') {
                                leasedRefs.add(ref);
                            }
                        }
                    }
                }
                const transactionRecords = Array.isArray(documentsRead.result)
                    ? documentsRead.result.flatMap((value: unknown) => {
                        const record = toPersistedDocumentRecord(value);
                        return record ? [record] : [];
                    })
                    : records;
                const transactionRecordsByRef = new Map(transactionRecords.map(record => [
                    record.ref,
                    record,
                ]));
                const transactionPendingChunkGenerationsByRef = new Map(
                    transactionRecords
                        .filter(hasActivePendingChunkGeneration)
                        .flatMap(record => record.pendingChunkGeneration
                            ? [[
                                record.ref,
                                record.pendingChunkGeneration,
                            ] as const]
                            : []),
                );
                const transactionNonWorkingDependentCounts = countNonWorkingDependents(transactionRecords);
                const transactionBrokenChunkRefs = new Set(
                    transactionRecords
                        .filter(record => (
                            brokenChunkRefs.includes(record.ref)
                            && isBrokenChunkedRecord(record, chunkIndicesByRef)
                        ))
                        .map(record => record.ref),
                );
                const brokenChunkRefsSet = new Set(brokenChunkRefs);
                const finalRefs = new Set(Array.from(refsToRemoveSet).filter(ref => {
                    if (leasedRefs.has(ref) || transactionPendingChunkGenerationsByRef.has(ref)) {
                        return false;
                    }
                    const transactionRecord = transactionRecordsByRef.get(ref);
                    if (!transactionRecord) {
                        return false;
                    }
                    if (brokenChunkRefsSet.has(ref)) {
                        return transactionBrokenChunkRefs.has(ref);
                    }
                    return shouldRemovePersistedRecord(
                        transactionRecord,
                        transactionRecentRefs,
                        transactionNonWorkingDependentCounts,
                    );
                }));
                finalRefs.forEach(ref => documentsStore.delete(ref));
                for (const chunkKey of chunkKeys) {
                    if (pendingRefs.has(chunkKey.ref)) continue;
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
                setResult(finalRefs);
            };
            recoveriesRead.onsuccess = () => {
                recoveryReadComplete = true;
                process();
            };
            documentsRead.onsuccess = () => {
                documentsReadComplete = true;
                process();
            };
            recentFilesLockRead.onsuccess = () => {
                recentFilesLockReadComplete = true;
                process();
            };
        },
    );
    if (!deletedRefs) {
        throw new Error('IndexedDB document delete did not commit.');
    }
    deletedRefs.forEach(ref => entries.delete(ref));
    if (deletedRefs.size > 0) {
        await runSerializedRecentFilesStorageMutation(currentFiles => ({
            files: currentFiles.filter(candidate => !deletedRefs.has(candidate.originalPath)),
            value: undefined,
        })).catch(() => undefined);
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
