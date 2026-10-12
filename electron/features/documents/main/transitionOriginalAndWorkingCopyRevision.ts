import {rm} from 'node:fs/promises';
import type {TDocumentRevisionChangeReason} from '@contracts/documentRevision';
import {copyFileAtomic} from '@electron/file-access/documentFileWriteAtomic';
import {linkOriginalBackup} from '@electron/file-access/linkOriginalBackup';
import {transitionWorkingCopyContentRevision} from '@electron/file-access/documentRevisionStore';
import {
    createOriginalTransitionBackupPath,
    recordWorkingCopyJournalOriginal,
    recoverWorkingCopyTransition,
    type IWorkingCopyJournal,
} from '@electron/file-access/workingCopyJournal';
import {
    captureIntendedContentFingerprint, restoreOriginal,
} from '@electron/file-access/workingCopyJournalOriginal';
import {withOriginalPathMutationLock} from '@electron/file-access/withOriginalPathMutationLock';
import {ensureWorkingCopyMaterialized} from '@electron/file-access/workingCopyMaterialization';
import {measureOperationPhase} from '@contracts/measureOperationPhase';
import {
    assertPathMatchesSaveWitnessSnapshot, type IOriginalPathSaveWitness,
} from '@electron/file-access/originalPathSaveWitness';
import {OriginalPathSaveConflictError} from '@electron/file-access/originalPathSnapshot';

export async function transitionOriginalAndWorkingCopyRevision(input: {
    workingCopyPath: string;
    originalPath: string;
    reason: TDocumentRevisionChangeReason;
    senderId?: number;
    signal?: AbortSignal;
    captureOriginalWitness?: () => Promise<IOriginalPathSaveWitness | null>;
    publishOriginal: (assertDestinationCurrent?: () => Promise<void>, destinationBackupPath?: string) => Promise<void>;
    publishedSourcePath: string;
    afterWorkingCopySync?: (originalFileExpectation?: ReturnType<IOriginalPathSaveWitness['getOriginalFileExpectation']>) => Promise<void>;
    afterOriginalRestore?: () => Promise<void>;
    onPhase?: (phase: string, durationMs: number) => void;
}) {
    const measurePhase = <T>(phase: string, operation: () => Promise<T>) =>
        measureOperationPhase(operation, durationMs => input.onPhase?.(phase, durationMs));
    await measurePhase('transition-materialize', () =>
        ensureWorkingCopyMaterialized(input.workingCopyPath, {
            ...(input.senderId === undefined ? {} : {ownerWebContentsId: input.senderId}),
            reason: 'first-mutation',
        }));
    return withOriginalPathMutationLock(input.originalPath, async () => {
        const witness = input.captureOriginalWitness
            ? await measurePhase('transition-admit-original', input.captureOriginalWitness)
            : null;
        input.signal?.throwIfAborted();
        if (input.captureOriginalWitness && !witness) {
            return null;
        }
        const originalBackupPath = createOriginalTransitionBackupPath(input.originalPath, input.workingCopyPath);
        let committed = false as boolean;
        let journal = null as IWorkingCopyJournal | null;
        try {
            await measurePhase('transition-backup-original', () =>
                linkOriginalBackup(witness, input.originalPath, originalBackupPath));
            await measurePhase('transition-rebase-original-witness', async () =>
                witness?.rebaseOnUnchangedContent(undefined, input.signal));
            const event = await transitionWorkingCopyContentRevision(
                input.workingCopyPath,
                input.reason,
                async (_nextRevision, transitionJournal) => {
                    journal = transitionJournal;
                    const original = {
                        path: input.originalPath,
                        backupPath: originalBackupPath,
                        state: 'prepared',
                        ...(witness === null ? {} : {preparedSnapshot: witness.getSnapshotForJournal()}),
                        ...(witness === null ? {} : {intendedFingerprint: await captureIntendedContentFingerprint(input.publishedSourcePath, input.signal)}),
                    } as const;
                    await measurePhase('transition-journal-prepared', () =>
                        recordWorkingCopyJournalOriginal(transitionJournal, original));
                    await measurePhase('transition-rebase-original-witness-after-working-backup',
                        async () => witness?.rebaseOnUnchangedContent(undefined, input.signal));
                    await measurePhase('transition-publish-original', () =>
                        input.publishOriginal(witness ? async () => {
                            input.signal?.throwIfAborted();
                            await witness.assertCurrent();
                            input.signal?.throwIfAborted();
                        } : undefined, witness ? originalBackupPath : undefined));
                    try {
                        if (witness) await assertPathMatchesSaveWitnessSnapshot(originalBackupPath, original.preparedSnapshot!, {contentOnly: true});
                        await measurePhase('transition-rebase-original-witness-after-publish',
                            async () => witness?.rebaseAfterPublish(original.intendedFingerprint!, transitionJournal.backupPath));
                        await measurePhase('transition-journal-original-published', () =>
                            recordWorkingCopyJournalOriginal(transitionJournal, {
                                ...original,
                                state: 'published',
                                ...(witness === null ? {} : {publishedSnapshot: witness.getSnapshotForJournal()}),
                            }));
                        await measurePhase('transition-sync-working-copy', () =>
                            copyFileAtomic(input.originalPath, input.workingCopyPath, {onPhase: (phase, durationMs) => input.onPhase?.(
                                `transition-sync-working-copy-${phase}`,
                                durationMs,
                            )}));
                        await measurePhase('transition-rebase-original-witness-after-working-sync',
                            async () => witness?.assertCurrent({allowBackupMetadataChange: true}));
                        await measurePhase('transition-after-working-copy-sync', async () =>
                            input.afterWorkingCopySync?.(witness?.getOriginalFileExpectation()));
                    } catch (error) {
                        if (error instanceof OriginalPathSaveConflictError) await recordWorkingCopyJournalOriginal(transitionJournal, {
                            ...transitionJournal.original!,
                            state: 'conflicted',
                        });
                        throw error;
                    }
                },
                input.senderId,
                input.onPhase,
                'hard-link',
            );
            committed = true;
            return event;
        } catch (error) {
            if (error instanceof OriginalPathSaveConflictError) {
                if (journal?.original) {
                    if (journal.original.state === 'conflicted') throw new OriginalPathSaveConflictError(error.keptFilePath
                        ?? (journal.original.publishedSnapshot ? journal.backupPath : journal.original.backupPath));
                    await recordWorkingCopyJournalOriginal(journal, {
                        ...journal.original,
                        state: 'restored',
                    });
                }
                return null;
            }
            throw error;
        } finally {
            try {
                if (!committed && journal?.original
                    && (journal.original.state === 'prepared' || journal.original.state === 'published')) {
                    await restoreOriginal(journal.original);
                    try {
                        await recordWorkingCopyJournalOriginal(journal, {
                            ...journal.original,
                            state: 'restored',
                        });
                    } finally {
                        await input.afterOriginalRestore?.();
                    }
                }
            } finally {
                if (!committed && (!journal?.original || journal.original.state === 'restored' || journal.original.state === 'conflicted')) {
                    // Recovery keeps failed rollbacks. An unjournaled backup is ours alone.
                    await (journal && recoverWorkingCopyTransition(input.workingCopyPath).catch(() => undefined));
                    await (journal?.original ? undefined : rm(originalBackupPath, {force: true}));
                }
            }
        }
    });
}
