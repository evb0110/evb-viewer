import {randomUUID} from 'node:crypto';
import {
    open as openFileHandle,
    rm,
    stat,
} from 'node:fs/promises';
import { isRecord } from '@contracts/runtimeGuards';
import {
    requireDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {readWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {
    copyFileAtomic,
    linkOrCopyFileDurably,
    writeFileAtomic,
} from '@electron/file-access/documentFileWriteAtomic';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import {measureOperationPhase} from '@contracts/measureOperationPhase';
import {
    invalidDocumentRecoveryJournal,
    readDocumentRecoveryJournal,
} from '@electron/file-access/documentRecoveryJournal';

const log = createLogger('workingCopyContentTransitionJournal');

export type TWorkingCopyContentBackupMode = 'copy-on-write' | 'hard-link' | 'append';

type TContentTransitionJournalBackupMode = 'copy' | 'append-hard-link';

interface IWorkingCopyContentTransitionJournal {
    version: 1;
    state: 'prepared';
    workingCopyPath: string;
    backupPath: string;
    nextRevisionToken: TDocumentRevisionToken;
    backupMode: TContentTransitionJournalBackupMode;
    previousLength?: number;
}

function journalPathFor(workingCopyPath: string) {
    return `${workingCopyPath}.evb-content-transition.json`;
}

async function writeJsonAtomic(path: string, value: unknown) {
    await writeFileAtomic(path, Buffer.from(JSON.stringify(value), 'utf8'));
}

function parseJournal(value: unknown): IWorkingCopyContentTransitionJournal | null {
    if (
        !isRecord(value)
        || value.version !== 1
        || value.state !== 'prepared'
        || typeof value.workingCopyPath !== 'string'
        || typeof value.backupPath !== 'string'
        || typeof value.nextRevisionToken !== 'string'
    ) {
        return null;
    }
    const backupMode = value.backupMode === undefined
        ? 'copy' as const
        : value.backupMode === 'copy' || value.backupMode === 'append-hard-link'
            ? value.backupMode
            : null;
    if (backupMode === null) {
        return null;
    }
    let previousLength: number | undefined;
    if (backupMode === 'append-hard-link') {
        const storedPreviousLength = value.previousLength;
        if (
            typeof storedPreviousLength !== 'number'
            || !Number.isSafeInteger(storedPreviousLength)
            || storedPreviousLength < 0
        ) {
            return null;
        }
        previousLength = storedPreviousLength;
    }
    return {
        version: 1,
        state: 'prepared',
        workingCopyPath: value.workingCopyPath,
        backupPath: value.backupPath,
        nextRevisionToken: requireDocumentRevisionToken(value.nextRevisionToken),
        backupMode,
        ...(previousLength === undefined ? {} : {previousLength}),
    };
}

export async function prepareWorkingCopyContentTransition(
    workingCopyPath: string,
    nextRevisionToken: TDocumentRevisionToken,
    onPhase?: (phase: string, durationMs: number) => void,
    backupMode: TWorkingCopyContentBackupMode = 'copy-on-write',
) {
    await measureContentTransitionPhase('content-recover', onPhase, () =>
        recoverWorkingCopyContentTransition(workingCopyPath));
    const suffix = `${process.pid}-${randomUUID()}`;
    const backupPath = `${workingCopyPath}.evb-content-${suffix}.bak`;
    const appendSourceStat = backupMode === 'append'
        ? await stat(workingCopyPath)
        : null;
    await measureContentTransitionPhase('content-backup-pdf', onPhase, () => backupMode === 'copy-on-write'
        ? copyFileAtomic(workingCopyPath, backupPath)
        : linkOrCopyFileDurably(workingCopyPath, backupPath));
    const appendBackupStat = backupMode === 'append'
        ? await stat(backupPath)
        : null;
    const appendHardLink = backupMode === 'append'
        && appendSourceStat !== null
        && appendBackupStat !== null
        && Number.isSafeInteger(appendSourceStat.size)
        && appendSourceStat.dev === appendBackupStat.dev
        && appendSourceStat.ino === appendBackupStat.ino;
    const journal: IWorkingCopyContentTransitionJournal = {
        version: 1,
        state: 'prepared',
        workingCopyPath,
        backupPath,
        nextRevisionToken,
        backupMode: appendHardLink ? 'append-hard-link' : 'copy',
        ...(appendHardLink && appendSourceStat !== null
            ? {previousLength: appendSourceStat.size}
            : {}),
    };
    await measureContentTransitionPhase('content-write-journal', onPhase, () =>
        writeJsonAtomic(journalPathFor(workingCopyPath), journal));
    return journal;
}

async function truncateWorkingCopy(workingCopyPath: string, length: number) {
    const handle = await openFileHandle(workingCopyPath, 'r+');
    try {
        await handle.truncate(length);
        await handle.sync();
    } finally {
        await handle.close().catch(() => undefined);
    }
}

async function restoreWorkingCopyContent(
    journal: IWorkingCopyContentTransitionJournal,
) {
    const appendedLength = journal.backupMode === 'append-hard-link'
        ? journal.previousLength
        : undefined;
    if (appendedLength !== undefined) {
        const stats = await Promise.all([
            stat(journal.workingCopyPath),
            stat(journal.backupPath),
        ]).catch(() => null);
        const [
            workingCopyStat,
            backupStat,
        ] = stats ?? [];
        if (
            workingCopyStat !== undefined
            && backupStat !== undefined
            && workingCopyStat.dev === backupStat.dev
            && workingCopyStat.ino === backupStat.ino
        ) {
            await truncateWorkingCopy(journal.workingCopyPath, appendedLength);
            return;
        }
    }
    await copyFileAtomic(journal.backupPath, journal.workingCopyPath);
    if (appendedLength !== undefined) {
        // The backup is a hard link to the appended file, so the copy carries
        // the append too; cut it back to the recorded pre-append length.
        await truncateWorkingCopy(journal.workingCopyPath, appendedLength);
    }
}

async function measureContentTransitionPhase<T>(
    phase: string,
    onPhase: ((phase: string, durationMs: number) => void) | undefined,
    operation: () => Promise<T>,
): Promise<T> {
    return measureOperationPhase(operation, durationMs => {
        try { onPhase?.(phase, durationMs); }
        catch (error) { log.warn(`Content transition phase reporter failed: ${getErrorMessage(error)}`); }
    });
}

export async function rollbackWorkingCopyContentTransition(
    journal: IWorkingCopyContentTransitionJournal,
) {
    await restoreWorkingCopyContent(journal);
    await completeWorkingCopyContentTransition(journal);
}

export async function completeWorkingCopyContentTransition(
    journal: IWorkingCopyContentTransitionJournal,
) {
    await Promise.all([
        rm(journal.backupPath, {force: true}),
        rm(journalPathFor(journal.workingCopyPath), {force: true}),
    ]);
}

/**
 * A prepared transition is committed only when its exact revision token is
 * already public. Otherwise the old bytes win. This closes both crash windows:
 * content-before-revision and revision-before-journal-cleanup.
 */
export async function recoverWorkingCopyContentTransition(workingCopyPath: string) {
    const journalPath = journalPathFor(workingCopyPath);
    const value = await readDocumentRecoveryJournal(journalPath);
    if (value === undefined) {
        return false;
    }
    const journal = parseJournal(value);
    if (!journal) {
        throw invalidDocumentRecoveryJournal(journalPath);
    }
    if (journal.workingCopyPath !== workingCopyPath) {
        throw new Error('Working-copy content transition journal targets another document');
    }
    const revision = await readWorkingCopyRevisionSidecar(workingCopyPath);
    if (revision?.token !== journal.nextRevisionToken) {
        await restoreWorkingCopyContent(journal);
    }
    await completeWorkingCopyContentTransition(journal);
    return true;
}
