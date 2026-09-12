import { randomUUID } from 'node:crypto';
import {
    existsSync,
    statSync,
} from 'fs';
import {stat} from 'node:fs/promises';
import {
    basename,
    dirname,
    isAbsolute,
    relative,
    sep,
} from 'path';
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
import { createWorkingCopySyncRequiredError } from '@contracts/documentMutationErrors';
import {createEpochMs} from '@contracts/timestamps';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    assertWorkingCopyRevisionSidecarCurrent,
    clearWorkingCopyRevisionSidecarCommit,
    clearWorkingCopySyncRequiredJournalEntry,
    getWorkingCopyRevisionSidecarPath,
    readWorkingCopyRevisionSidecar,
    readWorkingCopySyncRequiredJournalEntry,
    reconcileWorkingCopyRevisionSidecarJournal,
    stageWorkingCopyRevisionSidecarCommit,
    writeProvisionalWorkingCopyRevisionSidecar,
    writeWorkingCopySyncRequiredJournalEntry,
    writeWorkingCopyRevisionSidecar,
    type IWorkingCopyRevisionSidecar,
} from '@electron/file-access/documentRevisionSidecar';
import {
    getWorkingCopyBackingEntry,
    getWorkingCopyOwnerWebContentsId,
    getWorkingCopyOriginalFileExpectation,
    getWorkingCopyRegistrationId,
    normalizePathForLookup,
    refreshWorkingCopyOriginalFileExpectation,
    workingCopyMap,
} from '@electron/file-access/workingCopyStore';
import { isWorkingCopyDirectoryName } from '@electron/file-access/workingCopyDirectory';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { clearWorkingCopyOcrArtifacts } from '@electron/file-access/workingCopyMutationQueue';
import {recoverPreparedOcrRevisionTransition} from '@electron/features/ocr/public/recovery';
import {
    completeWorkingCopyContentTransition,
    prepareWorkingCopyContentTransition,
    recoverWorkingCopyContentTransition,
    rollbackWorkingCopyContentTransition,
} from '@electron/file-access/workingCopyContentTransitionJournal';
import {
    hasTwoTargetTransitionEvidence,
    invalidateTwoTargetTransitionEvidence,
    recoverTwoTargetDocumentTransition,
} from '@electron/file-access/recoverTwoTargetDocumentTransition';
import {measureOperationPhase} from '@contracts/measureOperationPhase';
import {
    getPageIdentitySidecarPath,
    quarantinePageIdentitySidecar,
    rebasePageIdentitySidecarRevision,
} from '@electron/file-access/rebasePageIdentitySidecarRevision';

const log = createLogger('documentRevisionStore');
const revisionListeners = new Set<(event: IDocumentRevisionChangedEvent) => void>();
const workingCopySyncRequired = new Map<string, string>();
const workingCopySyncRequiredJournalReadFailures = new Set<string>();
interface IProvisionalWorkingCopyRevision {
    durabilityPromise?: Promise<void>;
    sidecar: IWorkingCopyRevisionSidecar;
}
const provisionalWorkingCopyRevisions = new Map<string, IProvisionalWorkingCopyRevision>();
const workingCopyContentTransitionQueue = new Map<string, Promise<void>>();

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

function enqueueWorkingCopyContentTransition<T>(
    workingCopyPath: string,
    operation: () => Promise<T>,
) {
    const queueKey = getRevisionQueueKey(workingCopyPath);
    const previousTail = workingCopyContentTransitionQueue.get(queueKey) ?? Promise.resolve();
    const operationPromise = previousTail.then(operation, operation);
    const nextTail = operationPromise.then(() => undefined, () => undefined);
    workingCopyContentTransitionQueue.set(queueKey, nextTail);
    return operationPromise.finally(() => {
        if (workingCopyContentTransitionQueue.get(queueKey) === nextTail) {
            workingCopyContentTransitionQueue.delete(queueKey);
        }
    });
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
            || originalStat.nlink !== fence.linkCount - 1n
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

async function rebasePageIdentityAfterContentCommit(
    workingCopyPath: string,
    previousRevision: IWorkingCopyRevisionSidecar | null,
    nextRevision: IDocumentRevisionInfo,
) {
    const pageIdentityPath = getPageIdentitySidecarPath(workingCopyPath);
    if (!previousRevision) {
        const quarantinePath = await quarantinePageIdentitySidecar(workingCopyPath);
        if (quarantinePath !== null) {
            log.warn(`Quarantined unfenced page identity sidecar at ${quarantinePath}`);
        }
        return;
    }
    if (!existsSync(pageIdentityPath)) {
        return;
    }
    await rebasePageIdentitySidecarRevision(
        workingCopyPath,
        toRevisionInfo(previousRevision),
        nextRevision,
    );
}

function isUnregisteredWorkingCopyPath(workingCopyPath: string) {
    const normalizedWorkingPath = typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '';
    if (!normalizedWorkingPath || !isAbsolute(normalizedWorkingPath) || !isExistingFile(normalizedWorkingPath)) {
        return false;
    }

    const tempDir = normalizePathForLookup(getAppTempDir());
    const parentDir = normalizePathForLookup(dirname(normalizedWorkingPath));
    const relativePath = relative(tempDir, parentDir);
    return (
        relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
        && isWorkingCopyDirectoryName(basename(parentDir))
    );
}

function assertCanUseWorkingCopyRevision(workingCopyPath: string, senderId?: number) {
    const ownerWebContentsId = getWorkingCopyOwnerWebContentsId(workingCopyPath);
    if (typeof ownerWebContentsId === 'number' && ownerWebContentsId !== senderId) {
        throw new Error('Working copy path is owned by another sender');
    }
    if (workingCopyMap.has(workingCopyPath) || isUnregisteredWorkingCopyPath(workingCopyPath)) {
        return;
    }
    if (existsSync(getWorkingCopyRevisionSidecarPath(workingCopyPath))) {
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

function createRevisionSidecar(
    workingCopyPath: string,
    contentRevision: number,
    senderId?: number,
): IWorkingCopyRevisionSidecar {
    const mintedAt = createEpochMs();
    return {
        sidecarVersion: 1,
        version: 1,
        documentRef: requireDocumentRef(workingCopyPath),
        authority: 'electron-working-copy',
        token: requireDocumentRevisionToken(`drt1:${getTokenRegistrationId(workingCopyPath, senderId)}:${contentRevision}:${randomUUID()}`),
        contentRevision,
        mintedAt,
        updatedAt: mintedAt,
    };
}

function toRevisionInfo(sidecar: IWorkingCopyRevisionSidecar): IDocumentRevisionInfo {
    return {
        version: 1,
        documentRef: sidecar.documentRef,
        authority: sidecar.authority,
        token: sidecar.token,
        contentRevision: sidecar.contentRevision,
        mintedAt: sidecar.mintedAt,
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
        return toRevisionInfo(active.sidecar);
    }
    if (existsSync(getWorkingCopyRevisionSidecarPath(normalizedWorkingPath))) {
        return ensureWorkingCopyRevision(normalizedWorkingPath, senderId);
    }

    const sidecar = createRevisionSidecar(normalizedWorkingPath, 1, senderId);
    await writeProvisionalWorkingCopyRevisionSidecar(normalizedWorkingPath, sidecar);
    provisionalWorkingCopyRevisions.set(queueKey, {sidecar});
    return toRevisionInfo(sidecar);
}

/** Promotes a fresh revision to durable storage before any mutation commits. */
export async function awaitWorkingCopyRevisionDurability(workingCopyPath: string) {
    const queueKey = getRevisionQueueKey(workingCopyPath);
    const entry = provisionalWorkingCopyRevisions.get(queueKey);
    if (!entry) {
        return;
    }
    entry.durabilityPromise ??= writeWorkingCopyRevisionSidecar(
        workingCopyPath,
        entry.sidecar,
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

function hydrateWorkingCopySyncRequiredFromJournal(workingCopyPath: string) {
    const queueKey = getRevisionQueueKey(workingCopyPath);
    if (workingCopySyncRequired.has(queueKey) && !workingCopySyncRequiredJournalReadFailures.has(queueKey)) {
        return workingCopySyncRequired.get(queueKey);
    }

    let pendingSync;
    try {
        pendingSync = readWorkingCopySyncRequiredJournalEntry(workingCopyPath);
        workingCopySyncRequiredJournalReadFailures.delete(queueKey);
    } catch (error) {
        const reason = `Working copy recovery journal is unavailable: ${getErrorMessage(error)}`;
        workingCopySyncRequired.set(queueKey, reason);
        workingCopySyncRequiredJournalReadFailures.add(queueKey);
        return reason;
    }
    if (!pendingSync) {
        workingCopySyncRequired.delete(queueKey);
        return undefined;
    }
    workingCopySyncRequired.set(queueKey, pendingSync.reason);
    return pendingSync.reason;
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
        return toRevisionInfo(provisional.sidecar);
    }
    const pendingSaveAsSync = await recoverTwoTargetDocumentTransition(normalizedWorkingPath);
    if (
        pendingSaveAsSync
        && typeof pendingSaveAsSync === 'object'
        && pendingSaveAsSync.kind === 'save-as-working-copy-sync-required'
    ) {
        markWorkingCopySyncRequired(normalizedWorkingPath, pendingSaveAsSync.reason, {
            originalPath: pendingSaveAsSync.originalPath,
            ...(pendingSaveAsSync.ownerWebContentsId === undefined
                ? {}
                : {ownerWebContentsId: pendingSaveAsSync.ownerWebContentsId}),
        });
    }
    invalidateTwoTargetTransitionEvidence(normalizedWorkingPath);
    await recoverWorkingCopyContentTransition(normalizedWorkingPath);
    await recoverPreparedOcrRevisionTransition(normalizedWorkingPath);
    hydrateWorkingCopySyncRequiredFromJournal(normalizedWorkingPath);

    const existing = await readWorkingCopyRevisionSidecar(normalizedWorkingPath);
    if (existing) {
        return toRevisionInfo(existing);
    }

    // A new revision cannot safely adopt a page ledger that has no current
    // revision fence. Keep the old ledger as evidence and let the next open
    // seed identities under the revision we publish here.
    const pageIdentityPath = getPageIdentitySidecarPath(normalizedWorkingPath);
    const quarantinePath = await quarantinePageIdentitySidecar(normalizedWorkingPath);
    if (quarantinePath !== null) {
        log.warn(`Quarantined unfenced page identity sidecar at ${quarantinePath}`);
    } else if (existsSync(pageIdentityPath)) {
        throw new Error('Page identity sidecar disappeared while its revision fence was being recovered');
    }

    const sidecar = createRevisionSidecar(normalizedWorkingPath, 1, senderId);
    await writeWorkingCopyRevisionSidecar(normalizedWorkingPath, sidecar);
    return toRevisionInfo(sidecar);
}

export function getWorkingCopyRevision(workingCopyPath: string, senderId?: number) {
    return ensureWorkingCopyRevision(workingCopyPath, senderId);
}

export async function markWorkingCopyRevisionChanged(
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

    const previous = await readWorkingCopyRevisionSidecar(normalizedWorkingPath);
    const contentRevision = (previous?.contentRevision ?? 0) + 1;
    const sidecar = createRevisionSidecar(normalizedWorkingPath, contentRevision, senderId);
    stageWorkingCopyRevisionSidecarCommit(normalizedWorkingPath, sidecar, reason);
    await rebasePageIdentityAfterContentCommit(normalizedWorkingPath, previous, toRevisionInfo(sidecar));
    await writeWorkingCopyRevisionSidecar(normalizedWorkingPath, sidecar);
    try {
        clearWorkingCopyRevisionSidecarCommit(normalizedWorkingPath, sidecar.token);
    } catch (error) {
        log.debug(`Failed to clear document revision journal entry: ${getErrorMessage(error)}`);
    }

    const event: IDocumentRevisionChangedEvent = {
        ...toRevisionInfo(sidecar),
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
    commit: (nextRevision: IDocumentRevisionInfo) => Promise<void>,
    senderId?: number,
    onPhase?: (phase: string, durationMs: number) => void,
    contentBackupMode: 'copy-on-write' | 'hard-link' = 'copy-on-write',
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
        readWorkingCopyRevisionSidecar(normalizedWorkingPath));
    const sidecar = createRevisionSidecar(normalizedWorkingPath, (previous?.contentRevision ?? 0) + 1, senderId);
    const contentJournal = await measureRevisionTransitionPhase('revision-prepare-journal', onPhase, () =>
        prepareWorkingCopyContentTransition(
            normalizedWorkingPath,
            sidecar.token,
            onPhase,
            contentBackupMode,
        ));
    try {
        await measureRevisionTransitionPhase('revision-commit-files', onPhase, () =>
            commit(toRevisionInfo(sidecar)));
        await measureRevisionTransitionPhase('revision-rebase-page-identity', onPhase, () =>
            rebasePageIdentityAfterContentCommit(
                normalizedWorkingPath,
                previous,
                toRevisionInfo(sidecar),
            ));
        // The atomic, durable sidecar rename is the transaction commit point.
        // Unlike standalone revision bumps, this path already has a content
        // recovery journal, so a second pending-revision journal would make a
        // crash before this write look committed during recovery.
        await measureRevisionTransitionPhase('revision-write-sidecar', onPhase, () =>
            writeWorkingCopyRevisionSidecar(normalizedWorkingPath, sidecar));
    } catch (error) {
        await rollbackWorkingCopyContentTransition(contentJournal);
        throw error;
    }
    try {
        await measureRevisionTransitionPhase('revision-complete-journal', onPhase, () =>
            completeWorkingCopyContentTransition(contentJournal));
    } catch (error) {
        log.debug(`Failed to clean committed content transition journal: ${getErrorMessage(error)}`);
    }
    if (linkedOriginalExpectationFence) {
        await refreshOriginalExpectationAfterManagedLinkedDetach(
            linkedOriginalExpectationFence,
            senderId,
        );
    }

    const event: IDocumentRevisionChangedEvent = {
        ...toRevisionInfo(sidecar),
        ...(previous?.token ? {previousToken: previous.token} : {}),
        reason,
    };
    notifyRevisionChanged(event);
    return event;
}

export function transitionWorkingCopyContentRevision(
    workingCopyPath: string,
    reason: TDocumentRevisionChangeReason,
    commit: (nextRevision: IDocumentRevisionInfo) => Promise<void>,
    senderId?: number,
    onPhase?: (phase: string, durationMs: number) => void,
    contentBackupMode: 'copy-on-write' | 'hard-link' = 'copy-on-write',
): Promise<IDocumentRevisionChangedEvent> {
    return enqueueWorkingCopyContentTransition(workingCopyPath, () =>
        runWorkingCopyContentRevisionTransition(
            workingCopyPath,
            reason,
            commit,
            senderId,
            onPhase,
            contentBackupMode,
        ));
}

export async function markWorkingCopyContentChanged(
    workingCopyPath: string,
    reason: TDocumentRevisionChangeReason,
    senderId?: number,
): Promise<IDocumentRevisionChangedEvent> {
    const event = await markWorkingCopyRevisionChanged(workingCopyPath, reason, senderId);
    await clearWorkingCopyOcrArtifacts(workingCopyPath);
    return event;
}

export function isWorkingCopyRevisionCurrent(
    workingCopyPath: string,
    token: TDocumentRevisionToken,
): Promise<boolean> {
    return reconcileWorkingCopyRevisionSidecarJournal(workingCopyPath)
        .catch(() => null)
        .then(() => readWorkingCopyRevisionSidecar(workingCopyPath))
        .then(sidecar => sidecar?.token === token)
        .catch(() => false);
}

export async function assertWorkingCopyRevisionCurrent(
    workingCopyPath: string,
    token: TDocumentRevisionToken,
): Promise<void> {
    await awaitWorkingCopyRevisionDurability(workingCopyPath);
    await reconcileWorkingCopyRevisionSidecarJournal(workingCopyPath);
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, token);
}

export function assertWorkingCopyMutationAllowed(workingCopyPath: string) {
    const reason = hydrateWorkingCopySyncRequiredFromJournal(workingCopyPath);
    if (reason !== undefined) {
        throw createWorkingCopySyncRequiredError({
            documentRef: requireDocumentRef(workingCopyPath),
            message: reason,
        });
    }
    if (hasTwoTargetTransitionEvidence(workingCopyPath)) {
        throw createWorkingCopySyncRequiredError({
            documentRef: requireDocumentRef(workingCopyPath),
            message: 'Working copy recovery is unresolved; resync is required before further edits',
        });
    }
}

export function hasWorkingCopySyncRequired(workingCopyPath: string) {
    return hydrateWorkingCopySyncRequiredFromJournal(workingCopyPath) !== undefined
        || hasTwoTargetTransitionEvidence(workingCopyPath);
}

export function assertWorkingCopyResyncAllowed(workingCopyPath: string, senderId?: number) {
    assertCanUseWorkingCopyRevision(workingCopyPath, senderId);
}

export function markWorkingCopySyncRequired(
    workingCopyPath: string,
    reason: string,
    options: {
        originalPath?: string;
        ownerWebContentsId?: number;
    } = {},
) {
    const normalizedWorkingPath = typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '';
    const activeEntry = normalizedWorkingPath ? workingCopyMap.get(normalizedWorkingPath) : undefined;
    workingCopySyncRequired.set(
        getRevisionQueueKey(workingCopyPath),
        reason,
    );
    workingCopySyncRequiredJournalReadFailures.delete(getRevisionQueueKey(workingCopyPath));
    if (!normalizedWorkingPath) {
        return false;
    }
    // A caller that recovered the state from a journal knows the original it
    // belonged to; the live map may no longer hold that tab.
    const originalPath = options.originalPath ?? activeEntry?.originalPath;
    const ownerWebContentsId = options.ownerWebContentsId ?? activeEntry?.ownerWebContentsId;
    try {
        writeWorkingCopySyncRequiredJournalEntry(normalizedWorkingPath, {
            reason,
            ...(originalPath === undefined ? {} : {originalPath}),
            ...(ownerWebContentsId === undefined ? {} : {ownerWebContentsId}),
        });
    } catch (error) {
        log.debug(`Failed to persist working-copy sync-required journal entry: ${getErrorMessage(error)}`);
        return false;
    }
    return true;
}

export function clearWorkingCopySyncRequired(workingCopyPath: string) {
    const queueKey = getRevisionQueueKey(workingCopyPath);
    try {
        clearWorkingCopySyncRequiredJournalEntry(workingCopyPath);
    } catch (error) {
        log.debug(`Failed to clear working-copy sync-required journal entry: ${getErrorMessage(error)}`);
        return false;
    }
    workingCopySyncRequired.delete(queueKey);
    workingCopySyncRequiredJournalReadFailures.delete(queueKey);
    // The caller clears the fence only after the two-target transition it
    // belonged to has completed, so the journal is gone with it.
    invalidateTwoTargetTransitionEvidence(workingCopyPath);
    return true;
}

export function onWorkingCopyRevisionChanged(listener: (event: IDocumentRevisionChangedEvent) => void) {
    revisionListeners.add(listener);
    return () => {
        revisionListeners.delete(listener);
    };
}
