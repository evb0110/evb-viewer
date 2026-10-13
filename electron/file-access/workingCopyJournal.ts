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
    keepOriginalBeside, truncateUtf8PathComponent,
} from '@electron/utils/boundedPathComponent';
import {isSameFile} from '@electron/utils/fileIdentity';
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
    const raw = await readFile(journalPath, 'utf8').catch((error: unknown) => {
        if (!isErrnoException(error) || error.code !== 'ENOENT') throw new Error(`Working-copy journal could not be read: ${journalPath}`, {cause: error});
    });
    if (raw === undefined) return null;
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
    const heldOriginal = await measureOperationPhase(() => recoverWorkingCopyTransition(workingCopyPath), durationMs => onPhase?.('content-recover', durationMs));
    const backupPath = getWorkingCopyJournalBackupPath(workingCopyPath, `${process.pid}-${randomUUID()}`);
    const appendSourceStat = backupMode === 'append' ? await stat(workingCopyPath) : null;
    await measureOperationPhase(() => backupMode === 'copy-on-write'
        ? copyFileAtomic(workingCopyPath, backupPath)
        : linkOrCopyFileDurably(workingCopyPath, backupPath), durationMs => onPhase?.('content-backup-pdf', durationMs));
    const appendHardLink = appendSourceStat !== null && await isSameFile(workingCopyPath, backupPath);
    const journal: IWorkingCopyJournal = {
        version: 1,
        workingCopyPath,
        nextRevisionToken,
        backupPath,
        backupMode: appendHardLink ? 'append-hard-link' : 'copy',
        ...(appendHardLink ? {previousLength: appendSourceStat.size} : {}),
        ...(typeof heldOriginal === 'object' ? {original: heldOriginal} : {}),
    };
    await measureOperationPhase(() => writeJournal(journal), durationMs => onPhase?.('content-write-journal', durationMs));
    return journal;
}

/**
 * Records the original a transition publishes, before and after publication. An earlier transition's original carried
 * here is removed first, so a file another program still holds refuses this one. A conflicted save is recorded before
 * its displaced original moves to a visible "<name> (original).pdf", so recovery finishes a move a crash cut short.
 */
export async function recordWorkingCopyJournalOriginal(
    journal: IWorkingCopyJournal,
    original: IWorkingCopyJournalOriginal,
) {
    if (journal.original && journal.original.backupPath !== original.backupPath) await rm(journal.original.backupPath, {force: true});
    journal.original = original;
    await writeJournal(journal);
    if (original.state === 'conflicted') original.backupPath = await keepOriginalBeside(original.backupPath, original.path).catch(() => original.backupPath);
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
    if (!await isSameFile(journal.workingCopyPath, journal.backupPath)) await copyFileAtomic(journal.backupPath, journal.workingCopyPath);
    if (journal.previousLength !== undefined) await truncateWorkingCopy(journal.workingCopyPath, journal.previousLength);
}

/**
 * Completion starts once the original holds the committed or restored bytes,
 * so the original's backup goes first (recovery already removed its publication
 * name): nothing beside the original outlives the journal that names it.
 * A conflicted original's backup is the file kept beside the PDF, so it stays.
 * The working-copy backup goes after the journal, because recovering an
 * unfinished rollback copies from it; a crash leaves it unreferenced.
 */
export async function completeWorkingCopyTransition(journal: IWorkingCopyJournal) {
    if (journal.original && journal.original.state !== 'conflicted') await rm(journal.original.backupPath, {force: true});
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

/**
 * Restores the original a transition displaced. When another program changed the PDF since, the transition is
 * recorded as conflicted, which keeps the displaced file beside the PDF, and the conflict names that file.
 */
export async function restoreTransitionOriginal(journal: IWorkingCopyJournal, original: IWorkingCopyJournalOriginal) {
    // A conflicted transition only finishes keeping its displaced file, which a crash may have cut short.
    await (original.state === 'conflicted' ? Promise.reject(new OriginalPathSaveConflictError()) : restoreOriginal(original)).catch(async (error: unknown) => {
        if (!(error instanceof OriginalPathSaveConflictError) || !existsSync(original.backupPath)) throw error;
        original.state = 'conflicted';
        await recordWorkingCopyJournalOriginal(journal, original);
        throw new OriginalPathSaveConflictError(original.backupPath);
    });
}

/**
 * Completes committed journals and rolls back others; unreadable journals fail closed. A finished transition whose
 * displaced original another program holds open returns that original, still journaled, for the next transition's
 * journal to carry, so the hold fails no read and blocks no edit.
 */
export async function recoverWorkingCopyTransition(workingCopyPath: string) {
    const journal = await readJournal(workingCopyPath);
    // A publication's temporary name is never needed once its transition ends, whatever the outcome.
    if (journal?.original) await rm(getPublicationTemporaryPath(journal.original.path, journal.original.backupPath), {force: true});
    if (journal && (await readWorkingCopyManifest(workingCopyPath))?.revision.token !== journal.nextRevisionToken) {
        if (journal.original) await restoreTransitionOriginal(journal, journal.original).catch((error: unknown) => {
            if (!(error instanceof OriginalPathSaveConflictError)) throw error;
        });
        await restoreWorkingCopyContent(journal);
    }
    return journal !== null && completeWorkingCopyTransition(journal).then(() => true, (error: unknown) => {
        if (!isErrnoException(error) || error.code !== 'EBUSY' || !journal.original) throw error;
        journal.original.state = 'restored';
        return journal.original;
    });
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
