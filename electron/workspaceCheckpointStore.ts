import { getErrorMessage } from '@electron/utils/error';
import {
    app,
    webContents,
} from 'electron';
import type {WebContents} from 'electron';
import {
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    decodeWorkspaceCheckpoint,
    type IWorkspaceCheckpoint,
} from '@contracts/workspaceCheckpoint';
import {parseDocumentRef} from '@contracts/documentRef';
import {
    isErrnoException,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { createLogger } from '@electron/utils/createLogger';
import { quarantineCorruptFile } from '@electron/utils/quarantineCorruptFile';
import {
    claimWorkingCopyOwnership,
    getWorkingCopyBackingEntry,
    getWorkingCopyOriginalPath,
    getWorkingCopyOwnerWebContentsId,
    setWorkingCopyOriginalPath,
    transitionWorkingCopyBackingState,
    type IWorkingCopyAdmissionSnapshot,
    type IWorkingCopyOriginalFileExpectation,
    type TWorkingCopyBackingErrorCode,
    type TWorkingCopyRole,
} from '@electron/file-access/workingCopyStore';
import {blockStaleWorkingCopyDirectoryCleanup} from '@electron/file-access/workingCopyCleanup';
import {requireOpenPath} from '@electron/file-access/openPathCapabilities';

const log = createLogger('workspace-checkpoint-store');

interface IStoredLazyWorkingCopy {
    admissionSnapshot: {
        mtimeNs: string;
        size: string;
    };
    originalFileExpectation?: IWorkingCopyOriginalFileExpectation;
    originalPath: string;
    registrationId: number;
    role: TWorkingCopyRole;
    sourceBackingErrorCode?: TWorkingCopyBackingErrorCode;
    workingCopyRef: string;
}

interface IStoredWorkspaceCheckpoint {
    version: 1;
    ownerWebContentsId: number;
    claimedByWebContentsId?: number;
    checkpoint: IWorkspaceCheckpoint;
    lazyWorkingCopies?: IStoredLazyWorkingCopy[];
    sourceProvenance?: IStoredSourceProvenance[];
}

interface IStoredSourceProvenance {
    kind: 'open-grant' | 'working-copy';
    ownerWebContentsId: number;
    sourceRef: string;
    workingCopyRef?: string;
}

interface IWorkspaceCheckpointSaveWaiter {
    resolve(): void;
    reject(error: unknown): void;
}

interface IPendingWorkspaceCheckpointSave {
    stored: IStoredWorkspaceCheckpoint;
    waiters: IWorkspaceCheckpointSaveWaiter[];
}

interface ITrailingWorkspaceCheckpointSave {
    stored: IStoredWorkspaceCheckpoint;
    ownerWebContentsId: number;
    waiters: IWorkspaceCheckpointSaveWaiter[];
    timer: NodeJS.Timeout;
}

const WORKSPACE_CHECKPOINT_SAVE_DEBOUNCE_MS = 500;

let checkpointWriteInFlight: Promise<void> | null = null;
let pendingLatestCheckpointSave: IPendingWorkspaceCheckpointSave | null = null;
let trailingCheckpointSave: ITrailingWorkspaceCheckpointSave | null = null;
let lastCheckpointSaveStartedAtMs = 0;
let checkpointBarrierQueue: Promise<unknown> = Promise.resolve();
let claimedWorkspaceCheckpointOwnerWebContentsId: number | null = null;
let claimedWorkspaceCheckpointPath: string | null = null;
let lastDurableWorkspaceCheckpoint: IStoredWorkspaceCheckpoint | null = null;
const discardedCheckpointOwnerGenerations = new Map<number, string>();
let nextDiscardedCheckpointOwnerGeneration = 1;

class WorkspaceCheckpointReadError extends Error {
    public readonly code = 'WORKSPACE_CHECKPOINT_READ_FAILED' as const;
    public readonly checkpointPath: string;
    public override readonly cause: unknown;

    public constructor(checkpointPath: string, cause: unknown) {
        super(`Workspace checkpoint could not be read: ${checkpointPath}`);
        this.name = 'WorkspaceCheckpointReadError';
        this.checkpointPath = checkpointPath;
        this.cause = cause;
    }
}

function getStoragePath() {
    return join(app.getPath('userData'), 'workspace-checkpoint.json');
}

function releaseClaimIfOwnerDestroyed(newOwnerWebContentsId: number) {
    if (
        claimedWorkspaceCheckpointOwnerWebContentsId === null
        || claimedWorkspaceCheckpointOwnerWebContentsId === newOwnerWebContentsId
        || claimedWorkspaceCheckpointPath !== getStoragePath()
    ) {
        return;
    }
    const claimedOwner = webContents.fromId(claimedWorkspaceCheckpointOwnerWebContentsId);
    if (claimedOwner?.isDestroyed() === true || claimedOwner === undefined) {
        claimedWorkspaceCheckpointOwnerWebContentsId = null;
        claimedWorkspaceCheckpointPath = null;
    }
}

const BACKING_ERROR_CODES = new Set<TWorkingCopyBackingErrorCode>([
    'SOURCE_BACKING_CHANGED',
    'SOURCE_BACKING_UNAVAILABLE',
    'WORKING_COPY_MATERIALIZATION_CANCELLED',
    'WORKING_COPY_MATERIALIZATION_FAILED',
    'WORKING_COPY_MATERIALIZATION_NO_SPACE',
    'WORKING_COPY_MATERIALIZATION_VERIFICATION_FAILED',
    'WORKING_COPY_REGISTRATION_CHANGED',
]);

function decodeOriginalFileExpectation(value: unknown): IWorkingCopyOriginalFileExpectation | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (
        !isRecord(value)
        || typeof value.mtimeMs !== 'number'
        || !Number.isFinite(value.mtimeMs)
        || typeof value.size !== 'number'
        || !Number.isSafeInteger(value.size)
        || value.size < 0
        || (
            value.contentFingerprint !== undefined
            && typeof value.contentFingerprint !== 'string'
        )
        || [
            value.ctimeNs,
            value.deviceId,
            value.inode,
            value.mtimeNs,
        ].some(field => field !== undefined && (
            typeof field !== 'string'
            || !/^(?:0|[1-9]\d*)$/u.test(field)
        ))
    ) {
        return undefined;
    }
    return {
        ...(value.contentFingerprint === undefined ? {} : {contentFingerprint: value.contentFingerprint}),
        ...(value.ctimeNs === undefined ? {} : {ctimeNs: value.ctimeNs as string}),
        ...(value.deviceId === undefined ? {} : {deviceId: value.deviceId as string}),
        ...(value.inode === undefined ? {} : {inode: value.inode as string}),
        ...(value.mtimeNs === undefined ? {} : {mtimeNs: value.mtimeNs as string}),
        mtimeMs: value.mtimeMs,
        size: value.size,
    };
}

function decodeLazyWorkingCopy(value: unknown): IStoredLazyWorkingCopy | null {
    if (
        !isRecord(value)
        || !isRecord(value.admissionSnapshot)
        || typeof value.admissionSnapshot.mtimeNs !== 'string'
        || !/^\d+$/.test(value.admissionSnapshot.mtimeNs)
        || typeof value.admissionSnapshot.size !== 'string'
        || !/^\d+$/.test(value.admissionSnapshot.size)
        || typeof value.originalPath !== 'string'
        || !value.originalPath
        || !Number.isSafeInteger(value.registrationId)
        || (value.role !== 'current' && value.role !== 'snapshot')
        || typeof value.workingCopyRef !== 'string'
        || !value.workingCopyRef
        || (
            value.sourceBackingErrorCode !== undefined
            && (
                typeof value.sourceBackingErrorCode !== 'string'
                || !BACKING_ERROR_CODES.has(value.sourceBackingErrorCode as TWorkingCopyBackingErrorCode)
            )
        )
    ) {
        return null;
    }
    const originalFileExpectation = decodeOriginalFileExpectation(value.originalFileExpectation);
    if (value.originalFileExpectation !== undefined && !originalFileExpectation) {
        return null;
    }
    return {
        admissionSnapshot: {
            mtimeNs: value.admissionSnapshot.mtimeNs,
            size: value.admissionSnapshot.size,
        },
        ...(originalFileExpectation ? {originalFileExpectation} : {}),
        originalPath: value.originalPath,
        registrationId: value.registrationId as number,
        role: value.role,
        ...(value.sourceBackingErrorCode === undefined
            ? {}
            : {sourceBackingErrorCode: value.sourceBackingErrorCode as TWorkingCopyBackingErrorCode}),
        workingCopyRef: value.workingCopyRef,
    };
}

function decodeStoredCheckpoint(value: unknown): IStoredWorkspaceCheckpoint | null {
    if (
        !isRecord(value)
        || value.version !== 1
        || !Number.isSafeInteger(value.ownerWebContentsId)
        || (
            value.claimedByWebContentsId !== undefined
            && !Number.isSafeInteger(value.claimedByWebContentsId)
        )
    ) {
        return null;
    }
    const checkpoint = decodeWorkspaceCheckpoint(value.checkpoint);
    if (!checkpoint) {
        return null;
    }
    const lazyWorkingCopies: IStoredLazyWorkingCopy[] = [];
    if (value.lazyWorkingCopies !== undefined) {
        if (!Array.isArray(value.lazyWorkingCopies)) {
            return null;
        }
        for (const candidate of value.lazyWorkingCopies) {
            const decoded = decodeLazyWorkingCopy(candidate);
            if (!decoded) {
                return null;
            }
            lazyWorkingCopies.push(decoded);
        }
    }
    const sourceProvenance: IStoredSourceProvenance[] = [];
    if (value.sourceProvenance !== undefined) {
        if (!Array.isArray(value.sourceProvenance)) {
            return null;
        }
        for (const candidate of value.sourceProvenance) {
            if (
                !isRecord(candidate)
                || (candidate.kind !== 'open-grant' && candidate.kind !== 'working-copy')
                || !Number.isSafeInteger(candidate.ownerWebContentsId)
                || typeof candidate.sourceRef !== 'string'
                || !candidate.sourceRef
                || (
                    candidate.workingCopyRef !== undefined
                    && (typeof candidate.workingCopyRef !== 'string' || !candidate.workingCopyRef)
                )
                || (candidate.kind === 'working-copy' && candidate.workingCopyRef === undefined)
            ) {
                return null;
            }
            sourceProvenance.push({
                kind: candidate.kind,
                ownerWebContentsId: candidate.ownerWebContentsId as number,
                sourceRef: candidate.sourceRef,
                ...(candidate.workingCopyRef === undefined ? {} : {workingCopyRef: candidate.workingCopyRef}),
            });
        }
    }
    return {
        version: 1,
        ownerWebContentsId: value.ownerWebContentsId as number,
        ...(value.claimedByWebContentsId === undefined
            ? {}
            : {claimedByWebContentsId: value.claimedByWebContentsId as number}),
        checkpoint,
        ...(lazyWorkingCopies.length === 0 ? {} : {lazyWorkingCopies}),
        ...(sourceProvenance.length === 0 ? {} : {sourceProvenance}),
    };
}

function collectLazyWorkingCopies(
    checkpoint: IWorkspaceCheckpoint,
    ownerWebContentsId: number,
) {
    const lazyWorkingCopies = new Map<string, IStoredLazyWorkingCopy>();
    for (const tab of checkpoint.tabs) {
        if (!tab.workingCopyRef || lazyWorkingCopies.has(tab.workingCopyRef)) {
            continue;
        }
        const entry = getWorkingCopyBackingEntry(tab.workingCopyRef, ownerWebContentsId);
        if (
            !entry
            || (
                entry.backingState !== 'lazy-original'
                && entry.backingState !== 'materializing'
            )
        ) {
            continue;
        }
        if (checkpoint.tabs.some(candidate => (
            candidate.workingCopyRef === tab.workingCopyRef
            && candidate.isDirty
        ))) {
            throw new Error('Workspace checkpoint cannot persist a dirty lazy working copy');
        }
        if (!entry.admissionSnapshot) {
            throw new Error('Workspace checkpoint lazy working copy has no admission snapshot');
        }
        lazyWorkingCopies.set(tab.workingCopyRef, {
            admissionSnapshot: {
                mtimeNs: entry.admissionSnapshot.mtimeNs.toString(),
                size: entry.admissionSnapshot.size.toString(),
            },
            ...(entry.originalFileExpectation
                ? {originalFileExpectation: entry.originalFileExpectation}
                : {}),
            originalPath: entry.originalPath,
            registrationId: entry.registrationId,
            role: entry.role,
            ...(entry.sourceBackingErrorCode
                ? {sourceBackingErrorCode: entry.sourceBackingErrorCode}
                : {}),
            workingCopyRef: tab.workingCopyRef,
        });
    }
    return Array.from(lazyWorkingCopies.values());
}

function assertNoDirtyLazyRecovery(stored: IStoredWorkspaceCheckpoint) {
    const lazyWorkingCopyRefs = new Set(
        (stored.lazyWorkingCopies ?? []).map(entry => entry.workingCopyRef),
    );
    if (stored.checkpoint.tabs.some(tab => (
        tab.isDirty
        && tab.workingCopyRef
        && lazyWorkingCopyRefs.has(tab.workingCopyRef)
    ))) {
        throw new Error('Workspace checkpoint rejected dirty lazy working-copy recovery');
    }
}

function toAdmissionSnapshot(stored: IStoredLazyWorkingCopy): IWorkingCopyAdmissionSnapshot {
    return {
        mtimeNs: BigInt(stored.admissionSnapshot.mtimeNs),
        size: BigInt(stored.admissionSnapshot.size),
    };
}

function canonicalizeCheckpointSources(
    checkpoint: IWorkspaceCheckpoint,
    ownerWebContentsId: number,
    options: {rejectUnmappedWorkingCopy: boolean},
) {
    return {
        ...checkpoint,
        tabs: checkpoint.tabs.map((tab) => {
            const workingCopySourceRef = tab.workingCopyRef
                ? parseDocumentRef(getWorkingCopyOriginalPath(tab.workingCopyRef, ownerWebContentsId)?.originalPath)
                : null;
            const sourceMapping = tab.sourceRef
                ? parseDocumentRef(getWorkingCopyOriginalPath(tab.sourceRef, ownerWebContentsId)?.originalPath)
                : null;
            const canonicalSourceRef = workingCopySourceRef ?? sourceMapping ?? tab.sourceRef;
            if (tab.workingCopyRef && !workingCopySourceRef && canonicalSourceRef === tab.workingCopyRef) {
                if (options.rejectUnmappedWorkingCopy) {
                    throw new Error('Workspace checkpoint working copy has no canonical source mapping');
                }
                return {
                    ...tab,
                    sourceRef: null,
                    workingCopyRef: null,
                };
            }
            return canonicalSourceRef === tab.sourceRef
                ? tab
                : {
                    ...tab,
                    sourceRef: canonicalSourceRef,
                };
        }),
    } satisfies IWorkspaceCheckpoint;
}

function buildSourceProvenance(
    checkpoint: IWorkspaceCheckpoint,
    ownerWebContentsId: number,
    sourceAuthorizationOwner: number | WebContents | undefined,
) {
    const provenance = new Map<string, IStoredSourceProvenance>();
    for (const tab of checkpoint.tabs) {
        if (!tab.sourceRef) {
            continue;
        }
        const mappedSource = tab.workingCopyRef
            ? parseDocumentRef(getWorkingCopyOriginalPath(tab.workingCopyRef, ownerWebContentsId)?.originalPath)
            : null;
        if (mappedSource && mappedSource === tab.sourceRef) {
            provenance.set(`${tab.workingCopyRef ?? ''}\u0000${tab.sourceRef}`, {
                kind: 'working-copy',
                ownerWebContentsId,
                sourceRef: tab.sourceRef,
                workingCopyRef: tab.workingCopyRef!,
            });
            continue;
        }
        if (sourceAuthorizationOwner !== undefined) {
            requireOpenPath(tab.sourceRef, sourceAuthorizationOwner);
        }
        provenance.set(`${tab.workingCopyRef ?? ''}\u0000${tab.sourceRef}`, {
            kind: 'open-grant',
            ownerWebContentsId,
            sourceRef: tab.sourceRef,
            ...(tab.workingCopyRef ? {workingCopyRef: tab.workingCopyRef} : {}),
        });
    }
    return Array.from(provenance.values());
}

function assertDurableSourceProvenance(
    stored: IStoredWorkspaceCheckpoint,
    checkpoint: IWorkspaceCheckpoint,
) {
    const provenance = stored.sourceProvenance ?? [];
    for (const tab of checkpoint.tabs) {
        if (!tab.sourceRef) {
            continue;
        }
        const entry = provenance.find(candidate => (
            candidate.sourceRef === tab.sourceRef
            && candidate.ownerWebContentsId === stored.ownerWebContentsId
            && (
                candidate.kind === 'open-grant'
                || candidate.workingCopyRef === tab.workingCopyRef
            )
        ));
        if (entry) {
            continue;
        }
        if (tab.workingCopyRef) {
            const mappedSource = parseDocumentRef(
                getWorkingCopyOriginalPath(tab.workingCopyRef, stored.ownerWebContentsId)?.originalPath,
            );
            if (mappedSource === tab.sourceRef) {
                continue;
            }
            const lazyWorkingCopy = stored.lazyWorkingCopies?.find(entry => (
                entry.workingCopyRef === tab.workingCopyRef
                && parseDocumentRef(entry.originalPath) === tab.sourceRef
            ));
            if (lazyWorkingCopy) {
                continue;
            }
        }
        throw new Error('Workspace checkpoint source has no durable authorization provenance');
    }
}

async function quarantineCorruptWorkspaceCheckpoint(reason: string) {
    // A corrupt checkpoint must not silently masquerade as "no checkpoint" on
    // every startup: log it and move it aside so recovery stops repeating while
    // the bad file is preserved for diagnosis.
    log.error(`Discarding workspace checkpoint: ${reason}`, {
        code: 'MAIN_WORKSPACE_CHECKPOINT_FAILED',
        context: {},
    });
    const storagePath = getStoragePath();
    try {
        const quarantinePath = await quarantineCorruptFile(storagePath);
        if (quarantinePath) {
            log.warn(`Quarantined corrupt workspace checkpoint at ${quarantinePath}`);
        } else {
            log.warn(`Corrupt workspace checkpoint already absent at ${storagePath}; nothing to quarantine`);
        }
    } catch (error) {
        // A failed quarantine must not masquerade as success: keep the original
        // error and the checkpoint path so the bad file can still be found. The
        // corrupt checkpoint is treated as discarded either way, so recovery
        // continues rather than propagating this failure.
        log.error(`Failed to quarantine corrupt workspace checkpoint at ${storagePath}: ${getErrorMessage(error)}`, {
            code: 'MAIN_WORKSPACE_CHECKPOINT_FAILED',
            context: {},
            cause: error,
        });
    }
}

async function writeStoredWorkspaceCheckpoint(stored: IStoredWorkspaceCheckpoint) {
    const storagePath = getStoragePath();
    const tempPath = makeSiblingTempPath(storagePath);
    try {
        await writeFile(tempPath, JSON.stringify(stored, null, 2), 'utf-8');
        await atomicReplace(tempPath, storagePath);
        lastDurableWorkspaceCheckpoint = stored;
    } catch (error) {
        // A failed write or replace must not leave the sibling .tmp behind, or
        // autosave retries accumulate orphans in userData and worsen a disk-full
        // condition. Best-effort cleanup; the original error still propagates.
        await rm(tempPath, {force: true}).catch(() => undefined);
        throw error;
    }
}

function readDurableWorkspaceCheckpointForSave() {
    if (lastDurableWorkspaceCheckpoint) {
        return lastDurableWorkspaceCheckpoint;
    }
    let raw: string;
    try {
        raw = readFileSync(getStoragePath(), 'utf-8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw new WorkspaceCheckpointReadError(getStoragePath(), error);
    }
    let stored: IStoredWorkspaceCheckpoint | null = null;
    try {
        stored = decodeStoredCheckpoint(JSON.parse(raw));
    } catch (error) {
        throw new WorkspaceCheckpointReadError(getStoragePath(), error);
    }
    if (!stored) {
        throw new WorkspaceCheckpointReadError(
            getStoragePath(),
            new Error('Workspace checkpoint schema decode returned no checkpoint'),
        );
    }
    lastDurableWorkspaceCheckpoint = stored;
    return stored;
}

function retainUnresolvedCheckpointTabs(
    checkpoint: IWorkspaceCheckpoint,
    durable: IStoredWorkspaceCheckpoint | null,
) {
    if (!durable) {
        return checkpoint;
    }
    const previousByTabId = new Map(
        durable.checkpoint.tabs.map(tab => [
            tab.tabId,
            tab,
        ]),
    );
    return {
        ...checkpoint,
        tabs: checkpoint.tabs.map((tab) => {
            if (!tab.isDirty || tab.workingCopyRef) {
                return tab;
            }
            const previous = previousByTabId.get(tab.tabId);
            if (!previous?.workingCopyRef) {
                return tab;
            }
            return {
                ...tab,
                sourceRef: tab.sourceRef ?? previous.sourceRef,
                workingCopyRef: previous.workingCopyRef,
                ...(previous.requiresSaveAsOnFirstSave && tab.requiresSaveAsOnFirstSave === undefined
                    ? {requiresSaveAsOnFirstSave: true}
                    : {}),
            };
        }),
    } satisfies IWorkspaceCheckpoint;
}

function settleCheckpointSave(
    save: IPendingWorkspaceCheckpointSave,
    error?: unknown,
) {
    for (const waiter of save.waiters) {
        if (error === undefined) {
            waiter.resolve();
        } else {
            waiter.reject(error);
        }
    }
}

function startCheckpointWriteDrain(initialSave: IPendingWorkspaceCheckpointSave) {
    checkpointWriteInFlight = (async () => {
        let currentSave: IPendingWorkspaceCheckpointSave | null = initialSave;
        while (currentSave) {
            try {
                await writeStoredWorkspaceCheckpoint(currentSave.stored);
                settleCheckpointSave(currentSave);
            } catch (error) {
                settleCheckpointSave(currentSave, error);
            }
            currentSave = pendingLatestCheckpointSave;
            pendingLatestCheckpointSave = null;
        }
    })().finally(() => {
        checkpointWriteInFlight = null;
        if (pendingLatestCheckpointSave) {
            const nextSave = pendingLatestCheckpointSave;
            pendingLatestCheckpointSave = null;
            startCheckpointWriteDrain(nextSave);
        }
    });
}

function enqueueWorkspaceCheckpointSave(stored: IStoredWorkspaceCheckpoint) {
    return new Promise<void>((resolve, reject) => {
        const waiter = {
            resolve,
            reject,
        };
        if (!checkpointWriteInFlight) {
            startCheckpointWriteDrain({
                stored,
                waiters: [waiter],
            });
            return;
        }
        if (pendingLatestCheckpointSave) {
            pendingLatestCheckpointSave = {
                stored,
                waiters: [
                    ...pendingLatestCheckpointSave.waiters,
                    waiter,
                ],
            };
            return;
        }
        pendingLatestCheckpointSave = {
            stored,
            waiters: [waiter],
        };
    });
}

async function drainWorkspaceCheckpointWrites() {
    while (checkpointWriteInFlight) {
        await checkpointWriteInFlight;
    }
}

function takeTrailingCheckpointSave() {
    const pending = trailingCheckpointSave;
    if (!pending) {
        return null;
    }
    trailingCheckpointSave = null;
    clearTimeout(pending.timer);
    return pending;
}

// Runs only from inside the barrier queue: committing anywhere else would let a
// queued clear or claim land between taking the trailing save and writing it,
// and the write would resurrect the checkpoint the barrier just removed.
async function commitTrailingCheckpointSave(pending: ITrailingWorkspaceCheckpointSave) {
    lastCheckpointSaveStartedAtMs = Date.now();
    try {
        if (!discardedCheckpointOwnerGenerations.has(pending.ownerWebContentsId)) {
            await enqueueWorkspaceCheckpointSave(pending.stored);
        }
        for (const waiter of pending.waiters) {
            waiter.resolve();
        }
    } catch (error) {
        for (const waiter of pending.waiters) {
            waiter.reject(error);
        }
    }
}

function scheduleTrailingCheckpointSave(
    stored: IStoredWorkspaceCheckpoint,
    ownerWebContentsId: number,
    delayMs: number,
) {
    return new Promise<void>((resolve, reject) => {
        const waiter = {
            resolve,
            reject,
        };
        if (trailingCheckpointSave) {
            trailingCheckpointSave.stored = stored;
            trailingCheckpointSave.ownerWebContentsId = ownerWebContentsId;
            trailingCheckpointSave.waiters.push(waiter);
            return;
        }
        const timer = setTimeout(() => {
            // The barrier's own take-and-flush commits the pending save; a no-op
            // barrier serializes the debounced write against queued clears/claims.
            void enqueueWorkspaceCheckpointBarrier(async () => {});
        }, delayMs);
        timer.unref();
        trailingCheckpointSave = {
            stored,
            ownerWebContentsId,
            waiters: [waiter],
            timer,
        };
    });
}

/**
 * Writes any debounced checkpoint immediately. Shutdown preservation must await this
 * before the process exits, otherwise the newest checkpoint is lost.
 */
export async function flushPendingWorkspaceCheckpointSave() {
    await enqueueWorkspaceCheckpointBarrier(async () => {});
}

function enqueueWorkspaceCheckpointBarrier<T>(operation: () => Promise<T>) {
    const barrier = checkpointBarrierQueue.then(async () => {
        // Claim and clear observe the newest state, so a debounced save is written
        // before them rather than after, where it would resurrect a removed checkpoint.
        const pending = takeTrailingCheckpointSave();
        if (pending) {
            await commitTrailingCheckpointSave(pending);
        }
        await drainWorkspaceCheckpointWrites();
        return operation();
    });
    checkpointBarrierQueue = barrier.then(() => undefined, () => undefined);
    return barrier;
}

export async function saveWorkspaceCheckpoint(
    checkpoint: IWorkspaceCheckpoint,
    ownerWebContentsId: number,
    sourceAuthorizationOwner?: number | WebContents,
) {
    if (discardedCheckpointOwnerGenerations.has(ownerWebContentsId)) {
        return;
    }
    for (const tab of checkpoint.tabs) {
        if (tab.workingCopyRef && getWorkingCopyOwnerWebContentsId(tab.workingCopyRef) !== ownerWebContentsId) {
            throw new Error('Workspace checkpoint contains an unowned working copy');
        }
    }
    const durable = readDurableWorkspaceCheckpointForSave();
    const checkpointWithRetainedTabs = retainUnresolvedCheckpointTabs(checkpoint, durable);
    const canonicalCheckpoint = canonicalizeCheckpointSources(
        checkpointWithRetainedTabs,
        ownerWebContentsId,
        {rejectUnmappedWorkingCopy: true},
    );
    const sourceProvenance = buildSourceProvenance(
        canonicalCheckpoint,
        ownerWebContentsId,
        sourceAuthorizationOwner,
    );
    const lazyWorkingCopies = collectLazyWorkingCopies(checkpointWithRetainedTabs, ownerWebContentsId);
    const stored: IStoredWorkspaceCheckpoint = {
        version: 1,
        ownerWebContentsId,
        ...(claimedWorkspaceCheckpointOwnerWebContentsId === ownerWebContentsId
            && claimedWorkspaceCheckpointPath === getStoragePath()
            ? {claimedByWebContentsId: ownerWebContentsId}
            : {}),
        checkpoint: canonicalCheckpoint,
        ...(lazyWorkingCopies.length === 0 ? {} : {lazyWorkingCopies}),
        ...(sourceProvenance.length === 0 ? {} : {sourceProvenance}),
    };
    await checkpointBarrierQueue;
    if (discardedCheckpointOwnerGenerations.has(ownerWebContentsId)) {
        return;
    }
    const elapsedMs = Date.now() - lastCheckpointSaveStartedAtMs;
    if (!trailingCheckpointSave && elapsedMs >= WORKSPACE_CHECKPOINT_SAVE_DEBOUNCE_MS) {
        lastCheckpointSaveStartedAtMs = Date.now();
        return enqueueWorkspaceCheckpointSave(stored);
    }
    return scheduleTrailingCheckpointSave(
        stored,
        ownerWebContentsId,
        Math.max(0, WORKSPACE_CHECKPOINT_SAVE_DEBOUNCE_MS - elapsedMs),
    );
}

export async function claimWorkspaceCheckpoint(newOwnerWebContentsId: number) {
    return enqueueWorkspaceCheckpointBarrier(async () => {
        releaseClaimIfOwnerDestroyed(newOwnerWebContentsId);
        if (
            claimedWorkspaceCheckpointPath === getStoragePath()
            && claimedWorkspaceCheckpointOwnerWebContentsId !== null
            && claimedWorkspaceCheckpointOwnerWebContentsId !== newOwnerWebContentsId
        ) {
            // A renderer is already restoring this checkpoint. Keeping the file
            // in place makes a crash retryable, but a second live renderer must
            // not steal its working copies mid-restore.
            return null;
        }
        let raw: string;
        try {
            raw = await readFile(getStoragePath(), 'utf-8');
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                // No checkpoint has been written yet: the normal clean-startup case.
                return null;
            }
            // A permission or transient I/O failure is not corruption. Keep the
            // evidence and stop stale cleanup before surfacing a typed failure.
            const checkpointPath = getStoragePath();
            blockStaleWorkingCopyDirectoryCleanup(
                `workspace checkpoint read failed at ${checkpointPath}`,
            );
            log.error(`Failed to read workspace checkpoint: ${getErrorMessage(error)}`, {
                code: 'MAIN_WORKSPACE_CHECKPOINT_FAILED',
                context: {},
                cause: error,
            });
            throw new WorkspaceCheckpointReadError(checkpointPath, error);
        }

        let stored: IStoredWorkspaceCheckpoint | null = null;
        try {
            stored = decodeStoredCheckpoint(JSON.parse(raw));
        } catch (error) {
            await quarantineCorruptWorkspaceCheckpoint(
                `parse failure: ${getErrorMessage(error)}`,
            );
            return null;
        }
        if (!stored) {
            await quarantineCorruptWorkspaceCheckpoint('schema decode returned no checkpoint');
            return null;
        }
        try {
            assertNoDirtyLazyRecovery(stored);
        } catch (error) {
            // A persisted-state invariant violation is corruption, not a
            // transient failure: quarantine and return null like the parse and
            // schema paths above, or the same bad file crash-loops recovery on
            // every startup. This runs before any ownership change below.
            await quarantineCorruptWorkspaceCheckpoint(
                `invariant failure: ${getErrorMessage(error)}`,
            );
            return null;
        }
        const canonicalCheckpoint = canonicalizeCheckpointSources(
            stored.checkpoint,
            stored.ownerWebContentsId,
            {rejectUnmappedWorkingCopy: false},
        );
        assertDurableSourceProvenance(stored, canonicalCheckpoint);
        const lazyWorkingCopies = new Map(
            (stored.lazyWorkingCopies ?? []).map(entry => [
                entry.workingCopyRef,
                entry,
            ]),
        );
        for (const tab of canonicalCheckpoint.tabs) {
            if (tab.workingCopyRef) {
                const transferred = claimWorkingCopyOwnership(
                    tab.workingCopyRef,
                    stored.ownerWebContentsId,
                    newOwnerWebContentsId,
                );
                const lazyWorkingCopy = lazyWorkingCopies.get(tab.workingCopyRef);
                if (!transferred && lazyWorkingCopy) {
                    await setWorkingCopyOriginalPath(
                        tab.workingCopyRef,
                        lazyWorkingCopy.originalPath,
                        newOwnerWebContentsId,
                        {
                            admissionSnapshot: toAdmissionSnapshot(lazyWorkingCopy),
                            backingState: 'lazy-original',
                            deferOriginalFileExpectation: true,
                            ...(lazyWorkingCopy.originalFileExpectation
                                ? {originalFileExpectation: lazyWorkingCopy.originalFileExpectation}
                                : {}),
                            role: lazyWorkingCopy.role,
                        },
                    );
                    if (lazyWorkingCopy.sourceBackingErrorCode) {
                        const restoredEntry = getWorkingCopyBackingEntry(
                            tab.workingCopyRef,
                            newOwnerWebContentsId,
                        );
                        if (restoredEntry) {
                            transitionWorkingCopyBackingState(
                                tab.workingCopyRef,
                                restoredEntry.registrationId,
                                'lazy-original',
                                {sourceBackingErrorCode: lazyWorkingCopy.sourceBackingErrorCode},
                            );
                        }
                    }
                } else if (!transferred && tab.sourceRef) {
                    await setWorkingCopyOriginalPath(
                        tab.workingCopyRef,
                        tab.sourceRef,
                        newOwnerWebContentsId,
                    );
                }
            }
        }
        // Keep the checkpoint until the renderer has reopened every tab and
        // explicitly acknowledges success. The owner marker is persisted so a
        // main-process restart can distinguish an in-progress restore from an
        // old, untouched checkpoint without deleting recovery evidence early.
        await writeStoredWorkspaceCheckpoint({
            ...stored,
            claimedByWebContentsId: newOwnerWebContentsId,
            checkpoint: canonicalCheckpoint,
        });
        lastDurableWorkspaceCheckpoint = {
            ...stored,
            claimedByWebContentsId: newOwnerWebContentsId,
            checkpoint: canonicalCheckpoint,
        };
        claimedWorkspaceCheckpointOwnerWebContentsId = newOwnerWebContentsId;
        claimedWorkspaceCheckpointPath = getStoragePath();
        return canonicalCheckpoint;
    });
}

export function acknowledgeWorkspaceCheckpoint(ownerWebContentsId: number) {
    return enqueueWorkspaceCheckpointBarrier(async () => {
        const storagePath = getStoragePath();
        let raw: string;
        try {
            raw = await readFile(storagePath, 'utf-8');
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                if (
                    claimedWorkspaceCheckpointPath === storagePath
                    && claimedWorkspaceCheckpointOwnerWebContentsId === ownerWebContentsId
                ) {
                    claimedWorkspaceCheckpointOwnerWebContentsId = null;
                    claimedWorkspaceCheckpointPath = null;
                }
                return false;
            }
            blockStaleWorkingCopyDirectoryCleanup(`workspace checkpoint acknowledgement read failed at ${storagePath}`);
            throw new WorkspaceCheckpointReadError(storagePath, error);
        }
        let stored: IStoredWorkspaceCheckpoint | null = null;
        try {
            stored = decodeStoredCheckpoint(JSON.parse(raw));
        } catch (error) {
            await quarantineCorruptWorkspaceCheckpoint(
                `acknowledgement parse failure: ${getErrorMessage(error)}`,
            );
            throw new WorkspaceCheckpointReadError(storagePath, error);
        }
        if (!stored) {
            const decodeError = new Error('Workspace checkpoint schema decode returned no checkpoint');
            await quarantineCorruptWorkspaceCheckpoint(
                `acknowledgement schema failure: ${decodeError.message}`,
            );
            throw new WorkspaceCheckpointReadError(storagePath, decodeError);
        }
        if (
            stored.claimedByWebContentsId !== ownerWebContentsId
            && !(
                claimedWorkspaceCheckpointPath === storagePath
                && claimedWorkspaceCheckpointOwnerWebContentsId === ownerWebContentsId
            )
        ) {
            throw new Error('Workspace checkpoint acknowledgement is not owned by this renderer');
        }
        await rm(storagePath, {force: true});
        lastDurableWorkspaceCheckpoint = null;
        if (
            claimedWorkspaceCheckpointPath === storagePath
            && claimedWorkspaceCheckpointOwnerWebContentsId === ownerWebContentsId
        ) {
            claimedWorkspaceCheckpointOwnerWebContentsId = null;
            claimedWorkspaceCheckpointPath = null;
        }
        return true;
    });
}

export function clearWorkspaceCheckpoint() {
    return enqueueWorkspaceCheckpointBarrier(async () => {
        await rm(getStoragePath(), {force: true});
        lastDurableWorkspaceCheckpoint = null;
        claimedWorkspaceCheckpointOwnerWebContentsId = null;
        claimedWorkspaceCheckpointPath = null;
    });
}

export async function discardWorkspaceCheckpoint(ownerWebContentsId: number) {
    const generation = String(nextDiscardedCheckpointOwnerGeneration);
    nextDiscardedCheckpointOwnerGeneration += 1;
    discardedCheckpointOwnerGenerations.set(
        ownerWebContentsId,
        generation,
    );
    try {
        await clearWorkspaceCheckpoint();
    } catch (error) {
        if (discardedCheckpointOwnerGenerations.get(ownerWebContentsId) === generation) {
            discardedCheckpointOwnerGenerations.delete(ownerWebContentsId);
        }
        throw error;
    }
    return generation;
}

export function resumeWorkspaceCheckpoint(
    ownerWebContentsId: number,
    discardToken: string,
) {
    if (discardedCheckpointOwnerGenerations.get(ownerWebContentsId) !== discardToken) {
        throw new Error('Workspace checkpoint discard token is stale or invalid');
    }
    discardedCheckpointOwnerGenerations.delete(ownerWebContentsId);
}
