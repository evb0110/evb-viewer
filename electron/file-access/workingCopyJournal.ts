import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {
    open as openFileHandle,
    readFile,
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
import {OriginalPathSaveConflictError} from '@electron/file-access/originalPathSnapshot';
import {
    copyFileAtomic,
    getPublicationTemporaryPath,
    linkOrCopyFileDurably,
} from '@electron/file-access/documentFileWriteAtomic';
import {
    moveFileToLabelledPathBeside, truncateUtf8PathComponent,
} from '@electron/utils/boundedPathComponent';
import {
    originalSchema,
    restoreOriginal,
    type IWorkingCopyJournalOriginal,
} from '@electron/file-access/workingCopyJournalOriginal';
import {
    getWorkingCopyJournalBackupPath,
    getWorkingCopyJournalPath,
} from '@electron/file-access/workingCopyDirectory';
import {writeJsonAtomic} from '@electron/utils/atomicReplace';
import * as v from 'valibot';

export type TWorkingCopyContentBackupMode = 'copy-on-write' | 'hard-link' | 'append';

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
const journalFileSchema = v.pipe(v.string(), v.parseJson(), journalSchema);

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
    const result = v.safeParse(journalFileSchema, raw, {abortEarly: true});
    if (!result.success || result.output.workingCopyPath !== workingCopyPath) {
        throw new Error(`Working-copy journal is invalid: ${journalPath}`);
    }
    return result.output;
}

function writeJournal(journal: IWorkingCopyJournal) {
    return writeJsonAtomic(getWorkingCopyJournalPath(journal.workingCopyPath), journal, {markMutationCommitStarted: false});
}

export async function prepareWorkingCopyTransition(
    workingCopyPath: string,
    nextRevisionToken: TDocumentRevisionToken,
    onPhase?: (phase: string, durationMs: number) => void,
    backupMode: TWorkingCopyContentBackupMode = 'copy-on-write',
) {
    await measureOperationPhase(() => recoverWorkingCopyTransition(workingCopyPath), durationMs => onPhase?.('content-recover', durationMs));
    const backupPath = getWorkingCopyJournalBackupPath(workingCopyPath, `${process.pid}-${randomUUID()}`);
    const appendSourceStat = backupMode === 'append' ? await stat(workingCopyPath) : null;
    await measureOperationPhase(() => backupMode === 'copy-on-write'
        ? copyFileAtomic(workingCopyPath, backupPath)
        : linkOrCopyFileDurably(workingCopyPath, backupPath), durationMs => onPhase?.('content-backup-pdf', durationMs));
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
    await measureOperationPhase(() => writeJournal(journal), durationMs => onPhase?.('content-write-journal', durationMs));
    return journal;
}

/**
 * Records the original a transition publishes, before and after publication. A conflicted save first moves the
 * displaced original to a visible "<name> (original).pdf" beside the PDF, so the journal never names a missing file.
 */
export async function recordWorkingCopyJournalOriginal(
    journal: IWorkingCopyJournal,
    original: IWorkingCopyJournalOriginal,
) {
    if (original.state === 'conflicted') original.backupPath = await moveFileToLabelledPathBeside(original.backupPath, original.path, 'original');
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

// A working copy that is still the backup's inode was never replaced; only a replaced one needs the backup copied
// back. An append-mode backup is a hard link to the appended file, so either way the append is cut off afterwards.
async function restoreWorkingCopyContent(journal: IWorkingCopyJournal) {
    const [
        workingCopyStat,
        backupStat,
    ] = await Promise.all([
        stat(journal.workingCopyPath),
        stat(journal.backupPath),
    ]).catch(() => []);
    if (workingCopyStat === undefined || workingCopyStat.dev !== backupStat?.dev || workingCopyStat.ino !== backupStat.ino) {
        await copyFileAtomic(journal.backupPath, journal.workingCopyPath);
    }
    if (journal.previousLength !== undefined) await truncateWorkingCopy(journal.workingCopyPath, journal.previousLength);
}

/**
 * Completion starts once the original holds the committed or restored bytes,
 * so the original's backup and publication name go first: nothing beside the
 * original outlives the journal that names it, and a crash repeats the step.
 * A conflicted original's backup is the file kept beside the PDF, so it stays.
 * The working-copy backup goes after the journal, because recovering an
 * unfinished rollback copies from it; a crash leaves it unreferenced.
 */
export async function completeWorkingCopyTransition(journal: IWorkingCopyJournal) {
    if (journal.original && journal.original.state !== 'conflicted') {
        await rm(journal.original.backupPath, {force: true});
        await rm(getPublicationTemporaryPath(journal.original.path, journal.original.backupPath), {force: true});
    }
    await rm(getWorkingCopyJournalPath(journal.workingCopyPath), {force: true});
    await rm(journal.backupPath, {force: true});
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

// Another program changed the PDF before recovery could restore it: what the save displaced stays beside it as a
// conflicted save's does, and the transition finishes, so reads work and the next Save refuses with Save As.
async function keepChangedOriginal(original: IWorkingCopyJournalOriginal, error: unknown) {
    const keptPath = error instanceof OriginalPathSaveConflictError && await moveFileToLabelledPathBeside(original.backupPath, original.path, 'original');
    if (keptPath === false || keptPath === original.backupPath && existsSync(keptPath)) throw error;
}

/** Completes committed journals and rolls back others; unreadable journals fail closed. */
export async function recoverWorkingCopyTransition(workingCopyPath: string) {
    const journal = await readJournal(workingCopyPath);
    if (!journal) {
        return false;
    }
    const manifest = await readWorkingCopyManifest(workingCopyPath);
    if (manifest?.revision.token !== journal.nextRevisionToken) {
        if (journal.original) {
            await restoreOriginal(journal.original).catch((error: unknown) => keepChangedOriginal(journal.original!, error));
        }
        await restoreWorkingCopyContent(journal);
    }
    await completeWorkingCopyTransition(journal);
    return true;
}

const UUID_LENGTH = 36;
const NAME_MAX_BYTES = 255;

/**
 * An original backup is named for the working copy whose transition made it:
 * the `pdf-work-*` directory key is part of the name, so a sweep can tell its
 * own orphans from a backup another working copy's journal still names. The
 * original basename leads only as far as the name stays within NAME_MAX.
 */
function getOriginalBackupNamePrefix(originalPath: string, workingCopyPath: string) {
    const ownerSegment = `.evb-transition-${basename(dirname(workingCopyPath))}-`;
    const basenameBudget = NAME_MAX_BYTES - Buffer.byteLength(ownerSegment, 'utf8') - UUID_LENGTH - '.bak.tmp'.length;
    return `${truncateUtf8PathComponent(basename(originalPath), basenameBudget)}${ownerSegment}`;
}

export function createOriginalTransitionBackupPath(originalPath: string, workingCopyPath: string) {
    return join(dirname(originalPath), `${getOriginalBackupNamePrefix(originalPath, workingCopyPath)}${randomUUID()}.bak`);
}
