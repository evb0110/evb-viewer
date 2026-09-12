import { getErrorMessage } from '@electron/utils/error';
import {
    app,
    webContents,
} from 'electron';
import type {WebContents} from 'electron';
import {
    readFile,
    rm,
    mkdir,
    writeFile,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    decodeWorkspaceCheckpoint,
    type IWorkspaceCheckpoint,
    type IWorkspaceCheckpointAnnotationRecovery,
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
    claimWorkingCopyRecovery,
    getWorkingCopyBackingEntry,
    getWorkingCopyOriginalPath,
    getWorkingCopyOwnerWebContentsId,
    setWorkingCopyOriginalPath,
    releaseWorkingCopyRecovery,
    transitionWorkingCopyBackingState,
    type TWorkingCopyBackingState,
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
    workingCopies?: IStoredWorkingCopy[];
    sourceProvenance?: IStoredSourceProvenance[];
}

interface IStoredWorkspaceJournal {
    version: 2;
    records: IStoredWorkspaceCheckpoint[];
}

interface IStoredWorkingCopy {
    admissionSnapshot?: {
        mtimeNs: string;
        size: string;
    };
    backingState: TWorkingCopyBackingState;
    originalFileExpectation?: IWorkingCopyOriginalFileExpectation;
    originalPath: string;
    registrationId: number;
    role: TWorkingCopyRole;
    sourceBackingErrorCode?: TWorkingCopyBackingErrorCode;
    workingCopyRef: string;
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
    artifacts: IAnnotationRecoveryArtifact[];
    waiters: IWorkspaceCheckpointSaveWaiter[];
}

interface ITrailingWorkspaceCheckpointSave {
    stored: IStoredWorkspaceCheckpoint;
    artifacts: IAnnotationRecoveryArtifact[];
    ownerWebContentsId: number;
    waiters: IWorkspaceCheckpointSaveWaiter[];
    timer: NodeJS.Timeout;
}

const WORKSPACE_CHECKPOINT_SAVE_DEBOUNCE_MS = 500;

let checkpointWriteInFlight: Promise<void> | null = null;
const pendingLatestCheckpointSaves = new Map<number, IPendingWorkspaceCheckpointSave>();
const trailingCheckpointSaves = new Map<number, ITrailingWorkspaceCheckpointSave>();
const lastCheckpointSaveStartedAtMs = new Map<number, number>();
let checkpointBarrierQueue: Promise<unknown> = Promise.resolve();
const claimedWorkspaceCheckpointOwnerWebContentsIds = new Map<number, number>();
const lastDurableWorkspaceCheckpoints = new Map<number, IStoredWorkspaceCheckpoint>();
const recoveryClaimGenerationsByOwner = new Map<number, Map<string, number>>();
let shouldMigrateLegacyWorkspaceJournal = false;
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

function getAnnotationRecoveryDirectory() {
    return join(app.getPath('userData'), 'workspace-annotation-recovery');
}

function getAnnotationRecoveryPath(artifactId: string) {
    return join(getAnnotationRecoveryDirectory(), `${artifactId}.json`);
}

interface IAnnotationRecoveryArtifact {
    ref: IWorkspaceCheckpointAnnotationRecovery;
    payload: unknown;
}

interface IStoredAnnotationRecoveryArtifact extends IAnnotationRecoveryArtifact {version: 1;}

async function writeAnnotationRecoveryArtifact(
    ref: IWorkspaceCheckpointAnnotationRecovery,
    payload: unknown,
) {
    const path = getAnnotationRecoveryPath(ref.artifactId);
    await mkdir(getAnnotationRecoveryDirectory(), {recursive: true});
    const tempPath = makeSiblingTempPath(path);
    try {
        await writeFile(tempPath, JSON.stringify({
            version: 1,
            ref,
            payload,
        }), 'utf-8');
        await atomicReplace(tempPath, path);
    } catch (error) {
        await rm(tempPath, {force: true}).catch(() => undefined);
        throw error;
    }
}

async function readAnnotationRecoveryArtifact(ref: IWorkspaceCheckpointAnnotationRecovery) {
    const raw = await readFile(getAnnotationRecoveryPath(ref.artifactId), 'utf-8');
    const artifact = JSON.parse(raw) as Partial<IStoredAnnotationRecoveryArtifact>;
    if (artifact.version !== 1 || !artifact.ref || artifact.payload === undefined
        || artifact.ref.artifactId !== ref.artifactId
        || artifact.ref.documentInstanceId !== ref.documentInstanceId
        || artifact.ref.workingByteRevision !== ref.workingByteRevision
        || artifact.ref.annotationMutationGeneration !== ref.annotationMutationGeneration
        || artifact.ref.workingCopyRef !== ref.workingCopyRef) {
        throw new Error(`Annotation recovery artifact metadata mismatch: ${ref.artifactId}`);
    }
    return artifact.payload;
}

function getAnnotationRecoveryRefs(checkpoint: IWorkspaceCheckpoint | null) {
    if (!checkpoint) {
        return [];
    }
    return checkpoint.tabs.flatMap(tab => tab.annotationRecovery ? [tab.annotationRecovery] : []);
}

async function removeAnnotationRecoveryArtifacts(checkpoint: IWorkspaceCheckpoint | null) {
    if (!checkpoint) {
        return;
    }
    await Promise.all(getAnnotationRecoveryRefs(checkpoint).map(ref => (
        rm(getAnnotationRecoveryPath(ref.artifactId), {force: true})
    )));
}

function releaseDestroyedWorkspaceClaims() {
    for (const [
        recordOwner,
        claimant,
    ] of claimedWorkspaceCheckpointOwnerWebContentsIds) {
        let liveClaimant: WebContents | undefined;
        try {
            liveClaimant = webContents.fromId(claimant);
        } catch {
            liveClaimant = undefined;
        }
        if (liveClaimant?.isDestroyed() === true || liveClaimant === undefined) {
            claimedWorkspaceCheckpointOwnerWebContentsIds.delete(recordOwner);
        }
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

function decodeWorkingCopy(value: unknown): IStoredWorkingCopy | null {
    if (
        !isRecord(value)
        || (value.admissionSnapshot !== undefined && (
            !isRecord(value.admissionSnapshot)
            || typeof value.admissionSnapshot.mtimeNs !== 'string'
            || !/^\d+$/.test(value.admissionSnapshot.mtimeNs)
            || typeof value.admissionSnapshot.size !== 'string'
            || !/^\d+$/.test(value.admissionSnapshot.size)
        ))
        || typeof value.originalPath !== 'string'
        || !value.originalPath
        || !Number.isSafeInteger(value.registrationId)
        || (
            value.backingState !== 'cloned'
            && value.backingState !== 'eager'
            && value.backingState !== 'lazy-original'
            && value.backingState !== 'materializing'
            && value.backingState !== 'materialized'
        )
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
        ...(value.admissionSnapshot === undefined ? {} : {admissionSnapshot: {
            mtimeNs: value.admissionSnapshot.mtimeNs as string,
            size: value.admissionSnapshot.size as string,
        }}),
        backingState: value.backingState,
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
    const workingCopies: IStoredWorkingCopy[] = [];
    if (value.workingCopies !== undefined) {
        if (!Array.isArray(value.workingCopies)) {
            return null;
        }
        for (const candidate of value.workingCopies) {
            const decoded = decodeWorkingCopy(candidate);
            if (!decoded) {
                return null;
            }
            workingCopies.push(decoded);
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
        ...(workingCopies.length === 0 ? {} : {workingCopies}),
        ...(sourceProvenance.length === 0 ? {} : {sourceProvenance}),
    };
}

function decodeStoredJournal(value: unknown): IStoredWorkspaceJournal | null {
    if (isRecord(value) && value.version === 2 && Array.isArray(value.records)) {
        const records = value.records.map(decodeStoredCheckpoint);
        return records.every((record): record is IStoredWorkspaceCheckpoint => record !== null)
            ? {
                version: 2,
                records,
            }
            : null;
    }
    const legacy = decodeStoredCheckpoint(value);
    return legacy ? {
        version: 2,
        records: [legacy],
    } : null;
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

function collectMaterializedWorkingCopies(
    checkpoint: IWorkspaceCheckpoint,
    ownerWebContentsId: number,
) {
    const workingCopies = new Map<string, IStoredWorkingCopy>();
    for (const tab of checkpoint.tabs) {
        if (!tab.workingCopyRef || workingCopies.has(tab.workingCopyRef)) {
            continue;
        }
        const entry = getWorkingCopyBackingEntry(tab.workingCopyRef, ownerWebContentsId);
        if (
            !entry
            || entry.backingState === 'lazy-original'
            || entry.backingState === 'materializing'
        ) {
            continue;
        }
        workingCopies.set(tab.workingCopyRef, {
            ...(entry.admissionSnapshot ? {admissionSnapshot: {
                mtimeNs: entry.admissionSnapshot.mtimeNs.toString(),
                size: entry.admissionSnapshot.size.toString(),
            }} : {}),
            backingState: entry.backingState,
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
    return Array.from(workingCopies.values());
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

function toAdmissionSnapshot(admissionSnapshot: {
    mtimeNs: string;
    size: string;
}): IWorkingCopyAdmissionSnapshot {
    return {
        mtimeNs: BigInt(admissionSnapshot.mtimeNs),
        size: BigInt(admissionSnapshot.size),
    };
}

function matchesStoredWorkingCopy(
    entry: NonNullable<ReturnType<typeof getWorkingCopyBackingEntry>>,
    stored: IStoredWorkingCopy,
) {
    return entry.originalPath === stored.originalPath
        && entry.registrationId === stored.registrationId
        && entry.backingState === stored.backingState
        && entry.role === stored.role
        && (
            stored.admissionSnapshot === undefined
            || (
                entry.admissionSnapshot !== undefined
                && entry.admissionSnapshot.mtimeNs === BigInt(stored.admissionSnapshot.mtimeNs)
                && entry.admissionSnapshot.size === BigInt(stored.admissionSnapshot.size)
            )
        )
        && (
            stored.originalFileExpectation === undefined
            || JSON.stringify(entry.originalFileExpectation) === JSON.stringify(stored.originalFileExpectation)
        )
        && (
            stored.sourceBackingErrorCode === undefined
            || entry.sourceBackingErrorCode === stored.sourceBackingErrorCode
        );
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
    const sourceAuthorizationOwnerId = sourceAuthorizationOwner === undefined
        ? undefined
        : typeof sourceAuthorizationOwner === 'number'
            ? sourceAuthorizationOwner
            : sourceAuthorizationOwner.id;
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
        if (sourceAuthorizationOwnerId !== ownerWebContentsId) {
            throw new Error('Workspace checkpoint source has no sender-bound authorization');
        }
        requireOpenPath(tab.sourceRef, sourceAuthorizationOwner);
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
            && candidate.workingCopyRef === tab.workingCopyRef
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

function releaseRecoveryClaims(ownerWebContentsId: number, checkpoint: IWorkspaceCheckpoint | null) {
    const generations = recoveryClaimGenerationsByOwner.get(ownerWebContentsId);
    for (const tab of checkpoint?.tabs ?? []) {
        if (tab.workingCopyRef) {
            const generation = generations?.get(tab.workingCopyRef);
            if (generation !== undefined) {
                releaseWorkingCopyRecovery(tab.workingCopyRef, generation);
            }
        }
    }
    recoveryClaimGenerationsByOwner.delete(ownerWebContentsId);
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

async function writeStoredWorkspaceJournal(records: IStoredWorkspaceCheckpoint[]) {
    const storagePath = getStoragePath();
    const tempPath = makeSiblingTempPath(storagePath);
    try {
        const value = records.length === 0
            ? null
            : records.length === 1 && !shouldMigrateLegacyWorkspaceJournal
                ? records[0]
                : {
                    version: 2,
                    records,
                };
        if (value === null) {
            await rm(tempPath, {force: true});
            await rm(storagePath, {force: true});
            lastDurableWorkspaceCheckpoints.clear();
            shouldMigrateLegacyWorkspaceJournal = false;
            return;
        }
        await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
        await atomicReplace(tempPath, storagePath);
        shouldMigrateLegacyWorkspaceJournal = false;
        lastDurableWorkspaceCheckpoints.clear();
        for (const record of records) {
            lastDurableWorkspaceCheckpoints.set(record.ownerWebContentsId, record);
        }
    } catch (error) {
        // A failed write or replace must not leave the sibling .tmp behind, or
        // autosave retries accumulate orphans in userData and worsen a disk-full
        // condition. Best-effort cleanup; the original error still propagates.
        await rm(tempPath, {force: true}).catch(() => undefined);
        throw error;
    }
}

async function writeStoredWorkspaceCheckpoint(stored: IStoredWorkspaceCheckpoint) {
    const journal = await readStoredWorkspaceJournal(false);
    const records = journal.records.filter(record => record.ownerWebContentsId !== stored.ownerWebContentsId);
    records.push(stored);
    await writeStoredWorkspaceJournal(records);
}

function readDurableWorkspaceCheckpointForSave(ownerWebContentsId: number) {
    const cached = lastDurableWorkspaceCheckpoints.get(ownerWebContentsId);
    if (cached) {
        return cached;
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
    let parsed: unknown;
    let journal: IStoredWorkspaceJournal | null = null;
    try {
        parsed = JSON.parse(raw);
        journal = decodeStoredJournal(parsed);
    } catch (error) {
        throw new WorkspaceCheckpointReadError(getStoragePath(), error);
    }
    if (!journal) {
        throw new WorkspaceCheckpointReadError(
            getStoragePath(),
            new Error('Workspace checkpoint schema decode returned no checkpoint'),
        );
    }
    shouldMigrateLegacyWorkspaceJournal = !(isRecord(parsed) && parsed.version === 2);
    lastDurableWorkspaceCheckpoints.clear();
    for (const record of journal.records) {
        lastDurableWorkspaceCheckpoints.set(record.ownerWebContentsId, record);
    }
    return lastDurableWorkspaceCheckpoints.get(ownerWebContentsId) ?? null;
}

async function readStoredWorkspaceJournal(markLegacyMigration = true): Promise<IStoredWorkspaceJournal> {
    let raw: string;
    try {
        raw = await readFile(getStoragePath(), 'utf-8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return {
                version: 2,
                records: [],
            };
        }
        throw new WorkspaceCheckpointReadError(getStoragePath(), error);
    }
    const parsed: unknown = JSON.parse(raw);
    const journal = decodeStoredJournal(parsed);
    if (!journal) {
        throw new WorkspaceCheckpointReadError(
            getStoragePath(),
            new Error('Workspace checkpoint schema decode returned no journal'),
        );
    }
    if (markLegacyMigration) {
        shouldMigrateLegacyWorkspaceJournal = !(isRecord(parsed) && parsed.version === 2);
    }
    return journal;
}

function admitAnnotationRecovery(checkpoint: IWorkspaceCheckpoint) {
    const artifacts: IAnnotationRecoveryArtifact[] = [];
    const admittedCheckpoint: IWorkspaceCheckpoint = {
        ...checkpoint,
        tabs: checkpoint.tabs.map((tab) => {
            const capture = tab.annotationRecovery;
            if (!capture || capture.payload === undefined) {
                return tab;
            }
            const serialized = JSON.stringify(capture.payload);
            if (serialized.length > 8 * 1024 * 1024) {
                throw new Error('Canonical annotation recovery exceeds the checkpoint artifact budget');
            }
            const ref: IWorkspaceCheckpointAnnotationRecovery = {
                artifactId: randomUUID().replaceAll('-', ''),
                documentInstanceId: capture.documentInstanceId,
                workingCopyRef: capture.workingCopyRef,
                workingByteRevision: capture.workingByteRevision,
                annotationMutationGeneration: capture.annotationMutationGeneration,
            };
            artifacts.push({
                ref,
                payload: capture.payload,
            });
            return {
                ...tab,
                annotationRecovery: ref,
            };
        }),
    };
    return {
        checkpoint: admittedCheckpoint,
        artifacts,
    };
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
                const previous = lastDurableWorkspaceCheckpoints.get(currentSave.stored.ownerWebContentsId);
                // The artifacts are written here rather than when the save was
                // requested: a trailing save that is superseded before it commits
                // never reaches this point, so its artifacts never reach the disk.
                await Promise.all(currentSave.artifacts.map(artifact => (
                    writeAnnotationRecoveryArtifact(artifact.ref, artifact.payload)
                )));
                await writeStoredWorkspaceCheckpoint(currentSave.stored);
                const currentArtifactIds = new Set(
                    getAnnotationRecoveryRefs(currentSave.stored.checkpoint).map(ref => ref.artifactId),
                );
                await Promise.all(getAnnotationRecoveryRefs(previous?.checkpoint ?? null)
                    .filter(ref => !currentArtifactIds.has(ref.artifactId))
                    .map(ref => rm(getAnnotationRecoveryPath(ref.artifactId), {force: true})));
                settleCheckpointSave(currentSave);
            } catch (error) {
                await Promise.all(currentSave.artifacts.map(artifact => (
                    rm(getAnnotationRecoveryPath(artifact.ref.artifactId), {force: true})
                )));
                settleCheckpointSave(currentSave, error);
            }
            currentSave = pendingLatestCheckpointSaves.values().next().value ?? null;
            if (currentSave) {
                pendingLatestCheckpointSaves.delete(currentSave.stored.ownerWebContentsId);
            }
        }
    })().finally(() => {
        checkpointWriteInFlight = null;
        if (pendingLatestCheckpointSaves.size > 0) {
            const nextSave = pendingLatestCheckpointSaves.values().next().value as IPendingWorkspaceCheckpointSave;
            pendingLatestCheckpointSaves.delete(nextSave.stored.ownerWebContentsId);
            startCheckpointWriteDrain(nextSave);
        }
    });
}

function enqueueWorkspaceCheckpointSave(
    stored: IStoredWorkspaceCheckpoint,
    artifacts: IAnnotationRecoveryArtifact[],
) {
    return new Promise<void>((resolve, reject) => {
        const waiter = {
            resolve,
            reject,
        };
        if (!checkpointWriteInFlight) {
            startCheckpointWriteDrain({
                stored,
                artifacts,
                waiters: [waiter],
            });
            return;
        }
        const owner = stored.ownerWebContentsId;
        const pending = pendingLatestCheckpointSaves.get(owner);
        if (pending) {
            pendingLatestCheckpointSaves.set(owner, {
                stored,
                artifacts,
                waiters: [
                    ...pending.waiters,
                    waiter,
                ],
            });
            return;
        }
        pendingLatestCheckpointSaves.set(owner, {
            stored,
            artifacts,
            waiters: [waiter],
        });
    });
}

async function drainWorkspaceCheckpointWrites() {
    while (checkpointWriteInFlight) {
        await checkpointWriteInFlight;
    }
}

function takeTrailingCheckpointSave() {
    const pending = Array.from(trailingCheckpointSaves.values());
    if (pending.length === 0) {
        return null;
    }
    for (const save of pending) {
        trailingCheckpointSaves.delete(save.ownerWebContentsId);
        clearTimeout(save.timer);
    }
    return pending;
}

// Runs only from inside the barrier queue: committing anywhere else would let a
// queued clear or claim land between taking the trailing save and writing it,
// and the write would resurrect the checkpoint the barrier just removed.
async function commitTrailingCheckpointSave(pending: ITrailingWorkspaceCheckpointSave) {
    lastCheckpointSaveStartedAtMs.set(pending.ownerWebContentsId, Date.now());
    try {
        if (!discardedCheckpointOwnerGenerations.has(pending.ownerWebContentsId)) {
            await enqueueWorkspaceCheckpointSave(pending.stored, pending.artifacts);
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
    artifacts: IAnnotationRecoveryArtifact[],
    ownerWebContentsId: number,
    delayMs: number,
) {
    return new Promise<void>((resolve, reject) => {
        const waiter = {
            resolve,
            reject,
        };
        const trailing = trailingCheckpointSaves.get(ownerWebContentsId);
        if (trailing) {
            trailing.stored = stored;
            trailing.artifacts = artifacts;
            trailing.waiters.push(waiter);
            return;
        }
        const timer = setTimeout(() => {
            // The barrier's own take-and-flush commits the pending save; a no-op
            // barrier serializes the debounced write against queued clears/claims.
            void enqueueWorkspaceCheckpointBarrier(async () => {});
        }, delayMs);
        timer.unref();
        trailingCheckpointSaves.set(ownerWebContentsId, {
            stored,
            artifacts,
            ownerWebContentsId,
            waiters: [waiter],
            timer,
        });
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
            for (const save of pending) {
                await commitTrailingCheckpointSave(save);
            }
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
    const durable = readDurableWorkspaceCheckpointForSave(ownerWebContentsId);
    const checkpointWithRetainedTabs = retainUnresolvedCheckpointTabs(checkpoint, durable);
    const admittedAnnotationRecovery = admitAnnotationRecovery(checkpointWithRetainedTabs);
    const checkpointWithArtifacts = admittedAnnotationRecovery.checkpoint;
    const canonicalCheckpoint = canonicalizeCheckpointSources(
        checkpointWithArtifacts,
        ownerWebContentsId,
        {rejectUnmappedWorkingCopy: true},
    );
    const sourceProvenance = buildSourceProvenance(
        canonicalCheckpoint,
        ownerWebContentsId,
        sourceAuthorizationOwner,
    );
    const lazyWorkingCopies = collectLazyWorkingCopies(checkpointWithArtifacts, ownerWebContentsId);
    const workingCopies = collectMaterializedWorkingCopies(checkpointWithArtifacts, ownerWebContentsId);
    const stored: IStoredWorkspaceCheckpoint = {
        version: 1,
        ownerWebContentsId,
        ...(claimedWorkspaceCheckpointOwnerWebContentsIds.get(ownerWebContentsId) === ownerWebContentsId
            ? {claimedByWebContentsId: ownerWebContentsId}
            : {}),
        checkpoint: canonicalCheckpoint,
        ...(lazyWorkingCopies.length === 0 ? {} : {lazyWorkingCopies}),
        ...(workingCopies.length === 0 ? {} : {workingCopies}),
        ...(sourceProvenance.length === 0 ? {} : {sourceProvenance}),
    };
    await checkpointBarrierQueue;
    if (discardedCheckpointOwnerGenerations.has(ownerWebContentsId)) {
        return;
    }
    const elapsedMs = Date.now() - (lastCheckpointSaveStartedAtMs.get(ownerWebContentsId) ?? 0);
    if (!trailingCheckpointSaves.has(ownerWebContentsId) && elapsedMs >= WORKSPACE_CHECKPOINT_SAVE_DEBOUNCE_MS) {
        lastCheckpointSaveStartedAtMs.set(ownerWebContentsId, Date.now());
        await enqueueWorkspaceCheckpointSave(stored, admittedAnnotationRecovery.artifacts);
    } else {
        await scheduleTrailingCheckpointSave(
            stored,
            admittedAnnotationRecovery.artifacts,
            ownerWebContentsId,
            Math.max(0, WORKSPACE_CHECKPOINT_SAVE_DEBOUNCE_MS - elapsedMs),
        );
    }
}

export async function claimWorkspaceCheckpoint(newOwnerWebContentsId: number) {
    return enqueueWorkspaceCheckpointBarrier(async () => {
        releaseDestroyedWorkspaceClaims();
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

        let journal: IStoredWorkspaceJournal | null = null;
        try {
            journal = decodeStoredJournal(JSON.parse(raw));
        } catch (error) {
            await quarantineCorruptWorkspaceCheckpoint(
                `parse failure: ${getErrorMessage(error)}`,
            );
            return null;
        }
        if (!journal) {
            await quarantineCorruptWorkspaceCheckpoint('schema decode returned no checkpoint');
            return null;
        }
        const stored = journal.records.filter((candidate) => {
            const claimant = claimedWorkspaceCheckpointOwnerWebContentsIds.get(candidate.ownerWebContentsId);
            if (claimant !== undefined && claimant !== newOwnerWebContentsId) {
                return false;
            }
            if (
                candidate.claimedByWebContentsId !== undefined
                && candidate.claimedByWebContentsId !== newOwnerWebContentsId
            ) {
                let persistedClaimant: WebContents | undefined;
                try {
                    persistedClaimant = webContents.fromId(candidate.claimedByWebContentsId);
                } catch {
                    persistedClaimant = undefined;
                }
                if (persistedClaimant && !persistedClaimant.isDestroyed()) {
                    return false;
                }
            }
            let savedOwner: WebContents | undefined;
            try {
                savedOwner = webContents.fromId(candidate.ownerWebContentsId);
            } catch {
                // Focused store tests do not need an Electron webContents registry.
                savedOwner = undefined;
            }
            return candidate.ownerWebContentsId === newOwnerWebContentsId
                || savedOwner?.isDestroyed() === true
                || savedOwner === undefined;
        }).reduce<IStoredWorkspaceCheckpoint | null>((newest, candidate) => (
            newest === null || candidate.checkpoint.capturedAt > newest.checkpoint.capturedAt
                ? candidate
                : newest
        ), null);
        if (!stored) {
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
        const checkpointWithAnnotationRecovery: IWorkspaceCheckpoint = {
            ...canonicalCheckpoint,
            tabs: await Promise.all(canonicalCheckpoint.tabs.map(async (tab) => {
                const ref = tab.annotationRecovery;
                if (!ref) {
                    return tab;
                }
                try {
                    const payload = await readAnnotationRecoveryArtifact(ref);
                    return {
                        ...tab,
                        annotationRecovery: {
                            ...ref,
                            payload,
                        },
                    };
                } catch (error) {
                    // Each tab's artifact stands alone, so one unreadable file drops the
                    // annotations of its own tab and leaves every other tab recoverable.
                    log.warn(`Annotation recovery artifact unavailable for ${ref.artifactId}: ${getErrorMessage(error)}`);
                    const {
                        annotationRecovery: _unavailable, ...tabWithoutAnnotationRecovery
                    } = tab;
                    return tabWithoutAnnotationRecovery;
                }
            })),
        };
        const lazyWorkingCopies = new Map(
            (stored.lazyWorkingCopies ?? []).map(entry => [
                entry.workingCopyRef,
                entry,
            ]),
        );
        const workingCopies = new Map(
            (stored.workingCopies ?? []).map(entry => [
                entry.workingCopyRef,
                entry,
            ]),
        );
        for (const tab of checkpointWithAnnotationRecovery.tabs) {
            if (tab.workingCopyRef) {
                const lazyWorkingCopy = lazyWorkingCopies.get(tab.workingCopyRef);
                const storedWorkingCopy = workingCopies.get(tab.workingCopyRef);
                const liveWorkingCopy = storedWorkingCopy
                    ? getWorkingCopyBackingEntry(tab.workingCopyRef, stored.ownerWebContentsId)
                    : null;
                const transferred = (!storedWorkingCopy || (
                    liveWorkingCopy !== null
                    && matchesStoredWorkingCopy(liveWorkingCopy, storedWorkingCopy)
                )) && claimWorkingCopyOwnership(
                    tab.workingCopyRef,
                    stored.ownerWebContentsId,
                    newOwnerWebContentsId,
                );
                if (!transferred && lazyWorkingCopy) {
                    await setWorkingCopyOriginalPath(
                        tab.workingCopyRef,
                        lazyWorkingCopy.originalPath,
                        newOwnerWebContentsId,
                        {
                            admissionSnapshot: toAdmissionSnapshot(lazyWorkingCopy.admissionSnapshot),
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
                } else if (!transferred && storedWorkingCopy) {
                    await setWorkingCopyOriginalPath(
                        tab.workingCopyRef,
                        storedWorkingCopy.originalPath,
                        newOwnerWebContentsId,
                        {
                            ...(storedWorkingCopy.admissionSnapshot
                                ? {admissionSnapshot: toAdmissionSnapshot(storedWorkingCopy.admissionSnapshot)}
                                : {}),
                            backingState: storedWorkingCopy.backingState,
                            deferOriginalFileExpectation: true,
                            ...(storedWorkingCopy.originalFileExpectation
                                ? {originalFileExpectation: storedWorkingCopy.originalFileExpectation}
                                : {}),
                            role: storedWorkingCopy.role,
                        },
                    );
                    if (storedWorkingCopy.sourceBackingErrorCode) {
                        const restoredEntry = getWorkingCopyBackingEntry(
                            tab.workingCopyRef,
                            newOwnerWebContentsId,
                        );
                        if (restoredEntry) {
                            transitionWorkingCopyBackingState(
                                tab.workingCopyRef,
                                restoredEntry.registrationId,
                                storedWorkingCopy.backingState,
                                {sourceBackingErrorCode: storedWorkingCopy.sourceBackingErrorCode},
                            );
                        }
                    }
                } else if (!transferred && tab.sourceRef) {
                    await setWorkingCopyOriginalPath(
                        tab.workingCopyRef,
                        tab.sourceRef,
                        newOwnerWebContentsId,
                        {deferOriginalFileExpectation: true},
                    );
                }
            }
        }
        // Keep the checkpoint until the renderer has reopened every tab and
        // explicitly acknowledges success. The owner marker is persisted so a
        // main-process restart can distinguish an in-progress restore from an
        // old, untouched checkpoint without deleting recovery evidence early.
        const claimedStored = {
            ...stored,
            claimedByWebContentsId: newOwnerWebContentsId,
            checkpoint: canonicalCheckpoint,
        };
        await writeStoredWorkspaceCheckpoint(claimedStored);
        for (const tab of canonicalCheckpoint.tabs) {
            if (tab.workingCopyRef) {
                const generation = claimWorkingCopyRecovery(tab.workingCopyRef);
                const generations = recoveryClaimGenerationsByOwner.get(stored.ownerWebContentsId)
                    ?? new Map<string, number>();
                generations.set(tab.workingCopyRef, generation);
                recoveryClaimGenerationsByOwner.set(stored.ownerWebContentsId, generations);
            }
        }
        claimedWorkspaceCheckpointOwnerWebContentsIds.set(
            stored.ownerWebContentsId,
            newOwnerWebContentsId,
        );
        return checkpointWithAnnotationRecovery;
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
                return false;
            }
            blockStaleWorkingCopyDirectoryCleanup(`workspace checkpoint acknowledgement read failed at ${storagePath}`);
            throw new WorkspaceCheckpointReadError(storagePath, error);
        }
        let journal: IStoredWorkspaceJournal | null = null;
        try {
            journal = decodeStoredJournal(JSON.parse(raw));
        } catch (error) {
            await quarantineCorruptWorkspaceCheckpoint(
                `acknowledgement parse failure: ${getErrorMessage(error)}`,
            );
            throw new WorkspaceCheckpointReadError(storagePath, error);
        }
        if (!journal) {
            const decodeError = new Error('Workspace checkpoint schema decode returned no checkpoint');
            await quarantineCorruptWorkspaceCheckpoint(
                `acknowledgement schema failure: ${decodeError.message}`,
            );
            throw new WorkspaceCheckpointReadError(storagePath, decodeError);
        }
        const stored = journal.records.find(record => (
            record.claimedByWebContentsId === ownerWebContentsId
            || claimedWorkspaceCheckpointOwnerWebContentsIds.get(record.ownerWebContentsId) === ownerWebContentsId
        ));
        if (!stored) {
            throw new Error('Workspace checkpoint acknowledgement is not owned by this renderer');
        }
        await writeStoredWorkspaceJournal(journal.records.filter(record => (
            record.ownerWebContentsId !== stored.ownerWebContentsId
        )));
        await removeAnnotationRecoveryArtifacts(stored.checkpoint);
        releaseRecoveryClaims(stored.ownerWebContentsId, stored.checkpoint);
        claimedWorkspaceCheckpointOwnerWebContentsIds.delete(stored.ownerWebContentsId);
        lastDurableWorkspaceCheckpoints.delete(stored.ownerWebContentsId);
        return true;
    });
}

export function clearWorkspaceCheckpoint() {
    return enqueueWorkspaceCheckpointBarrier(async () => {
        const checkpoints = Array.from(lastDurableWorkspaceCheckpoints.values());
        let journal: IStoredWorkspaceJournal;
        try {
            journal = await readStoredWorkspaceJournal();
        } catch (error) {
            if (error instanceof WorkspaceCheckpointReadError) {
                throw error;
            }
            throw error;
        }
        await writeStoredWorkspaceJournal([]);
        await Promise.all([
            ...checkpoints.map(checkpoint => removeAnnotationRecoveryArtifacts(checkpoint.checkpoint)),
            ...journal.records
                .filter(record => !lastDurableWorkspaceCheckpoints.has(record.ownerWebContentsId))
                .map(record => removeAnnotationRecoveryArtifacts(record.checkpoint)),
        ]);
        for (const checkpoint of journal.records) {
            releaseRecoveryClaims(checkpoint.ownerWebContentsId, checkpoint.checkpoint);
        }
        lastDurableWorkspaceCheckpoints.clear();
        claimedWorkspaceCheckpointOwnerWebContentsIds.clear();
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
        await enqueueWorkspaceCheckpointBarrier(async () => {
            const journal = await readStoredWorkspaceJournal();
            const stored = journal.records.find(record => (
                record.ownerWebContentsId === ownerWebContentsId
                || record.claimedByWebContentsId === ownerWebContentsId
                || claimedWorkspaceCheckpointOwnerWebContentsIds.get(record.ownerWebContentsId) === ownerWebContentsId
            ));
            if (!stored) {
                return;
            }
            await writeStoredWorkspaceJournal(journal.records.filter(record => (
                record.ownerWebContentsId !== stored.ownerWebContentsId
            )));
            await removeAnnotationRecoveryArtifacts(stored.checkpoint);
            releaseRecoveryClaims(stored.ownerWebContentsId, stored.checkpoint);
            lastDurableWorkspaceCheckpoints.delete(stored.ownerWebContentsId);
            claimedWorkspaceCheckpointOwnerWebContentsIds.delete(stored.ownerWebContentsId);
        });
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
