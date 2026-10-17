import { getAppTempDir } from '@electron/utils/appTempDir';
import { usingManagedScratchScope } from '@electron/utils/managedScratchTemp';
import { existsSync } from 'fs';
import {stat} from 'fs/promises';
import {randomUUID} from 'node:crypto';
import {
    basename,
    join,
} from 'path';
import {
    buildCombinedPdfOutputPath,
    createPdfFileFromInputPaths,
    type ICreatePdfFromInputPathsProgress,
    isDjvuPath,
    isPdfPath,
    isSupportedOpenPath,
} from '@electron/image/pdfConversion';
import {
    createWorkingCopyFromPath,
    createWorkingCopyWithOutcome,
} from '@electron/file-access/workingCopyCreation';
import {PdfDecryptAttemptError} from '@electron/file-access/workingCopyDecryption';
import {DocumentOpenRefusalError} from '@contracts/documentOpenErrors';
import { cleanupWorkingCopy } from '@electron/file-access/workingCopyCleanup';
import {
    allowOpenPaths,
    requireOpenPath,
} from '@electron/file-access/openPathCapabilities';
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { addRecentInputs } from '@electron/features/documents/main/addRecentInputs.service';
import {getErrorMessage} from '@electron/utils/error';
import { normalizeExistingPath } from '@electron/utils/normalizeExistingPath';
import {
    MAX_DOCUMENT_ALLOCATION_BYTES, type TOpenFileResult,
} from '@contracts/electronApiDocuments';
import {requireDocumentRef} from '@contracts/documentRef';
import type { TOpenPathOwner } from '@electron/features/documents/main/openPathOwner';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
import { abortErrorFromSignal } from '@electron/utils/abort';
import {
    mainJobBroker, type IJobResourceVector,
} from '@electron/resources/jobBroker';
import {
    assertOpenInputPathCount,
    MAX_COMBINE_INPUT_PATHS,
} from '@electron/features/documents/public/assertOpenInputPathCount';
import {
    isScanCleanupGeneratedOutputPath,
    touchScanCleanupGeneratedOutput,
} from '@electron/features/scan-cleanup/public/generatedOutputs';
import {findKeptOriginal} from '@electron/file-access/keptOriginalNotices';
import {
    readExactPageGeometry, registerNativePdfSenderCleanup,
} from '@electron/features/documents/main/nativePdfMetadata';
import {getWorkingCopyBackingEntry} from '@electron/file-access/workingCopyStore';
import {isWorkingCopyRevisionCurrent} from '@electron/file-access/documentRevisionStore';
import {cancelNativeCommandGroup} from '@electron/native-tools/runNativeCommand';
import {NativeToolBuildMismatchError} from '@electron/native-tools/runNativeToolCommand';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';

const PDF_OPEN_ADMISSION_TIMEOUT_MS = 15_000;

const logger = createLogger('documents-open-service');

interface IOpenInputPathsOptions {
    onCombineProgress?: (progress: ICreatePdfFromInputPathsProgress) => void;
    signal?: AbortSignal;
    forceCombine?: boolean;
    password?: string;
}

function getOwnerWebContentsId(owner?: TOpenPathOwner) {
    return typeof owner === 'number' ? owner : owner?.id;
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function createOpenInputPathsAbortLifecycle(
    owner: TOpenPathOwner | undefined,
    operationPath: string,
    externalSignal?: AbortSignal,
) {
    const controller = new AbortController();
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: getOwnerWebContentsId(owner),
        workingCopyPath: operationPath,
    });
    const stopSenderLifetime = registerNativePdfSenderCleanup(
        typeof owner === 'object' ? owner : undefined,
        reason => controller.abort(new Error(reason)),
        'Renderer navigation canceled open input paths operation',
    );
    return {
        signal: AbortSignal.any([
            controller.signal,
            mainOperation.signal,
            ...(externalSignal ? [externalSignal] : []),
        ]),
        cleanup: () => {
            controller.abort();
            stopSenderLifetime();
            mainOperation.complete();
        },
    };
}

export async function openInputPaths(
    paths: string[],
    options: IOpenInputPathsOptions = {},
    owner?: TOpenPathOwner,
): Promise<TOpenFileResult | null> {
    const normalizedPaths = paths.filter(path => typeof path === 'string' && path.length > 0)
        .map(path => normalizeExistingPath(path) ?? path);
    if (normalizedPaths.length === 0) {
        return null;
    }
    assertOpenInputPathCount(
        normalizedPaths,
        options.forceCombine ? MAX_COMBINE_INPUT_PATHS : undefined,
    );

    if (normalizedPaths.some(path => !existsSync(path))) {
        throw new Error(te('errors.file.invalid'));
    }

    if (normalizedPaths.some(path => !isSupportedOpenPath(path))) {
        throw new Error(te('errors.file.invalid'));
    }

    allowOpenPaths(normalizedPaths, owner);

    const djvuPaths = normalizedPaths.filter(path => isDjvuPath(path));
    if (!options.forceCombine && djvuPaths.length > 0 && normalizedPaths.length === 1 && djvuPaths.length === 1) {
        const djvuPath = djvuPaths[0]!;
        const trustedDjvuPath = requireOpenPath(djvuPath, owner);
        persistRecentInputsAfterOpen([djvuPath], owner);
        return {
            kind: 'djvu',
            workingPath: '',
            originalPath: requireDocumentRef(trustedDjvuPath),
        };
    }

    if (!options.forceCombine && normalizedPaths.length === 1 && isPdfPath(normalizedPaths[0]!)) {
        const startedAt = performance.now();
        const originalPath = normalizedPaths[0]!;
        const isGenerated = isScanCleanupGeneratedOutputPath(originalPath);
        const ownerWebContentsId = getOwnerWebContentsId(owner);
        const lifecycle = createOpenInputPathsAbortLifecycle(owner, originalPath, options.signal);
        const { signal } = lifecycle;
        let openLease: Awaited<ReturnType<typeof mainJobBroker.acquire>> | null = null;
        const admitNative = async (kind: string, resources: IJobResourceVector) => {
            openLease?.release();
            openLease = null;
            openLease = await mainJobBroker.acquire({
                ownerId: `pdf-open:${ownerWebContentsId ?? 'main'}`,
                kind,
                priority: 'foreground',
                perOwnerLimit: 1,
                signal,
                resources,
            });
        };
        // A canceled copy must finish before this owner disposes of it.
        let unclaimedPath: string | null = null;
        const geometry: {read?: Promise<Awaited<ReturnType<typeof readExactPageGeometry>> | null>} = {};
        const geometryGroup = `pdf-open-geometry:${randomUUID()}`;
        const settleOpeningGeometry = async () => {
            cancelNativeCommandGroup(geometryGroup);
            await geometry.read?.catch(error => {
                if (getUnprovenNativeTerminationDetail(error) !== undefined) throw error;
            });
        };
        try {
            throwIfAborted(signal);
            const inputBytes = await stat(originalPath).then(fileStat => fileStat.size, () => 0);
            const admissionTimeoutSignal = AbortSignal.timeout(PDF_OPEN_ADMISSION_TIMEOUT_MS);
            openLease = await mainJobBroker.acquire({
                ownerId: `pdf-open:${ownerWebContentsId ?? 'main'}`,
                kind: 'pdf-working-copy',
                priority: 'foreground',
                admissionClass: 'interactive',
                perOwnerLimit: 1,
                signal: AbortSignal.any([
                    signal,
                    admissionTimeoutSignal,
                ]),
                resources: {
                    cpuTokens: 0,
                    estimatedResidentBytes: Math.min(64 * 1024 * 1024, Math.max(4 * 1024 * 1024, inputBytes / 64)),
                    nativeProcesses: 0,
                    ioWeight: 1,
                },
            });
            throwIfAborted(signal);
            try {
                const trustedOriginalPath = requireOpenPath(originalPath, owner);
                const workingCopy = await createWorkingCopyWithOutcome(
                    trustedOriginalPath,
                    ownerWebContentsId,
                    options.password,
                    signal,
                    () => admitNative('pdf-open-rewrite', {
                        cpuTokens: 1,
                        estimatedResidentBytes: Math.min(
                            256 * 1024 * 1024,
                            Math.max(32 * 1024 * 1024, Math.ceil(inputBytes / 2)),
                        ),
                        nativeProcesses: 1,
                        ioWeight: 4,
                    }),
                    inputBytes > MAX_DOCUMENT_ALLOCATION_BYTES ? async workingPath => {
                        await admitNative('pdf-opening-geometry', {
                            cpuTokens: 2,
                            estimatedResidentBytes: 256 * 1024 * 1024,
                            nativeProcesses: 1,
                            ioWeight: 2,
                        });
                        geometry.read = readExactPageGeometry(workingPath, signal, geometryGroup).catch(error => {
                            if (signal.aborted || error instanceof NativeToolBuildMismatchError || getUnprovenNativeTerminationDetail(error) !== undefined) throw error;
                            logger.warn('Opening geometry unavailable', {error: getErrorMessage(error)});
                            return null;
                        });
                        void geometry.read.catch(() => undefined);
                        return settleOpeningGeometry;
                    } : undefined,
                );
                unclaimedPath = workingCopy.workingPath;
                throwIfAborted(signal);
                const entry = getWorkingCopyBackingEntry(unclaimedPath, ownerWebContentsId);
                const pages = await geometry.read;
                throwIfAborted(signal);
                if (pages && entry && await isWorkingCopyRevisionCurrent(unclaimedPath, workingCopy.revision.token)
                    && getWorkingCopyBackingEntry(unclaimedPath, ownerWebContentsId) === entry) {
                    entry.openingPageGeometry = {
                        kind: 'exact',
                        documentRef: requireDocumentRef(unclaimedPath),
                        documentRevisionToken: workingCopy.revision.token,
                        pageCount: pages.length,
                        pages,
                    };
                }
                if (isGenerated) {
                    // Opening a generated output renews its retention window.
                    await touchScanCleanupGeneratedOutput(originalPath);
                } else {
                    persistRecentInputsAfterOpen([originalPath], owner);
                }
                throwIfAborted(signal);
                logger.debug('PDF input source-critical timings', {
                    recentPersistence: 'background',
                    totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
                });
                const keptOriginalPath = isGenerated ? undefined : await findKeptOriginal(originalPath);
                const result: TOpenFileResult = {
                    kind: 'pdf',
                    workingPath: requireDocumentRef(unclaimedPath),
                    originalPath: requireDocumentRef(originalPath),
                    ...(isGenerated ? {isGenerated: true} : {}),
                    ...(workingCopy.wasEncrypted ? {wasEncrypted: true as const} : {}),
                    ...(keptOriginalPath ? {keptOriginalPath: requireDocumentRef(keptOriginalPath)} : {}),
                };
                unclaimedPath = null;
                return result;
            } catch (error) {
                if (error instanceof PdfDecryptAttemptError) {
                    return {
                        kind: error.outcome === 'needs-password'
                            ? 'pdf-needs-password'
                            : 'pdf-unsupported-encryption',
                        originalPath: requireDocumentRef(originalPath),
                    };
                }
                // Refusals name the selected source.
                throw error instanceof DocumentOpenRefusalError
                    ? new DocumentOpenRefusalError(error.code, error.message, {
                        cause: error.cause,
                        fileName: basename(originalPath),
                    })
                    : error;
            }
        } finally {
            try {
                await settleOpeningGeometry();
            } finally {
                openLease?.release();
                lifecycle.cleanup();
            }
            if (unclaimedPath) {
                await cleanupWorkingCopy(unclaimedPath, ownerWebContentsId)
                    .catch(error => {
                        logger.warn('Failed to clean unclaimed PDF copy', {error: getErrorMessage(error)});
                    });
            }
        }
    }

    const outputPath = buildCombinedPdfOutputPath(normalizedPaths);
    const workingPath = await usingManagedScratchScope('pdfExport-scope-', getAppTempDir(), async tempDir => {
        let lifecycle: ReturnType<typeof createOpenInputPathsAbortLifecycle> | null = null;
        let brokerLease: Awaited<ReturnType<typeof mainJobBroker.acquire>> | null = null;
        let workingPath: string;
        try {
            lifecycle = createOpenInputPathsAbortLifecycle(
                owner,
                outputPath,
                options.signal,
            );
            const { signal } = lifecycle;
            const combinedInputBytes = await Promise.all(normalizedPaths.map(path => stat(path)
                .then(fileStat => fileStat.size, () => 0)))
                .then(sizes => sizes.reduce((total, size) => total + size, 0));
            brokerLease = await mainJobBroker.acquire({
                ownerId: `pdf-combine:${getOwnerWebContentsId(owner) ?? 'main'}`,
                kind: 'pdf-combine',
                priority: 'user',
                perOwnerLimit: 1,
                signal,
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: Math.min(
                        256 * 1024 * 1024,
                        Math.max(32 * 1024 * 1024, Math.ceil(combinedInputBytes / 2)),
                    ),
                    nativeProcesses: 1,
                    ioWeight: 4,
                },
            });
            const tempOutputPath = join(tempDir, basename(outputPath));
            throwIfAborted(signal);
            await createPdfFileFromInputPaths(
                normalizedPaths,
                tempOutputPath,
                {
                    ...(options.onCombineProgress ? { onProgress: options.onCombineProgress } : {}),
                    signal,
                },
            );
            throwIfAborted(signal);
            logger.info('Created combined PDF for input batch', {outputPath});
            allowOpenPaths([tempOutputPath], owner);
            const trustedTempOutputPath = requireOpenPath(tempOutputPath, owner);
            workingPath = await createWorkingCopyFromPath(
                trustedTempOutputPath,
                outputPath,
                getOwnerWebContentsId(owner),
            );
        } finally {
            brokerLease?.release();
            lifecycle?.cleanup();
        }

        return workingPath;
    });

    return {
        kind: 'pdf',
        workingPath: requireDocumentRef(workingPath),
        originalPath: requireDocumentRef(outputPath),
        isGenerated: true,
    };
}

function persistRecentInputsAfterOpen(paths: string[], owner?: TOpenPathOwner) {
    void addRecentInputs(paths, owner).catch(error => {
        logger.warn('Failed to persist opened input in Recent Files', {error: getErrorMessage(error)});
    });
}
