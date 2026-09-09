import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'fs';
import {
    copyFile,
    link,
    lstat,
    open,
    readFile,
    readdir,
    rename,
    stat,
    unlink,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
} from 'path';
import { isErrnoException } from '@contracts/runtimeGuards';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {assertNoSymlinkPathSegments} from '@electron/file-access/assertNoSymlinkPathSegments';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { syncFileHandleForDurability } from '@electron/utils/syncFileHandleForDurability';
import { markActiveWorkingCopyMutationCommitStarted } from '@electron/file-access/workingCopyMutationCommitSignal';
import {
    assertPathMatchesSaveWitnessSnapshot,
    capturePathSaveWitness,
    type IOriginalPathSaveJournalSnapshot,
} from '@electron/file-access/originalPathSaveWitness';

const logger = createLogger('atomicReplace');
const DEFAULT_ATOMIC_REPLACE_BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ATOMIC_REPLACE_BACKUP_NAME_PATTERN = /^(?<destination>.+)\.bak-[0-9a-f]{16}$/u;
const ATOMIC_REPLACE_JOURNAL_VERSION = 1;
const WINDOWS_FALLBACK_CODES = new Set([
    'EACCES',
    'EBUSY',
    'EPERM',
    'ENOTEMPTY',
]);

function isPdfDestination(destinationPath: string) {
    return /\.pdf$/iu.test(destinationPath);
}

interface IWindowsAtomicReplaceJournal {
    version: typeof ATOMIC_REPLACE_JOURNAL_VERSION;
    sourcePath: string;
    destinationPath: string;
    backupPath: string;
    destinationSnapshot: IOriginalPathSaveJournalSnapshot;
    sourceSnapshot: IOriginalPathSaveJournalSnapshot;
}

function attachFailureReceipt(error: Error, receipt: FailureReceipt | undefined) {
    if (!receipt) {
        return error;
    }
    try {
        if (!Object.hasOwn(error, 'failure')) {
            Object.defineProperty(error, 'failure', {
                configurable: true,
                value: receipt,
            });
        }
    } catch {
        // A diagnostic receipt must never change the atomic replacement outcome.
    }
    return error;
}

export interface IAtomicReplaceBackupCleanupOptions {
    isDestinationActive?: (destinationPath: string) => boolean;
    maxAgeMs?: number;
    now?: number;
}

export interface IAtomicReplaceBackupCleanupResult {
    hasRetainedBackup: boolean;
    removedBackups: number;
}

function randomSuffix() {
    return randomBytes(8).toString('hex');
}

async function fsyncPath(filePath: string) {
    const handle = await open(filePath, 'r');
    try {
        await syncFileHandleForDurability(handle, {onSkipped: error => logger.debug(
            `Skipping temp-file fsync for "${filePath}": ${getErrorMessage(error)}`,
        )});
    } finally {
        await handle.close();
    }
}

export async function fsyncParentDirectory(filePath: string) {
    if (process.platform === 'win32') {
        return;
    }

    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        handle = await open(dirname(filePath), fsConstants.O_RDONLY);
        await handle.sync();
    } catch {
        return;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

async function pathExists(filePath: string) {
    try {
        await stat(filePath);
        return true;
    } catch {
        return false;
    }
}

async function assertPathExists(filePath: string, context: string) {
    if (await pathExists(filePath)) {
        return;
    }

    throw new Error(`${context}: destination "${filePath}" is missing after atomic replace`);
}

function atomicReplaceJournalPath(destinationPath: string) {
    return `${destinationPath}.evb-atomic-replace.json`;
}

async function writeWindowsAtomicReplaceJournal(journal: IWindowsAtomicReplaceJournal) {
    const path = atomicReplaceJournalPath(journal.destinationPath);
    const temporaryPath = `${path}.${randomSuffix()}.tmp`;
    const handle = await open(temporaryPath, 'wx');
    try {
        await handle.writeFile(JSON.stringify(journal), 'utf8');
        await syncFileHandleForDurability(handle);
    } finally {
        await handle.close();
    }
    try {
        await rename(temporaryPath, path);
        await fsyncParentDirectory(path);
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

async function readWindowsAtomicReplaceJournal(destinationPath: string) {
    const path = atomicReplaceJournalPath(destinationPath);
    let value: unknown;
    try {
        value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return undefined;
        }
        throw new Error(`Windows atomic replace journal is unreadable: ${path}`, {cause: error});
    }
    if (
        !value
        || typeof value !== 'object'
        || (value as Record<string, unknown>).version !== ATOMIC_REPLACE_JOURNAL_VERSION
        || (value as Record<string, unknown>).destinationPath !== destinationPath
        || typeof (value as Record<string, unknown>).sourcePath !== 'string'
        || typeof (value as Record<string, unknown>).backupPath !== 'string'
        || !(value as Record<string, unknown>).destinationSnapshot
        || !(value as Record<string, unknown>).sourceSnapshot
    ) {
        throw new Error(`Windows atomic replace journal is invalid: ${path}`);
    }
    return value as IWindowsAtomicReplaceJournal;
}

async function recoverWindowsAtomicReplace(destinationPath: string) {
    const journal = await readWindowsAtomicReplaceJournal(destinationPath);
    if (!journal) {
        return;
    }
    assertNoSymlinkPathSegments(destinationPath);
    assertNoSymlinkPathSegments(journal.backupPath);
    const backupExists = await pathExists(journal.backupPath);
    if (await pathExists(destinationPath)) {
        if (!backupExists) {
            await assertPathMatchesSaveWitnessSnapshot(destinationPath, journal.destinationSnapshot);
            await unlink(atomicReplaceJournalPath(destinationPath));
            return;
        }
        await assertPathMatchesSaveWitnessSnapshot(journal.backupPath, journal.destinationSnapshot, {contentOnly: true});
        try {
            await assertPathMatchesSaveWitnessSnapshot(destinationPath, journal.sourceSnapshot);
            await unlink(journal.backupPath);
            await unlink(atomicReplaceJournalPath(destinationPath));
            return;
        } catch {
            try {
                await assertPathMatchesSaveWitnessSnapshot(destinationPath, journal.destinationSnapshot);
                await unlink(journal.backupPath);
                await unlink(atomicReplaceJournalPath(destinationPath));
                return;
            } catch {
                throw new Error(`Windows atomic replace recovery refused to overwrite destination "${destinationPath}"`);
            }
        }
    }

    if (!backupExists) {
        throw new Error(`Windows atomic replace recovery is missing its owned backup for "${destinationPath}"`);
    }
    await assertPathMatchesSaveWitnessSnapshot(journal.backupPath, journal.destinationSnapshot, {contentOnly: true});

    // A hard link is deliberately used for the missing-path case. It creates
    // the destination only if it is still absent, so a third-party replacement
    // cannot be overwritten between the witness and recovery.
    await link(journal.backupPath, destinationPath);
    await unlink(journal.backupPath);
    await unlink(atomicReplaceJournalPath(destinationPath));
}

async function createRestoreFailureError(
    dst: string,
    backupPath: string,
    promotionError: unknown,
    restoreError: unknown,
) {
    const [
        dstExists,
        backupExists,
    ] = await Promise.all([
        pathExists(dst),
        pathExists(backupPath),
    ]);
    return new Error(
        `Atomic replace failed and backup restore failed for "${dst}". `
        + `Promotion error: ${getErrorMessage(promotionError)}. `
        + `Restore error: ${getErrorMessage(restoreError)}. `
        + `Backup path: "${backupPath}" (exists: ${backupExists ? 'yes' : 'no'}). `
        + `Destination exists: ${dstExists ? 'yes' : 'no'}.`,
    );
}

export function makeSiblingTempPath(targetPath: string) {
    return join(dirname(targetPath), `.${randomSuffix()}.tmp`);
}

function getAtomicReplaceBackupDestination(backupPath: string) {
    const destinationName = basename(backupPath).match(ATOMIC_REPLACE_BACKUP_NAME_PATTERN)?.groups?.destination;
    return destinationName ? join(dirname(backupPath), destinationName) : null;
}

/**
 * Removes only old atomic-replace backups in one caller-selected directory.
 * The caller owns the directory scope. A backup stays in place when its
 * destination is missing, active, too recent, or cannot be inspected safely.
 */
export async function cleanupStaleAtomicReplaceBackups(
    directoryPath: string,
    options: IAtomicReplaceBackupCleanupOptions = {},
): Promise<IAtomicReplaceBackupCleanupResult> {
    const result: IAtomicReplaceBackupCleanupResult = {
        hasRetainedBackup: false,
        removedBackups: 0,
    };
    if (process.platform !== 'win32') {
        return result;
    }

    const configuredNow = options.now;
    const now = configuredNow !== undefined && Number.isFinite(configuredNow)
        ? configuredNow
        : Date.now();
    const configuredMaxAgeMs = options.maxAgeMs;
    const maxAgeMs = configuredMaxAgeMs !== undefined
        && Number.isFinite(configuredMaxAgeMs)
        && configuredMaxAgeMs >= 0
        ? configuredMaxAgeMs
        : DEFAULT_ATOMIC_REPLACE_BACKUP_MAX_AGE_MS;
    try {
        const directoryStat = await lstat(directoryPath);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
            return result;
        }
    } catch {
        return result;
    }
    let entries: string[];
    try {
        entries = await readdir(directoryPath);
    } catch {
        return result;
    }

    for (const entry of entries) {
        if (!entry.includes('.bak-')) {
            continue;
        }

        const backupPath = join(directoryPath, entry);
        const destinationPath = getAtomicReplaceBackupDestination(backupPath);
        if (!destinationPath) {
            // Keep names from another backup scheme. They are outside this
            // utility's naming contract and may carry user data.
            result.hasRetainedBackup = true;
            continue;
        }

        let backupStat;
        try {
            backupStat = await lstat(backupPath);
        } catch {
            continue;
        }
        if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
            result.hasRetainedBackup = true;
            continue;
        }

        let destinationStat;
        try {
            destinationStat = await lstat(destinationPath);
        } catch {
            // A backup without its destination is the useful recovery copy.
            result.hasRetainedBackup = true;
            continue;
        }
        if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
            result.hasRetainedBackup = true;
            continue;
        }

        if (options.isDestinationActive?.(destinationPath)) {
            result.hasRetainedBackup = true;
            continue;
        }

        const lastTouchedAt = backupStat.mtimeMs;
        if (!Number.isFinite(lastTouchedAt) || now - lastTouchedAt < maxAgeMs) {
            result.hasRetainedBackup = true;
            continue;
        }

        // Recheck the destination immediately before unlinking the backup. It
        // does not make the pair a conditional filesystem operation, but it
        // avoids deleting a recovery copy after an obvious destination loss.
        try {
            const currentDestinationStat = await lstat(destinationPath);
            if (!currentDestinationStat.isFile() || currentDestinationStat.isSymbolicLink()) {
                result.hasRetainedBackup = true;
                continue;
            }
            if (options.isDestinationActive?.(destinationPath)) {
                result.hasRetainedBackup = true;
                continue;
            }
        } catch {
            result.hasRetainedBackup = true;
            continue;
        }

        try {
            await unlink(backupPath);
            result.removedBackups += 1;
        } catch (error) {
            result.hasRetainedBackup = true;
            logger.warn(`Failed to remove stale atomic replace backup "${backupPath}": ${getErrorMessage(error)}`);
        }
    }

    return result;
}

export async function atomicReplace(
    srcTemp: string,
    dst: string,
    options: {
        /**
         * Whether the replacement has to survive a crash. A within-run cache
         * publishes into a scratch directory that is discarded when the process
         * exits, so it takes the same replace semantics — a reader of the
         * destination keeps reading a complete file, and Windows never fails
         * the rename against an open handle — without paying for two fsyncs it
         * has nothing to recover.
         */
        durable?: boolean;
        assertDestinationCurrent?: () => Promise<void>;
        markMutationCommitStarted?: boolean;
    } = {},
) {
    assertNoSymlinkPathSegments(srcTemp);
    assertNoSymlinkPathSegments(dst);
    if (process.platform === 'win32' && isPdfDestination(dst)) {
        await recoverWindowsAtomicReplace(dst);
    }
    const durable = options.durable !== false;
    const shouldMarkMutationCommitStarted = options.markMutationCommitStarted !== false;
    const shouldDeferMutationCommitStarted = options.assertDestinationCurrent !== undefined
        && shouldMarkMutationCommitStarted;
    if (durable) {
        await fsyncPath(srcTemp);
    }
    if (shouldMarkMutationCommitStarted && !shouldDeferMutationCommitStarted) {
        markActiveWorkingCopyMutationCommitStarted();
    }

    if (
        process.env.EVB_DOCUMENT_RECOVERY_COPY === '1'
        && /\.(?:pdf|djvu?|tiff?)$/iu.test(dst)
        && await pathExists(dst)
    ) {
        const recoveryTempPath = `${dst}.evb-recovery.tmp`;
        const recoveryPath = `${dst}.evb-recovery`;
        await copyFile(dst, recoveryTempPath);
        await fsyncPath(recoveryTempPath);
        await rename(recoveryTempPath, recoveryPath);
        await fsyncParentDirectory(recoveryPath);
    }

    if (process.platform !== 'win32') {
        await options.assertDestinationCurrent?.();
        if (shouldDeferMutationCommitStarted) {
            markActiveWorkingCopyMutationCommitStarted();
        }
        await rename(srcTemp, dst);
        if (durable) {
            await fsyncParentDirectory(dst);
        }
        return;
    }

    await options.assertDestinationCurrent?.();
    if (shouldDeferMutationCommitStarted) {
        markActiveWorkingCopyMutationCommitStarted();
    }

    // Node's Windows rename uses the same-name replacement primitive. Keep
    // this as the first choice so the destination name never disappears.
    try {
        await rename(srcTemp, dst);
    } catch (error) {
        const code = isErrnoException(error) ? error.code : undefined;
        if (!WINDOWS_FALLBACK_CODES.has(typeof code === 'string' ? code : '') || !(await pathExists(dst))) {
            throw error;
        }

        if (!isPdfDestination(dst)) {
            const backupPath = `${dst}.bak-${randomSuffix()}`;
            let hasBackup = false;
            try {
                await rename(dst, backupPath);
                hasBackup = true;
                await rename(srcTemp, dst);
            } catch (promotionError) {
                if (hasBackup) {
                    await rename(backupPath, dst).catch(() => undefined);
                }
                throw promotionError;
            }
            await assertPathExists(dst, 'Atomic replace completed');
            await fsyncParentDirectory(dst);
            await unlink(backupPath).catch(() => undefined);
            return;
        }

        // A reader that denies delete sharing can reject the one-call
        // replacement. The fallback keeps an exact durable ownership record
        // before moving the old destination aside. Recovery only links that
        // recorded backup into a still-missing destination.
        const destinationWitness = await capturePathSaveWitness(dst);
        const sourceWitness = await capturePathSaveWitness(srcTemp);
        if (!destinationWitness || !sourceWitness) {
            await destinationWitness?.close();
            await sourceWitness?.close();
            throw error;
        }
        const backupPath = `${dst}.bak-${randomSuffix()}`;
        try {
            await writeWindowsAtomicReplaceJournal({
                version: ATOMIC_REPLACE_JOURNAL_VERSION,
                sourcePath: srcTemp,
                destinationPath: dst,
                backupPath,
                destinationSnapshot: destinationWitness.getSnapshotForJournal(),
                sourceSnapshot: sourceWitness.getSnapshotForJournal(),
            });
        } finally {
            await destinationWitness.close();
            await sourceWitness.close();
        }

        let hasBackup = false;
        try {
            await rename(dst, backupPath);
            hasBackup = true;
            await rename(srcTemp, dst);
        } catch (promotionError) {
            if (!hasBackup) {
                await unlink(atomicReplaceJournalPath(dst)).catch(() => undefined);
            }
            if (hasBackup) {
                try {
                    await recoverWindowsAtomicReplace(dst);
                } catch (restoreError) {
                    const receipt = logger.error(
                        `Failed to restore backup after atomic replace failure: ${getErrorMessage(restoreError)}`,
                        {
                            code: 'MAIN_ATOMIC_REPLACE_RESTORE_FAILED',
                            context: {},
                            cause: restoreError,
                        },
                    );
                    throw attachFailureReceipt(
                        await createRestoreFailureError(dst, backupPath, promotionError, restoreError),
                        receipt,
                    );
                }
            }
            throw promotionError;
        }

        await assertPathExists(dst, 'Atomic replace completed');
        await fsyncParentDirectory(dst);
        await unlink(atomicReplaceJournalPath(dst)).catch(() => undefined);
        await unlink(backupPath).catch((cleanupError) => {
            logger.warn(`Failed to remove atomic replace backup "${backupPath}": ${getErrorMessage(cleanupError)}`);
        });
        return;
    }
    await assertPathExists(dst, 'Atomic replace completed');
    await fsyncParentDirectory(dst);
}
