import { getErrorMessage } from '@electron/utils/error';
import {
    app,
    webContents,
} from 'electron';
import type {WebContents} from 'electron';
import {
    readFile,
    readdir,
    rename,
    rm,
    mkdir,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    type IWorkspaceCheckpoint,
    type IWorkspaceCheckpointAnnotationRecovery,
    workspaceCheckpointSchema,
} from '@contracts/workspaceCheckpoint';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {isErrnoException} from '@contracts/runtimeGuards';
import { writeJsonAtomic } from '@electron/utils/atomicReplace';
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
    type IWorkingCopyAdmissionSnapshot,
    type TWorkingCopyBackingErrorCode,
} from '@electron/file-access/workingCopyStore';
import {blockStaleWorkingCopyDirectoryCleanup} from '@electron/file-access/workingCopyCleanup';
import {
    isOpenPathAccessible,
    requireOpenPath,
} from '@electron/file-access/openPathCapabilities';
import {touchScanCleanupGeneratedOutput} from '@electron/features/scan-cleanup/public/generatedOutputs';
import {onSenderLifetimeEnd} from '@electron/utils/onSenderLifetimeEnd';
import * as v from 'valibot';

const log = createLogger('workspace-checkpoint-store');

const BACKING_ERROR_CODES = [
    'SOURCE_BACKING_CHANGED',
    'SOURCE_BACKING_UNAVAILABLE',
    'WORKING_COPY_MATERIALIZATION_CANCELLED',
    'WORKING_COPY_MATERIALIZATION_FAILED',
    'WORKING_COPY_MATERIALIZATION_NO_SPACE',
    'WORKING_COPY_MATERIALIZATION_VERIFICATION_FAILED',
    'WORKING_COPY_REGISTRATION_CHANGED',
] as const satisfies readonly TWorkingCopyBackingErrorCode[];
const backingErrorCodeSchema = v.picklist(BACKING_ERROR_CODES);
const safeIntegerSchema = v.pipe(v.number(), v.check(value => Number.isSafeInteger(value)));
const decimalStringSchema = v.pipe(v.string(), v.regex(/^\d+$/u));
const canonicalDecimalStringSchema = v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d*)$/u));
const admissionSnapshotSchema = v.object({
    mtimeNs: decimalStringSchema,
    size: decimalStringSchema,
});
const originalFileExpectationSchema = v.pipe(v.object({
    contentFingerprint: v.optional(v.string()),
    ctimeNs: v.optional(canonicalDecimalStringSchema),
    deviceId: v.optional(canonicalDecimalStringSchema),
    inode: v.optional(canonicalDecimalStringSchema),
    mtimeNs: v.optional(canonicalDecimalStringSchema),
    mtimeMs: v.pipe(v.number(), v.finite()),
    size: v.pipe(safeIntegerSchema, v.minValue(0)),
}), v.transform(value => ({
    ...(value.contentFingerprint === undefined ? {} : {contentFingerprint: value.contentFingerprint}),
    ...(value.ctimeNs === undefined ? {} : {ctimeNs: value.ctimeNs}),
    ...(value.deviceId === undefined ? {} : {deviceId: value.deviceId}),
    ...(value.inode === undefined ? {} : {inode: value.inode}),
    ...(value.mtimeNs === undefined ? {} : {mtimeNs: value.mtimeNs}),
    mtimeMs: value.mtimeMs,
    size: value.size,
})));
const lazyWorkingCopySchema = v.object({
    admissionSnapshot: admissionSnapshotSchema,
    originalFileExpectation: v.optional(originalFileExpectationSchema),
    originalPath: v.pipe(v.string(), v.minLength(1)),
    registrationId: safeIntegerSchema,
    role: v.picklist([
        'current',
        'snapshot',
    ]),
    sourceBackingErrorCode: v.optional(backingErrorCodeSchema),
    workingCopyRef: v.pipe(v.string(), v.minLength(1)),
});
const workingCopySchema = v.object({
    admissionSnapshot: v.optional(admissionSnapshotSchema),
    backingState: v.picklist([
        'cloned',
        'eager',
        'lazy-original',
        'materializing',
        'materialized',
    ]),
    originalFileExpectation: v.optional(originalFileExpectationSchema),
    originalPath: v.pipe(v.string(), v.minLength(1)),
    registrationId: safeIntegerSchema,
    role: v.picklist([
        'current',
        'snapshot',
    ]),
    sourceBackingErrorCode: v.optional(backingErrorCodeSchema),
    workingCopyRef: v.pipe(v.string(), v.minLength(1)),
});
const sourceProvenanceSchema = v.pipe(v.object({
    kind: v.picklist([
        'open-grant',
        'working-copy',
    ]),
    ownerWebContentsId: safeIntegerSchema,
    sourceRef: v.pipe(v.string(), v.minLength(1)),
    workingCopyRef: v.optional(v.pipe(v.string(), v.minLength(1))),
}), v.check(value => value.kind !== 'working-copy' || value.workingCopyRef !== undefined));
const recoveryOwnerIdSchema = v.pipe(v.string(), v.minLength(1));
// Old records derive missing recovery identities from WebContents IDs and omit empty optional collections.
const storedCheckpointSchema = v.pipe(v.object({
    version: v.literal(1),
    ownerRecoveryId: v.optional(recoveryOwnerIdSchema),
    ownerWebContentsId: safeIntegerSchema,
    claimedByRecoveryId: v.optional(recoveryOwnerIdSchema),
    claimedByWebContentsId: v.optional(safeIntegerSchema),
    checkpoint: workspaceCheckpointSchema,
    lazyWorkingCopies: v.optional(v.array(lazyWorkingCopySchema)),
    workingCopies: v.optional(v.array(workingCopySchema)),
    sourceProvenance: v.optional(v.array(sourceProvenanceSchema)),
}), v.transform(value => ({
    version: 1 as const,
    ownerRecoveryId: value.ownerRecoveryId ?? `legacy:webContents:${String(value.ownerWebContentsId)}`,
    ownerWebContentsId: value.ownerWebContentsId,
    ...(value.claimedByRecoveryId === undefined
        ? value.claimedByWebContentsId === undefined ? {} : {claimedByRecoveryId: `legacy:webContents:${String(value.claimedByWebContentsId)}`}
        : {claimedByRecoveryId: value.claimedByRecoveryId}),
    ...(value.claimedByWebContentsId === undefined ? {} : {claimedByWebContentsId: value.claimedByWebContentsId}),
    checkpoint: value.checkpoint,
    ...(value.lazyWorkingCopies?.length ? {lazyWorkingCopies: value.lazyWorkingCopies} : {}),
    ...(value.workingCopies?.length ? {workingCopies: value.workingCopies} : {}),
    ...(value.sourceProvenance?.length ? {sourceProvenance: value.sourceProvenance} : {}),
})));
type IStoredWorkspaceCheckpoint = v.InferOutput<typeof storedCheckpointSchema>;
type IStoredLazyWorkingCopy = NonNullable<IStoredWorkspaceCheckpoint['lazyWorkingCopies']>[number];
type IStoredWorkingCopy = NonNullable<IStoredWorkspaceCheckpoint['workingCopies']>[number];
type IStoredSourceProvenance = NonNullable<IStoredWorkspaceCheckpoint['sourceProvenance']>[number];
const storedJournalSchema = v.union([
    v.pipe(v.object({
        version: v.literal(2),
        records: v.array(storedCheckpointSchema),
    }), v.transform(value => ({
        version: 2 as const,
        records: value.records,
    }))),
    v.pipe(storedCheckpointSchema, v.transform(record => ({
        version: 2 as const,
        records: [record],
    }))),
]);
type IStoredWorkspaceJournal = v.InferOutput<typeof storedJournalSchema>;

const WORKSPACE_CHECKPOINT_SAVE_DEBOUNCE_MS = 500;

// Each window owns one record file, named by its recovery identity. Claiming
// another window's record renames that file to the claimant, so ownership is
// the file name and no journal has to be merged or fenced.
const recoveryOwnerIdsByWebContents = new WeakMap<WebContents, string>();
const liveRecoveryOwners = new Map<string, WebContents>();
// A checkpoint is delivered once per renderer load; a reload may claim again.
const claimedInCurrentLoad = new Set<string>();
const durableRecords = new Map<string, IStoredWorkspaceCheckpoint>();
const recoveryClaimGenerationsByOwner = new Map<string, Map<string, number>>();
const discardedOwners = new Map<string, string>();
let nextDiscardToken = 1;
let storageQueue: Promise<unknown> = Promise.resolve();

interface IPendingSave {
    stored: IStoredWorkspaceCheckpoint;
    artifacts: IAnnotationRecoveryArtifact[];
    waiters: Array<{
        resolve(): void;
        reject(error: unknown): void;
    }>;
    timer: NodeJS.Timeout;
}
const pendingSaves = new Map<string, IPendingSave>();
const lastSaveStartedAtMs = new Map<string, number>();
// A claimed restore its renderer has not acknowledged yet, by owner: the
// documents it opens at once that can stay closed without losing work. A
// renderer that dies before it acknowledges was killed by one of them, so
// those documents are not reopened again (#1264).
const restoresInFlight = new Map<string, {
    tabIds: Set<string>;
    sourceRefs: Set<TDocumentRef>;
}>();

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


function getAnnotationRecoveryDirectory() {
    return join(app.getPath('userData'), 'workspace-annotation-recovery');
}

function getAnnotationRecoveryPath(artifactId: string) {
    return join(getAnnotationRecoveryDirectory(), `${artifactId}.json`);
}


const annotationRecoveryArtifactSchema = v.pipe(v.object({
    version: v.literal(1),
    ref: v.object({
        artifactId: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,128}$/u)),
        documentInstanceId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
        workingCopyRef: v.nullable(v.pipe(v.string(), v.check(value => parseDocumentRef(value) !== null), v.transform(value => parseDocumentRef(value)!))),
        workingByteRevision: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
        annotationMutationGeneration: v.pipe(safeIntegerSchema, v.minValue(0)),
    }),
    payload: v.unknown(),
}), v.check(value => value.payload !== undefined));
type IAnnotationRecoveryArtifact = v.InferOutput<typeof annotationRecoveryArtifactSchema>;

async function writeAnnotationRecoveryArtifact(artifact: IAnnotationRecoveryArtifact) {
    const {ref} = artifact;
    const path = getAnnotationRecoveryPath(ref.artifactId);
    await mkdir(getAnnotationRecoveryDirectory(), {recursive: true});
    await writeJsonAtomic(path, artifact);
}

async function readAnnotationRecoveryArtifact(ref: IWorkspaceCheckpointAnnotationRecovery) {
    const raw = await readFile(getAnnotationRecoveryPath(ref.artifactId), 'utf-8');
    const parsed = v.safeParse(annotationRecoveryArtifactSchema, JSON.parse(raw), {abortEarly: true});
    const artifact = parsed.success ? parsed.output : null;
    if (!artifact
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

// The recovery identity belongs to the WebContents and survives a reload, which
// the automation checkpoint reset relies on. Once that WebContents' load has
// ended, the claims its identity still holds came from the ended load, so the
// new load takes that session over instead of finding it held. A repeated
// claim within one load keeps its claim, so a checkpoint is delivered once.
function decodeStoredCheckpoint(value: unknown): IStoredWorkspaceCheckpoint | null {
    const result = v.safeParse(storedCheckpointSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

function decodeStoredJournal(value: unknown): IStoredWorkspaceJournal | null {
    const result = v.safeParse(storedJournalSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
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

// A dirty working copy holds edits that were never written to the original, so
// transferring it without a matching witness would let the next save overwrite
// a file that changed while EVB was stopped. A clean copy has nothing to lose,
// so a checkpoint predating the witness may still transfer.
function matchesStoredWorkingCopy(
    entry: NonNullable<ReturnType<typeof getWorkingCopyBackingEntry>>,
    stored: IStoredWorkingCopy,
    {requireOriginalFileExpectation}: {requireOriginalFileExpectation: boolean},
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
        && (!requireOriginalFileExpectation || (
            stored.originalFileExpectation !== undefined
            && entry.originalFileExpectation !== undefined
            && JSON.stringify(entry.originalFileExpectation) === JSON.stringify(stored.originalFileExpectation)
        ))
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

function findDurableSourceProvenance(
    durable: IStoredWorkspaceCheckpoint | null,
    tab: IWorkspaceCheckpoint['tabs'][number],
    ownerWebContentsId: number,
) {
    return durable?.sourceProvenance?.find(entry => (
        entry.sourceRef === tab.sourceRef
        && entry.ownerWebContentsId === ownerWebContentsId
        && (entry.workingCopyRef ?? null) === (tab.workingCopyRef ?? null)
    )) ?? null;
}

// A source-only tab can name a file that is not there right now: a generated
// PDF still opening under its future Save As name, or a file on a drive that
// went away. One such tab must not stop every other tab from being saved. A
// source this record already authorized keeps that authorization, so it can
// be restored once the file is back; one never authorized has nothing to
// restore and is saved without a source.
function detachUnreachableSources(
    checkpoint: IWorkspaceCheckpoint,
    durable: IStoredWorkspaceCheckpoint | null,
    ownerWebContentsId: number,
) {
    return {
        ...checkpoint,
        tabs: checkpoint.tabs.map(tab => (
            tab.sourceRef
            && !tab.workingCopyRef
            && !isOpenPathAccessible(tab.sourceRef)
            && !findDurableSourceProvenance(durable, tab, ownerWebContentsId)
                ? {
                    ...tab,
                    sourceRef: null,
                }
                : tab
        )),
    } satisfies IWorkspaceCheckpoint;
}

function buildSourceProvenance(
    checkpoint: IWorkspaceCheckpoint,
    ownerWebContentsId: number,
    sourceAuthorizationOwner: number | WebContents | undefined,
    durable: IStoredWorkspaceCheckpoint | null,
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
        const carriedProvenance = !tab.workingCopyRef && !isOpenPathAccessible(tab.sourceRef)
            ? findDurableSourceProvenance(durable, tab, ownerWebContentsId)
            : null;
        if (carriedProvenance) {
            provenance.set(`${tab.workingCopyRef ?? ''}\u0000${tab.sourceRef}`, carriedProvenance);
            continue;
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
        // A source-only tab stores `workingCopyRef: null`, while its open-grant
        // provenance omits the field; both mean "no working copy".
        const entry = provenance.find(candidate => (
            candidate.sourceRef === tab.sourceRef
            && candidate.ownerWebContentsId === stored.ownerWebContentsId
            && (candidate.workingCopyRef ?? null) === (tab.workingCopyRef ?? null)
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


function getLegacyJournalPath() {
    return join(app.getPath('userData'), 'workspace-checkpoint.json');
}

function getRecordDirectory() {
    return join(app.getPath('userData'), 'workspace-recovery');
}

function getRecordPath(recoveryId: string) {
    return join(getRecordDirectory(), `${encodeURIComponent(recoveryId)}.json`);
}

function getLegacyRecoveryOwnerId(ownerWebContentsId: number) {
    return `legacy:webContents:${ownerWebContentsId}`;
}

function getWorkspaceRecoveryOwnerId(
    ownerWebContentsId: number,
    owner?: number | WebContents,
) {
    if (owner === undefined || typeof owner === 'number') {
        return getLegacyRecoveryOwnerId(ownerWebContentsId);
    }
    const knownId = recoveryOwnerIdsByWebContents.get(owner);
    if (knownId) {
        return knownId;
    }
    const recoveryId = randomUUID();
    recoveryOwnerIdsByWebContents.set(owner, recoveryId);
    liveRecoveryOwners.set(recoveryId, owner);
    const stopWatching = onSenderLifetimeEnd(owner, (end) => {
        claimedInCurrentLoad.delete(recoveryId);
        const interruptedRestore = restoresInFlight.get(recoveryId);
        restoresInFlight.delete(recoveryId);
        if (end === 'render-process-gone' && interruptedRestore) {
            // Queued before the recovery reload can claim, and before a
            // shutdown flush completes.
            void serialize(() => closeRestoreDocuments(recoveryId, interruptedRestore)).catch((error: unknown) => {
                log.warn(`Could not close the documents of a restore that ended the renderer: ${getErrorMessage(error)}`);
            });
        }
        if (end === 'destroyed') {
            stopWatching();
            liveRecoveryOwners.delete(recoveryId);
        }
    }, {navigation: true});
    return recoveryId;
}

function getWebContentsById(id: number) {
    try {
        return webContents.fromId(id);
    } catch {
        return undefined;
    }
}

/** A record's owner is live while the renderer that wrote it still exists. */
function isLiveOwner(record: IStoredWorkspaceCheckpoint) {
    const owner = liveRecoveryOwners.get(record.ownerRecoveryId);
    if (owner) {
        return !owner.isDestroyed() && getWebContentsById(owner.id) === owner;
    }
    if (record.ownerRecoveryId !== getLegacyRecoveryOwnerId(record.ownerWebContentsId)) {
        return false;
    }
    const legacyOwner = getWebContentsById(record.ownerWebContentsId);
    return legacyOwner !== undefined
        && !legacyOwner.isDestroyed()
        && recoveryOwnerIdsByWebContents.get(legacyOwner) === undefined;
}

function serialize<T>(operation: () => Promise<T>) {
    const run = storageQueue.then(operation);
    storageQueue = run.then(() => undefined, () => undefined);
    return run;
}

async function quarantineCorruptWorkspaceCheckpoint(path: string, reason: string) {
    // A corrupt record must not masquerade as "no checkpoint" on every start:
    // move it aside so recovery stops repeating and the file stays for diagnosis.
    log.error(`Discarding workspace checkpoint ${path}: ${reason}`, {code: 'MAIN_WORKSPACE_CHECKPOINT_FAILED'});
    try {
        const quarantinePath = await quarantineCorruptFile(path);
        log.warn(`Quarantined corrupt workspace checkpoint at ${quarantinePath ?? path}`);
    } catch (error) {
        log.error(`Failed to quarantine corrupt workspace checkpoint at ${path}: ${getErrorMessage(error)}`, {
            code: 'MAIN_WORKSPACE_CHECKPOINT_FAILED',
            cause: error,
        });
    }
}

async function writeRecord(record: IStoredWorkspaceCheckpoint) {
    await mkdir(getRecordDirectory(), {recursive: true});
    await writeJsonAtomic(getRecordPath(record.ownerRecoveryId), record);
    durableRecords.set(record.ownerRecoveryId, record);
}

async function deleteRecord(recoveryId: string) {
    await rm(getRecordPath(recoveryId), {force: true});
    durableRecords.delete(recoveryId);
}

// Splits the single-file journal of earlier versions into per-window records.
async function migrateLegacyJournal() {
    let raw: string;
    try {
        raw = await readFile(getLegacyJournalPath(), 'utf-8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return;
        }
        blockStaleWorkingCopyDirectoryCleanup(`workspace checkpoint read failed at ${getLegacyJournalPath()}`);
        throw new WorkspaceCheckpointReadError(getLegacyJournalPath(), error);
    }
    let journal: IStoredWorkspaceJournal | null = null;
    try {
        journal = decodeStoredJournal(JSON.parse(raw));
    } catch {
        journal = null;
    }
    if (!journal) {
        await quarantineCorruptWorkspaceCheckpoint(getLegacyJournalPath(), 'schema decode returned no checkpoint');
    } else {
        for (const record of journal.records) {
            await writeRecord(record);
        }
        await rm(getLegacyJournalPath(), {force: true});
    }
}

async function readRecordFile(recoveryId: string): Promise<IStoredWorkspaceCheckpoint | null> {
    const path = getRecordPath(recoveryId);
    let raw: string;
    try {
        raw = await readFile(path, 'utf-8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        blockStaleWorkingCopyDirectoryCleanup(`workspace checkpoint read failed at ${path}`);
        log.error(`Failed to read workspace checkpoint: ${getErrorMessage(error)}`, {
            code: 'MAIN_WORKSPACE_CHECKPOINT_FAILED',
            cause: error,
        });
        throw new WorkspaceCheckpointReadError(path, error);
    }
    let record: IStoredWorkspaceCheckpoint | null = null;
    try {
        record = decodeStoredCheckpoint(JSON.parse(raw));
    } catch {
        record = null;
    }
    if (!record) {
        await quarantineCorruptWorkspaceCheckpoint(path, 'schema decode returned no checkpoint');
        return null;
    }
    // The file name is the owner; a record renamed by a claim keeps its old body.
    return {
        ...record,
        ownerRecoveryId: recoveryId,
    };
}

async function readAllRecords() {
    await migrateLegacyJournal();
    let names: string[];
    try {
        names = await readdir(getRecordDirectory());
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return [];
        }
        throw new WorkspaceCheckpointReadError(getRecordDirectory(), error);
    }
    const records: IStoredWorkspaceCheckpoint[] = [];
    for (const name of names) {
        if (!name.endsWith('.json')) {
            continue;
        }
        const record = await readRecordFile(decodeURIComponent(name.slice(0, -'.json'.length)));
        if (record) {
            records.push(record);
        }
    }
    return records;
}

function readDurableRecordForSave(recoveryId: string) {
    const cached = durableRecords.get(recoveryId);
    if (cached) {
        return cached;
    }
    let raw: string;
    try {
        raw = readFileSync(getRecordPath(recoveryId), 'utf-8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw new WorkspaceCheckpointReadError(getRecordPath(recoveryId), error);
    }
    let record: IStoredWorkspaceCheckpoint | null;
    try {
        record = decodeStoredCheckpoint(JSON.parse(raw));
    } catch (error) {
        throw new WorkspaceCheckpointReadError(getRecordPath(recoveryId), error);
    }
    if (!record) {
        throw new WorkspaceCheckpointReadError(
            getRecordPath(recoveryId),
            new Error('Workspace checkpoint schema decode returned no checkpoint'),
        );
    }
    durableRecords.set(recoveryId, record);
    return record;
}

async function commitSave(save: IPendingSave) {
    try {
        if (!discardedOwners.has(save.stored.ownerRecoveryId)) {
            const previous = durableRecords.get(save.stored.ownerRecoveryId);
            // Artifacts go first, so the record never names a missing one.
            await Promise.all(save.artifacts.map(artifact => (
                writeAnnotationRecoveryArtifact(artifact)
            )));
            try {
                await writeRecord(save.stored);
            } catch (error) {
                await Promise.all(save.artifacts.map(artifact => (
                    rm(getAnnotationRecoveryPath(artifact.ref.artifactId), {force: true})
                )));
                throw error;
            }
            const currentArtifactIds = new Set(getAnnotationRecoveryRefs(save.stored.checkpoint).map(ref => ref.artifactId));
            await Promise.all(getAnnotationRecoveryRefs(previous?.checkpoint ?? null)
                .filter(ref => !currentArtifactIds.has(ref.artifactId))
                .map(ref => rm(getAnnotationRecoveryPath(ref.artifactId), {force: true})));
        }
        for (const waiter of save.waiters) {
            waiter.resolve();
        }
    } catch (error) {
        for (const waiter of save.waiters) {
            waiter.reject(error);
        }
    }
}

// Pending debounced saves are written before any claim or clear reads the
// records, so neither sees or resurrects a stale state.
async function flushPendingSaves() {
    for (const [
        recoveryId,
        save,
    ] of [...pendingSaves]) {
        pendingSaves.delete(recoveryId);
        clearTimeout(save.timer);
        lastSaveStartedAtMs.set(recoveryId, Date.now());
        await commitSave(save);
    }
}

function scheduleSave(
    stored: IStoredWorkspaceCheckpoint,
    artifacts: IAnnotationRecoveryArtifact[],
) {
    const recoveryId = stored.ownerRecoveryId;
    return new Promise<void>((resolve, reject) => {
        const waiter = {
            resolve,
            reject,
        };
        const pending = pendingSaves.get(recoveryId);
        if (pending) {
            pending.stored = stored;
            pending.artifacts = artifacts;
            pending.waiters.push(waiter);
            return;
        }
        const elapsedMs = Date.now() - (lastSaveStartedAtMs.get(recoveryId) ?? 0);
        const timer = setTimeout(() => {
            void serialize(flushPendingSaves);
        }, Math.max(0, WORKSPACE_CHECKPOINT_SAVE_DEBOUNCE_MS - elapsedMs));
        timer.unref();
        pendingSaves.set(recoveryId, {
            stored,
            artifacts,
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
    await serialize(flushPendingSaves);
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
                version: 1,
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
    return {
        ...checkpoint,
        tabs: checkpoint.tabs.map((tab) => {
            const previous = durable.checkpoint.tabs.find(candidate => candidate.tabId === tab.tabId);
            if (!tab.isDirty || !previous?.workingCopyRef
                || (tab.workingCopyRef && tab.workingCopyRef !== previous.workingCopyRef)) {
                return tab;
            }
            const annotationRecovery = !tab.annotationRecovery && previous.isDirty ? previous.annotationRecovery : undefined;
            if (tab.workingCopyRef && !annotationRecovery) {return tab;}
            return {
                ...tab,
                ...(!tab.workingCopyRef ? {
                    sourceRef: tab.sourceRef ?? previous.sourceRef,
                    workingCopyRef: previous.workingCopyRef,
                    ...(previous.requiresSaveAsOnFirstSave && tab.requiresSaveAsOnFirstSave === undefined
                        ? {requiresSaveAsOnFirstSave: true}
                        : {}),
                } : {}),
                ...(annotationRecovery ? {annotationRecovery} : {}),
            };
        }),
    } satisfies IWorkspaceCheckpoint;
}

// A restore opens the documents of shown tabs at once. Those without unsaved
// changes can stay closed without losing work; a dirty tab reopens from its
// working copy and is never closed here.
function getRestoreOpenedDocuments(checkpoint: IWorkspaceCheckpoint) {
    const shownTabIds = new Set(checkpoint.panes.map(pane => pane.activeTabId));
    const tabs = checkpoint.tabs.filter(tab => (
        shownTabIds.has(tab.tabId)
        && !tab.isDirty
        && (tab.sourceRef !== null || tab.workingCopyRef !== null)
    ));
    return {
        tabIds: new Set<string>(tabs.map(tab => tab.tabId)),
        sourceRefs: new Set(tabs.flatMap(tab => (tab.sourceRef === null ? [] : [tab.sourceRef]))),
    };
}

// Keeps those tabs as empty ones, so the next claim, by the recovery reload or
// at the next launch, restores the rest of the workspace without reopening a
// document that ended the renderer, and names it so the user is told why. The
// file stays in Recent Files.
async function closeRestoreDocuments(
    recoveryId: string,
    documents: NonNullable<ReturnType<typeof restoresInFlight.get>>,
) {
    await flushPendingSaves();
    const record = await readRecordFile(recoveryId);
    if (!record) {
        return;
    }
    const notReopened = [...record.checkpoint.notReopened ?? []];
    let closedTabCount = 0;
    const tabs = record.checkpoint.tabs.map((tab) => {
        if (tab.isDirty || !(documents.tabIds.has(tab.tabId)
            || (tab.sourceRef !== null && documents.sourceRefs.has(tab.sourceRef)))) {
            return tab;
        }
        closedTabCount += 1;
        if (!notReopened.some(document => document.sourceRef === tab.sourceRef && document.fileName === tab.fileName)) {
            notReopened.push({
                fileName: tab.fileName,
                sourceRef: tab.sourceRef,
            });
        }
        return {
            tabId: tab.tabId,
            paneId: tab.paneId,
            fileName: null,
            sourceRef: null,
            workingCopyRef: null,
            isDirty: false,
            isDjvu: false,
            currentPage: null,
            zoom: null,
            zoomMode: null,
        };
    });
    if (closedTabCount === 0) {
        return;
    }
    log.warn(`Renderer ended while restoring; ${String(closedTabCount)} document tab(s) will not reopen`);
    await writeRecord({
        ...record,
        checkpoint: {
            ...record.checkpoint,
            tabs,
            notReopened,
        },
    });
}

export async function saveWorkspaceCheckpoint(
    checkpoint: IWorkspaceCheckpoint,
    ownerWebContentsId: number,
    sourceAuthorizationOwner?: number | WebContents,
) {
    const ownerRecoveryId = getWorkspaceRecoveryOwnerId(ownerWebContentsId, sourceAuthorizationOwner);
    // An unmigrated journal still holds the durable evidence this save protects.
    await serialize(migrateLegacyJournal);
    if (discardedOwners.has(ownerRecoveryId)) {
        return;
    }
    for (const tab of checkpoint.tabs) {
        if (tab.workingCopyRef && getWorkingCopyOwnerWebContentsId(tab.workingCopyRef) !== ownerWebContentsId) {
            throw new Error('Workspace checkpoint contains an unowned working copy');
        }
    }
    const durable = readDurableRecordForSave(ownerRecoveryId);
    const checkpointWithRetainedTabs = retainUnresolvedCheckpointTabs(checkpoint, durable);
    // A generated cleanup output can be the source of a restored tab. Refresh
    // its retention stamp after unresolved tabs have been restored, so the
    // startup sweep cannot expire a retained output before recovery reopens
    // it. The helper is deliberately best effort: non-cleanup paths are
    // ignored and a stamp failure must not discard the checkpoint itself.
    const generatedOutputCandidates = checkpointWithRetainedTabs.tabs.flatMap(tab => [
        tab.sourceRef,
        tab.workingCopyRef,
    ].filter((path): path is TDocumentRef => path !== null));
    if (generatedOutputCandidates.length > 0) {
        await Promise.allSettled(generatedOutputCandidates.map(path => (
            touchScanCleanupGeneratedOutput(path)
        )));
    }
    const admittedAnnotationRecovery = admitAnnotationRecovery(checkpointWithRetainedTabs);
    const checkpointWithArtifacts = admittedAnnotationRecovery.checkpoint;
    const canonicalCheckpoint = detachUnreachableSources(
        canonicalizeCheckpointSources(
            checkpointWithArtifacts,
            ownerWebContentsId,
            {rejectUnmappedWorkingCopy: true},
        ),
        durable,
        ownerWebContentsId,
    );
    const sourceProvenance = buildSourceProvenance(
        canonicalCheckpoint,
        ownerWebContentsId,
        sourceAuthorizationOwner,
        durable,
    );
    const lazyWorkingCopies = collectLazyWorkingCopies(checkpointWithArtifacts, ownerWebContentsId);
    const workingCopies = collectMaterializedWorkingCopies(checkpointWithArtifacts, ownerWebContentsId);
    const stored: IStoredWorkspaceCheckpoint = {
        version: 1,
        ownerRecoveryId,
        ownerWebContentsId,
        checkpoint: canonicalCheckpoint,
        ...(lazyWorkingCopies.length === 0 ? {} : {lazyWorkingCopies}),
        ...(workingCopies.length === 0 ? {} : {workingCopies}),
        ...(sourceProvenance.length === 0 ? {} : {sourceProvenance}),
    };
    const elapsedMs = Date.now() - (lastSaveStartedAtMs.get(ownerRecoveryId) ?? 0);
    if (!pendingSaves.has(ownerRecoveryId) && elapsedMs >= WORKSPACE_CHECKPOINT_SAVE_DEBOUNCE_MS) {
        lastSaveStartedAtMs.set(ownerRecoveryId, Date.now());
        await serialize(() => new Promise<void>((resolve, reject) => {
            void commitSave({
                stored,
                artifacts: admittedAnnotationRecovery.artifacts,
                waiters: [{
                    resolve,
                    reject,
                }],
                timer: setTimeout(() => undefined, 0),
            }).then(undefined, reject);
        }));
        return;
    }
    await scheduleSave(stored, admittedAnnotationRecovery.artifacts);
}

function isClaimable(record: IStoredWorkspaceCheckpoint, claimantRecoveryId: string) {
    return record.ownerRecoveryId === claimantRecoveryId
        ? !claimedInCurrentLoad.has(claimantRecoveryId)
        : !isLiveOwner(record);
}

export async function hasRecoverableWorkspaceCheckpoints(
    newOwnerWebContentsId: number,
    newOwner?: number | WebContents,
) {
    const claimantRecoveryId = getWorkspaceRecoveryOwnerId(newOwnerWebContentsId, newOwner);
    return serialize(async () => {
        await flushPendingSaves();
        const records = await readAllRecords();
        return records.some(record => isClaimable(record, claimantRecoveryId));
    });
}

export async function claimWorkspaceCheckpoint(
    newOwnerWebContentsId: number,
    newOwner?: number | WebContents,
) {
    const newOwnerRecoveryId = getWorkspaceRecoveryOwnerId(newOwnerWebContentsId, newOwner);
    return serialize(async () => {
        await flushPendingSaves();
        const stored = (await readAllRecords())
            .filter(record => isClaimable(record, newOwnerRecoveryId))
            .reduce<IStoredWorkspaceCheckpoint | null>((newest, candidate) => (
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
            // An invariant violation in persisted state is corruption: quarantine
            // it before any ownership change, or it crash-loops every start.
            await quarantineCorruptWorkspaceCheckpoint(
                getRecordPath(stored.ownerRecoveryId),
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
                const canTransfer = storedWorkingCopy
                    ? liveWorkingCopy !== null
                        && matchesStoredWorkingCopy(
                            liveWorkingCopy,
                            storedWorkingCopy,
                            {requireOriginalFileExpectation: tab.isDirty},
                        )
                    : !tab.isDirty;
                const transferred = canTransfer && claimWorkingCopyOwnership(
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
        // The claimant keeps the record until it has reopened every tab and
        // acknowledges; renaming the file hands it over atomically.
        const claimedStored: IStoredWorkspaceCheckpoint = {
            ...stored,
            ownerRecoveryId: newOwnerRecoveryId,
            ownerWebContentsId: newOwnerWebContentsId,
            checkpoint: canonicalCheckpoint,
            ...(stored.sourceProvenance ? {sourceProvenance: stored.sourceProvenance.map(provenance => ({
                ...provenance,
                ownerWebContentsId: newOwnerWebContentsId,
            }))} : {}),
        };
        if (stored.ownerRecoveryId !== newOwnerRecoveryId) {
            await mkdir(getRecordDirectory(), {recursive: true});
            await rename(getRecordPath(stored.ownerRecoveryId), getRecordPath(newOwnerRecoveryId));
            durableRecords.delete(stored.ownerRecoveryId);
        }
        await writeRecord(claimedStored);
        const generations = new Map<string, number>();
        for (const tab of canonicalCheckpoint.tabs) {
            if (tab.workingCopyRef) {
                generations.set(tab.workingCopyRef, claimWorkingCopyRecovery(tab.workingCopyRef));
            }
        }
        recoveryClaimGenerationsByOwner.set(newOwnerRecoveryId, generations);
        claimedInCurrentLoad.add(newOwnerRecoveryId);
        restoresInFlight.set(newOwnerRecoveryId, getRestoreOpenedDocuments(canonicalCheckpoint));
        return checkpointWithAnnotationRecovery;
    });
}

function releaseRecoveryClaims(ownerRecoveryId: string) {
    for (const [
        workingCopyRef,
        generation,
    ] of recoveryClaimGenerationsByOwner.get(ownerRecoveryId) ?? []) {
        releaseWorkingCopyRecovery(workingCopyRef, generation);
    }
    recoveryClaimGenerationsByOwner.delete(ownerRecoveryId);
}

async function removeRecordAndArtifacts(recoveryId: string, record: IStoredWorkspaceCheckpoint | null) {
    // Artifacts retire first: a failed cleanup leaves the record for a retry.
    await removeAnnotationRecoveryArtifacts(record?.checkpoint ?? null);
    await deleteRecord(recoveryId);
    releaseRecoveryClaims(recoveryId);
}

export function acknowledgeWorkspaceCheckpoint(
    ownerWebContentsId: number,
    owner?: number | WebContents,
) {
    const ownerRecoveryId = getWorkspaceRecoveryOwnerId(ownerWebContentsId, owner);
    return serialize(async () => {
        if (!claimedInCurrentLoad.has(ownerRecoveryId)) {
            throw new Error('Workspace checkpoint acknowledgement is not owned by this renderer');
        }
        restoresInFlight.delete(ownerRecoveryId);
        const record = await readRecordFile(ownerRecoveryId);
        if (!record) {
            return false;
        }
        await removeRecordAndArtifacts(ownerRecoveryId, record);
        return true;
    });
}

export function clearWorkspaceCheckpoint() {
    return serialize(async () => {
        for (const save of pendingSaves.values()) {
            clearTimeout(save.timer);
            for (const waiter of save.waiters) {
                waiter.resolve();
            }
        }
        pendingSaves.clear();
        for (const record of await readAllRecords()) {
            await removeRecordAndArtifacts(record.ownerRecoveryId, record);
        }
        claimedInCurrentLoad.clear();
        restoresInFlight.clear();
        durableRecords.clear();
    });
}

export async function discardWorkspaceCheckpoint(
    ownerWebContentsId: number,
    owner?: number | WebContents,
) {
    const ownerRecoveryId = getWorkspaceRecoveryOwnerId(ownerWebContentsId, owner);
    const token = String(nextDiscardToken);
    nextDiscardToken += 1;
    discardedOwners.set(ownerRecoveryId, token);
    restoresInFlight.delete(ownerRecoveryId);
    try {
        await serialize(async () => {
            await migrateLegacyJournal();
            const pending = pendingSaves.get(ownerRecoveryId);
            if (pending) {
                clearTimeout(pending.timer);
                pendingSaves.delete(ownerRecoveryId);
                for (const waiter of pending.waiters) {
                    waiter.resolve();
                }
            }
            await removeRecordAndArtifacts(ownerRecoveryId, await readRecordFile(ownerRecoveryId));
        });
    } catch (error) {
        if (discardedOwners.get(ownerRecoveryId) === token) {
            discardedOwners.delete(ownerRecoveryId);
        }
        throw error;
    }
    return token;
}

export function resumeWorkspaceCheckpoint(
    ownerWebContentsId: number,
    discardToken: string,
    owner?: number | WebContents,
) {
    const ownerRecoveryId = getWorkspaceRecoveryOwnerId(ownerWebContentsId, owner);
    if (discardedOwners.get(ownerRecoveryId) !== discardToken) {
        throw new Error('Workspace checkpoint discard token is stale or invalid');
    }
    discardedOwners.delete(ownerRecoveryId);
}
