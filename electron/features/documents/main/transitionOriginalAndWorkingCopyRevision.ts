import type {TDocumentRevisionChangeReason} from '@contracts/documentRevision';
import {copyFileAtomic} from '@electron/file-access/documentFileWriteAtomic';
import {transitionWorkingCopyContentRevision} from '@electron/file-access/documentRevisionStore';
import {
    createOriginalTransitionBackupPath,
    recordWorkingCopyJournalOriginal,
    recoverWorkingCopyTransition,
    restoreTransitionOriginal,
    type IWorkingCopyJournal,
} from '@electron/file-access/workingCopyJournal';
import {captureIntendedContentFingerprint} from '@electron/file-access/workingCopyJournalOriginal';
import {withOriginalPathMutationLock} from '@electron/file-access/withOriginalPathMutationLock';
import {ensureWorkingCopyMaterialized} from '@electron/file-access/workingCopyMaterialization';
import {measureOperationPhase} from '@contracts/measureOperationPhase';
import {
    assertPathMatchesSaveWitnessSnapshot, type IOriginalPathSaveWitness,
} from '@electron/file-access/originalPathSaveWitness';
import {OriginalPathSaveConflictError} from '@electron/file-access/originalPathSnapshot';
import {explainWriteRefusal} from '@electron/file-access/explainWriteRefusal';
import {supersedeClosedWorkingCopyJournals} from '@electron/file-access/workingCopyCleanup';

export async function transitionOriginalAndWorkingCopyRevision(input: {
    workingCopyPath: string;
    originalPath: string;
    reason: TDocumentRevisionChangeReason;
    senderId?: number;
    signal?: AbortSignal;
    captureOriginalWitness: () => Promise<IOriginalPathSaveWitness | null>;
    publishOriginal: (assertDestinationCurrent: () => Promise<void>, destinationBackupPath: string) => Promise<void>;
    stagePublication: (backupPath: string) => Promise<{path: string} & {contentFingerprint?: string}>;
    refreshOriginalExpectation?: (expected: ReturnType<IOriginalPathSaveWitness['getOriginalFileExpectation']>) => Promise<void>;
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
        // An interrupted save is finished first: a PDF that cannot be restored yet refuses this save with its cause.
        const pending = await recoverWorkingCopyTransition(input.workingCopyPath);
        if (pending instanceof Error) throw pending;
        const witness = await measurePhase('transition-admit-original', input.captureOriginalWitness);
        input.signal?.throwIfAborted();
        if (!witness) {
            return null;
        }
        const admittedExpectation = witness.getOriginalFileExpectation();
        // The person saves the PDF they see, which ends what a closed document's interrupted save of it had to undo.
        await supersedeClosedWorkingCopyJournals(input.originalPath);
        const originalBackupPath = createOriginalTransitionBackupPath(input.originalPath, input.workingCopyPath);
        let journal = null as IWorkingCopyJournal | null;
        try {
            return await transitionWorkingCopyContentRevision(
                input.workingCopyPath,
                input.reason,
                async (_nextRevision, transitionJournal) => {
                    journal = transitionJournal;
                    const original = {
                        path: input.originalPath,
                        backupPath: originalBackupPath,
                        state: 'prepared' as const,
                        preparedSnapshot: witness.getSnapshotForJournal(),
                        intendedFingerprint: undefined as string | undefined,
                    };
                    await recordWorkingCopyJournalOriginal(transitionJournal, original);
                    const staged = await measurePhase('transition-stage-publication', () => input.stagePublication(originalBackupPath));
                    original.intendedFingerprint = staged.contentFingerprint ?? await captureIntendedContentFingerprint(staged.path, input.signal);
                    await recordWorkingCopyJournalOriginal(transitionJournal, original);
                    await measurePhase('transition-rebase-original-witness-after-working-backup',
                        async () => witness.rebaseOnUnchangedContent(undefined, input.signal));
                    await measurePhase('transition-publish-original', () =>
                        input.publishOriginal(async () => {
                            await witness.assertCurrent();
                            input.signal?.throwIfAborted();
                        }, originalBackupPath));
                    try {
                        await assertPathMatchesSaveWitnessSnapshot(originalBackupPath, original.preparedSnapshot, {contentOnly: true});
                        await measurePhase('transition-rebase-original-witness-after-publish',
                            async () => witness.rebaseAfterPublish(original.intendedFingerprint!));
                        await measurePhase('transition-journal-original-published', () =>
                            recordWorkingCopyJournalOriginal(transitionJournal, {
                                ...original,
                                state: 'published',
                                publishedSnapshot: witness.getSnapshotForJournal(),
                            }));
                        await measurePhase('transition-sync-working-copy', () =>
                            copyFileAtomic(input.originalPath, input.workingCopyPath, {onPhase: (phase, durationMs) => input.onPhase?.(
                                `transition-sync-working-copy-${phase}`,
                                durationMs,
                            )}));
                        await measurePhase('transition-rebase-original-witness-after-working-sync',
                            async () => witness.assertCurrent({allowBackupMetadataChange: true}));
                        await measurePhase('transition-after-working-copy-sync', async () =>
                            input.refreshOriginalExpectation?.(witness.getOriginalFileExpectation()));
                    } catch (error) {
                        if (error instanceof OriginalPathSaveConflictError) await recordWorkingCopyJournalOriginal(transitionJournal, Object.assign(transitionJournal.original!, {state: 'conflicted' as const}));
                        throw error;
                    }
                },
                input.senderId,
                input.onPhase,
                'hard-link',
            );
        } catch (error) {
            try {
                if (journal?.original && (journal.original.state === 'prepared' || journal.original.state === 'published')) {
                    await restoreTransitionOriginal(journal, journal.original);
                    await recordWorkingCopyJournalOriginal(journal, Object.assign(journal.original, {state: 'restored' as const}))
                        .finally(() => input.refreshOriginalExpectation?.(admittedExpectation));
                }
            } finally {
                if (!journal?.original || journal.original.state === 'restored' || journal.original.state === 'conflicted') {
                    // Recovery owns the journaled backups and keeps failed rollbacks.
                    await (journal && recoverWorkingCopyTransition(input.workingCopyPath).catch(() => undefined));
                }
            }
            if (error instanceof OriginalPathSaveConflictError && journal?.original) {
                if (journal.original.state === 'conflicted') throw new OriginalPathSaveConflictError(journal.original.backupPath);
                return null;
            }
            throw error;
        }
    }).catch(async (error: unknown) => {
        // Only once the save has rolled back can a refusal tell a read-only PDF from an unwritable folder.
        throw await explainWriteRefusal(error, input.originalPath);
    });
}
