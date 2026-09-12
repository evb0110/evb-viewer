import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import type {TDocumentRevisionChangeReason} from '@contracts/documentRevision';
import {
    copyFileAtomic,
    linkOrCopyFileDurably,
    writeFileAtomic,
} from '@electron/file-access/documentFileWriteAtomic';
import {transitionWorkingCopyContentRevision} from '@electron/file-access/documentRevisionStore';
import {withOriginalPathMutationLock} from '@electron/features/documents/main/withOriginalPathMutationLock';
import {readWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {rebindDocumentTextCatalogIfPresent} from '@electron/file-access/rebindDocumentTextCatalogIfPresent';
import {ensureWorkingCopyMaterialized} from '@electron/file-access/workingCopyMaterialization';
import {measureOperationPhase} from '@contracts/measureOperationPhase';
import {isErrnoException} from '@contracts/runtimeGuards';
import {getErrorMessage} from '@electron/utils/error';
import {
    OriginalPathSaveConflictError,
    type IOriginalPathSaveWitness,
} from '@electron/file-access/originalPathSaveWitness';
import {
    getTwoTargetTransitionJournalPath as journalPath,
    noteTwoTargetTransitionJournalCleared,
    noteTwoTargetTransitionJournalWritten,
} from '@electron/file-access/recoverTwoTargetDocumentTransition';

async function writeJournal(workingCopyPath: string, value: unknown) {
    await writeFileAtomic(journalPath(workingCopyPath), Buffer.from(JSON.stringify(value), 'utf8'));
    noteTwoTargetTransitionJournalWritten(workingCopyPath);
}

async function measureTransitionPhase<T>(
    phase: string,
    onPhase: ((phase: string, durationMs: number) => void) | undefined,
    operation: () => Promise<T>,
): Promise<T> {
    return measureOperationPhase(operation, durationMs => onPhase?.(phase, durationMs));
}

interface ISaveAsWorkingCopySyncFailure {
    targetWriteCommitted: true;
    workingCopyRefreshed: false;
    workingCopySyncError: string;
}

class SaveAsWorkingCopySyncFailure extends Error {
    public readonly fencePersisted: boolean;

    public constructor(error: unknown, fencePersisted: boolean) {
        super(getErrorMessage(error), {cause: error});
        this.name = 'SaveAsWorkingCopySyncFailure';
        this.fencePersisted = fencePersisted;
    }
}

export async function transitionOriginalAndWorkingCopyRevision(input: {
    workingCopyPath: string;
    originalPath: string;
    reason: TDocumentRevisionChangeReason;
    senderId?: number;
    captureOriginalWitness?: () => Promise<IOriginalPathSaveWitness | null>;
    publishOriginal: (assertDestinationCurrent?: () => Promise<void>) => Promise<void>;
    afterWorkingCopySync?: () => Promise<void>;
    afterOriginalRestore?: () => Promise<void>;
    afterOriginalPublish?: () => Promise<void>;
    syncWorkingCopy?: () => Promise<void>;
    onWorkingCopySyncFailure?: (error: unknown) => Promise<boolean> | boolean;
    allowMissingOriginalWitness?: boolean;
    preservePublishedOriginalOnWorkingCopySyncFailure?: boolean;
    useDestinationWitnessForPublication?: boolean;
    onPhase?: (phase: string, durationMs: number) => void;
}) {
    const preservePublishedTarget = input.preservePublishedOriginalOnWorkingCopySyncFailure === true;
    await measureTransitionPhase('transition-materialize', input.onPhase, () =>
        ensureWorkingCopyMaterialized(input.workingCopyPath, {
            ...(input.senderId === undefined ? {} : {ownerWebContentsId: input.senderId}),
            reason: 'first-mutation',
        }));
    return withOriginalPathMutationLock(input.originalPath, async () => {
        const witness = input.captureOriginalWitness
            ? await measureTransitionPhase(
                'transition-admit-original',
                input.onPhase,
                input.captureOriginalWitness,
            )
            : null;
        if (input.captureOriginalWitness && !witness && !input.allowMissingOriginalWitness) {
            return null;
        }
        const suffix = `${process.pid}-${randomUUID()}`;
        let originalBackupPath: string | null = `${input.originalPath}.evb-transition-${suffix}.bak`;
        let backupCreated = false as boolean;
        let committed = false as boolean;
        let shouldRestoreOriginal = false as boolean;
        let originalRestoredByRollback = false as boolean;
        let preserveRecoveryEvidence = false as boolean;
        let targetPublicationStarted = false as boolean;
        try {
            const previousRevision = await measureTransitionPhase(
                'transition-read-revision',
                input.onPhase,
                () => readWorkingCopyRevisionSidecar(input.workingCopyPath),
            );
            try {
                await measureTransitionPhase('transition-backup-original', input.onPhase, () =>
                    linkOrCopyFileDurably(input.originalPath, originalBackupPath!));
                backupCreated = true;
            } catch (error) {
                if (!preservePublishedTarget || (isErrnoException(error) && error.code === 'ENOENT')) {
                    if (!preservePublishedTarget) {
                        await witness?.assertCurrent();
                    }
                    originalBackupPath = null;
                } else {
                    await witness?.assertCurrent();
                    throw error;
                }
            }
            await measureTransitionPhase('transition-rebase-original-witness', input.onPhase, async () =>
                witness?.rebaseAfterBackup());
            const event = await transitionWorkingCopyContentRevision(
                input.workingCopyPath,
                input.reason,
                async nextRevision => {
                    const record = {
                        version: 1,
                        state: 'prepared',
                        ...(preservePublishedTarget ? {mode: 'save-as' as const} : {}),
                        workingCopyPath: input.workingCopyPath,
                        originalPath: input.originalPath,
                        originalBackupPath,
                        ...(preservePublishedTarget ? {originalExistedBefore: witness !== null || backupCreated} : {}),
                        ...(input.senderId === undefined ? {} : {ownerWebContentsId: input.senderId}),
                        nextRevisionToken: nextRevision.token,
                        ...(witness === null ? {} : {preparedOriginalSnapshot: witness.getSnapshotForJournal()}),
                    } as const;
                    await measureTransitionPhase('transition-journal-prepared', input.onPhase, () =>
                        writeJournal(input.workingCopyPath, record));
                    await measureTransitionPhase(
                        'transition-rebase-original-witness-after-working-backup',
                        input.onPhase,
                        async () => witness?.rebaseAfterBackup(),
                    );
                    shouldRestoreOriginal = !preservePublishedTarget;
                    targetPublicationStarted = true;
                    await measureTransitionPhase('transition-publish-original', input.onPhase, async () => {
                        await input.publishOriginal(
                            input.useDestinationWitnessForPublication === false || !witness
                                ? undefined
                                : () => witness.assertCurrent(),
                        );
                    });
                    await measureTransitionPhase(
                        'transition-rebase-original-witness-after-publish',
                        input.onPhase,
                        async () => witness?.rebaseAfterPublish(),
                    );
                    await measureTransitionPhase('transition-journal-original-committed', input.onPhase, () =>
                        writeJournal(input.workingCopyPath, {
                            ...record,
                            state: 'original-committed',
                            ...(witness === null ? {} : {publishedOriginalSnapshot: witness.getSnapshotForJournal()}),
                        }));
                    try {
                        await measureTransitionPhase('transition-after-original-publish', input.onPhase, async () => {
                            if (input.afterOriginalPublish) {
                                await input.afterOriginalPublish();
                            }
                        });
                        await measureTransitionPhase('transition-sync-working-copy', input.onPhase, () =>
                            input.syncWorkingCopy
                                ? input.syncWorkingCopy()
                                : copyFileAtomic(input.originalPath, input.workingCopyPath, {
                                    // The published original is immutable from the app's point of view.
                                    // Working-copy writers must keep staging a sibling and renaming it.
                                    linkImmutableSource: true,
                                    onPhase: (phase, durationMs) => input.onPhase?.(
                                        `transition-sync-working-copy-${phase}`,
                                        durationMs,
                                    ),
                                }));
                        await measureTransitionPhase(
                            'transition-rebase-original-witness-after-working-sync',
                            input.onPhase,
                            async () => witness?.assertCurrent({allowBackupMetadataChange: true}),
                        );
                        await measureTransitionPhase('transition-rebind-ocr', input.onPhase, () =>
                            rebindDocumentTextCatalogIfPresent(
                                input.workingCopyPath,
                                previousRevision?.token,
                                nextRevision.token,
                            ));
                        if (input.afterWorkingCopySync) {
                            await measureTransitionPhase(
                                'transition-after-working-copy-sync',
                                input.onPhase,
                                input.afterWorkingCopySync,
                            );
                        }
                    } catch (error) {
                        if (!preservePublishedTarget) {
                            throw error;
                        }
                        const fencePersisted = await input.onWorkingCopySyncFailure?.(error) ?? false;
                        await measureTransitionPhase('transition-journal-sync-required', input.onPhase, () =>
                            writeJournal(input.workingCopyPath, {
                                ...record,
                                state: 'sync-required',
                                syncRequiredReason: getErrorMessage(error),
                                ...(witness === null ? {} : {publishedOriginalSnapshot: witness.getSnapshotForJournal()}),
                            })).catch(() => undefined);
                        throw new SaveAsWorkingCopySyncFailure(error, fencePersisted);
                    }
                },
                input.senderId,
                input.onPhase,
                'hard-link',
            );
            committed = true;
            shouldRestoreOriginal = false;
            return event;
        } catch (error) {
            if (error instanceof SaveAsWorkingCopySyncFailure) {
                committed = true;
                shouldRestoreOriginal = false;
                preserveRecoveryEvidence = !error.fencePersisted;
                return {
                    targetWriteCommitted: true,
                    workingCopyRefreshed: false,
                    workingCopySyncError: error.message,
                } satisfies ISaveAsWorkingCopySyncFailure;
            }
            if (preservePublishedTarget && targetPublicationStarted) {
                preserveRecoveryEvidence = true;
            }
            if (error instanceof OriginalPathSaveConflictError) {
                shouldRestoreOriginal = false;
                return null;
            }
            throw error;
        } finally {
            let originalRestored = !shouldRestoreOriginal;
            try {
                if (!committed && shouldRestoreOriginal && backupCreated && originalBackupPath) {
                    const restoreOptions = witness === null
                        ? {}
                        : {assertDestinationCurrent: () => witness.assertCurrent({allowBackupMetadataChange: true})};
                    await copyFileAtomic(originalBackupPath, input.originalPath, restoreOptions);
                    originalRestored = true;
                    originalRestoredByRollback = true;
                }
            } finally {
                try {
                    if (originalRestoredByRollback) {
                        await input.afterOriginalRestore?.();
                    }
                } finally {
                    try {
                        if ((!committed && originalRestored || committed) && !preserveRecoveryEvidence) {
                            await Promise.all([
                                ...(originalBackupPath ? [rm(originalBackupPath, {force: true})] : []),
                                rm(journalPath(input.workingCopyPath), {force: true})
                                    .then(() => noteTwoTargetTransitionJournalCleared(input.workingCopyPath)),
                            ]);
                        }
                    } finally {
                        await witness?.close();
                    }
                }
            }
        }
    });
}
