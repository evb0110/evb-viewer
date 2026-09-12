import {
    link,
    rm,
} from 'node:fs/promises';
import {isRecord} from '@contracts/runtimeGuards';
import {copyFileAtomic} from '@electron/file-access/documentFileWriteAtomic';
import {readWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {
    assertPathMatchesSaveWitnessSnapshot,
    capturePathSaveWitness,
    type IOriginalPathSaveJournalSnapshot,
    OriginalPathSaveConflictError,
} from '@electron/file-access/originalPathSaveWitness';
import {
    invalidDocumentRecoveryJournal,
    readDocumentRecoveryJournal,
} from '@electron/file-access/documentRecoveryJournal';

function journalPath(workingCopyPath: string) {
    return `${workingCopyPath}.evb-two-target-transition.json`;
}

function parseJournalSnapshot(value: unknown, journalPath: string) {
    if (value === undefined) {
        return undefined;
    }
    if (
        !value
        || typeof value !== 'object'
        || [
            'ctimeNs',
            'deviceId',
            'inode',
            'linkCount',
            'mtimeNs',
            'sampleSha256',
            'size',
        ].some(name => typeof (value as Record<string, unknown>)[name] !== 'string')
    ) {
        throw invalidDocumentRecoveryJournal(
            journalPath,
            undefined,
            'Invalid two-target document transition journal',
        );
    }
    return value as IOriginalPathSaveJournalSnapshot;
}

export async function recoverTwoTargetDocumentTransition(workingCopyPath: string) {
    const path = journalPath(workingCopyPath);
    const value = await readDocumentRecoveryJournal(path);
    if (value === undefined) {
        return false;
    }
    if (!isRecord(value)) {
        throw invalidDocumentRecoveryJournal(
            path,
            undefined,
            'Invalid two-target document transition journal',
        );
    }
    if (
        value.version !== 1
        || (value.state !== 'prepared' && value.state !== 'original-committed')
        || value.workingCopyPath !== workingCopyPath
        || typeof value.originalPath !== 'string'
        || typeof value.originalBackupPath !== 'string'
        || typeof value.nextRevisionToken !== 'string'
    ) {
        throw invalidDocumentRecoveryJournal(path);
    }
    const preparedOriginalSnapshot = parseJournalSnapshot(value.preparedOriginalSnapshot, path);
    const publishedOriginalSnapshot = parseJournalSnapshot(value.publishedOriginalSnapshot, path);
    const revision = await readWorkingCopyRevisionSidecar(workingCopyPath);
    if (revision?.token !== value.nextRevisionToken) {
        const expectedOriginalSnapshot = value.state === 'prepared'
            ? preparedOriginalSnapshot
            : publishedOriginalSnapshot;
        if (expectedOriginalSnapshot !== undefined) {
            try {
                await assertPathMatchesSaveWitnessSnapshot(value.originalPath, expectedOriginalSnapshot);
            } catch (error) {
                // A Windows fallback can be interrupted after it moves the
                // original aside. In that state there is no live destination
                // witness. Restore only when the journaled backup itself is
                // the exact pre-publication file, and create the destination
                // exclusively so a third-party replacement wins the race.
                const missingDestination = await capturePathSaveWitness(value.originalPath) === null;
                if (!missingDestination) {
                    throw error;
                }
                const backupSnapshot = preparedOriginalSnapshot ?? expectedOriginalSnapshot;
                await assertPathMatchesSaveWitnessSnapshot(value.originalBackupPath, backupSnapshot, {contentOnly: true});
                await link(value.originalBackupPath, value.originalPath);
                await Promise.all([
                    rm(value.originalBackupPath, {force: true}),
                    rm(path, {force: true}),
                ]);
                return true;
            }
        }
        const witness = await capturePathSaveWitness(value.originalPath);
        if (!witness) {
            throw new OriginalPathSaveConflictError();
        }
        try {
            await copyFileAtomic(value.originalBackupPath, value.originalPath, {assertDestinationCurrent: () => witness.assertCurrent()});
        } finally {
            await witness.close();
        }
    }
    await Promise.all([
        rm(value.originalBackupPath, {force: true}),
        rm(path, {force: true}),
    ]);
    return true;
}
