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
import {
    OriginalPathSaveConflictError,
    type IOriginalPathSaveWitness,
} from '@electron/file-access/originalPathSaveWitness';

function journalPath(workingCopyPath: string) {
    return `${workingCopyPath}.evb-two-target-transition.json`;
}

async function writeJournal(path: string, value: unknown) {
    await writeFileAtomic(path, Buffer.from(JSON.stringify(value), 'utf8'));
}

async function measureTransitionPhase<T>(
    phase: string,
    onPhase: ((phase: string, durationMs: number) => void) | undefined,
    operation: () => Promise<T>,
): Promise<T> {
    return measureOperationPhase(operation, durationMs => onPhase?.(phase, durationMs));
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
    onPhase?: (phase: string, durationMs: number) => void;
}) {
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
        if (input.captureOriginalWitness && !witness) {
            return null;
        }
        const suffix = `${process.pid}-${randomUUID()}`;
        const originalBackupPath = `${input.originalPath}.evb-transition-${suffix}.bak`;
        let backupCreated = false as boolean;
        let committed = false as boolean;
        let shouldRestoreOriginal = false as boolean;
        let originalRestoredByRollback = false as boolean;
        try {
            const previousRevision = await measureTransitionPhase(
                'transition-read-revision',
                input.onPhase,
                () => readWorkingCopyRevisionSidecar(input.workingCopyPath),
            );
            try {
                await measureTransitionPhase('transition-backup-original', input.onPhase, () =>
                    linkOrCopyFileDurably(input.originalPath, originalBackupPath));
            } catch (error) {
                await witness?.assertCurrent();
                throw error;
            }
            backupCreated = true;
            await measureTransitionPhase('transition-rebase-original-witness', input.onPhase, async () =>
                witness?.rebaseAfterBackup());
            const event = await transitionWorkingCopyContentRevision(
                input.workingCopyPath,
                input.reason,
                async nextRevision => {
                    const record = {
                        version: 1,
                        state: 'prepared',
                        workingCopyPath: input.workingCopyPath,
                        originalPath: input.originalPath,
                        originalBackupPath,
                        nextRevisionToken: nextRevision.token,
                        ...(witness === null ? {} : {preparedOriginalSnapshot: witness.getSnapshotForJournal()}),
                    } as const;
                    await measureTransitionPhase('transition-journal-prepared', input.onPhase, () =>
                        writeJournal(journalPath(input.workingCopyPath), record));
                    await measureTransitionPhase(
                        'transition-rebase-original-witness-after-working-backup',
                        input.onPhase,
                        async () => witness?.rebaseAfterBackup(),
                    );
                    shouldRestoreOriginal = true;
                    await measureTransitionPhase('transition-publish-original', input.onPhase, () =>
                        input.publishOriginal(witness ? () => witness.assertCurrent() : undefined));
                    await measureTransitionPhase(
                        'transition-rebase-original-witness-after-publish',
                        input.onPhase,
                        async () => witness?.rebaseAfterPublish(),
                    );
                    await measureTransitionPhase('transition-journal-original-committed', input.onPhase, () =>
                        writeJournal(journalPath(input.workingCopyPath), {
                            ...record,
                            state: 'original-committed',
                            ...(witness === null ? {} : {publishedOriginalSnapshot: witness.getSnapshotForJournal()}),
                        }));
                    await measureTransitionPhase('transition-sync-working-copy', input.onPhase, () =>
                        copyFileAtomic(input.originalPath, input.workingCopyPath, {
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
                },
                input.senderId,
                input.onPhase,
                'hard-link',
            );
            committed = true;
            shouldRestoreOriginal = false;
            await measureTransitionPhase('transition-cleanup', input.onPhase, () => Promise.all([
                rm(originalBackupPath, {force: true}),
                rm(journalPath(input.workingCopyPath), {force: true}),
            ])).catch(() => undefined);
            return event;
        } catch (error) {
            if (error instanceof OriginalPathSaveConflictError) {
                shouldRestoreOriginal = false;
                return null;
            }
            throw error;
        } finally {
            let originalRestored = !shouldRestoreOriginal;
            try {
                if (!committed && shouldRestoreOriginal && backupCreated) {
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
                        if (!committed && originalRestored) {
                            await Promise.all([
                                rm(originalBackupPath, {force: true}),
                                rm(journalPath(input.workingCopyPath), {force: true}),
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
