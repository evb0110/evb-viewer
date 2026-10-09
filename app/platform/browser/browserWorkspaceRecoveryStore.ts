import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import { decodeWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import { WORKSPACE_RECOVERY_STORE } from '@app/platform/browser/browserDocumentConstants';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    runObjectStoreTransaction,
    withObjectStoreReadResult,
} from '@app/platform/browser/browserDocumentIdb';
import { withLeaseOwnerLock } from '@app/platform/browser/browserDocumentLeaseStore';
import * as v from 'valibot';

const recoveryOwnerIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const recoveryRecordSchema = v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    ownerId: recoveryOwnerIdSchema,
    generation: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    leaseRevision: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
    checkpoint: v.unknown(),
    snapshotRefs: v.array(v.string()),
    updatedAt: v.pipe(v.number(), v.finite()),
});
type IBrowserWorkspaceRecoveryRecord = v.InferOutput<typeof recoveryRecordSchema>;

const recoverySnapshotSchema = v.pipe(
    recoveryRecordSchema,
    // Recovery loading preserves the legacy lease revision and scopes refs to the checkpoint's working copies.
    v.transform(record => {
        const checkpoint = decodeWorkspaceCheckpoint(record.checkpoint);
        if (!checkpoint || record.id !== getRecoveryRecordId(record.ownerId)) {
            return null;
        }
        const leaseRevision = record.leaseRevision ?? (
            Number.isSafeInteger(record.updatedAt) && record.updatedAt >= 0
                ? record.updatedAt
                : 0
        );
        const snapshotRefs = record.snapshotRefs.map(parseDocumentRef);
        if (snapshotRefs.some(ref => ref === null)) {
            return null;
        }
        const checkpointRefs = new Set(checkpoint.tabs.flatMap(tab => (
            tab.workingCopyRef ? [tab.workingCopyRef] : []
        )));
        return {
            ownerId: record.ownerId,
            generation: record.generation,
            leaseRevision,
            checkpoint,
            snapshotRefs: Array.from(new Set(snapshotRefs.flatMap(ref => {
                return ref !== null && checkpointRefs.has(ref) ? [ref] : [];
            }))),
            updatedAt: record.updatedAt,
        };
    }),
    v.check(value => value !== null),
    v.transform(value => value as NonNullable<typeof value>),
);
type IBrowserWorkspaceRecoverySnapshot = v.InferOutput<typeof recoverySnapshotSchema>;

export type TBrowserWorkspaceRecoveryMutationResult =
    | {
        saved: true;
        generation: number
    }
    | {
        saved: false;
        generation: number
    };

export type TBrowserWorkspaceRecoveryClaimResult =
    | {
        claimed: true;
        generation: number
    }
    | {
        claimed: false;
        generation: number
    };

export const RECOVERY_OWNER_LEASE_TIMEOUT_MS = 30_000;

function getRecoveryRecordId(ownerId: string) {
    return `owner:${ownerId}`;
}

function isValidOwnerId(value: unknown): value is string {
    return v.safeParse(recoveryOwnerIdSchema, value, {abortEarly: true}).success;
}

function decodeRecoveryRecord(value: unknown): IBrowserWorkspaceRecoverySnapshot | null {
    const result = v.safeParse(recoverySnapshotSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export async function loadBrowserWorkspaceRecoveries() {
    const result = await withObjectStoreReadResult<unknown[]>(
        WORKSPACE_RECOVERY_STORE,
        store => store.getAll(),
    );
    if (!result.available || !Array.isArray(result.value)) {
        return [];
    }
    return result.value.flatMap((value) => {
        const decoded = decodeRecoveryRecord(value);
        return decoded ? [decoded] : [];
    });
}

export async function loadBrowserWorkspaceRecovery(ownerId: string) {
    if (!isValidOwnerId(ownerId)) {
        return null;
    }
    const result = await withObjectStoreReadResult<unknown>(
        WORKSPACE_RECOVERY_STORE,
        store => store.get(getRecoveryRecordId(ownerId)),
    );
    return result.available ? decodeRecoveryRecord(result.value) : null;
}

export async function loadBrowserWorkspaceRecoveryLeasedRefs() {
    return new Set<string>((await loadBrowserWorkspaceRecoveries()).flatMap(record => record.snapshotRefs));
}

async function mutateBrowserWorkspaceRecovery(
    ownerId: string,
    expectedGeneration: number,
    mutate: (
        store: IDBObjectStore,
        id: string,
        current: IBrowserWorkspaceRecoverySnapshot | null,
        currentGeneration: number,
    ) => number | null,
) {
    if (!isValidOwnerId(ownerId) || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
        throw new TypeError('Browser recovery owner and generation must be valid.');
    }
    const id = getRecoveryRecordId(ownerId);
    const outcome = await runObjectStoreTransaction<TBrowserWorkspaceRecoveryMutationResult>(
        WORKSPACE_RECOVERY_STORE,
        'readwrite',
        (store, setResult) => {
            const read = store.get(id);
            read.onsuccess = () => {
                const current = decodeRecoveryRecord(read.result);
                const currentGeneration = current?.generation ?? 0;
                if (currentGeneration !== expectedGeneration) {
                    setResult({
                        saved: false,
                        generation: currentGeneration,
                    });
                    return;
                }
                const nextGeneration = mutate(store, id, current, currentGeneration);
                if (nextGeneration === null) {
                    setResult({
                        saved: false,
                        generation: currentGeneration,
                    });
                    return;
                }
                setResult({
                    saved: true,
                    generation: nextGeneration,
                });
            };
        },
    );
    if (!outcome) {
        throw new Error('IndexedDB browser recovery mutation did not commit.');
    }
    return outcome;
}

export async function saveBrowserWorkspaceRecovery(
    ownerId: string,
    expectedGeneration: number,
    checkpoint: IWorkspaceCheckpoint,
    snapshotRefs: TDocumentRef[],
): Promise<TBrowserWorkspaceRecoveryMutationResult> {
    return mutateBrowserWorkspaceRecovery(ownerId, expectedGeneration, (store, id, current, currentGeneration) => {
        const generation = currentGeneration + 1;
        const record: IBrowserWorkspaceRecoveryRecord = {
            id,
            ownerId,
            generation,
            leaseRevision: (current?.leaseRevision ?? 0) + 1,
            checkpoint,
            snapshotRefs: Array.from(new Set(snapshotRefs)),
            updatedAt: Date.now(),
        };
        store.put(record);
        return generation;
    });
}

export async function clearBrowserWorkspaceRecovery(
    ownerId: string,
    expectedGeneration: number,
): Promise<TBrowserWorkspaceRecoveryMutationResult> {
    return mutateBrowserWorkspaceRecovery(ownerId, expectedGeneration, (store, id, current) => {
        if (current) store.delete(id);
        return 0;
    });
}

export async function touchBrowserWorkspaceRecovery(
    ownerId: string,
    expectedGeneration: number,
): Promise<TBrowserWorkspaceRecoveryMutationResult> {
    if (!isValidOwnerId(ownerId) || !Number.isSafeInteger(expectedGeneration) || expectedGeneration <= 0) {
        throw new TypeError('Browser recovery heartbeat owner and generation must be valid.');
    }

    return mutateBrowserWorkspaceRecovery(ownerId, expectedGeneration, (store, id, current) => {
        if (!current) {
            return null;
        }
        store.put({
            id,
            ownerId: current.ownerId,
            generation: current.generation,
            leaseRevision: current.leaseRevision + 1,
            checkpoint: current.checkpoint,
            snapshotRefs: current.snapshotRefs,
            updatedAt: Date.now(),
        } satisfies IBrowserWorkspaceRecoveryRecord);
        return current.generation;
    });
}

export async function claimBrowserWorkspaceRecoveryOwner(
    sourceOwnerId: string,
    targetOwnerId: string,
    expectedGeneration: number,
    expectedLeaseRevision?: number,
): Promise<TBrowserWorkspaceRecoveryClaimResult> {
    if (
        !isValidOwnerId(sourceOwnerId)
        || !isValidOwnerId(targetOwnerId)
        || sourceOwnerId === targetOwnerId
        || !Number.isSafeInteger(expectedGeneration)
        || expectedGeneration <= 0
        || (
            expectedLeaseRevision !== undefined
            && (!Number.isSafeInteger(expectedLeaseRevision) || expectedLeaseRevision < 0)
        )
    ) {
        throw new TypeError('Browser recovery claim owners and generation must be valid.');
    }
    const sourceId = getRecoveryRecordId(sourceOwnerId);
    const targetId = getRecoveryRecordId(targetOwnerId);
    // A frozen or throttled owner keeps its lease lock, so holding that lock
    // through the transaction proves the owner is gone. Only a browser without
    // a lock manager falls back to the age of the owner's last heartbeat.
    const outcome = await withLeaseOwnerLock(sourceOwnerId, ownerLock => runObjectStoreTransaction<TBrowserWorkspaceRecoveryClaimResult>(
        WORKSPACE_RECOVERY_STORE,
        'readwrite',
        (store, setResult) => {
            const recordsRead = store.getAll();
            recordsRead.onsuccess = () => {
                const records = Array.isArray(recordsRead.result) ? recordsRead.result : [];
                const source = records
                    .map(decodeRecoveryRecord)
                    .find(record => record?.ownerId === sourceOwnerId) ?? null;
                const now = Date.now();
                if (
                    !source
                    || source.ownerId !== sourceOwnerId
                    || source.generation !== expectedGeneration
                    || (
                        expectedLeaseRevision !== undefined
                        && source.leaseRevision !== expectedLeaseRevision
                    )
                    || ownerLock === 'held'
                    || (
                        ownerLock === 'unsupported'
                        && now - source.updatedAt < RECOVERY_OWNER_LEASE_TIMEOUT_MS
                    )
                ) {
                    setResult({
                        claimed: false,
                        generation: source?.generation ?? 0,
                    });
                    return;
                }
                const target = records
                    .map(decodeRecoveryRecord)
                    .find(record => record?.ownerId === targetOwnerId) ?? null;
                if (target) {
                    setResult({
                        claimed: false,
                        generation: target.generation,
                    });
                    return;
                }
                const generation = source.generation + 1;
                store.delete(sourceId);
                store.put({
                    id: targetId,
                    ownerId: targetOwnerId,
                    generation,
                    leaseRevision: source.leaseRevision + 1,
                    checkpoint: source.checkpoint,
                    snapshotRefs: source.snapshotRefs,
                    updatedAt: Date.now(),
                } satisfies IBrowserWorkspaceRecoveryRecord);
                setResult({
                    claimed: true,
                    generation,
                });
            };
        },
    ));
    if (!outcome) throw new Error('IndexedDB browser recovery owner claim did not commit.');
    return outcome;
}
