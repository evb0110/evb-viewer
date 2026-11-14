import { randomBytes } from 'node:crypto';
import {
    chmod,
    link,
    lstat,
    open,
    readFile,
    copyFile,
    rename,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    dirname,
    join,
} from 'path';
import { isErrnoException } from '@contracts/runtimeGuards';
import { isNoHardLinkError } from '@electron/utils/isNoHardLinkError';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {assertNoSymlinkPathSegments} from '@electron/file-access/assertNoSymlinkPathSegments';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { markActiveWorkingCopyMutationCommitStarted } from '@electron/file-access/workingCopyMutationCommitSignal';
import {
    assertPathMatchesSaveWitnessSnapshot,
    capturePathSaveWitness,
} from '@electron/file-access/originalPathSaveWitness';
import type {IOriginalPathSaveJournalSnapshot} from '@electron/file-access/originalPathSnapshot';
import {
    fsyncDirectory,
    fsyncFile as fsyncPath,
} from '@electron/utils/fsyncPath';

const logger = createLogger('atomicReplace');
const ATOMIC_REPLACE_JOURNAL_VERSION = 1;
const WINDOWS_FALLBACK_CODES = new Set<string | number>([
    'EACCES',
    'EBUSY',
    'EPERM',
    'ENOTEMPTY',
]);

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


export async function fsyncParentDirectory(filePath: string) {
    await fsyncDirectory(dirname(filePath)).catch(() => undefined);
}

async function fileExists(filePath: string) {
    try {
        return (await stat(filePath)).isFile();
    } catch {
        return false;
    }
}

async function assertFileExists(filePath: string, context: string) {
    if (await fileExists(filePath)) {
        return;
    }

    throw new Error(`${context}: destination "${filePath}" is missing after atomic replace`);
}

function atomicReplaceJournalPath(destinationPath: string) {
    return `${destinationPath}.evb-atomic-replace.json`;
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

export async function recoverWindowsAtomicReplace(destinationPath: string) {
    const journal = await readWindowsAtomicReplaceJournal(destinationPath);
    if (!journal) {
        return;
    }
    assertNoSymlinkPathSegments(destinationPath);
    assertNoSymlinkPathSegments(journal.backupPath);
    const backupExists = await fileExists(journal.backupPath);
    if (await fileExists(destinationPath)) {
        if (backupExists) await assertPathMatchesSaveWitnessSnapshot(journal.backupPath, journal.destinationSnapshot, {contentOnly: true});
        // The destination holds the recorded new file (renamed into place) or
        // the old one, even when cleanup removed the backup but not this journal.
        await assertPathMatchesSaveWitnessSnapshot(destinationPath, journal.sourceSnapshot, {allowBackupMetadataChange: true})
            .catch(() => assertPathMatchesSaveWitnessSnapshot(destinationPath, journal.destinationSnapshot))
            .catch(() => {
                throw new Error(`Windows atomic replace recovery refused to overwrite destination "${destinationPath}"`);
            });
        if (backupExists) await unlink(journal.backupPath);
        await unlink(atomicReplaceJournalPath(destinationPath));
        return;
    }

    if (!backupExists) {
        throw new Error(`Windows atomic replace recovery is missing its owned backup for "${destinationPath}"`);
    }
    await moveFileToMissingPath(journal.backupPath, destinationPath);
    await assertPathMatchesSaveWitnessSnapshot(destinationPath, journal.destinationSnapshot, {contentOnly: true});
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
        fileExists(dst),
        fileExists(backupPath),
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

/** Moves a complete file into an absent path; no-link volumes use rename. */
export async function moveFileToMissingPath(sourcePath: string, destinationPath: string) {
    try {
        await link(sourcePath, destinationPath);
    } catch (error) {
        if (!isNoHardLinkError(error)) throw error;
        // A no-link volume still refuses an entry already present. Node cannot
        // make this check and the following rename one no-replace operation.
        const destination = await lstat(destinationPath).catch((lookupError: unknown) => {
            if (isErrnoException(lookupError) && lookupError.code === 'ENOENT') return null;
            throw lookupError;
        });
        if (destination) throw Object.assign(new Error(`File exists: ${destinationPath}`), {code: 'EEXIST'});
        await rename(sourcePath, destinationPath);
        return;
    }
    await unlink(sourcePath);
}

/** Detach shared staging before opening the inode to chmod and durably publish. */
async function prepareReplacement(srcTemp: string, dst: string, durable: boolean) {
    const [
        staged,
        replaced,
    ] = await Promise.all([
        stat(srcTemp),
        process.platform === 'win32' ? null : stat(dst).catch(() => null),
    ]);
    const mode = replaced && (staged.mode & 0o7777) !== (replaced.mode & 0o7777)
        ? replaced.mode & 0o7777 : undefined;
    if (mode !== undefined && staged.nlink !== 1) {
        const ownCopy = `${srcTemp}.mode`;
        try {
            await copyFile(srcTemp, ownCopy);
            await rename(ownCopy, srcTemp);
        } finally {
            await unlink(ownCopy).catch(() => undefined);
        }
    }
    const handle = durable ? await open(srcTemp, process.platform === 'win32' ? 'r+' : 'r') : undefined;
    try {
        if (mode !== undefined) {
            await chmod(srcTemp, mode).catch(async (error: unknown) => {
                if (((await stat(srcTemp)).mode & ~mode & 0o777) !== 0) throw error;
                logger.warn(`Could not keep the permissions of "${dst}": ${getErrorMessage(error)}`);
            });
        }
        await handle?.sync();
    } finally {
        await handle?.close();
    }
}

export async function atomicReplace(
    srcTemp: string,
    dst: string,
    options: {
        /** Within-run caches can skip durability fsyncs. */
        durable?: boolean;
        assertDestinationCurrent?: () => Promise<void>;
        /** Save-owned path that retains the exact revision displaced at publication. */
        destinationBackupPath?: string;
        markMutationCommitStarted?: boolean;
    } = {},
) {
    assertNoSymlinkPathSegments(srcTemp);
    assertNoSymlinkPathSegments(dst);
    if (process.platform === 'win32') {
        await recoverWindowsAtomicReplace(dst);
    }
    const durable = options.durable !== false;
    await prepareReplacement(srcTemp, dst, durable);
    if (options.assertDestinationCurrent) await options.assertDestinationCurrent();
    if (options.markMutationCommitStarted !== false) markActiveWorkingCopyMutationCommitStarted();
    if (options.destinationBackupPath !== undefined) {
        const backupPath = options.destinationBackupPath;
        assertNoSymlinkPathSegments(backupPath);
        await rename(dst, backupPath);
        await fsyncPath(backupPath);
        await moveFileToMissingPath(srcTemp, dst);
        await fsyncParentDirectory(dst);
        return;
    }

    if (process.platform !== 'win32') {
        await rename(srcTemp, dst);
        if (durable) {
            await fsyncParentDirectory(dst);
        }
        return;
    }

    // Node's Windows rename uses the same-name replacement primitive. Keep
    // this as the first choice so the destination name never disappears.
    try {
        await rename(srcTemp, dst);
    } catch (error) {
        if (!isErrnoException(error) || !WINDOWS_FALLBACK_CODES.has(error.code ?? '') || !(await fileExists(dst))) {
            throw error;
        }

        // A reader that denies delete sharing can reject the one-call
        // replacement. The fallback keeps an exact durable ownership record
        // before moving the old destination aside. Recovery only links that
        // recorded backup into a still-missing destination.
        const destinationWitness = await capturePathSaveWitness(dst);
        const sourceWitness = await capturePathSaveWitness(srcTemp);
        if (!destinationWitness || !sourceWitness) {
            throw error;
        }
        const backupPath = `${dst}.bak-${randomSuffix()}`;
        await writeJsonAtomic(atomicReplaceJournalPath(dst), {
            version: ATOMIC_REPLACE_JOURNAL_VERSION,
            sourcePath: srcTemp,
            destinationPath: dst,
            backupPath,
            destinationSnapshot: destinationWitness.getSnapshotForJournal(),
            sourceSnapshot: sourceWitness.getSnapshotForJournal(),
        } satisfies IWindowsAtomicReplaceJournal, {markMutationCommitStarted: false});

        try {
            // The witnesses above describe the bytes present now. The admitted
            // original is checked again right before it is moved aside.
            await options.assertDestinationCurrent?.();
            await rename(dst, backupPath);
            await rename(srcTemp, dst);
        } catch (promotionError) {
            if (!(await fileExists(backupPath))) {
                await unlink(atomicReplaceJournalPath(dst)).catch(() => undefined);
            } else {
                try {
                    await recoverWindowsAtomicReplace(dst);
                } catch (restoreError) {
                    const receipt = logger.error(
                        `Failed to restore backup after atomic replace failure: ${getErrorMessage(restoreError)}`,
                        {
                            code: 'MAIN_ATOMIC_REPLACE_RESTORE_FAILED',
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

        await assertFileExists(dst, 'Atomic replace completed');
        await fsyncParentDirectory(dst);
        await unlink(atomicReplaceJournalPath(dst)).catch(() => undefined);
        await unlink(backupPath).catch((cleanupError) => {
            logger.warn(`Failed to remove atomic replace backup "${backupPath}": ${getErrorMessage(cleanupError)}`);
        });
        return;
    }
    await assertFileExists(dst, 'Atomic replace completed');
    await fsyncParentDirectory(dst);
}

/** Writes JSON through a sibling temp file and publishes it with `atomicReplace`. */
export async function writeJsonAtomic(
    path: string,
    value: unknown,
    options: Parameters<typeof atomicReplace>[2] = {},
) {
    const temporaryPath = makeSiblingTempPath(path);
    try {
        await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, 'utf8');
        await atomicReplace(temporaryPath, path, options);
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}
