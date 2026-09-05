import {
    existsSync,
    mkdirSync,
} from 'fs';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    sep,
} from 'path';
import {
    rmdir,
    rm,
    writeFile,
} from 'fs/promises';
import {
    decryptWorkingCopyWithWriter,
    PdfDecryptAttemptError,
    type TWorkingCopyDecryptionResult,
} from '@electron/file-access/workingCopyDecryption';
import {isPdfFileEncrypted} from '@electron/file-access/isPdfFileEncrypted';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import {
    attemptWorkingCopyClone,
    copyFileCopyOnWrite,
    copyFileFromStableSource,
    createWorkingDirectory,
    isWorkingCopyDirectoryName,
    safeRemoveDirectory,
} from '@electron/file-access/workingCopyDirectory';
import {
    captureWorkingCopyAdmissionSnapshot,
    forgetRetiredWorkingCopyOriginal,
    getWorkingCopyBackingEntry,
    getWorkingCopyOriginalPath,
    getWorkingCopyRole,
    isKnownWorkingCopyOriginalPath,
    normalizePathForLookup,
    setWorkingCopyOriginalPath,
    type TWorkingCopyRole,
    workingCopyAdmissionSnapshotsMatch,
} from '@electron/file-access/workingCopyStore';
import { isAllowedOriginalSavePath } from '@electron/file-access/isAllowedOriginalSavePath';
import { WorkingCopyMissingError } from '@electron/file-access/workingCopyMissingError';
import { createLogger } from '@electron/utils/createLogger';
import { getAppTempDir } from '@electron/utils/appTempDir';
import {
    ensureWorkingCopyRevision,
    initializeFreshWorkingCopyRevision,
    markWorkingCopyContentChanged,
} from '@electron/file-access/documentRevisionStore';
import { readWorkingCopySyncRequiredJournalEntry } from '@electron/file-access/documentRevisionSidecar';
import {schedulePageIdentityStoreInitialization} from '@electron/file-access/pageIdentityStore';
import {
    startBackgroundWorkingCopyMaterialization,
    ensureWorkingCopyMaterialized,
    WorkingCopyMaterializationError,
} from '@electron/file-access/workingCopyMaterialization';

const logger = createLogger('working-copy');

interface IWorkingCopyPhaseTiming {
    durationMs: number;
    phase: string;
}

type TWorkingCopyMaterializationMode = 'eager' | 'background' | 'lazy';

interface IWorkingCopyCreationResult {
    workingPath: string;
    wasEncrypted: true | undefined;
}

// Permanent runtime kill-switch, not a compatibility shim: 'eager' restores
// pre-lazy behavior for filesystems where background materialization
// misbehaves; remove only if the lazy backing itself is ever removed.
function getWorkingCopyMaterializationMode(): TWorkingCopyMaterializationMode {
    const configuredMode = process.env.EVB_WORKING_COPY_MATERIALIZATION_MODE ?? 'background';
    return configuredMode === 'eager' || configuredMode === 'lazy'
        ? configuredMode
        : 'background';
}

async function measureWorkingCopyPhase<T>(
    timings: IWorkingCopyPhaseTiming[],
    phase: string,
    operation: () => Promise<T>,
) {
    const startedAt = performance.now();
    try {
        return await operation();
    } finally {
        timings.push({
            durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
            phase,
        });
    }
}

function resolveWorkingCopyRoleForPathClone(
    sourcePath: string,
    ownerWebContentsId?: number,
): TWorkingCopyRole {
    return getWorkingCopyOriginalPath(sourcePath, ownerWebContentsId) ? 'snapshot' : 'current';
}

async function decryptPdfWorkingCopy(
    workingPath: string,
    password: string | undefined,
    timings: IWorkingCopyPhaseTiming[],
    signal?: AbortSignal,
): Promise<TWorkingCopyDecryptionResult> {
    const encrypted = await measureWorkingCopyPhase(timings, 'encryption-probe', () =>
        isPdfFileEncrypted(workingPath));
    if (!encrypted) {
        return {
            outcome: 'plain',
            wasEncrypted: false,
            revision: null,
        };
    }
    const result = await measureWorkingCopyPhase(timings, 'decrypt', () =>
        decryptWorkingCopyWithWriter(workingPath, password, signal));
    assertWorkingCopyDecryptionSucceeded(result);
    return result;
}

function assertWorkingCopyDecryptionSucceeded(result: TWorkingCopyDecryptionResult) {
    if (result.outcome === 'needs-password' || result.outcome === 'unsupported') {
        throw new PdfDecryptAttemptError(
            result.outcome === 'needs-password'
                ? 'needs-password'
                : 'unsupported-encryption',
        );
    }
}

async function createWorkingCopyWithOutcomeInternal(
    originalPath: TOpenPath,
    ownerWebContentsId?: number,
    password?: string,
    signal?: AbortSignal,
): Promise<IWorkingCopyCreationResult> {
    const operationStartedAt = performance.now();
    const phaseTimings: IWorkingCopyPhaseTiming[] = [];
    const workDir = createWorkingDirectory();
    try {
        const fileName = basename(originalPath);
        const workingPath = join(workDir, fileName);
        const isPdf = workingPath.toLowerCase().endsWith('.pdf');
        const materializationMode = getWorkingCopyMaterializationMode();
        let admissionSnapshot: Awaited<ReturnType<typeof captureWorkingCopyAdmissionSnapshot>> | undefined;
        let backingState: 'cloned' | 'eager' | 'lazy-original';
        let encrypted = false;

        if (materializationMode === 'eager') {
            const cloneOutcome = await measureWorkingCopyPhase(phaseTimings, 'copy-on-write', () =>
                attemptWorkingCopyClone(originalPath, workingPath));
            if (cloneOutcome === 'known-unsupported') {
                await measureWorkingCopyPhase(phaseTimings, 'eager-copy', () =>
                    copyFileFromStableSource(originalPath, workingPath));
            }
            if (isPdf) {
                const decryption = await decryptPdfWorkingCopy(workingPath, password, phaseTimings, signal);
                encrypted = decryption.wasEncrypted;
            }
            backingState = cloneOutcome === 'cloned' && !encrypted ? 'cloned' : 'eager';
        } else {
            const cloneOutcome = await measureWorkingCopyPhase(phaseTimings, 'copy-on-write', () =>
                attemptWorkingCopyClone(originalPath, workingPath));
            if (cloneOutcome === 'known-unsupported') {
                const beforeProbe = await measureWorkingCopyPhase(phaseTimings, 'source-stat-before-probe', () =>
                    captureWorkingCopyAdmissionSnapshot(originalPath));
                encrypted = isPdf
                    ? await measureWorkingCopyPhase(phaseTimings, 'encryption-probe', () =>
                        isPdfFileEncrypted(originalPath))
                    : false;
                const afterProbe = await measureWorkingCopyPhase(phaseTimings, 'source-stat-after-probe', () =>
                    captureWorkingCopyAdmissionSnapshot(originalPath));
                if (!workingCopyAdmissionSnapshotsMatch(beforeProbe, afterProbe)) {
                    throw new WorkingCopyMaterializationError(
                        'SOURCE_BACKING_CHANGED',
                        'The original document changed while it was being opened',
                    );
                }
                admissionSnapshot = afterProbe;
                if (encrypted || !isPdf) {
                    await measureWorkingCopyPhase(phaseTimings, 'eager-copy', () =>
                        copyFileFromStableSource(originalPath, workingPath));
                    if (isPdf) {
                        const decryption = await decryptPdfWorkingCopy(
                            workingPath,
                            password,
                            phaseTimings,
                            signal,
                        );
                        encrypted = decryption.wasEncrypted;
                    }
                    backingState = 'eager';
                } else {
                    backingState = 'lazy-original';
                }
            } else {
                if (isPdf) {
                    const decryption = await decryptPdfWorkingCopy(workingPath, password, phaseTimings, signal);
                    encrypted = decryption.wasEncrypted;
                }
                backingState = cloneOutcome === 'cloned' && !encrypted ? 'cloned' : 'eager';
            }
        }

        await measureWorkingCopyPhase(phaseTimings, 'register-source', () => setWorkingCopyOriginalPath(
            workingPath,
            originalPath,
            ownerWebContentsId,
            {
                ...(admissionSnapshot ? {admissionSnapshot} : {}),
                backingState,
            },
        ));
        const revision = await measureWorkingCopyPhase(phaseTimings, 'revision-sidecar', () =>
            initializeFreshWorkingCopyRevision(workingPath, ownerWebContentsId));
        if (isPdf) {
            void schedulePageIdentityStoreInitialization(workingPath, revision, originalPath);
        }
        if (backingState === 'lazy-original' && materializationMode === 'background') {
            const backgroundMaterialization = startBackgroundWorkingCopyMaterialization(
                workingPath,
                ownerWebContentsId,
            );
            void backgroundMaterialization?.promise.catch(error => {
                logger.warn(`Background working-copy materialization failed: ${String(error)}`);
            });
        }

        logger.debug(`Working copy source-critical timings: ${JSON.stringify({
            deferredUntilNeeded: ['page-identity-on-mutation'],
            backingState,
            materializationMode,
            phases: phaseTimings,
            totalMs: Math.round((performance.now() - operationStartedAt) * 10) / 10,
            workingPath,
        })}`);
        return {
            workingPath,
            wasEncrypted: encrypted || undefined,
        };
    } catch (error) {
        await safeRemoveDirectory(workDir);
        throw error;
    }
}

export async function createWorkingCopyWithOutcome(
    originalPath: TOpenPath,
    ownerWebContentsId?: number,
    password?: string,
    signal?: AbortSignal,
) {
    return createWorkingCopyWithOutcomeInternal(
        originalPath,
        ownerWebContentsId,
        password,
        signal,
    );
}

export async function createWorkingCopy(
    originalPath: TOpenPath,
    ownerWebContentsId?: number,
    password?: string,
) {
    const result = await createWorkingCopyWithOutcome(originalPath, ownerWebContentsId, password);
    return result.workingPath;
}

export async function createWorkingCopyFromPath(
    sourcePath: TOpenPath,
    originalPath?: string,
    ownerWebContentsId?: number,
    options: {
        role?: TWorkingCopyRole;
        mapToSourceWhenOriginalMissing?: boolean;
        password?: string;
    } = {},
) {
    const explicitOriginalPath = typeof originalPath === 'string' && originalPath.trim().length > 0
        ? originalPath.trim()
        : undefined;
    const mappedOriginalPath = explicitOriginalPath
        ?? (options.mapToSourceWhenOriginalMissing === false ? undefined : sourcePath);
    if (mappedOriginalPath && !isAllowedOriginalSavePath(mappedOriginalPath)) {
        throw new Error('Invalid original path mapping');
    }

    const workDir = createWorkingDirectory();
    try {
        const fileName = basename(sourcePath);
        const normalizedName = fileName.toLowerCase().endsWith('.pdf')
            ? fileName
            : `${fileName}.pdf`;
        const workingPath = join(workDir, normalizedName);

        await copyFileCopyOnWrite(sourcePath, workingPath);
        if (workingPath.toLowerCase().endsWith('.pdf') && await isPdfFileEncrypted(workingPath)) {
            assertWorkingCopyDecryptionSucceeded(
                await decryptWorkingCopyWithWriter(workingPath, options.password),
            );
        }

        const role = options.role ?? resolveWorkingCopyRoleForPathClone(sourcePath, ownerWebContentsId);
        if (mappedOriginalPath) {
            await setWorkingCopyOriginalPath(workingPath, mappedOriginalPath, ownerWebContentsId, {
                backingState: 'eager',
                role,
            });
        }
        const revision = await initializeFreshWorkingCopyRevision(workingPath, ownerWebContentsId);
        const pageIdentitySourcePath = options.mapToSourceWhenOriginalMissing === false
            ? undefined
            : sourcePath;
        void schedulePageIdentityStoreInitialization(workingPath, revision, pageIdentitySourcePath);

        return workingPath;
    } catch (error) {
        await safeRemoveDirectory(workDir);
        throw error;
    }
}

/**
 * Clones a verified native staging artifact into an uncommitted snapshot.
 * The artifact is disposable, so it must not become the snapshot's backing
 * original when no live original path is available.
 */
export function createDisposableWorkingCopyFromPath(
    sourcePath: TOpenPath,
    originalPath: string | undefined,
    ownerWebContentsId?: number,
) {
    return createWorkingCopyFromPath(sourcePath, originalPath, ownerWebContentsId, {
        role: 'snapshot',
        mapToSourceWhenOriginalMissing: false,
    });
}

export async function createWorkingCopyFromData(
    fileName: string,
    data: Uint8Array,
    originalPath?: string,
    ownerWebContentsId?: number,
    password?: string,
) {
    const normalizedOriginalPath = typeof originalPath === 'string' && originalPath.trim().length > 0
        ? originalPath.trim()
        : null;
    if (normalizedOriginalPath && !isAllowedOriginalSavePath(normalizedOriginalPath)) {
        throw new Error('Invalid original path mapping');
    }

    const workDir = createWorkingDirectory();
    try {
        const baseName = basename(fileName);
        const normalizedName = baseName.toLowerCase().endsWith('.pdf')
            ? baseName
            : `${baseName}.pdf`;
        const workingPath = join(workDir, normalizedName);

        await writeFile(workingPath, data);
        if (workingPath.toLowerCase().endsWith('.pdf') && await isPdfFileEncrypted(workingPath)) {
            assertWorkingCopyDecryptionSucceeded(
                await decryptWorkingCopyWithWriter(workingPath, password),
            );
        }

        if (normalizedOriginalPath) {
            const role = isKnownWorkingCopyOriginalPath(normalizedOriginalPath, ownerWebContentsId) ? 'snapshot' : 'current';
            await setWorkingCopyOriginalPath(workingPath, normalizedOriginalPath, ownerWebContentsId, {
                backingState: 'eager',
                role,
            });
        }
        const revision = await initializeFreshWorkingCopyRevision(workingPath, ownerWebContentsId);
        void schedulePageIdentityStoreInitialization(workingPath, revision);

        return workingPath;
    } catch (error) {
        await safeRemoveDirectory(workDir);
        throw error;
    }
}

export async function ensureWorkingCopyDirectory(workingPath: string, senderWebContentsId?: number) {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }
    let mapping = getWorkingCopyOriginalPath(normalizedWorkingPath, senderWebContentsId);
    if (!mapping) {
        const pendingSync = readWorkingCopySyncRequiredJournalEntry(normalizedWorkingPath);
        if (
            pendingSync?.originalPath
            && (
                pendingSync.ownerWebContentsId === undefined
                || pendingSync.ownerWebContentsId === senderWebContentsId
            )
        ) {
            await setWorkingCopyOriginalPath(
                normalizedWorkingPath,
                pendingSync.originalPath,
                pendingSync.ownerWebContentsId,
            );
            mapping = getWorkingCopyOriginalPath(normalizedWorkingPath, senderWebContentsId);
        }
    }
    if (!mapping) {
        return false;
    }
    const { originalPath } = mapping;
    const backingEntry = getWorkingCopyBackingEntry(normalizedWorkingPath, senderWebContentsId);

    if (
        backingEntry?.backingState === 'lazy-original'
        || backingEntry?.backingState === 'materializing'
    ) {
        await ensureWorkingCopyMaterialized(normalizedWorkingPath, {
            ...(senderWebContentsId === undefined ? {} : {ownerWebContentsId: senderWebContentsId}),
            reason: 'page-operation',
        });
        return true;
    }

    const tempDir = normalizePathForLookup(getAppTempDir());
    const parentDir = normalizePathForLookup(dirname(normalizedWorkingPath));
    const relativePath = relative(tempDir, parentDir);
    const isWithinTemp = (
        relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
    );
    if (!isWithinTemp || !isWorkingCopyDirectoryName(basename(parentDir))) {
        throw new WorkingCopyMissingError('Working copy path is not a managed temp working directory');
    }

    if (existsSync(parentDir) && existsSync(normalizedWorkingPath)) {
        return true;
    }
    if (!existsSync(originalPath)) {
        throw new WorkingCopyMissingError('Working copy directory was removed and the original file is unavailable');
    }

    const parentExisted = existsSync(parentDir);
    try {
        mkdirSync(parentDir, { recursive: true });
        await copyFileCopyOnWrite(originalPath, normalizedWorkingPath);
        if (normalizedWorkingPath.toLowerCase().endsWith('.pdf')
            && await isPdfFileEncrypted(normalizedWorkingPath)) {
            assertWorkingCopyDecryptionSucceeded(
                await decryptWorkingCopyWithWriter(normalizedWorkingPath),
            );
        }
        if (mapping.retired) {
            const role = getWorkingCopyRole(normalizedWorkingPath, senderWebContentsId) ?? 'current';
            await setWorkingCopyOriginalPath(normalizedWorkingPath, originalPath, mapping.ownerWebContentsId, {role});
            forgetRetiredWorkingCopyOriginal(normalizedWorkingPath);
        }
        if (normalizedWorkingPath.toLowerCase().endsWith('.pdf')) {
            const revision = await ensureWorkingCopyRevision(normalizedWorkingPath, senderWebContentsId);
            void schedulePageIdentityStoreInitialization(normalizedWorkingPath, revision, originalPath);
        }
        await markWorkingCopyContentChanged(normalizedWorkingPath, 'replace-working-copy', senderWebContentsId);
        logger.warn(`Recreated missing working copy directory for "${normalizedWorkingPath}"`);
        return true;
    } catch (error) {
        await rm(normalizedWorkingPath, {force: true}).catch(() => undefined);
        if (!parentExisted) {
            await rmdir(parentDir).catch(() => undefined);
        }
        throw error;
    }
}

export async function requireManagedWorkingCopyPath(sourcePath: string, senderWebContentsId?: number): Promise<TOpenPath> {
    const normalizedSourcePath = typeof sourcePath === 'string' ? sourcePath.trim() : '';
    if (!normalizedSourcePath) {
        throw new Error('Invalid source path');
    }
    const backingEntry = getWorkingCopyBackingEntry(normalizedSourcePath, senderWebContentsId);
    if (
        backingEntry?.backingState === 'lazy-original'
        || backingEntry?.backingState === 'materializing'
    ) {
        return normalizedSourcePath as TOpenPath;
    }
    const isManagedWorkingCopy = await ensureWorkingCopyDirectory(normalizedSourcePath, senderWebContentsId);
    if (!isManagedWorkingCopy) {
        throw new Error('Source path is not a managed working copy');
    }
    if (!existsSync(normalizedSourcePath)) {
        throw new Error(`File not found: ${normalizedSourcePath}`);
    }
    return normalizedSourcePath as TOpenPath;
}
