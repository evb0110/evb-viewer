import { randomUUID } from 'node:crypto';
import {
    existsSync,
    statSync,
} from 'fs';
import {stat} from 'node:fs/promises';
import type {
    IDocumentRevisionChangedEvent,
    IDocumentRevisionInfo,
    TDocumentRevisionChangeReason,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    createStaleRevisionError,
    createWorkingCopySyncRequiredError,
} from '@contracts/documentMutationErrors';
import {createEpochMs} from '@contracts/timestamps';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    readWorkingCopyRevision,
    readWorkingCopySyncRequired,
    updateWorkingCopyManifest,
    writeWorkingCopyManifestRevision,
} from '@electron/file-access/workingCopyManifest';
import {
    getWorkingCopyBackingEntry,
    getWorkingCopyOwnerWebContentsId,
    getWorkingCopyOriginalPath,
    getWorkingCopyOriginalFileExpectation,
    getWorkingCopyRegistrationId,
    normalizePathForLookup,
    refreshWorkingCopyOriginalFileExpectation,
    workingCopyMap,
} from '@electron/file-access/workingCopyStore';
import {
    getWorkingCopyManifestPath,
    isManagedWorkingCopyPath,
} from '@electron/file-access/workingCopyDirectory';
import {createKeyedSerialQueue} from '@electron/utils/createKeyedSerialQueue';
import {
    completeWorkingCopyTransition,
    prepareWorkingCopyTransition,
    recoverWorkingCopyTransition,
    rollbackWorkingCopyTransition,
    sweepOrphanedOriginalBackups,
    type IWorkingCopyJournal,
    type TWorkingCopyContentBackupMode,
} from '@electron/file-access/workingCopyJournal';
import {measureOperationPhase} from '@contracts/measureOperationPhase';

const log = createLogger('documentRevisionStore');
const revisionListeners = new Set<(event: IDocumentRevisionChangedEvent) => void>();
const workingCopySyncRequired = new Map<string, string>();
interface IProvisionalWorkingCopyRevision {
    durabilityPromise?: Promise<unknown>;
    revision: IDocumentRevisionInfo;
}
const provisionalWorkingCopyRevisions = new Map<string, IProvisionalWorkingCopyRevision>();
const runContentTransitionSerially = createKeyedSerialQueue();

function requireDocumentRef(value: string): TDocumentRef {
    const parsed = parseDocumentRef(value);
    if (parsed === null) {
        throw new TypeError('Working copy path must be an absolute document ref');
    }
    return parsed;
}

async function measureRevisionTransitionPhase<T>(
    phase: string,
    onPhase: ((phase: string, durationMs: number) => void) | undefined,
    operation: () => Promise<T>,
): Promise<T> {
    return measureOperationPhase(operation, durationMs => {
        try { onPhase?.(phase, durationMs); }
        catch (error) { log.warn(`Document revision phase reporter failed: ${getErrorMessage(error)}`); }
    });
}

function getRevisionQueueKey(workingCopyPath: string) {
    return normalizePathForLookup(workingCopyPath) || workingCopyPath;
}

function isExistingFile(workingCopyPath: string) {
    try {
        return statSync(workingCopyPath).isFile();
    } catch {
        return false;
    }
}

interface ILinkedOriginalExpectationFence {
    ctimeNs: bigint;
    deviceId: bigint;
    inode: bigint;
    linkCount: bigint;
    mtimeNs: bigint;
    originalPath: string;
    size: bigint;
    workingCopyPath: string;
}

async function captureLinkedOriginalExpectationFence(
    workingCopyPath: string,
    senderId?: number,
): Promise<ILinkedOriginalExpectationFence | null> {
    const entry = getWorkingCopyBackingEntry(workingCopyPath, senderId);
    const expected = getWorkingCopyOriginalFileExpectation(workingCopyPath, senderId);
    if (!entry || !expected
        || expected.ctimeNs === undefined
        || expected.deviceId === undefined
        || expected.inode === undefined
        || expected.mtimeNs === undefined) {
        return null;
    }

    try {
        const [
            originalStat,
            workingCopyStat,
        ] = await Promise.all([
            stat(entry.originalPath, {bigint: true}),
            stat(workingCopyPath, {bigint: true}),
        ]);
        if (
            !originalStat.isFile()
            || !workingCopyStat.isFile()
            || originalStat.dev !== workingCopyStat.dev
            || originalStat.ino !== workingCopyStat.ino
            || originalStat.nlink < 2n
            || originalStat.ctimeNs.toString() !== expected.ctimeNs
            || originalStat.dev.toString() !== expected.deviceId
            || originalStat.ino.toString() !== expected.inode
            || originalStat.mtimeNs.toString() !== expected.mtimeNs
            || originalStat.size !== BigInt(expected.size)
        ) {
            return null;
        }
        return {
            ctimeNs: originalStat.ctimeNs,
            deviceId: originalStat.dev,
            inode: originalStat.ino,
            linkCount: originalStat.nlink,
            mtimeNs: originalStat.mtimeNs,
            originalPath: entry.originalPath,
            size: originalStat.size,
            workingCopyPath,
        };
    } catch {
        return null;
    }
}

async function refreshOriginalExpectationAfterManagedLinkedDetach(
    fence: ILinkedOriginalExpectationFence,
    senderId?: number,
) {
    const entry = getWorkingCopyBackingEntry(fence.workingCopyPath, senderId);
    if (!entry || entry.originalPath !== fence.originalPath) {
        return;
    }

    try {
        const [
            originalStat,
            workingCopyStat,
        ] = await Promise.all([
            stat(fence.originalPath, {bigint: true}),
            stat(fence.workingCopyPath, {bigint: true}),
        ]);
        const workingCopyStillUsesOriginal = (
            workingCopyStat.dev === fence.deviceId
            && workingCopyStat.ino === fence.inode
        );
        if (
            !originalStat.isFile()
            || !workingCopyStat.isFile()
            || originalStat.dev !== fence.deviceId
            || originalStat.ino !== fence.inode
            || originalStat.ctimeNs === fence.ctimeNs
            || originalStat.mtimeNs !== fence.mtimeNs
            || originalStat.size !== fence.size
            || workingCopyStillUsesOriginal
        ) {
            return;
        }
    } catch {
        return;
    }

    // A page/content transition owns the working-copy replacement. Refreshing
    // only after the source hard link was proven to detach preserves the save
    // fence for edits made outside this transition.
    await refreshWorkingCopyOriginalFileExpectation(fence.workingCopyPath, senderId);
}

function assertCanUseWorkingCopyRevision(workingCopyPath: string, senderId?: number) {
    const ownerWebContentsId = getWorkingCopyOwnerWebContentsId(workingCopyPath);
    if (typeof ownerWebContentsId === 'number' && ownerWebContentsId !== senderId) {
        throw new Error('Working copy path is owned by another sender');
    }
    if (workingCopyMap.has(workingCopyPath) || (isManagedWorkingCopyPath(workingCopyPath) && isExistingFile(workingCopyPath))) {
        return;
    }
    if (existsSync(getWorkingCopyManifestPath(workingCopyPath))) {
        return;
    }

    throw new Error('Working copy path is not managed');
}

function getTokenRegistrationId(workingCopyPath: string, senderId?: number) {
    const registrationId = getWorkingCopyRegistrationId(workingCopyPath, senderId);
    if (registrationId !== null) {
        return String(registrationId);
    }

    return `generated-${randomUUID()}`;
}

function createRevision(
    workingCopyPath: string,
    contentRevision: number,
    senderId?: number,
): IDocumentRevisionInfo {
    return {
        version: 1,
        documentRef: requireDocumentRef(workingCopyPath),
        authority: 'electron-working-copy',
        token: requireDocumentRevisionToken(`drt1:${getTokenRegistrationId(workingCopyPath, senderId)}:${contentRevision}:${randomUUID()}`),
        contentRevision,
        mintedAt: createEpochMs(),
    };
}

/**
 * Initializes a revision for a path that was created in a fresh working-copy
 * directory during this process. Unlike `ensureWorkingCopyRevision`, this does
 * not run recovery for journals that cannot exist yet and it avoids an fsync on
 * the user-visible open path. Every mutation entry point must cross
 * `awaitWorkingCopyRevisionDurability` before changing the document.
 */
export async function initializeFreshWorkingCopyRevision(
    workingCopyPath: string,
    senderId?: number,
): Promise<IDocumentRevisionInfo> {
    const normalizedWorkingPath = typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }
    assertCanUseWorkingCopyRevision(normalizedWorkingPath, senderId);
    const queueKey = getRevisionQueueKey(normalizedWorkingPath);
    const active = provisionalWorkingCopyRevisions.get(queueKey);
    if (active) {
        return active.revision;
    }
    if (existsSync(getWorkingCopyManifestPath(normalizedWorkingPath))) {
        return ensureWorkingCopyRevision(normalizedWorkingPath, senderId);
    }

    const originalPath = getWorkingCopyOriginalPath(normalizedWorkingPath, senderId)?.originalPath;
    if (originalPath) {
        await sweepOrphanedOriginalBackups(originalPath, normalizedWorkingPath);
    }

    const revision = createRevision(normalizedWorkingPath, 1, senderId);
    await writeWorkingCopyManifestRevision(normalizedWorkingPath, revision, {durable: false});
    provisionalWorkingCopyRevisions.set(queueKey, {revision});
    return revision;
}

/** Promotes a fresh revision to durable storage before any mutation commits. */
export async function awaitWorkingCopyRevisionDurability(workingCopyPath: string) {
    const queueKey = getRevisionQueueKey(workingCopyPath);
    const entry = provisionalWorkingCopyRevisions.get(queueKey);
    if (!entry) {
        return;
    }
    entry.durabilityPromise ??= writeWorkingCopyManifestRevision(
        workingCopyPath,
        entry.revision,
        {markMutationCommitStarted: false},
    );
    try {
        await entry.durabilityPromise;
        if (provisionalWorkingCopyRevisions.get(queueKey) === entry) {
            provisionalWorkingCopyRevisions.delete(queueKey);
        }
    } catch (error) {
        delete entry.durabilityPromise;
        throw error;
    }
}

export function forgetWorkingCopyRevisionInitialization(workingCopyPath: string) {
    provisionalWorkingCopyRevisions.delete(getRevisionQueueKey(workingCopyPath));
}

export function clearWorkingCopyRevisionInitializations() {
    provisionalWorkingCopyRevisions.clear();
}

function notifyRevisionChanged(event: IDocumentRevisionChangedEvent) {
    for (const listener of revisionListeners) {
        try {
            listener(event);
        } catch (error) {
            log.debug(`Failed to notify document revision listener: ${getErrorMessage(error)}`);
        }
    }
}

function hydrateWorkingCopySyncRequired(workingCopyPath: string) {
    const queueKey = getRevisionQueueKey(workingCopyPath);
    const known = workingCopySyncRequired.get(queueKey);
    if (known !== undefined) {
        return known;
    }
    let pendingSync;
    try {
        pendingSync = readWorkingCopySyncRequired(workingCopyPath);
    } catch (error) {
        // Unreadable evidence blocks mutations until it can be read again.
        return `Working copy manifest is unavailable: ${getErrorMessage(error)}`;
    }
    if (pendingSync) {
        workingCopySyncRequired.set(queueKey, pendingSync.reason);
    }
    return pendingSync?.reason;
}

export async function ensureWorkingCopyRevision(
    workingCopyPath: string,
    senderId?: number,
): Promise<IDocumentRevisionInfo> {
    const normalizedWorkingPath = typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }
    assertCanUseWorkingCopyRevision(normalizedWorkingPath, senderId);
    const provisional = provisionalWorkingCopyRevisions.get(getRevisionQueueKey(normalizedWorkingPath));
    if (provisional) {
        return provisional.revision;
    }
    await recoverWorkingCopyTransition(normalizedWorkingPath);
    const originalPath = getWorkingCopyOriginalPath(normalizedWorkingPath, senderId)?.originalPath;
    if (originalPath) {
        await sweepOrphanedOriginalBackups(originalPath, normalizedWorkingPath);
    }
    hydrateWorkingCopySyncRequired(normalizedWorkingPath);

    const existing = await readWorkingCopyRevision(normalizedWorkingPath);
    if (existing) {
        return existing;
    }

    const revision = createRevision(normalizedWorkingPath, 1, senderId);
    await writeWorkingCopyManifestRevision(normalizedWorkingPath, revision);
    return revision;
}

export function getWorkingCopyRevision(workingCopyPath: string, senderId?: number) {
    return ensureWorkingCopyRevision(workingCopyPath, senderId);
}

/** Publishes a new revision for content that was already replaced. */
export async function markWorkingCopyContentChanged(
    workingCopyPath: string,
    reason: TDocumentRevisionChangeReason,
    senderId?: number,
): Promise<IDocumentRevisionChangedEvent> {
    const normalizedWorkingPath = typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }
    assertCanUseWorkingCopyRevision(normalizedWorkingPath, senderId);
    await awaitWorkingCopyRevisionDurability(normalizedWorkingPath);

    const previous = await readWorkingCopyRevision(normalizedWorkingPath);
    const revision = createRevision(normalizedWorkingPath, (previous?.contentRevision ?? 0) + 1, senderId);
    await writeWorkingCopyManifestRevision(normalizedWorkingPath, revision);

    const event: IDocumentRevisionChangedEvent = {
        ...revision,
        ...(previous?.token ? {previousToken: previous.token} : {}),
        reason,
    };
    notifyRevisionChanged(event);
    return event;
}

/**
 * Runs a content replacement and its revision publication as one serialized
 * transition. The caller must make `commit` rollback its file mutations when
 * it throws; no new revision is externally visible until it succeeds.
 */
async function runWorkingCopyContentRevisionTransition(
    workingCopyPath: string,
    reason: TDocumentRevisionChangeReason,
    commit: (nextRevision: IDocumentRevisionInfo, journal: IWorkingCopyJournal) => Promise<void>,
    senderId?: number,
    onPhase?: (phase: string, durationMs: number) => void,
    contentBackupMode: TWorkingCopyContentBackupMode = 'copy-on-write',
): Promise<IDocumentRevisionChangedEvent> {
    const normalizedWorkingPath = typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }
    assertCanUseWorkingCopyRevision(normalizedWorkingPath, senderId);
    await measureRevisionTransitionPhase('revision-await-existing-durability', onPhase, () =>
        awaitWorkingCopyRevisionDurability(normalizedWorkingPath));
    const linkedOriginalExpectationFence = await captureLinkedOriginalExpectationFence(
        normalizedWorkingPath,
        senderId,
    );

    const previous = await measureRevisionTransitionPhase('revision-read-previous', onPhase, () =>
        readWorkingCopyRevision(normalizedWorkingPath));
    const revision = createRevision(normalizedWorkingPath, (previous?.contentRevision ?? 0) + 1, senderId);
    const journal = await measureRevisionTransitionPhase('revision-prepare-journal', onPhase, () =>
        prepareWorkingCopyTransition(
            normalizedWorkingPath,
            revision.token,
            onPhase,
            contentBackupMode,
        ));
    try {
        await measureRevisionTransitionPhase('revision-commit-files', onPhase, () =>
            commit(revision, journal));
        // The durable manifest write is the transaction commit point.
        await measureRevisionTransitionPhase('revision-write-manifest', onPhase, () =>
            writeWorkingCopyManifestRevision(normalizedWorkingPath, revision));
    } catch (error) {
        await rollbackWorkingCopyTransition(journal);
        throw error;
    }
    try {
        await measureRevisionTransitionPhase('revision-complete-journal', onPhase, () =>
            completeWorkingCopyTransition(journal));
    } catch (error) {
        log.debug(`Failed to clean committed working-copy journal: ${getErrorMessage(error)}`);
    }
    if (linkedOriginalExpectationFence) {
        await refreshOriginalExpectationAfterManagedLinkedDetach(
            linkedOriginalExpectationFence,
            senderId,
        );
    }

    const event: IDocumentRevisionChangedEvent = {
        ...revision,
        ...(previous?.token ? {previousToken: previous.token} : {}),
        reason,
    };
    notifyRevisionChanged(event);
    return event;
}

export function transitionWorkingCopyContentRevision(
    workingCopyPath: string,
    reason: TDocumentRevisionChangeReason,
    commit: (nextRevision: IDocumentRevisionInfo, journal: IWorkingCopyJournal) => Promise<void>,
    senderId?: number,
    onPhase?: (phase: string, durationMs: number) => void,
    contentBackupMode: TWorkingCopyContentBackupMode = 'copy-on-write',
): Promise<IDocumentRevisionChangedEvent> {
    return runContentTransitionSerially(getRevisionQueueKey(workingCopyPath), () =>
        runWorkingCopyContentRevisionTransition(
            workingCopyPath,
            reason,
            commit,
            senderId,
            onPhase,
            contentBackupMode,
        ));
}

export function isWorkingCopyRevisionCurrent(
    workingCopyPath: string,
    token: TDocumentRevisionToken,
): Promise<boolean> {
    return readWorkingCopyRevision(workingCopyPath)
        .then(revision => revision?.token === token)
        .catch(() => false);
}

export async function assertWorkingCopyRevisionCurrent(
    workingCopyPath: string,
    token: TDocumentRevisionToken,
): Promise<void> {
    await awaitWorkingCopyRevisionDurability(workingCopyPath);
    const revision = await readWorkingCopyRevision(workingCopyPath);
    if (revision?.token !== token) {
        throw createStaleRevisionError({
            documentRef: requireDocumentRef(workingCopyPath),
            expectedRevision: token,
            actualRevision: revision?.token ?? null,
        });
    }
}

export function assertWorkingCopyMutationAllowed(workingCopyPath: string) {
    const reason = hydrateWorkingCopySyncRequired(workingCopyPath);
    if (reason !== undefined) {
        throw createWorkingCopySyncRequiredError({
            documentRef: requireDocumentRef(workingCopyPath),
            message: reason,
        });
    }
}

export function hasWorkingCopySyncRequired(workingCopyPath: string) {
    return hydrateWorkingCopySyncRequired(workingCopyPath) !== undefined;
}

export async function markWorkingCopySyncRequired(workingCopyPath: string, reason: string) {
    const normalizedWorkingPath = typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '';
    const activeEntry = normalizedWorkingPath ? workingCopyMap.get(normalizedWorkingPath) : undefined;
    workingCopySyncRequired.set(getRevisionQueueKey(workingCopyPath), reason);
    if (!normalizedWorkingPath) {
        return;
    }
    try {
        await updateWorkingCopyManifest(normalizedWorkingPath, current => ({
            version: 1,
            revision: current?.revision ?? createRevision(normalizedWorkingPath, 1, activeEntry?.ownerWebContentsId),
            syncRequired: {
                reason,
                ...(activeEntry?.originalPath === undefined ? {} : {originalPath: activeEntry.originalPath}),
                ...(activeEntry?.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: activeEntry.ownerWebContentsId}),
            },
        }));
    } catch (error) {
        log.debug(`Failed to persist working-copy sync-required state: ${getErrorMessage(error)}`);
    }
}

export function onWorkingCopyRevisionChanged(listener: (event: IDocumentRevisionChangedEvent) => void) {
    revisionListeners.add(listener);
    return () => {
        revisionListeners.delete(listener);
    };
}
