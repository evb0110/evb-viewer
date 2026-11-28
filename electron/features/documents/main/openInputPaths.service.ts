import {getAppTempDir} from '@electron/utils/appTempDir';
import {usingManagedScratchScope} from '@electron/utils/managedScratchTemp';
import {existsSync} from 'fs';
import {stat} from 'fs/promises';
import {randomUUID} from 'node:crypto';
import {basename, join} from 'path';
import {
    buildCombinedPdfOutputPath,
    createPdfFileFromInputPaths,
    type ICreatePdfFromInputPathsProgress,
    isDjvuPath,
    isPdfPath,
    isSupportedOpenPath,
} from '@electron/image/pdfConversion';
import {createDocumentFromFile, openFileAsDocument} from '@electron/features/documents/main/documentWorkingCopyHandlers';
import {PdfDecryptAttemptError} from '@electron/file-access/workingCopyDecryption';
import {DocumentOpenRefusalError} from '@contracts/documentOpenErrors';
import {
    cleanupWorkingCopy,
    documentRevisionToken,
    getWorkingCopyBackingEntry,
    runWithWorkingCopyReadBacking,
} from '@electron/file-access/documentStore';
import {allowOpenPaths, requireOpenPath} from '@electron/file-access/openPathCapabilities';
import {te} from '@electron/te';
import {createLogger} from '@electron/utils/createLogger';
import {addRecentInputs} from '@electron/features/documents/main/addRecentInputs.service';
import {getErrorMessage} from '@electron/utils/error';
import {normalizeExistingPath} from '@electron/utils/normalizeExistingPath';
import {isReservedTempPath} from '@electron/utils/pathValidator';
import {MAX_DOCUMENT_ALLOCATION_BYTES, type TOpenFileResult} from '@contracts/electronApiDocuments';
import {requireDocumentRef} from '@contracts/documentRef';
import type {TOpenPathOwner} from '@electron/features/documents/main/openPathOwner';
import {registerMainOperation} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {abortErrorFromSignal} from '@electron/utils/abort';
import {mainJobBroker, type IJobResourceVector} from '@electron/resources/jobBroker';
import {assertOpenInputPathCount, MAX_COMBINE_INPUT_PATHS} from '@electron/features/documents/public/assertOpenInputPathCount';
import {isScanCleanupGeneratedOutputPath, touchScanCleanupGeneratedOutput} from '@electron/features/scan-cleanup/public/generatedOutputs';
import {findKeptOriginal} from '@electron/file-access/keptOriginalNotices';
import {readExactPageGeometry, registerNativePdfSenderCleanup} from '@electron/features/documents/main/nativePdfMetadata';
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
    /** False when a session restore reopens a held tab: Recent Files keeps its last real open. */
    recordRecent?: boolean;
}

function getOwnerWebContentsId(owner?: TOpenPathOwner) {
    return typeof owner === 'number' ? owner : owner?.id;
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function createOpenInputPathsAbortLifecycle(owner: TOpenPathOwner | undefined, operationPath: string, externalSignal?: AbortSignal) {
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: getOwnerWebContentsId(owner),
        workingCopyPath: operationPath,
    });
    const stopSenderLifetime = registerNativePdfSenderCleanup(
        typeof owner === 'object' ? owner : undefined,
        mainOperation.abort,
        'Renderer navigation canceled open input paths operation',
    );
    return {
        signal: AbortSignal.any([mainOperation.signal, ...(externalSignal ? [externalSignal] : [])]),
        cleanup: () => {
            stopSenderLifetime();
            mainOperation.complete();
        },
    };
}

function probeInputFileSize(filePath: string) {
    return stat(filePath).then(
        (fileStat) => fileStat.size,
        () => 0,
    );
}

function createPdfNativeWriteResources(inputBytes: number): IJobResourceVector {
    return {
        cpuTokens: 1,
        estimatedResidentBytes: Math.min(256 * 1024 * 1024, Math.max(32 * 1024 * 1024, Math.ceil(inputBytes / 2))),
        nativeProcesses: 1,
        ioWeight: 4,
    };
}

export async function openInputPaths(
    paths: string[],
    options: IOpenInputPathsOptions = {},
    owner?: TOpenPathOwner,
): Promise<TOpenFileResult | null> {
    const normalizedPaths = paths
        .filter((path) => typeof path === 'string' && path.length > 0)
        .map((path) => normalizeExistingPath(path) ?? path);
    if (normalizedPaths.length === 0) {
        return null;
    }
    assertOpenInputPathCount(normalizedPaths, options.forceCombine ? MAX_COMBINE_INPUT_PATHS : undefined);

    if (normalizedPaths.some((path) => !existsSync(path))) {
        throw new Error(te('errors.file.invalid'));
    }

    if (
        paths.some((path) => typeof path === 'string' && path.length > 0 && isReservedTempPath(path)) ||
        normalizedPaths.some((path) => !isSupportedOpenPath(path) || isReservedTempPath(path))
    ) {
        throw new Error(te('errors.file.invalid'));
    }

    allowOpenPaths(normalizedPaths, owner);

    const djvuPaths = normalizedPaths.filter((path) => isDjvuPath(path));
    if (!options.forceCombine && normalizedPaths.length === 1 && djvuPaths.length === 1) {
        const djvuPath = djvuPaths[0]!;
        const trustedDjvuPath = requireOpenPath(djvuPath, owner);
        if (options.recordRecent !== false) {
            persistRecentInputsAfterOpen([djvuPath], owner);
        }
        return {
            kind: 'djvu',
            workingPath: '',
            originalPath: requireDocumentRef(trustedDjvuPath),
        };
    }

    if (!options.forceCombine && normalizedPaths.length === 1 && isPdfPath(normalizedPaths[0]!)) {
        return openSinglePdfInputPath(normalizedPaths[0]!, options, owner);
    }

    return openCombinedInputPaths(normalizedPaths, options, owner);
}

async function openSinglePdfInputPath(
    originalPath: string,
    options: IOpenInputPathsOptions,
    owner?: TOpenPathOwner,
): Promise<TOpenFileResult> {
    const startedAt = performance.now();
    const isGenerated = isScanCleanupGeneratedOutputPath(originalPath);
    const ownerWebContentsId = getOwnerWebContentsId(owner);
    const lifecycle = createOpenInputPathsAbortLifecycle(owner, originalPath, options.signal);
    const {signal} = lifecycle;
    let openLease: Awaited<ReturnType<typeof mainJobBroker.acquire>> | null = null;
    const admitNative = async (kind: string, resources: IJobResourceVector) => {
        openLease?.release();
        openLease = null;
        const timeoutController = new AbortController();
        const timeoutTimer = setTimeout(() => {
            timeoutController.abort(new Error(`PDF open admission for ${kind} timed out after ${PDF_OPEN_ADMISSION_TIMEOUT_MS}ms`));
        }, PDF_OPEN_ADMISSION_TIMEOUT_MS);
        timeoutTimer.unref?.();
        try {
            openLease = await mainJobBroker.acquire({
                ownerId: `pdf-open:${ownerWebContentsId ?? 'main'}`,
                kind,
                priority: 'foreground',
                perOwnerLimit: 1,
                signal: AbortSignal.any([signal, timeoutController.signal]),
                resources,
            });
        } finally {
            clearTimeout(timeoutTimer);
        }
    };
    // A canceled copy must finish before this owner disposes of it.
    let unclaimedPath: string | null = null;
    const geometry: {read?: Promise<Awaited<ReturnType<typeof readExactPageGeometry>> | null>} = {};
    const geometryGroup = `pdf-open-geometry:${randomUUID()}`;
    const settleOpeningGeometry = async () => {
        cancelNativeCommandGroup(geometryGroup);
        await geometry.read?.catch((error) => {
            if (getUnprovenNativeTerminationDetail(error) !== undefined) {
                throw error;
            }
        });
    };
    try {
        throwIfAborted(signal);
        const inputBytes = await probeInputFileSize(originalPath);
        const admissionTimeoutSignal = AbortSignal.timeout(PDF_OPEN_ADMISSION_TIMEOUT_MS);
        openLease = await mainJobBroker.acquire({
            ownerId: `pdf-open:${ownerWebContentsId ?? 'main'}`,
            kind: 'pdf-working-copy',
            priority: 'foreground',
            admissionClass: 'interactive',
            perOwnerLimit: 1,
            signal: AbortSignal.any([signal, admissionTimeoutSignal]),
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
            const opened = await openFileAsDocument(trustedOriginalPath, ownerWebContentsId, {
                password: options.password,
                signal,
                admitRewrite: () => admitNative('pdf-open-rewrite', createPdfNativeWriteResources(inputBytes)),
            });
            const {entry} = opened;
            unclaimedPath = entry.ref;
            throwIfAborted(signal);
            if (inputBytes > MAX_DOCUMENT_ALLOCATION_BYTES) {
                try {
                    await admitNative('pdf-opening-geometry', {
                        cpuTokens: 1,
                        estimatedResidentBytes: 256 * 1024 * 1024,
                        nativeProcesses: 1,
                        ioWeight: 2,
                    });
                    geometry.read = runWithWorkingCopyReadBacking(entry.ref, (path) =>
                        readExactPageGeometry(path, signal, geometryGroup),
                    ).catch((error) => {
                        if (
                            signal.aborted ||
                            error instanceof NativeToolBuildMismatchError ||
                            getUnprovenNativeTerminationDetail(error) !== undefined
                        ) {
                            throw error;
                        }
                        logger.warn('Opening geometry unavailable', {error: getErrorMessage(error)});
                        return null;
                    });
                } catch (error) {
                    if (signal.aborted) {
                        throw error;
                    }
                    logger.warn('Opening geometry admission unavailable', {error: getErrorMessage(error)});
                }
            }
            const revisionToken = documentRevisionToken(entry);
            const pages = await geometry.read;
            throwIfAborted(signal);
            if (
                pages &&
                getWorkingCopyBackingEntry(entry.ref, ownerWebContentsId) === entry &&
                documentRevisionToken(entry) === revisionToken
            ) {
                entry.openingPageGeometry = {
                    kind: 'exact',
                    documentRef: requireDocumentRef(entry.ref),
                    documentRevisionToken: revisionToken,
                    pageCount: pages.length,
                    pages,
                };
            }
            if (isGenerated) {
                // Opening a generated output renews its retention window.
                await touchScanCleanupGeneratedOutput(originalPath);
            } else if (options.recordRecent !== false) {
                persistRecentInputsAfterOpen([originalPath], owner);
            }
            throwIfAborted(signal);
            logger.debug('PDF input source-critical timings', {
                recentPersistence: 'background',
                totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
            });
            const keptOriginalPath = isGenerated ? undefined : await findKeptOriginal(originalPath);
            throwIfAborted(signal);
            const result: TOpenFileResult = {
                kind: 'pdf',
                workingPath: requireDocumentRef(entry.ref),
                originalPath: requireDocumentRef(originalPath),
                ...(isGenerated ? {isGenerated: true} : {}),
                ...(opened.wasEncrypted ? {wasEncrypted: true as const} : {}),
                ...(keptOriginalPath ? {keptOriginalPath: requireDocumentRef(keptOriginalPath)} : {}),
            };
            unclaimedPath = null;
            return result;
        } catch (error) {
            if (error instanceof PdfDecryptAttemptError) {
                return {
                    kind: error.outcome === 'needs-password' ? 'pdf-needs-password' : 'pdf-unsupported-encryption',
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
            await cleanupWorkingCopy(unclaimedPath, ownerWebContentsId).catch((error) => {
                logger.warn('Failed to clean unclaimed PDF copy', {error: getErrorMessage(error)});
            });
        }
    }
}

async function openCombinedInputPaths(
    normalizedPaths: string[],
    options: IOpenInputPathsOptions,
    owner?: TOpenPathOwner,
): Promise<TOpenFileResult> {
    const outputPath = buildCombinedPdfOutputPath(normalizedPaths);
    const workingPath = await usingManagedScratchScope('pdfExport-scope-', getAppTempDir(), async (tempDir) => {
        let lifecycle: ReturnType<typeof createOpenInputPathsAbortLifecycle> | null = null;
        try {
            lifecycle = createOpenInputPathsAbortLifecycle(owner, outputPath, options.signal);
            const {signal} = lifecycle;
            const combinedInputBytes = (await Promise.all(normalizedPaths.map(probeInputFileSize))).reduce(
                (total, size) => total + size,
                0,
            );
            return await mainJobBroker.run(
                {
                    ownerId: `pdf-combine:${getOwnerWebContentsId(owner) ?? 'main'}`,
                    kind: 'pdf-combine',
                    priority: 'user',
                    perOwnerLimit: 1,
                    signal,
                    resources: createPdfNativeWriteResources(combinedInputBytes),
                },
                async (brokerRun) => {
                    const tempOutputPath = join(tempDir, basename(outputPath));
                    throwIfAborted(signal);
                    await createPdfFileFromInputPaths(normalizedPaths, tempOutputPath, {
                        ...(options.onCombineProgress ? {onProgress: options.onCombineProgress} : {}),
                        brokerRun,
                        signal,
                    });
                    throwIfAborted(signal);
                    logger.info('Created combined PDF for input batch', {outputPath});
                    allowOpenPaths([tempOutputPath], owner);
                    const trustedTempOutputPath = requireOpenPath(tempOutputPath, owner);
                    return (await createDocumentFromFile(trustedTempOutputPath, outputPath, getOwnerWebContentsId(owner))).ref;
                },
            );
        } finally {
            lifecycle?.cleanup();
        }
    });

    return {
        kind: 'pdf',
        workingPath: requireDocumentRef(workingPath),
        originalPath: requireDocumentRef(outputPath),
        isGenerated: true,
    };
}

function persistRecentInputsAfterOpen(paths: string[], owner?: TOpenPathOwner) {
    void addRecentInputs(paths, owner).catch((error) => {
        logger.warn('Failed to persist opened input in Recent Files', {error: getErrorMessage(error)});
    });
}
