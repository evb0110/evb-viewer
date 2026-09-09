import { randomUUID } from 'node:crypto';
import {
    existsSync,
    statSync,
} from 'fs';
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
    getWorkingCopyOwnerWebContentsId,
    getWorkingCopyRegistrationId,
    normalizePathForLookup,
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
import {recoverTwoTargetDocumentTransition} from '@electron/file-access/recoverTwoTargetDocumentTransition';
import {measureOperationPhase} from '@contracts/measureOperationPhase';
import {
    getPageIdentitySidecarPath,
    quarantinePageIdentitySidecar,
    rebasePageIdentitySidecarRevision,
} from '@electron/file-access/rebasePageIdentitySidecarRevision';

const log = createLogger('documentRevisionStore');
const revisionListeners = new Set<(event: IDocumentRevisionChangedEvent) => void>();
const workingCopySyncRequired = new Map<string, string>();
interface IProvisionalWorkingCopyRevision {
    durabilityPromise?: Promise<void>;
    sidecar: IWorkingCopyRevisionSidecar;
}
const provisionalWorkingCopyRevisions = new Map<string, IProvisionalWorkingCopyRevision>();

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
    if (workingCopySyncRequired.has(queueKey)) {
        return workingCopySyncRequired.get(queueKey);
    }

    const pendingSync = readWorkingCopySyncRequiredJournalEntry(workingCopyPath);
    if (!pendingSync) {
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
    await recoverTwoTargetDocumentTransition(normalizedWorkingPath);
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
export async function transitionWorkingCopyContentRevision(
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

    const event: IDocumentRevisionChangedEvent = {
        ...toRevisionInfo(sidecar),
        ...(previous?.token ? {previousToken: previous.token} : {}),
        reason,
    };
    notifyRevisionChanged(event);
    return event;
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
        .then(sidecar => sidecar?.token === token);
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
}

export function hasWorkingCopySyncRequired(workingCopyPath: string) {
    return hydrateWorkingCopySyncRequiredFromJournal(workingCopyPath) !== undefined;
}

export function assertWorkingCopyResyncAllowed(workingCopyPath: string, senderId?: number) {
    assertCanUseWorkingCopyRevision(workingCopyPath, senderId);
}

export function markWorkingCopySyncRequired(workingCopyPath: string, reason: string) {
    const normalizedWorkingPath = typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '';
    const activeEntry = normalizedWorkingPath ? workingCopyMap.get(normalizedWorkingPath) : undefined;
    workingCopySyncRequired.set(
        getRevisionQueueKey(workingCopyPath),
        reason,
    );
    if (!normalizedWorkingPath) {
        return;
    }
    try {
        writeWorkingCopySyncRequiredJournalEntry(normalizedWorkingPath, {
            reason,
            ...(activeEntry?.originalPath === undefined ? {} : {originalPath: activeEntry.originalPath}),
            ...(activeEntry?.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: activeEntry.ownerWebContentsId}),
        });
    } catch (error) {
        log.debug(`Failed to persist working-copy sync-required journal entry: ${getErrorMessage(error)}`);
    }
}

export function clearWorkingCopySyncRequired(workingCopyPath: string) {
    workingCopySyncRequired.delete(getRevisionQueueKey(workingCopyPath));
    try {
        clearWorkingCopySyncRequiredJournalEntry(workingCopyPath);
    } catch (error) {
        log.debug(`Failed to clear working-copy sync-required journal entry: ${getErrorMessage(error)}`);
    }
}

export function onWorkingCopyRevisionChanged(listener: (event: IDocumentRevisionChangedEvent) => void) {
    revisionListeners.add(listener);
    return () => {
        revisionListeners.delete(listener);
    };
}
