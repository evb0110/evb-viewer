import {
} from 'fs';
import {
    copyFile,
    link,
    open as openFileHandle,
    rename,
    unlink,
} from 'fs/promises';
import {
    dirname,
} from 'path';
import { isErrnoException } from '@contracts/runtimeGuards';
import {attemptWorkingCopyClone} from '@electron/file-access/workingCopyDirectory';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {syncFileHandleForDurability} from '@electron/utils/syncFileHandleForDurability';
import {measureOperationPhase} from '@contracts/measureOperationPhase';
import {assertNoSymlinkPathSegments} from '@electron/file-access/assertNoSymlinkPathSegments';
import {atomicReplace, makeSiblingTempPath} from '@electron/utils/atomicReplace';

const log = createLogger('documentFileWriteAtomic');

const MAX_IPC_WRITE_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_MAX_IPC_WRITE_BYTES ?? `${16 * 1024 * 1024}`, 10);
    if (!Number.isFinite(parsed) || parsed < 1024) {
        return 16 * 1024 * 1024;
    }
    return parsed;
})();
const RECOVERABLE_IMMUTABLE_LINK_CODES = new Set([
    'EXDEV',
    'ENOTSUP',
    'EOPNOTSUPP',
    'EPERM',
    'EMLINK',
]);

function assertWithinIpcWriteBudget(byteLength: number) {
    if (byteLength > MAX_IPC_WRITE_BYTES) {
        throw new Error(`Invalid data: exceeds max size (${MAX_IPC_WRITE_BYTES} bytes)`);
    }
}

async function linkImmutableSourceForAtomicCopy(sourcePath: string, targetPath: string) {
    if (
        process.env.NODE_ENV === 'test'
        && process.env.EVB_TEST_FORCE_IMMUTABLE_LINK_RESULT === 'cross-device'
    ) {
        throw Object.assign(new Error('Forced cross-device immutable link for tests'), {code: 'EXDEV'});
    }
    await link(sourcePath, targetPath);
}

export function normalizeIpcWritePayload(data: unknown) {
    if (!(data instanceof Uint8Array)) {
        throw new Error('Invalid data: must be a Uint8Array');
    }
    assertWithinIpcWriteBudget(data.byteLength);
    return data;
}

async function fsyncDirectoryBestEffort(directoryPath: string) {
    let directoryHandle;
    try {
        directoryHandle = await openFileHandle(directoryPath, 'r');
        await directoryHandle.sync();
    } catch {
        // Some platforms do not allow opening directories for fsync.
    } finally {
        await directoryHandle?.close().catch(() => undefined);
    }
}

export async function writeFileAtomic(resolvedPath: string, payload: Uint8Array) {
    assertNoSymlinkPathSegments(resolvedPath);

    const directoryPath = dirname(resolvedPath);
    const temporaryPath = makeSiblingTempPath(resolvedPath);

    const handle = await openFileHandle(temporaryPath, 'wx');
    try {
        await handle.writeFile(payload);
        await syncFileHandleForDurability(handle);
    } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }

    await handle.close();
    try {
        assertNoSymlinkPathSegments(resolvedPath);
        await rename(temporaryPath, resolvedPath);
        await fsyncDirectoryBestEffort(directoryPath);
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

export async function copyFileAtomic(
    resolvedSourcePath: string,
    resolvedTargetPath: string,
    options: {
        assertDestinationCurrent?: () => Promise<void>;
        durable?: boolean;
        linkImmutableSource?: boolean;
        onPhase?: (phase: string, durationMs: number) => void;
    } = {},
) {
    assertNoSymlinkPathSegments(resolvedSourcePath);
    assertNoSymlinkPathSegments(resolvedTargetPath);

    const directoryPath = dirname(resolvedTargetPath);
    const temporaryPath = makeSiblingTempPath(resolvedTargetPath);

    try {
        const cloneOutcome = await measureCopyPhase(options.onPhase, 'clone', () =>
            attemptWorkingCopyClone(resolvedSourcePath, temporaryPath));
        if (cloneOutcome === 'known-unsupported') {
            let linked = false;
            if (options.linkImmutableSource) {
                try {
                    await measureCopyPhase(options.onPhase, 'link', () =>
                        linkImmutableSourceForAtomicCopy(resolvedSourcePath, temporaryPath));
                    linked = true;
                } catch (error) {
                    const code = isErrnoException(error) && typeof error.code === 'string'
                        ? error.code
                        : undefined;
                    if (!RECOVERABLE_IMMUTABLE_LINK_CODES.has(code ?? '')) {
                        throw error;
                    }
                }
            }
            if (!linked) {
                await measureCopyPhase(options.onPhase, 'copy', () =>
                    copyFile(resolvedSourcePath, temporaryPath));
            }
        }
        if (options.durable !== false) {
            const handle = await openFileHandle(temporaryPath, 'r');
            try {
                await measureCopyPhase(options.onPhase, 'fsync-file', () =>
                    syncFileHandleForDurability(handle));
            } finally {
                await handle.close().catch(() => undefined);
            }
        }
        assertNoSymlinkPathSegments(resolvedTargetPath);
        await measureCopyPhase(options.onPhase, 'rename', async () => {
            if (process.platform === 'win32') {
                await atomicReplace(temporaryPath, resolvedTargetPath, {
                    durable: false,
                    markMutationCommitStarted: false,
                    ...(options.assertDestinationCurrent === undefined
                        ? {}
                        : {assertDestinationCurrent: options.assertDestinationCurrent}),
                });
                return;
            }
            await options.assertDestinationCurrent?.();
            await rename(temporaryPath, resolvedTargetPath);
        });
        if (options.durable !== false) {
            await measureCopyPhase(options.onPhase, 'fsync-directory', () =>
                fsyncDirectoryBestEffort(directoryPath));
        }
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

async function measureCopyPhase<T>(
    onPhase: ((phase: string, durationMs: number) => void) | undefined,
    phase: string,
    operation: () => Promise<T>,
): Promise<T> {
    return measureOperationPhase(operation, durationMs => {
        try { onPhase?.(phase, durationMs); }
        catch (error) { log.warn(`Atomic copy phase reporter failed: ${getErrorMessage(error)}`); }
    });
}

/**
 * Publishes a fresh immutable target. Callers must fsync the source first.
 * The hard-link path deliberately refuses an existing target with EEXIST;
 * only unsupported-link errors fall back to a durable atomic copy.
 */
export async function linkOrCopyFileDurably(
    resolvedSourcePath: string,
    resolvedTargetPath: string,
) {
    assertNoSymlinkPathSegments(resolvedSourcePath);
    assertNoSymlinkPathSegments(resolvedTargetPath);
    try {
        await link(resolvedSourcePath, resolvedTargetPath);
        await fsyncDirectoryBestEffort(dirname(resolvedTargetPath));
    } catch (error) {
        const code = isErrnoException(error) && typeof error.code === 'string'
            ? error.code
            : undefined;
        if (!RECOVERABLE_IMMUTABLE_LINK_CODES.has(code ?? '')) {
            throw error;
        }
        await copyFileAtomic(resolvedSourcePath, resolvedTargetPath);
    }
}

/**
 * Publishes an already-fsynced immutable artifact without rewriting its bytes.
 * A same-filesystem hard link preserves the durable inode; cross-device and
 * unsupported filesystems fall back to the regular durable atomic copy.
 */
export async function publishImmutableFileAtomic(
    resolvedSourcePath: string,
    resolvedTargetPath: string,
    options: {assertDestinationCurrent?: () => Promise<void>} = {},
) {
    assertNoSymlinkPathSegments(resolvedSourcePath);
    assertNoSymlinkPathSegments(resolvedTargetPath);
    const directoryPath = dirname(resolvedTargetPath);
    const temporaryPath = makeSiblingTempPath(resolvedTargetPath);
    try {
        await linkImmutableSourceForAtomicCopy(resolvedSourcePath, temporaryPath);
    } catch (error) {
        const code = isErrnoException(error) && typeof error.code === 'string'
            ? error.code
            : undefined;
        if (!RECOVERABLE_IMMUTABLE_LINK_CODES.has(code ?? '')) {
            throw error;
        }
        return copyFileAtomic(resolvedSourcePath, resolvedTargetPath, {...(options.assertDestinationCurrent === undefined
            ? {}
            : {assertDestinationCurrent: options.assertDestinationCurrent})});
    }

    try {
        assertNoSymlinkPathSegments(resolvedTargetPath);
        if (process.platform === 'win32') {
            await atomicReplace(temporaryPath, resolvedTargetPath, {
                durable: false,
                markMutationCommitStarted: false,
                ...(options.assertDestinationCurrent === undefined
                    ? {}
                    : {assertDestinationCurrent: options.assertDestinationCurrent}),
            });
        } else {
            await options.assertDestinationCurrent?.();
            await rename(temporaryPath, resolvedTargetPath);
            await fsyncDirectoryBestEffort(directoryPath);
        }
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}
