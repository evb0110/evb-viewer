import { randomUUID } from 'node:crypto';
import {spawn} from 'node:child_process';
import {
    constants as fsConstants,
    existsSync,
    mkdirSync,
} from 'fs';
import {
    copyFile,
    open,
    rm,
    stat,
} from 'fs/promises';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    sep,
} from 'path';
import { isErrnoException } from '@contracts/runtimeGuards';
import { getAppTempDir } from '@electron/utils/appTempDir';
import {runtimeConfig} from '@electron/runtimeConfig';
import {
    normalizePathForLookup,
    type ICopiedSourceFingerprint,
} from '@electron/file-access/workingCopyStore';
import {readOriginalFileContentFingerprint} from '@electron/file-access/readFileChunk';
import {createLogger} from '@electron/utils/createLogger';

const COPY_ON_WRITE_FALLBACK_CODES = new Set([
    'ENOTSUP',
    'EOPNOTSUPP',
    'ENOSYS',
    'EINVAL',
    'EXDEV',
]);
const MAC_CLONE_TIMEOUT_MS = 30_000;
const MAC_CLONE_MAX_STDERR_BYTES = 16 * 1024;
const MAC_CLONE_UNSUPPORTED_PATTERN = /(?:operation not supported|not supported|invalid argument|cross-device|function not implemented)/iu;
const logger = createLogger('working-copy-directory');

export type TWorkingCopyCloneAttemptOutcome =
    | 'cloned'
    | 'known-unsupported'
    | 'unknown-error-eager-fallback';

function isCopyOnWriteUnavailable(error: unknown) {
    return isErrnoException(error)
        && typeof error.code === 'string'
        && COPY_ON_WRITE_FALLBACK_CODES.has(error.code);
}

function shouldUseMacCloneHelper() {
    const isTest = process.env.NODE_ENV === 'test';
    if (isTest && runtimeConfig.test.forceMacCloneHelper) {
        return true;
    }
    return process.platform === 'darwin'
        && !(isTest && runtimeConfig.test.disableMacCloneHelper);
}

interface IMacCloneAttemptResult {
    outcome: 'cloned' | 'known-unsupported' | 'failed';
    details: string;
}

async function copyFileWithMacClone(sourcePath: string, targetPath: string) {
    return new Promise<IMacCloneAttemptResult>((resolveClone) => {
        const child = spawn('/bin/cp', [
            '-c',
            '--',
            sourcePath,
            targetPath,
        ], {
            stdio: [
                'ignore',
                'ignore',
                'pipe',
            ],
            windowsHide: true,
        });
        let settled = false;
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            if (Buffer.byteLength(stderr, 'utf8') >= MAC_CLONE_MAX_STDERR_BYTES) {
                return;
            }
            stderr += chunk;
            if (Buffer.byteLength(stderr, 'utf8') > MAC_CLONE_MAX_STDERR_BYTES) {
                stderr = Buffer.from(stderr, 'utf8').subarray(0, MAC_CLONE_MAX_STDERR_BYTES).toString('utf8');
            }
        });
        const finish = (result: IMacCloneAttemptResult) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            resolveClone(result);
        };
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            finish({
                outcome: 'failed',
                details: `timed out after ${MAC_CLONE_TIMEOUT_MS} ms`,
            });
        }, MAC_CLONE_TIMEOUT_MS);
        timeout.unref();
        child.once('error', error => finish({
            outcome: 'failed',
            details: error.message,
        }));
        child.once('exit', (code, signal) => {
            if (code === 0) {
                finish({
                    outcome: 'cloned',
                    details: '',
                });
                return;
            }
            const details = stderr.trim() || `exited with code ${String(code)} signal ${String(signal)}`;
            finish({
                outcome: MAC_CLONE_UNSUPPORTED_PATTERN.test(details)
                    ? 'known-unsupported'
                    : 'failed',
                details,
            });
        });
    });
}

export function createWorkingDirectory() {
    const tempDir = getAppTempDir();
    const workDir = join(tempDir, `pdf-work-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    return workDir;
}

export function isWorkingCopyDirectoryName(name: string) {
    return name.startsWith('pdf-work-');
}

export function isWorkingCopyDocumentPath(path: string) {
    return isWorkingCopyDirectoryName(basename(dirname(path)));
}

/** A working-copy document inside this profile's app temp namespace. */
export function isManagedWorkingCopyPath(path: string) {
    const relativePath = relative(
        normalizePathForLookup(getAppTempDir()),
        normalizePathForLookup(dirname(path)),
    );
    return relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
        && isWorkingCopyDocumentPath(path);
}

/**
 * The layout of one working-copy directory. `document.<ext>` holds the bytes,
 * `manifest.json` the revision, `journal.json` an unfinished transition, and
 * `derived/` caches that are rebuilt whenever their revision does not match.
 */
export function getWorkingCopyManifestPath(workingCopyPath: string) {
    return join(dirname(workingCopyPath), 'manifest.json');
}

export function getWorkingCopyJournalPath(workingCopyPath: string) {
    return join(dirname(workingCopyPath), 'journal.json');
}

export function getWorkingCopyJournalBackupPath(workingCopyPath: string, suffix: string) {
    return join(dirname(workingCopyPath), `journal-${suffix}.bak`);
}

export function getWorkingCopyDerivedPath(workingCopyPath: string, name: string) {
    return join(dirname(workingCopyPath), 'derived', name);
}

export async function safeRemoveDirectory(path: string) {
    if (!existsSync(path)) {
        return false;
    }

    try {
        await rm(path, {
            recursive: true,
            force: true,
        });
        return true;
    } catch {
        return false;
    }
}

function getForcedCloneOutcomeForTests() {
    if (process.env.NODE_ENV !== 'test') {
        return null;
    }
    const forcedOutcome = runtimeConfig.test.forceWorkingCopyCloneResult;
    return forcedOutcome === 'success' || forcedOutcome === 'unsupported'
        ? forcedOutcome
        : null;
}

export async function attemptWorkingCopyClone(
    sourcePath: string,
    targetPath: string,
): Promise<TWorkingCopyCloneAttemptOutcome> {
    const forcedOutcome = getForcedCloneOutcomeForTests();
    if (forcedOutcome === 'unsupported') {
        return 'known-unsupported';
    }
    if (forcedOutcome === 'success') {
        await copyFile(sourcePath, targetPath);
        return 'cloned';
    }

    if (shouldUseMacCloneHelper()) {
        const result = await copyFileWithMacClone(sourcePath, targetPath);
        if (result.outcome === 'cloned') {
            return 'cloned';
        }
        await rm(targetPath, {force: true}).catch(() => undefined);
        if (result.outcome === 'known-unsupported') {
            logger.debug(`macOS clone helper is unavailable: ${result.details}`);
            return 'known-unsupported';
        }
        logger.warn(`macOS clone helper failed; using eager copy: ${result.details}`);
        await copyFile(sourcePath, targetPath);
        return 'unknown-error-eager-fallback';
    }

    try {
        await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE_FORCE);
        return 'cloned';
    } catch (error) {
        await rm(targetPath, {force: true}).catch(() => undefined);
        if (isCopyOnWriteUnavailable(error)) {
            return 'known-unsupported';
        }
    }

    await copyFile(sourcePath, targetPath);
    return 'unknown-error-eager-fallback';
}

export async function copyFileCopyOnWrite(sourcePath: string, targetPath: string) {
    const outcome = await attemptWorkingCopyClone(sourcePath, targetPath);
    if (outcome === 'known-unsupported') {
        await copyFileFromStableSource(sourcePath, targetPath);
    }
}

/** `fingerprintSource` hashes the fresh copy before any working-copy edits. */
interface ICopyFromStableSourceOptions {fingerprintSource?: boolean;}

/** Copy through the OS, then verify the source revision before publishing. */
export async function copyFileFromStableSource(
    sourcePath: string,
    targetPath: string,
    options: ICopyFromStableSourceOptions = {},
): Promise<ICopiedSourceFingerprint | null> {
    const sourceStat = await stat(sourcePath, {bigint: true});
    if (!sourceStat.isFile()) {
        throw new Error('Working-copy source is not a regular file');
    }
    let targetCreated = false;
    let copied = false;
    try {
        await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
        targetCreated = true;
        let contentFingerprint: string | undefined;
        if (options.fingerprintSource && Number.isSafeInteger(Number(sourceStat.size))) {
            const handle = await open(targetPath, 'r');
            try {
                contentFingerprint = await readOriginalFileContentFingerprint(handle, Number(sourceStat.size));
                if (contentFingerprint === undefined) {
                    throw Object.assign(new Error('The source changed while it was being copied'), {code: 'SOURCE_BACKING_CHANGED'});
                }
            } finally {
                await handle.close();
            }
        }
        const currentPathStat = await stat(sourcePath, {bigint: true});
        if (
            currentPathStat.dev !== sourceStat.dev
            || currentPathStat.ino !== sourceStat.ino
            || currentPathStat.size !== sourceStat.size
            || currentPathStat.mtimeNs !== sourceStat.mtimeNs
        ) {
            throw Object.assign(new Error('The source changed while it was being copied'), {code: 'SOURCE_BACKING_CHANGED'});
        }
        copied = true;
        return contentFingerprint && currentPathStat.ctimeNs === sourceStat.ctimeNs
            ? {
                contentFingerprint,
                sourceStat: currentPathStat,
            }
            : null;
    } finally {
        if (targetCreated && !copied) {
            await rm(targetPath, {force: true}).catch(() => undefined);
        }
    }
}
