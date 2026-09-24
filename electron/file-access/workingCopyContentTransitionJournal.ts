import {randomUUID} from 'node:crypto';
import {
    cp,
    lstat,
    open as openFileHandle,
    readFile,
    readdir,
    rm,
    stat,
} from 'node:fs/promises';
import type {Dirent} from 'node:fs';
import {join} from 'node:path';
import {
    isErrnoException,
    isRecord,
} from '@contracts/runtimeGuards';
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
import {getNativeCompactSearchIndexPath as getCompactSearchIndexPath} from '@electron/features/search/publicNative';
import {
    OCR_CATALOG_VERSION,
    parseOcrCatalogRootV4,
} from '@contracts/ocrIndex';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import {measureOperationPhase} from '@contracts/measureOperationPhase';
import {
    invalidDocumentRecoveryJournal,
    readDocumentRecoveryJournal,
} from '@electron/file-access/documentRecoveryJournal';

const log = createLogger('workingCopyContentTransitionJournal');

/**
 * A v4 catalog never crosses this path as a tree: its immutable generations
 * stay in place and this journal stores the small root manifest instead. Any
 * other catalog directory is a refused v3 tree and is left untouched.
 */
const OCR_ROOT_MANIFEST_FILENAME = 'manifest.json';
const OCR_GENERATION_DIRECTORY_PATTERN = /^gen-\d{8}$/u;

interface ITransitionSidecarBackup {
    targetPath: string;
    backupPath: string | null;
    directory: boolean;
    originalState: 'present' | 'absent' | 'unknown';
    kind?: 'ocr-v4-root' | 'ocr-v3-untouched';
}

export type TWorkingCopyContentBackupMode = 'copy-on-write' | 'hard-link' | 'append';

type TContentTransitionJournalBackupMode = 'copy' | 'append-hard-link';

interface IWorkingCopyContentTransitionJournal {
    version: 1;
    state: 'prepared';
    workingCopyPath: string;
    backupPath: string;
    nextRevisionToken: TDocumentRevisionToken;
    sidecars: ITransitionSidecarBackup[];
    backupMode: TContentTransitionJournalBackupMode;
    previousLength?: number;
}

function journalPathFor(workingCopyPath: string) {
    return `${workingCopyPath}.evb-content-transition.json`;
}

function isErrnoCode(error: unknown, code: string) {
    return isErrnoException(error) && error.code === code;
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
        || !Array.isArray(value.sidecars)
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
    const sidecars: ITransitionSidecarBackup[] = [];
    for (const sidecar of value.sidecars) {
        if (
            !isRecord(sidecar)
            || typeof sidecar.targetPath !== 'string'
            || (sidecar.backupPath !== null && typeof sidecar.backupPath !== 'string')
            || typeof sidecar.directory !== 'boolean'
            || (
                sidecar.originalState !== undefined
                && sidecar.originalState !== 'present'
                && sidecar.originalState !== 'absent'
            )
            || (
                sidecar.kind !== undefined
                && sidecar.kind !== 'ocr-v4-root'
                && sidecar.kind !== 'ocr-v3-untouched'
            )
        ) {
            return null;
        }
        const originalState = sidecar.originalState === 'present' || sidecar.originalState === 'absent'
            ? sidecar.originalState
            : sidecar.backupPath !== null || sidecar.kind === 'ocr-v3-untouched'
                ? 'present'
                : 'unknown';
        if (
            originalState === 'absent'
            && (sidecar.backupPath !== null || sidecar.kind === 'ocr-v3-untouched')
        ) {
            return null;
        }
        if (
            originalState === 'present'
            && sidecar.backupPath === null
            && sidecar.kind !== 'ocr-v3-untouched'
        ) {
            return null;
        }
        sidecars.push({
            targetPath: sidecar.targetPath,
            backupPath: sidecar.backupPath,
            directory: sidecar.directory,
            originalState,
            ...(sidecar.kind === 'ocr-v4-root' || sidecar.kind === 'ocr-v3-untouched'
                ? {kind: sidecar.kind}
                : {}),
        });
    }
    return {
        version: 1,
        state: 'prepared',
        workingCopyPath: value.workingCopyPath,
        backupPath: value.backupPath,
        nextRevisionToken: requireDocumentRevisionToken(value.nextRevisionToken),
        sidecars,
        backupMode,
        ...(previousLength === undefined ? {} : {previousLength}),
    };
}

async function isPreparedV4Root(targetPath: string) {
    const manifestPath = join(targetPath, OCR_ROOT_MANIFEST_FILENAME);
    let manifestText: string | null;
    try {
        manifestText = await readFile(manifestPath, 'utf8');
    } catch (error) {
        if (!isErrnoCode(error, 'ENOENT')) throw error;
        manifestText = null;
    }
    if (manifestText !== null) {
        let value: unknown;
        try {
            value = JSON.parse(manifestText) as unknown;
        } catch {
            value = null;
        }
        if (isRecord(value) && value.version === OCR_CATALOG_VERSION) {
            if (parseOcrCatalogRootV4(value) === null) {
                throw new Error(`Invalid OCR v4 root manifest: ${manifestPath}`);
            }
            return true;
        }
        // A v4 prepare can append its immutable generation before replacing a
        // legacy v3 manifest. Treat that mixed root as pointer-backed too.
    }

    // A worker can leave an unpublished generation under the shared root
    // before the root manifest is rebound by the apply transition.
    let entries: Dirent[];
    try {
        entries = await readdir(targetPath, {withFileTypes: true});
    } catch (error) {
        if (!isErrnoCode(error, 'ENOENT')) throw error;
        entries = [];
    }
    return entries.some(entry => entry.isDirectory() && OCR_GENERATION_DIRECTORY_PATTERN.test(entry.name));
}

async function backupOcrCatalogRoot(
    targetPath: string,
    backupPath: string,
): Promise<ITransitionSidecarBackup> {
    const manifestPath = join(targetPath, OCR_ROOT_MANIFEST_FILENAME);
    let manifestStat;
    try {
        manifestStat = await lstat(manifestPath);
    } catch (error) {
        if (!isErrnoCode(error, 'ENOENT')) throw error;
        manifestStat = null;
    }
    if (manifestStat && (!manifestStat.isFile() || manifestStat.isSymbolicLink())) {
        throw new Error(`OCR v4 root manifest is not a regular file: ${manifestPath}`);
    }
    if (manifestStat) {
        await copyFileAtomic(manifestPath, backupPath);
        return {
            targetPath,
            backupPath,
            directory: true,
            originalState: 'present',
            kind: 'ocr-v4-root',
        };
    }
    return {
        targetPath,
        backupPath: null,
        directory: true,
        originalState: 'absent',
        kind: 'ocr-v4-root',
    };
}

async function backupSidecars(
    workingCopyPath: string,
    suffix: string,
    backups: ITransitionSidecarBackup[],
) {
    const targets = [
        `${workingCopyPath}.ocr`,
        `${workingCopyPath}.evb-pages.json`,
        `${workingCopyPath}.index.json`,
        getCompactSearchIndexPath(workingCopyPath),
    ];
    for (const [
        index,
        targetPath,
    ] of targets.entries()) {
        let targetStat;
        try {
            targetStat = await stat(targetPath);
        } catch (error) {
            if (!isErrnoCode(error, 'ENOENT')) throw error;
            targetStat = null;
        }
        if (!targetStat) {
            backups.push({
                targetPath,
                backupPath: null,
                directory: false,
                originalState: 'absent',
            });
            continue;
        }
        const backupPath = `${workingCopyPath}.evb-sidecar-${suffix}-${index}.bak`;
        if (index === 0 && targetStat.isDirectory() && await isPreparedV4Root(targetPath)) {
            backups.push(await backupOcrCatalogRoot(targetPath, backupPath));
            continue;
        }
        if (index === 0 && targetStat.isDirectory()) {
            backups.push({
                targetPath,
                backupPath: null,
                directory: true,
                originalState: 'present',
                kind: 'ocr-v3-untouched',
            });
            continue;
        }
        if (targetStat.isDirectory()) await cp(targetPath, backupPath, {recursive: true});
        else await copyFileAtomic(targetPath, backupPath);
        backups.push({
            targetPath,
            backupPath,
            directory: targetStat.isDirectory(),
            originalState: 'present',
        });
    }
}

async function restoreSidecars(sidecars: readonly ITransitionSidecarBackup[]) {
    const uncertain = sidecars.find(sidecar => sidecar.originalState === 'unknown');
    if (uncertain) {
        throw new Error(`Cannot safely restore sidecar with unknown original state: ${uncertain.targetPath}`);
    }
    await Promise.all(sidecars.map(async sidecar => {
        if (sidecar.kind === 'ocr-v4-root') {
            if (!sidecar.backupPath) {
                // Keep immutable generations available for the orphan sweeper.
                // Only the root pointer is rolled back.
                await rm(join(sidecar.targetPath, OCR_ROOT_MANIFEST_FILENAME), {force: true});
                return;
            }
            await copyFileAtomic(
                sidecar.backupPath,
                join(sidecar.targetPath, OCR_ROOT_MANIFEST_FILENAME),
            );
            return;
        }
        if (sidecar.kind === 'ocr-v3-untouched') {
            // Transitions never modify a refused v3 tree; leave it in place.
            return;
        }
        if (!sidecar.backupPath) {
            await rm(sidecar.targetPath, {
                recursive: true,
                force: true,
            });
            return;
        }
        if (sidecar.directory) {
            await rm(sidecar.targetPath, {
                recursive: true,
                force: true,
            });
            await cp(sidecar.backupPath, sidecar.targetPath, {recursive: true});
        } else await copyFileAtomic(sidecar.backupPath, sidecar.targetPath);
    }));
}

async function removeSidecarBackups(sidecars: readonly ITransitionSidecarBackup[]) {
    await Promise.all(sidecars.flatMap(sidecar => sidecar.backupPath
        ? [rm(sidecar.backupPath, {
            recursive: true,
            force: true,
        })]
        : []));
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
    const sidecars: ITransitionSidecarBackup[] = [];
    try {
        await measureContentTransitionPhase('content-backup-sidecars', onPhase, () =>
            backupSidecars(workingCopyPath, suffix, sidecars));
    } catch (error) {
        await Promise.all([
            rm(backupPath, {force: true}),
            removeSidecarBackups(sidecars),
        ]);
        throw error;
    }
    const journal: IWorkingCopyContentTransitionJournal = {
        version: 1,
        state: 'prepared',
        workingCopyPath,
        backupPath,
        nextRevisionToken,
        sidecars,
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
    await restoreSidecars(journal.sidecars);
    await completeWorkingCopyContentTransition(journal);
}

export async function completeWorkingCopyContentTransition(
    journal: IWorkingCopyContentTransitionJournal,
) {
    await Promise.all([
        rm(journal.backupPath, {force: true}),
        rm(journalPathFor(journal.workingCopyPath), {force: true}),
        removeSidecarBackups(journal.sidecars),
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
        await restoreSidecars(journal.sidecars);
    }
    await completeWorkingCopyContentTransition(journal);
    return true;
}
