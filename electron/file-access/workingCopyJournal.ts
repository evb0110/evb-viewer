import {randomUUID} from 'node:crypto';
import {
    link,
    open as openFileHandle,
    readFile,
    readdir,
    rm,
    stat,
} from 'node:fs/promises';
import {
    basename,
    dirname,
    join,
} from 'node:path';
import {isErrnoException} from '@contracts/runtimeGuards';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {measureOperationPhase} from '@contracts/measureOperationPhase';
import {readWorkingCopyManifest} from '@electron/file-access/workingCopyManifest';
import {
    copyFileAtomic,
    linkOrCopyFileDurably,
} from '@electron/file-access/documentFileWriteAtomic';
import {
    assertPathMatchesSaveWitnessSnapshot,
    capturePathSaveWitness,
    OriginalPathSaveConflictError,
} from '@electron/file-access/originalPathSaveWitness';
import {
    getWorkingCopyJournalBackupPath,
    getWorkingCopyJournalPath,
} from '@electron/file-access/workingCopyDirectory';
import {writeJsonAtomic} from '@electron/utils/atomicReplace';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import * as v from 'valibot';

const log = createLogger('workingCopyJournal');

export type TWorkingCopyContentBackupMode = 'copy-on-write' | 'hard-link' | 'append';

/** The original file a save publishes in the same transition. */
const snapshotSchema = v.object({
    ctimeNs: v.string(),
    deviceId: v.string(),
    inode: v.string(),
    linkCount: v.string(),
    mtimeNs: v.string(),
    sampleSha256: v.string(),
    size: v.string(),
});

const originalSchema = v.object({
    path: v.string(),
    backupPath: v.string(),
    state: v.picklist([
        'prepared',
        'published',
    ]),
    preparedSnapshot: v.optional(snapshotSchema),
    publishedSnapshot: v.optional(snapshotSchema),
});

export type IWorkingCopyJournalOriginal = v.InferOutput<typeof originalSchema>;

/**
 * One write-ahead record per working-copy directory. `prepare` backs up the
 * document, the caller may publish an original, and the durable manifest
 * revision is the commit point: a journal whose next revision is already in
 * the manifest is finished, any other journal is rolled back.
 */
const journalRecordSchema = v.object({
    version: v.literal(1),
    workingCopyPath: v.string(),
    nextRevisionToken: v.pipe(v.string(), v.check(value => parseDocumentRevisionToken(value) !== null), v.transform(value => parseDocumentRevisionToken(value)!)),
    backupPath: v.string(),
    backupMode: v.picklist([
        'copy',
        'append-hard-link',
    ]),
    previousLength: v.optional(v.unknown()),
    original: v.optional(originalSchema),
});
// Copy-mode journals historically ignore an irrelevant previousLength field; the mode-dependent omission is a semantic normalization.
const journalSchema = v.pipe(
    journalRecordSchema,
    v.check(value => value.backupMode !== 'append-hard-link'
        || typeof value.previousLength === 'number' && Number.isSafeInteger(value.previousLength) && value.previousLength >= 0),
    v.transform(({
        previousLength, ...journal
    }) => ({
        ...journal,
        ...(journal.backupMode === 'append-hard-link' ? {previousLength: previousLength as number} : {}),
    })),
);

export type IWorkingCopyJournal = v.InferOutput<typeof journalSchema>;

function parseJournal(value: unknown, workingCopyPath: string): IWorkingCopyJournal | null {
    const result = v.safeParse(journalSchema, value, {abortEarly: true});
    if (!result.success || result.output.workingCopyPath !== workingCopyPath) {
        return null;
    }
    return result.output;
}

async function readJournal(workingCopyPath: string) {
    const journalPath = getWorkingCopyJournalPath(workingCopyPath);
    let raw: string;
    try {
        raw = await readFile(journalPath, 'utf8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw new Error(`Working-copy journal could not be read: ${journalPath}`, {cause: error});
    }
    let journal: IWorkingCopyJournal | null = null;
    try {
        journal = parseJournal(JSON.parse(raw), workingCopyPath);
    } catch {
        // Reported below.
    }
    if (!journal) {
        throw new Error(`Working-copy journal is invalid: ${journalPath}`);
    }
    return journal;
}

function writeJournal(journal: IWorkingCopyJournal) {
    return writeJsonAtomic(getWorkingCopyJournalPath(journal.workingCopyPath), journal, {markMutationCommitStarted: false});
}

async function measurePhase<T>(
    phase: string,
    onPhase: ((phase: string, durationMs: number) => void) | undefined,
    operation: () => Promise<T>,
): Promise<T> {
    return measureOperationPhase(operation, durationMs => {
        try { onPhase?.(phase, durationMs); }
        catch (error) { log.warn(`Working-copy journal phase reporter failed: ${getErrorMessage(error)}`); }
    });
}

export async function prepareWorkingCopyTransition(
    workingCopyPath: string,
    nextRevisionToken: TDocumentRevisionToken,
    onPhase?: (phase: string, durationMs: number) => void,
    backupMode: TWorkingCopyContentBackupMode = 'copy-on-write',
) {
    await measurePhase('content-recover', onPhase, () => recoverWorkingCopyTransition(workingCopyPath));
    const backupPath = getWorkingCopyJournalBackupPath(workingCopyPath, `${process.pid}-${randomUUID()}`);
    const appendSourceStat = backupMode === 'append' ? await stat(workingCopyPath) : null;
    await measurePhase('content-backup-pdf', onPhase, () => backupMode === 'copy-on-write'
        ? copyFileAtomic(workingCopyPath, backupPath)
        : linkOrCopyFileDurably(workingCopyPath, backupPath));
    const appendBackupStat = backupMode === 'append' ? await stat(backupPath) : null;
    const appendHardLink = appendSourceStat !== null
        && appendBackupStat !== null
        && Number.isSafeInteger(appendSourceStat.size)
        && appendSourceStat.dev === appendBackupStat.dev
        && appendSourceStat.ino === appendBackupStat.ino;
    const journal: IWorkingCopyJournal = {
        version: 1,
        workingCopyPath,
        nextRevisionToken,
        backupPath,
        backupMode: appendHardLink ? 'append-hard-link' : 'copy',
        ...(appendHardLink ? {previousLength: appendSourceStat.size} : {}),
    };
    await measurePhase('content-write-journal', onPhase, () => writeJournal(journal));
    return journal;
}

/** Records the original a transition publishes, before and after publication. */
export async function recordWorkingCopyJournalOriginal(
    journal: IWorkingCopyJournal,
    original: IWorkingCopyJournalOriginal,
) {
    journal.original = original;
    await writeJournal(journal);
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

async function restoreWorkingCopyContent(journal: IWorkingCopyJournal) {
    const appendedLength = journal.previousLength;
    if (appendedLength !== undefined) {
        const [
            workingCopyStat,
            backupStat,
        ] = await Promise.all([
            stat(journal.workingCopyPath),
            stat(journal.backupPath),
        ]).catch(() => []);
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

/**
 * Puts back the original of an interrupted transition. A crash can leave the
 * original as it was before publication, published, or (on the Windows
 * fallback) moved aside. Only an original that still matches the journaled
 * snapshot is overwritten, so a third-party replacement always wins.
 */
async function restoreOriginal(original: IWorkingCopyJournalOriginal) {
    const expectedSnapshot = original.state === 'prepared'
        ? original.preparedSnapshot
        : original.publishedSnapshot;
    if (expectedSnapshot !== undefined) {
        try {
            await assertPathMatchesSaveWitnessSnapshot(original.path, expectedSnapshot);
        } catch (error) {
            if (await capturePathSaveWitness(original.path) !== null) {
                throw error;
            }
            await assertPathMatchesSaveWitnessSnapshot(
                original.backupPath,
                original.preparedSnapshot ?? expectedSnapshot,
                {contentOnly: true},
            );
            // The link creates the destination only while it is still absent.
            await link(original.backupPath, original.path);
            return;
        }
    }
    const witness = await capturePathSaveWitness(original.path);
    if (!witness) {
        throw new OriginalPathSaveConflictError();
    }
    try {
        await copyFileAtomic(original.backupPath, original.path, {assertDestinationCurrent: () => witness.assertCurrent()});
    } finally {
        await witness.close();
    }
}

/**
 * Removes the journal, then every backup it named. A crash in between leaves
 * only an unreferenced backup, never a journal whose backup is gone.
 */
export async function completeWorkingCopyTransition(journal: IWorkingCopyJournal) {
    await rm(getWorkingCopyJournalPath(journal.workingCopyPath), {force: true});
    await Promise.all([
        rm(journal.backupPath, {force: true}),
        ...(journal.original ? [rm(journal.original.backupPath, {force: true})] : []),
    ]);
}

/**
 * Restores the document after a failed commit. A transition that also
 * published an original keeps its journal until the caller has restored that
 * original and completed the transition.
 */
export async function rollbackWorkingCopyTransition(journal: IWorkingCopyJournal) {
    await restoreWorkingCopyContent(journal);
    if (!journal.original) {
        await completeWorkingCopyTransition(journal);
    }
}

/**
 * Finishes the journal a crash left behind: kept when its revision is in the
 * manifest, rolled back otherwise. Unreadable journals fail closed.
 */
export async function recoverWorkingCopyTransition(workingCopyPath: string) {
    const journal = await readJournal(workingCopyPath);
    if (!journal) {
        return false;
    }
    const manifest = await readWorkingCopyManifest(workingCopyPath);
    if (manifest?.revision.token !== journal.nextRevisionToken) {
        if (journal.original) {
            await restoreOriginal(journal.original);
        }
        await restoreWorkingCopyContent(journal);
    }
    await completeWorkingCopyTransition(journal);
    return true;
}

/** Removes original backups a crash left before their journal named them. */
export async function sweepOrphanedOriginalBackups(originalPath: string, workingCopyPath: string) {
    // Recovery runs immediately before this sweep. Recheck the journal so a
    // transition that starts between those steps keeps its backup.
    if (await readJournal(workingCopyPath) !== null) {
        return;
    }
    const originalDirectory = dirname(originalPath);
    const backupPrefix = `${basename(originalPath)}.evb-transition-`;
    let entries;
    try {
        entries = await readdir(originalDirectory, {withFileTypes: true});
    } catch {
        return;
    }
    await Promise.all(entries
        .filter(entry => (
            entry.name.startsWith(backupPrefix)
            && entry.name.endsWith('.bak')
            && (entry.isFile() || entry.isSymbolicLink())
        ))
        .map(entry => rm(join(originalDirectory, entry.name), {force: true}).catch(() => undefined)));
}
