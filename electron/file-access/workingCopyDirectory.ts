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
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';
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
    if (
        process.env.NODE_ENV === 'test'
        && process.env.EVB_TEST_FORCE_MAC_CLONE_HELPER === '1'
    ) {
        return true;
    }
    return process.platform === 'darwin'
        && process.env.EVB_TEST_DISABLE_MAC_CLONE_HELPER !== '1';
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
    const forcedOutcome = process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
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

/**
 * Copies one source revision into a new target. The source handle prevents a
 * replacement from changing the bytes mid-stream, while the identity checks
 * reject publishing an older handle after the source path was replaced.
 */
export async function copyFileFromStableSource(sourcePath: string, targetPath: string) {
    const sourceHandle = await open(sourcePath, 'r');
    let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
    let copied = false;
    try {
        const sourceStat = await sourceHandle.stat({bigint: true});
        if (!sourceStat.isFile()) {
            throw new Error('Working-copy source is not a regular file');
        }
        targetHandle = await open(targetPath, 'wx');
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let offset = 0n;
        while (offset < sourceStat.size) {
            const length = Number(
                sourceStat.size - offset > BigInt(buffer.byteLength)
                    ? BigInt(buffer.byteLength)
                    : sourceStat.size - offset,
            );
            const result = await sourceHandle.read(buffer, 0, length, offset);
            if (result.bytesRead !== length) {
                throw Object.assign(new Error('The source changed while it was being copied'), {code: 'SOURCE_BACKING_CHANGED'});
            }
            await targetHandle.write(buffer, 0, length, Number(offset));
            offset += BigInt(length);
            if (offset < sourceStat.size) {
                await new Promise<void>(resolveCopyYield => setImmediate(resolveCopyYield));
            }
        }
        const currentHandleStat = await sourceHandle.stat({bigint: true});
        const currentPathStat = await stat(sourcePath, {bigint: true});
        if (
            currentHandleStat.dev !== sourceStat.dev
            || currentHandleStat.ino !== sourceStat.ino
            || currentHandleStat.size !== sourceStat.size
            || currentHandleStat.mtimeNs !== sourceStat.mtimeNs
            || currentPathStat.dev !== sourceStat.dev
            || currentPathStat.ino !== sourceStat.ino
            || currentPathStat.size !== sourceStat.size
            || currentPathStat.mtimeNs !== sourceStat.mtimeNs
        ) {
            throw Object.assign(new Error('The source changed while it was being copied'), {code: 'SOURCE_BACKING_CHANGED'});
        }
        copied = true;
    } finally {
        await targetHandle?.close().catch(() => undefined);
        await sourceHandle.close().catch(() => undefined);
        if (targetHandle && !copied) {
            await rm(targetPath, {force: true}).catch(() => undefined);
        }
    }
}
