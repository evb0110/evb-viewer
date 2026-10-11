import {
    BROWSER_CHUNK_WRITE_YIELD_EVERY,
    BROWSER_DOCUMENT_CHUNK_SIZE,
    DOCUMENTS_STORE,
    DOCUMENT_CHUNKS_STORE,
    WORKSPACE_RECOVERY_STORE,
    BROWSER_LIVE_LEASES_STORE,
    BROWSER_TRANSFER_AUTHORITY_STORE,
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
    runObjectStoresTransaction,BROWSER_TRANSFER_AUTHORITY_RECORD_SCHEMA,
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
import {BROWSER_DOCUMENT_LIVE_LEASE_SCHEMA} from '@app/platform/browser/browserDocumentTypes';
import type { IBrowserPersistedDocumentRecordsLoadResult } from '@app/platform/browser/browserPersistedDocumentRecordsLoadResult';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import { loadBrowserWorkspaceRecoveryLeasedRefs } from '@app/platform/browser/browserWorkspaceRecoveryStore';
import { reclaimOrphanedBrowserDocumentLiveLeases } from '@app/platform/browser/browserDocumentLeaseStore';
import {BrowserLogger} from '@app/utils/browserLogger';
import * as v from 'valibot';

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

interface IBrowserLiveLeaseProtection {
    leasedRefs: Set<string>;
    allGenerationsRefs: Set<string>;
    leasedGenerations: Set<string>;
}

function getChunkGenerationKey(ref: string, generation: string | undefined) {
    return `${ref}\0${generation ?? ''}`;
}

function readLiveLeaseProtection(value: unknown): IBrowserLiveLeaseProtection | null {
    const parsed = v.safeParse(v.array(BROWSER_DOCUMENT_LIVE_LEASE_SCHEMA), value, {abortEarly: true});
    if (!parsed.success) {
        return null;
    }

    const leasedRefs = new Set<string>();
    const allGenerationsRefs = new Set<string>();
    const leasedGenerations = new Set<string>();
    for (const lease of parsed.output) {
        if (lease.status === 'dead') {
            continue;
        }
        for (const dependency of lease.protectedDependencies) {
            leasedRefs.add(dependency.ref);
            if (dependency.chunkGeneration === undefined) {
                allGenerationsRefs.add(dependency.ref);
            } else {
                leasedGenerations.add(getChunkGenerationKey(
                    dependency.ref,
                    dependency.chunkGeneration,
                ));
            }
        }
    }

    return {
        leasedRefs,
        allGenerationsRefs,
        leasedGenerations,
    };
}

function liveLeaseProtectsChunk(
    protection: IBrowserLiveLeaseProtection,
    ref: string,
    generation: string | undefined,
) {
    return protection.allGenerationsRefs.has(ref)
        || protection.leasedGenerations.has(getChunkGenerationKey(ref, generation));
}

// A transfer that has reached a terminal decision no longer needs its backing
// refs pinned, but the losing participant may still be polling for that
// decision. Keep the record and its protection until the poll window has
// closed, then drop both; otherwise every transfer a window ever performed
// pins its documents for the lifetime of the origin.
const SETTLED_TRANSFER_RETENTION_MS = 60 * 1_000;

interface IBrowserTransferAuthorityProtection extends IBrowserLiveLeaseProtection {settledIds: Set<string>;}

function readTransferAuthorityProtection(value: unknown): IBrowserTransferAuthorityProtection | null {
    const parsed = v.safeParse(v.array(BROWSER_TRANSFER_AUTHORITY_RECORD_SCHEMA), value, {abortEarly: true});
    if (!parsed.success) {
        return null;
    }
    const leasedRefs = new Set<string>();
    const allGenerationsRefs = new Set<string>();
    const leasedGenerations = new Set<string>();
    const settledIds = new Set<string>();
    const settledBefore = Date.now() - SETTLED_TRANSFER_RETENTION_MS;
    for (const authority of parsed.output) {
        if ((authority.state === 'committed' || authority.state === 'aborted')
            && authority.decidedAt !== undefined
            && authority.decidedAt <= settledBefore) {
            settledIds.add(authority.id);
            continue;
        }
        for (const dependency of authority.backingRefs) {
            leasedRefs.add(dependency.ref);
            if (dependency.chunkGeneration === undefined) {
                allGenerationsRefs.add(dependency.ref);
            } else {
                leasedGenerations.add(getChunkGenerationKey(dependency.ref, dependency.chunkGeneration));
            }
        }
    }
    return {
        leasedRefs,
        allGenerationsRefs,
        leasedGenerations,
        settledIds,
    };
}

// The recovery journal's snapshot refs. Only that field is needed to protect a
// ref, so only that field is required to decode a recovery row.
const RECOVERY_SNAPSHOT_REFS_SCHEMA = v.object({snapshotRefs: v.array(v.string())});

interface IBrowserMaintenanceAuthorities {
    /** Every document row in the admitting transaction, decoded. */
    documents: IBrowserPersistedDocumentRecord[];
    recoveryLeasedRefs: Set<string>;
    liveLeases: IBrowserLiveLeaseProtection;
    transfers: IBrowserTransferAuthorityProtection;
}

// A row that cannot be decoded names refs this snapshot cannot see, so the whole
// snapshot is refused rather than read around it.
function readBrowserMaintenanceAuthorities(reads: {
    documents: unknown;
    recoveries: unknown;
    liveLeases: unknown;
    transfers: unknown;
}): IBrowserMaintenanceAuthorities | null {
    if (!Array.isArray(reads.documents) || !Array.isArray(reads.recoveries)) {
        return null;
    }
    const documents: IBrowserPersistedDocumentRecord[] = [];
    for (const value of reads.documents) {
        const record = toPersistedDocumentRecord(value);
        if (!record) {
            return null;
        }
        documents.push(record);
    }
    const recoveryLeasedRefs = new Set<string>();
    for (const value of reads.recoveries) {
        const parsed = v.safeParse(RECOVERY_SNAPSHOT_REFS_SCHEMA, value, {abortEarly: true});
        if (!parsed.success) {
            return null;
        }
        parsed.output.snapshotRefs.forEach(ref => recoveryLeasedRefs.add(ref));
    }
    const liveLeases = readLiveLeaseProtection(reads.liveLeases);
    const transfers = readTransferAuthorityProtection(reads.transfers);
    if (!liveLeases || !transfers) {
        return null;
    }
    return {
        documents,
        recoveryLeasedRefs,
        liveLeases,
        transfers,
    };
}

// The single admission for destructive decisions. Every authority is read in
// one transaction, and `decide` decides from that snapshot and performs its
// writes in the same transaction, so a lease committed after the reads cannot
// be overtaken. `decide` receives null when an authority cannot be read or
// decoded, and must then delete nothing.
async function admitBrowserMaintenance<T>(
    mode: IDBTransactionMode,
    decide: (authorities: IBrowserMaintenanceAuthorities | null, transaction: IDBTransaction) => T,
) {
    return runObjectStoresTransaction<T>(
        [
            WORKSPACE_RECOVERY_STORE,
            DOCUMENTS_STORE,
            DOCUMENT_CHUNKS_STORE,
            BROWSER_LIVE_LEASES_STORE,
            BROWSER_TRANSFER_AUTHORITY_STORE,
        ],
        mode,
        (transaction, setResult) => {
            const recoveriesRead = transaction.objectStore(WORKSPACE_RECOVERY_STORE).getAll();
            const documentsRead = transaction.objectStore(DOCUMENTS_STORE).getAll();
            const liveLeasesRead = transaction.objectStore(BROWSER_LIVE_LEASES_STORE).getAll();
            const transferAuthoritiesRead = transaction.objectStore(BROWSER_TRANSFER_AUTHORITY_STORE).getAll();
            // Recent-file mutations use this same documents-store transaction as their cross-window
            // lock. Do not read localStorage until this request succeeds, otherwise a touch admitted
            // before this transaction can be hidden by a stale snapshot.
            const recentFilesLockRead = transaction.objectStore(DOCUMENTS_STORE).get(BROWSER_RECENT_FILES_STORAGE_LOCK_KEY);
            const reads = [
                recoveriesRead,
                documentsRead,
                liveLeasesRead,
                transferAuthoritiesRead,
                recentFilesLockRead,
            ];
            let pendingReads = reads.length;
            for (const read of reads) {
                read.onsuccess = () => {
                    pendingReads -= 1;
                    if (pendingReads > 0) {
                        return;
                    }
                    setResult(decide(readBrowserMaintenanceAuthorities({
                        documents: documentsRead.result,
                        recoveries: recoveriesRead.result,
                        liveLeases: liveLeasesRead.result,
                        transfers: transferAuthoritiesRead.result,
                    }), transaction));
                };
            }
        },
    );
}

function isRefRetainedBy(authorities: IBrowserMaintenanceAuthorities, ref: string) {
    return authorities.documents.some((record) => record.ref !== ref && record.sourceRef === ref)
        || authorities.recoveryLeasedRefs.has(ref)
        || authorities.liveLeases.leasedRefs.has(ref)
        || authorities.transfers.leasedRefs.has(ref);
}

// Detached-record cleanup may remove a source only when no working copy depends
// on it and no live lease, recovery journal or transfer names it. These are the
// authorities the destructive sweep reads; an authority that cannot be read or
// decoded keeps the ref.
export async function isBrowserRefRetained(ref: string) {
    const retained = await admitBrowserMaintenance('readonly', authorities => (
        authorities === null || isRefRetainedBy(authorities, ref)
    ));
    return retained ?? true;
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
        const transactionNonWorkingDependentCounts = countNonWorkingDependents(authorities.documents);
        const transactionBrokenChunkRefs = new Set(
            authorities.documents
                .filter(record => (
                    brokenChunkRefs.includes(record.ref)
                    && isBrokenChunkedRecord(record, chunkIndicesByRef)
                ))
                .map(record => record.ref),
        );
        const transactionRefsToRemove = authorities.documents
            .filter(record => shouldRemovePersistedRecord(
                record,
                transactionRecentRefs,
                transactionNonWorkingDependentCounts,
            ))
            .filter(record => !authorities.recoveryLeasedRefs.has(record.ref))
            .filter(record => !authorities.liveLeases.leasedRefs.has(record.ref))
            .filter(record => !authorities.transfers.leasedRefs.has(record.ref))
            .filter(record => !transactionPendingChunkGenerationsByRef.has(record.ref))
            .filter(record => !pendingRefs.has(record.ref))
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
