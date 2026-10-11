import {randomUUID} from 'node:crypto';
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
import {
    copyFileAtomic,
    linkOrCopyFileDurably,
} from '@electron/file-access/documentFileWriteAtomic';
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
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import * as v from 'valibot';

const log = createLogger('workingCopyJournal');

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
 * Removes the journal, then every backup it named. A crash in between leaves
 * only an unreferenced backup, never a journal whose backup is gone.
 */
export async function completeWorkingCopyTransition(journal: IWorkingCopyJournal) {
    await rm(getWorkingCopyJournalPath(journal.workingCopyPath), {force: true});
    await Promise.all([
        rm(journal.backupPath, {force: true}),
        ...(journal.original && journal.original.state !== 'conflicted' ? [rm(journal.original.backupPath, {force: true})] : []),
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

/** Completes committed journals and rolls back others; unreadable journals fail closed. */
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

const UUID_LENGTH = 36;
const NAME_MAX_BYTES = 255;

/** Keeps the longest prefix of `text` whose UTF-8 form fits in `maxBytes`, never splitting a code point. */
function truncateToUtf8Bytes(text: string, maxBytes: number) {
    let result = '';
    let bytes = 0;
    for (const character of text) {
        bytes += Buffer.byteLength(character, 'utf8');
        if (bytes > maxBytes) {
            break;
        }
        result += character;
    }
    return result;
}

/**
 * An original backup is named for the working copy whose transition made it:
 * the `pdf-work-*` directory key is part of the name, so a sweep can tell its
 * own orphans from a backup another working copy's journal still names. The
 * original basename leads only as far as the name stays within NAME_MAX; a
 * UTF-8 byte bound also bounds the UTF-16 units NTFS counts.
 */
function getOriginalBackupNamePrefix(originalPath: string, workingCopyPath: string) {
    const ownerSegment = `.evb-transition-${basename(dirname(workingCopyPath))}-`;
    const basenameBudget = NAME_MAX_BYTES - Buffer.byteLength(ownerSegment, 'utf8') - UUID_LENGTH - '.bak'.length;
    return `${truncateToUtf8Bytes(basename(originalPath), basenameBudget)}${ownerSegment}`;
}

export function createOriginalTransitionBackupPath(originalPath: string, workingCopyPath: string) {
    return join(dirname(originalPath), `${getOriginalBackupNamePrefix(originalPath, workingCopyPath)}${randomUUID()}.bak`);
}
