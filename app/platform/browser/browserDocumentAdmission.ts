import {
    DOCUMENTS_STORE,
    DOCUMENT_CHUNKS_STORE,
    WORKSPACE_RECOVERY_STORE,
    BROWSER_LIVE_LEASES_STORE,
    BROWSER_TRANSFER_AUTHORITY_STORE,
} from '@app/platform/browser/browserDocumentConstants';
import {
    runObjectStoresTransaction,
    BROWSER_TRANSFER_AUTHORITY_RECORD_SCHEMA,
} from '@app/platform/browser/browserDocumentIdb';
import { toPersistedDocumentRecord } from '@app/platform/browser/browserDocumentRecords';
import {
    BROWSER_RECENT_FILES_STORAGE_LOCK_KEY,
    tryReadRecentFilesFromStorage,
} from '@app/platform/browser/browserRecentFilesStore';
import type {
    IBrowserDocumentEntry,
    IBrowserPersistedDocumentRecord,
} from '@app/platform/browser/browserDocumentTypes';
import {BROWSER_DOCUMENT_LIVE_LEASE_SCHEMA} from '@app/platform/browser/browserDocumentTypes';
import * as v from 'valibot';

const BROWSER_STAGED_CHUNK_GRACE_MS = 10 * 60 * 1_000;

export function isRecentlyCreatedChunkGeneration(generation: string | undefined) {
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

export function hasActivePendingChunkGeneration(record: IBrowserPersistedDocumentRecord) {
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

export function liveLeaseProtectsChunk(
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
export async function admitBrowserMaintenance<T>(
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

// A working copy is judged by the recovery journal and in-flight transfers only.
// The window's own lease names a copy until the next checkpoint or heartbeat
// republishes it, so a copy that an edit or save has superseded would stay pinned
// until reload. The sweep still honours every lease for working copies, which is
// how another window's open document keeps its copy.
function isRefRetainedBy(
    authorities: IBrowserMaintenanceAuthorities,
    ref: string,
    kind: IBrowserPersistedDocumentRecord['kind'] | undefined,
) {
    if (authorities.recoveryLeasedRefs.has(ref) || authorities.transfers.leasedRefs.has(ref)) {
        return true;
    }
    if (kind === 'working') {
        return false;
    }
    return authorities.documents.some((record) => record.ref !== ref && record.sourceRef === ref)
        || authorities.liveLeases.leasedRefs.has(ref);
}

type TBrowserDetachedRecordRemoval = 'absent' | 'deleted' | 'retained';

// Detached-record cleanup may delete a source only in the admission that judged
// it: no working copy depends on it, no live lease, recovery journal or transfer
// names it, and Recent Files does not list it. An authority that cannot be read
// or decoded keeps it. The reported result says whether this admission deleted a
// row, so the caller clears external chunks only for a record it removed.
export async function removeBrowserDetachedRecordIfUnretained(
    ref: string,
    entries: Map<string, IBrowserDocumentEntry>,
): Promise<TBrowserDetachedRecordRemoval> {
    const removal = await admitBrowserMaintenance<TBrowserDetachedRecordRemoval>('readwrite', (authorities, transaction) => {
        if (authorities === null || entries.get(ref)?.pendingLoad) {
            return 'retained';
        }
        const record = authorities.documents.find(candidate => candidate.ref === ref);
        if (isRefRetainedBy(authorities, ref, record?.kind)) {
            return 'retained';
        }
        // Read after the documents lock, like the sweep's admission.
        const recentFiles = tryReadRecentFilesFromStorage();
        if (recentFiles === null || recentFiles.some(file => file.originalPath === ref)) {
            return 'retained';
        }
        if (!record) {
            return 'absent';
        }
        if (hasActivePendingChunkGeneration(record)) {
            return 'retained';
        }
        transaction.objectStore(DOCUMENTS_STORE).delete(ref);
        return 'deleted';
    });
    return removal ?? 'retained';
}
