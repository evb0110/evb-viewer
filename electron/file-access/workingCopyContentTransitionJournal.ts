import {randomUUID} from 'node:crypto';
import {
    cp,
    lstat,
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
 * V3 catalogs are retained only for old documents and old journals. A v4
 * catalog never crosses this path as a tree: its immutable generations stay
 * in place and this journal stores the small root manifest instead.
 */
export const MAX_LEGACY_OCR_CATALOG_BACKUP_BYTES = 16 * 1024 * 1024;
export const MAX_LEGACY_OCR_CATALOG_FILES = 100_000;
const OCR_ROOT_MANIFEST_FILENAME = 'manifest.json';
const OCR_GENERATION_DIRECTORY_PATTERN = /^gen-\d{8}$/u;

interface ITransitionSidecarBackup {
    targetPath: string;
    backupPath: string | null;
    directory: boolean;
    originalState: 'present' | 'absent' | 'unknown';
    kind?: 'ocr-v4-root' | 'ocr-v3-untouched';
}

interface IWorkingCopyContentTransitionJournal {
    version: 1;
    state: 'prepared';
    workingCopyPath: string;
    backupPath: string;
    nextRevisionToken: TDocumentRevisionToken;
    sidecars: ITransitionSidecarBackup[];
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
    };
}

/**
 * Stop at the compatibility budget. Large legacy roots remain in place
 * during generic PDF transitions instead of being copied or rejected.
 */
async function isLegacyOcrCatalogWithinBudget(targetPath: string) {
    let totalBytes = 0;
    let fileCount = 0;
    const pending: string[] = [targetPath];
    while (pending.length > 0) {
        const currentPath = pending.pop()!;
        const currentStat = await lstat(currentPath);
        if (currentStat.isSymbolicLink()) {
            throw new Error(`OCR legacy catalog contains a symbolic link: ${currentPath}`);
        }
        if (currentStat.isDirectory()) {
            const entries = await readdir(currentPath, {withFileTypes: true});
            if (entries.length > MAX_LEGACY_OCR_CATALOG_FILES) {
                return false;
            }
            for (const entry of entries) {
                fileCount += 1;
                if (fileCount > MAX_LEGACY_OCR_CATALOG_FILES) {
                    return false;
                }
                pending.push(join(currentPath, entry.name));
            }
            continue;
        }
        if (!currentStat.isFile()) {
            throw new Error(`OCR legacy catalog contains a non-file entry: ${currentPath}`);
        }
        totalBytes += currentStat.size;
        if (totalBytes > MAX_LEGACY_OCR_CATALOG_BACKUP_BYTES) {
            return false;
        }
    }
    return true;
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
            if (!await isLegacyOcrCatalogWithinBudget(targetPath)) {
                backups.push({
                    targetPath,
                    backupPath: null,
                    directory: true,
                    originalState: 'present',
                    kind: 'ocr-v3-untouched',
                });
                continue;
            }
            await cp(targetPath, backupPath, {recursive: true});
        } else if (targetStat.isDirectory()) await cp(targetPath, backupPath, {recursive: true});
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
            // Generic PDF transitions do not modify the legacy OCR root.
            // Leave the large tree where it is and avoid a recursive restore.
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
    backupMode: 'copy-on-write' | 'hard-link' = 'copy-on-write',
) {
    await measureContentTransitionPhase('content-recover', onPhase, () =>
        recoverWorkingCopyContentTransition(workingCopyPath));
    const suffix = `${process.pid}-${randomUUID()}`;
    const backupPath = `${workingCopyPath}.evb-content-${suffix}.bak`;
    await measureContentTransitionPhase('content-backup-pdf', onPhase, () => backupMode === 'hard-link'
        ? linkOrCopyFileDurably(workingCopyPath, backupPath)
        : copyFileAtomic(workingCopyPath, backupPath));
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
    };
    await measureContentTransitionPhase('content-write-journal', onPhase, () =>
        writeJsonAtomic(journalPathFor(workingCopyPath), journal));
    return journal;
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
    await copyFileAtomic(journal.backupPath, journal.workingCopyPath);
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
        await copyFileAtomic(journal.backupPath, workingCopyPath);
        await restoreSidecars(journal.sidecars);
    }
    await completeWorkingCopyContentTransition(journal);
    return true;
}
