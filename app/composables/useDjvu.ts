import {isAbortError} from '@contracts/isAbortError';
import {getErrorMessage} from '@app/utils/error';
import type {TDocumentRef} from '@contracts/documentRef';
import {parseDocumentRef} from '@contracts/documentRef';
import {createRequestId, type TRequestId} from '@contracts/shared';
import {SerializableError} from '@contracts/serializableError';
import {getFailureReceipt, isExpectedOutcome, type ExpectedOutcome, type FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {getPerformanceProfile} from '@app/utils/performanceProfile';
import type {
    IDjvuConvertResult,
    IDjvuJobStartHandle,
    IDjvuOpenResult,
    IDjvuProgress,
    IDjvuPageSize,
    TDjvuPdfExportStrategy,
} from '@contracts/electronApiDjvu';
import {normalizeDjvuPdfSubsample, resolveDjvuPdfExportStrategy} from '@contracts/djvuConversionPolicy';
import {didOpenDocument, type TDocumentOpenOutcome} from '@app/types/documentOpenOutcome';
import type {IPdfRasterDisplayProfileOpenOptions, TPdfRasterDisplayProfile} from '@app/types/pdfRasterDisplayProfile';
import {
    createDocumentProjectionSession,
    ensurePdfProjection,
    PDF_SOURCE_CAPABILITIES,
    resolveDjvuPageSizeInPoints,
    type IDocumentOpenSurfaceSession,
    type IDocumentPageSource,
    type IDocumentProjectionSession,
    type IDocumentSourceCapabilities,
    type TPdfProjectionReason,
} from '@app/modules/document-viewer/public';
import {
    normalizePdfRasterSourcePagePixels,
    registerPdfRasterDisplayProfile,
    unregisterPdfRasterDisplayProfiles,
} from '@app/types/pdfRasterDisplayProfile';
import {type IDocumentSourceActivation, useDocumentSourceSession} from '@app/modules/workspace-shell/public/useDocumentSourceSession';
import {BrowserLogger} from '@app/utils/browserLogger';
import {waitForVisualFrames} from '@app/utils/asyncHelpers';
import {useFailureToast} from '@app/composables/useFailureToast';
import {getDocumentRefBaseName, isBrowserDocumentRef} from '@app/utils/documentRef';
import {getDjvuCapability} from '@app/utils/getDjvuCapability';
import {JobCanceledError, runJob, type IJobRun} from '@app/utils/jobs/runJob';
import {getDocumentFilesCapability, getDocumentWorkingCopyCapability} from '@app/utils/platformDocuments';

interface IDjvuConversionState {
    isConverting: boolean;
    phase: 'converting' | 'assembling' | 'bookmarks' | 'optimizing' | null;
    percent: number;
}

export interface IDjvuSourceSnapshot {
    readonly isDjvuMode: boolean;
    readonly sourcePath: TDocumentRef | null;
    readonly openingPath: TDocumentRef | null;
    readonly sourceError: string | null;
    readonly sourceSizeBytes: number | null;
}

export interface IOpenDjvuFileOptions {
    /** Runs once main accepts the DjVu, with its page count, before its pages are shown. */
    closeActiveDocument?: (pageCount: number | null) => void | Promise<void>;
    setOriginalPath?: (path: TDocumentRef | null) => void;
}

type TOpenConvertedPdf = (path: TDocumentRef, options?: IPdfRasterDisplayProfileOpenOptions) => Promise<TDocumentOpenOutcome>;

type TSupersededOpenReason = 'stale-after-native-result' | 'stale-after-pdf-close' | 'stale-before-source-activation';

function isPromiseLike(value: unknown): value is PromiseLike<void> {
    return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

function getDjvuExpectedOutcome(value: unknown): ExpectedOutcome | undefined {
    if (typeof value !== 'object' || value === null || !('expected' in value)) {
        return undefined;
    }
    return isExpectedOutcome(value.expected) ? value.expected : undefined;
}

/**
 * A refused DjVu open as an error the document-open classifier can localize:
 * its typed reason, the diagnostic message and one failure receipt, reusing
 * main's receipt instead of capturing the same failure again.
 */
function createDjvuOpenFailure(result: IDjvuOpenResult, fallbackMessage: string) {
    const message = result.error ?? fallbackMessage;
    const failure = BrowserLogger.error(
        'djvu',
        'Open failed',
        message,
        getFailureReceipt(result) ?? {code: 'RENDERER_DJVU_OPERATION_FAILED'},
    );
    const error = result.errorEnvelope ? new SerializableError(result.errorEnvelope) : new Error(message);
    return Object.assign(error, {failure});
}

function classifyDjvuConversionExpectedOutcome(error: unknown): ExpectedOutcome | undefined {
    if (
        isAbortError(error) ||
        (error instanceof Error && error.name === 'DjvuCanceledError') ||
        (error instanceof Error && getErrorMessage(error).trim().toLowerCase() === 'djvu conversion canceled')
    ) {
        return {
            kind: 'expected',
            code: 'canceled',
        };
    }
    return undefined;
}

const DJVU_JOB_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1_000;

const DJVU_PROJECTION_SOURCE_CAPABILITIES = {
    annotations: false,
    directImageExport: true,
    outline: true,
    pageEdits: false,
    search: true,
    text: true,
} as const satisfies IDocumentSourceCapabilities;

function createProjectionSourceIdentity(kind: IDocumentPageSource['kind'], documentRef: TDocumentRef): IDocumentPageSource {
    const unavailable = () => Promise.reject(new Error('Projection source identity cannot render pages'));
    return {
        kind,
        documentRef,
        pageCount: 0,
        getPageMetrics: unavailable,
        renderPage: unavailable,
        dispose() {},
    };
}

function createDjvuProjectionSession(sourcePath: TDocumentRef) {
    return createDocumentProjectionSession({
        id: `djvu:${String(sourcePath)}`,
        originalRef: sourcePath,
        source: createProjectionSourceIdentity('djvu', sourcePath),
        capabilities: DJVU_PROJECTION_SOURCE_CAPABILITIES,
    });
}

function ensurePdfSuggestedName(name: string) {
    const trimmedName = name.trim();
    const safeName = trimmedName.length > 0 ? trimmedName : 'document';
    return /\.pdf$/i.test(safeName) ? safeName : `${safeName}.pdf`;
}

function createTrustedRasterDjvuPdfDisplayProfile(
    pageSizes: readonly IDjvuPageSize[],
    options: {
        pdfStrategy: TDjvuPdfExportStrategy;
        subsample: number;
    },
): TPdfRasterDisplayProfile | null {
    const resolvedStrategy = resolveDjvuPdfExportStrategy(options.pdfStrategy);
    const sourcePixelScale = resolvedStrategy === 'direct' ? normalizeDjvuPdfSubsample(options.subsample) : 1;
    const sourcePagePixels = pageSizes.map((size) =>
        normalizePdfRasterSourcePagePixels({
            width: size.width / sourcePixelScale,
            height: size.height / sourcePixelScale,
        }),
    );
    return sourcePagePixels.some(Boolean)
        ? {
              kind: 'trusted-raster-djvu',
              sourcePagePixels,
          }
        : null;
}

export const useDjvu = (
    config: {
        getOpenSurface?: (() => IDocumentOpenSurfaceSession | null) | undefined;
        /** Names the document's file for its tabs, which open it when shown. */
        assignDocument?:
            ((document: {fileName: string | null; originalPath: TDocumentRef; isDjvu: boolean; isDirty: boolean}) => void) | undefined;
    } = {},
) => {
    const {t} = useTypedI18n();
    const toast = useToast();
    const {presentFailureToast} = useFailureToast();

    const {
        isDjvuSource: isDjvuMode,
        sourceRef: djvuSourcePath,
        activateDocumentSource,
        captureDocumentSourceActivation,
        clearDocumentSource,
    } = useDocumentSourceSession();

    const conversionState = ref<IDjvuConversionState>({
        isConverting: false,
        phase: null,
        percent: 0,
    });

    const sourceError = ref<string | null>(null);
    const openingPath = ref<TDocumentRef | null>(null);
    const sourceSizeBytes = ref<number | null>(null);

    let openDjvuGeneration = 0;
    let activeViewingRun: IJobRun<IDjvuOpenResult, {canceled: boolean}> | null = null;
    let activeConversion: IJobRun<IDjvuConvertResult, {canceled: boolean}> | null = null;
    let activeProjectionSession: IDocumentProjectionSession | null = null;

    function logSuppressedError(action: string, error: unknown) {
        BrowserLogger.warn('djvu', action, error);
    }

    function isCurrentDjvuOpen(generation: number, path: TDocumentRef) {
        return generation === openDjvuGeneration && openingPath.value === path;
    }

    async function discardSupersededOpen(
        generation: number,
        djvuPath: TDocumentRef,
        hasAcquiredGrant: boolean,
        reason?: TSupersededOpenReason,
    ) {
        if (reason) {
            BrowserLogger.warn('djvu-open-generation', 'Open superseded', {
                reason,
                generation,
                currentGeneration: openDjvuGeneration,
                djvuPath,
                openingPath: openingPath.value,
            });
        }
        if (hasAcquiredGrant) {
            await releaseViewingPath(djvuPath);
        }
        return false as const;
    }

    function invalidatePendingDjvuOpen() {
        openDjvuGeneration += 1;
        openingPath.value = null;
        const viewing = activeViewingRun;
        activeViewingRun = null;
        void viewing?.cancel().catch((error: unknown) => logSuppressedError('Failed to cancel DjVu open', error));
        return openDjvuGeneration;
    }

    function clearSourceError() {
        sourceError.value = null;
    }

    function showConversionError(message: string, failure: FailureReceipt) {
        // A conversion can run for minutes; its failure stays until dismissed.
        presentFailureToast({
            failure,
            title: t('errors.djvu.convert'),
            description: message,
            persistent: true,
        });
    }

    function showExpectedConversionOutcome(message: string, expected: ExpectedOutcome) {
        if (expected.code === 'canceled') {
            return;
        }
        toast.add({
            color: 'warning',
            title: t('errors.djvu.convert'),
            description: message,
        });
    }

    function presentConversionFailure(message: string, existingFailure?: FailureReceipt, expected?: ExpectedOutcome) {
        if (expected !== undefined) {
            showExpectedConversionOutcome(message, expected);
            return;
        }
        const failure =
            existingFailure ?? BrowserLogger.error('djvu', 'Conversion failed', message, {code: 'RENDERER_DJVU_OPERATION_FAILED'});
        showConversionError(message, failure);
    }

    function toConversionPhase(phase: IDjvuProgress['phase']): IDjvuConversionState['phase'] {
        return phase === 'converting' || phase === 'assembling' || phase === 'bookmarks' || phase === 'optimizing' ? phase : null;
    }

    async function releaseViewingPath(path: TDocumentRef | null | undefined) {
        if (!path) {
            return;
        }

        try {
            await getDjvuCapability().releaseViewingPath(path);
        } catch (error) {
            logSuppressedError('Failed to release DjVu viewing path', error);
        }
    }

    function cleanupBrowserOutputRef(path: TDocumentRef | undefined, diagnosticLabel: string) {
        if (!path || !isBrowserDocumentRef(path)) {
            return Promise.resolve();
        }
        return getDocumentWorkingCopyCapability()
            .cleanupFile(path)
            .catch((cleanupError: unknown) => {
                logSuppressedError(diagnosticLabel, cleanupError);
            });
    }

    function startDjvuJob<TResult extends {requestId?: TRequestId}>(options: {
        requestPrefix: string;
        selectOnComplete: (djvu: ReturnType<typeof getDjvuCapability>) => (listener: (result: TResult) => void) => () => void;
        onProgress?: (progress: IDjvuProgress) => void;
        releaseLateResult: (result: TResult) => void;
        admit: (djvu: ReturnType<typeof getDjvuCapability>, requestId: TRequestId) => Promise<IDjvuJobStartHandle>;
    }) {
        const djvu = getDjvuCapability();
        const requestId = createRequestId(options.requestPrefix);
        let admission: Promise<IDjvuJobStartHandle> | null = null;
        return runJob<IDjvuProgress, TResult, {canceled: boolean}>(
            {
                onProgress: djvu.onProgress,
                onComplete: options.selectOnComplete(djvu),
                cancel: async () => (admission ? djvu.cancel((await admission).jobId) : {canceled: false}),
            },
            {
                requestId,
                inactivityTimeoutMs: DJVU_JOB_INACTIVITY_TIMEOUT_MS,
                ...(options.onProgress ? {onProgress: options.onProgress} : {}),
                releaseLateResult: options.releaseLateResult,
                start: async () => {
                    admission = options.admit(djvu, requestId);
                    await admission;
                },
            },
        );
    }

    function publishOpeningPageGeometry(djvuPath: TDocumentRef, sourceInfo: IDjvuOpenResult['pageSourceInfo']) {
        const openSurface = config.getOpenSurface?.();
        const surfaceSnapshot = openSurface?.snapshot.value;
        if (
            sourceInfo?.sourceSize === undefined ||
            sourceInfo.sourceModifiedAt === undefined ||
            !surfaceSnapshot ||
            surfaceSnapshot.identity?.documentId !== String(djvuPath)
        ) {
            return;
        }
        const {widthPoints, heightPoints} = resolveDjvuPageSizeInPoints(sourceInfo.pageSize);
        openSurface.commitOpeningPageGeometry(surfaceSnapshot.generation, {
            documentId: String(djvuPath),
            pageNumber: sourceInfo.pageNumber,
            pageCount: sourceInfo.pageCount,
            width: widthPoints,
            height: heightPoints,
            rotation: 0,
            size: sourceInfo.sourceSize,
            modifiedAt: sourceInfo.sourceModifiedAt,
        });
    }

    function captureDjvuActivation() {
        const activation = captureDocumentSourceActivation();
        return activation?.kind === 'djvu' ? activation : null;
    }

    function exitDjvuMode(expectedActivation: IDocumentSourceActivation) {
        const sourcePath = expectedActivation.documentRef;
        if (!clearDocumentSource(expectedActivation)) {
            BrowserLogger.info('djvu-open-generation', 'Source clear rejected', {
                reason: 'activation-generation-mismatch',
                expectedActivation,
                currentActivation: captureDocumentSourceActivation(),
            });
            return false;
        }
        activeProjectionSession = null;
        sourceSizeBytes.value = null;
        void releaseViewingPath(sourcePath);
        return true;
    }

    function releaseActiveSource() {
        const activation = captureDjvuActivation();
        return activation ? exitDjvuMode(activation) : false;
    }

    function supersedePendingOpen() {
        invalidatePendingDjvuOpen();
    }

    function resetConversionState() {
        conversionState.value = {
            isConverting: false,
            phase: null,
            percent: 0,
        };
    }

    onUnmounted(() => {
        invalidatePendingDjvuOpen();
        void cancelActiveJobs();
        releaseActiveSource();
    });

    async function openDjvuFile(inputPath: string, options: IOpenDjvuFileOptions = {}) {
        const djvuPath = parseDocumentRef(inputPath);
        if (djvuPath === null) {
            throw new TypeError('DjVu path must be a valid document reference');
        }
        const generation = invalidatePendingDjvuOpen();
        clearSourceError();
        openingPath.value = djvuPath;
        BrowserLogger.info('djvu-open-generation', 'Open started', {
            generation,
            djvuPath,
            previousDjvuPath: djvuSourcePath.value,
        });
        let run: IJobRun<IDjvuOpenResult, {canceled: boolean}> | null = null;
        let acquiredViewingGrant = false;
        try {
            run = startDjvuJob<IDjvuOpenResult>({
                requestPrefix: 'djvu-open',
                selectOnComplete: (djvu) => djvu.onOpenComplete,
                releaseLateResult: (result) => {
                    if (result.success) {
                        void releaseViewingPath(djvuPath);
                    }
                },
                admit: (djvu, requestId) => djvu.startOpenForViewing(djvuPath, requestId),
            });
            activeViewingRun = run;
            const result = await run.result;
            acquiredViewingGrant = result.success;
            BrowserLogger.info('djvu-open-generation', 'Native result received', {
                generation,
                djvuPath,
                jobId: result.jobId ?? null,
                success: result.success,
            });
            if (!isCurrentDjvuOpen(generation, djvuPath)) {
                return discardSupersededOpen(generation, djvuPath, acquiredViewingGrant, 'stale-after-native-result');
            }
            if (!result.success) {
                if (getDjvuExpectedOutcome(result)?.code === 'canceled') {
                    throw new JobCanceledError();
                }
                throw createDjvuOpenFailure(result, t('errors.djvu.open'));
            }

            // The native open result is the candidate acceptance boundary.
            // Do not evict the current PDF until the DjVu source is known to
            // be readable, and release the accepted candidate if the close or
            // generation fence fails before activation.
            BrowserLogger.info('djvu-open-generation', 'Closing previous PDF state', {
                reason: 'close-after-native-acceptance',
                generation,
                djvuPath,
                current: isCurrentDjvuOpen(generation, djvuPath),
            });
            try {
                const closeResult = options.closeActiveDocument?.(result.pageCount ?? null);
                if (isPromiseLike(closeResult)) {
                    await closeResult;
                }
            } catch (closeError) {
                if (isCurrentDjvuOpen(generation, djvuPath) && acquiredViewingGrant) {
                    acquiredViewingGrant = false;
                    await releaseViewingPath(djvuPath);
                }
                throw closeError;
            }
            if (!isCurrentDjvuOpen(generation, djvuPath)) {
                return discardSupersededOpen(generation, djvuPath, acquiredViewingGrant, 'stale-after-pdf-close');
            }

            publishOpeningPageGeometry(djvuPath, result.pageSourceInfo);
            BrowserLogger.info('djvu', 'Native DjVu viewing ready', {pageCount: result.pageCount ?? 0});
            if (!isCurrentDjvuOpen(generation, djvuPath)) {
                return discardSupersededOpen(generation, djvuPath, acquiredViewingGrant, 'stale-before-source-activation');
            }
            const previousDjvuPath = djvuSourcePath.value;
            options.setOriginalPath?.(djvuPath);
            const activation = activateDocumentSource('djvu', djvuPath);
            acquiredViewingGrant = false;
            sourceSizeBytes.value = typeof result.pageSourceInfo?.sourceSize === 'number' ? result.pageSourceInfo.sourceSize : null;
            activeProjectionSession = createDjvuProjectionSession(djvuPath);
            BrowserLogger.info('djvu-open-generation', 'Source activated', {
                generation,
                djvuPath,
                isDjvuMode: isDjvuMode.value,
                sourcePath: djvuSourcePath.value,
                activationGeneration: activation.generation,
            });
            await releaseViewingPath(previousDjvuPath);
            return true;
        } catch (e) {
            if (e instanceof JobCanceledError) {
                return false;
            }
            if (!isCurrentDjvuOpen(generation, djvuPath)) {
                return discardSupersededOpen(generation, djvuPath, acquiredViewingGrant);
            }
            throw e;
        } finally {
            if (activeViewingRun === run) {
                activeViewingRun = null;
            }
            if (isCurrentDjvuOpen(generation, djvuPath)) {
                openingPath.value = null;
            }
        }
    }

    function startConversion(
        sourcePath: TDocumentRef,
        savePath: TDocumentRef,
        options: {
            subsample: number;
            preserveBookmarks: boolean;
            pdfStrategy: TDjvuPdfExportStrategy;
        },
    ) {
        return startDjvuJob<IDjvuConvertResult>({
            requestPrefix: 'djvu-convert',
            selectOnComplete: (djvu) => djvu.onConvertComplete,
            onProgress: (progress: IDjvuProgress) => {
                conversionState.value = {
                    isConverting: true,
                    phase: toConversionPhase(progress.phase),
                    percent: progress.percent,
                };
            },
            releaseLateResult: (result) => {
                void cleanupBrowserOutputRef(result.pdfPath, 'Failed to cleanup late DjVu browser output ref');
            },
            admit: (djvu, requestId) =>
                djvu.startConvertToPdf(sourcePath, savePath, {
                    ...options,
                    requestId,
                    documentRef: sourcePath,
                    hostTier: getPerformanceProfile().tier,
                }),
        });
    }

    async function handoffConvertedPdf(
        savePath: TDocumentRef,
        result: IDjvuConvertResult & {pdfPath: TDocumentRef},
        options: {
            pdfStrategy: TDjvuPdfExportStrategy;
            subsample: number;
        },
        openConvertedPdf: TOpenConvertedPdf,
        isActiveConversion: () => boolean,
        isCurrent: () => boolean,
    ): Promise<TDocumentRef | null> {
        if (result.notice) {
            toast.add({description: t('djvu.sourceTextOmitted')});
        }
        const rasterDisplayProfile = createTrustedRasterDjvuPdfDisplayProfile(result.pageSizes ?? [], options);
        registerPdfRasterDisplayProfile(savePath, rasterDisplayProfile);
        registerPdfRasterDisplayProfile(result.pdfPath, rasterDisplayProfile);
        // With no view of the document shown, the saved PDF becomes its
        // file, as a tab not shown is given one: the tab opens it when shown,
        // and nothing is presented or focused now.
        if (!config.getOpenSurface?.() && config.assignDocument) {
            config.assignDocument({
                fileName: getDocumentRefBaseName(result.pdfPath) ?? null,
                originalPath: result.pdfPath,
                isDjvu: false,
                isDirty: false,
            });
            return result.pdfPath;
        }

        let openResult: TDocumentOpenOutcome;
        try {
            openResult = rasterDisplayProfile
                ? await openConvertedPdf(result.pdfPath, {rasterDisplayProfile})
                : await openConvertedPdf(result.pdfPath);
        } finally {
            unregisterPdfRasterDisplayProfiles(savePath, result.pdfPath);
        }
        if (!isActiveConversion()) {
            return null;
        }
        if (didOpenDocument(openResult)) {
            return result.pdfPath;
        }
        if (!isCurrent()) {
            return null;
        }
        if (openResult.status === 'failed') {
            sourceError.value = openResult.error || t('errors.file.open');
        }
        return null;
    }

    async function convertToPdf(
        subsample: number,
        preserveBookmarks: boolean,
        pdfStrategy: TDjvuPdfExportStrategy,
        openConvertedPdf: TOpenConvertedPdf,
    ) {
        const sourcePath = djvuSourcePath.value;
        if (!sourcePath) {
            return null;
        }

        const sourceBaseName = getDocumentRefBaseName(sourcePath)?.trim();
        const suggestedName = sourceBaseName
            ? ensurePdfSuggestedName(sourceBaseName.replace(/\.djvu?$/i, ''))
            : ensurePdfSuggestedName(t('djvu.documentFallback'));
        const savePath = parseDocumentRef(await getDocumentFilesCapability().savePdfDialog(suggestedName));
        if (savePath === null) {
            return null;
        }
        if (activeConversion !== null || djvuSourcePath.value !== sourcePath) {
            await cleanupBrowserOutputRef(savePath, 'Failed to cleanup DjVu browser output ref');
            return null;
        }

        conversionState.value = {
            isConverting: true,
            phase: 'converting',
            percent: 0,
        };
        let shouldCleanupSavePath = true;

        BrowserLogger.info('djvu', 'Starting conversion to PDF', {
            subsample,
            preserveBookmarks,
            pdfStrategy,
        });

        clearSourceError();
        let run: IJobRun<IDjvuConvertResult, {canceled: boolean}> | null = null;
        const isActiveConversion = () => activeConversion === run;
        const isCurrent = () => isActiveConversion() && djvuSourcePath.value === sourcePath;
        try {
            // Paint the progress overlay before the job can finish, as OCR does.
            await nextTick();
            await waitForVisualFrames({frames: 2});
            if (!conversionState.value.isConverting || djvuSourcePath.value !== sourcePath) {
                return null;
            }
            run = startConversion(sourcePath, savePath, {
                subsample,
                preserveBookmarks,
                pdfStrategy,
            });
            activeConversion = run;
            const result = await run.result;
            if (!isCurrent()) {
                return null;
            }
            if (!result.success || !result.pdfPath) {
                presentConversionFailure(
                    result.error ?? t('errors.djvu.convert'),
                    getFailureReceipt(result),
                    getDjvuExpectedOutcome(result),
                );
                return null;
            }
            shouldCleanupSavePath = false;
            return await handoffConvertedPdf(
                savePath,
                {
                    ...result,
                    pdfPath: result.pdfPath,
                },
                {
                    pdfStrategy,
                    subsample,
                },
                openConvertedPdf,
                isActiveConversion,
                isCurrent,
            );
        } catch (error) {
            if (!isCurrent() || error instanceof JobCanceledError) {
                return null;
            }
            const message =
                error instanceof Error && getErrorMessage(error).trim().length > 0 ? getErrorMessage(error) : t('errors.djvu.convert');
            const expected = getDjvuExpectedOutcome(error) ?? classifyDjvuConversionExpectedOutcome(error);
            const failure = getFailureReceipt(error);
            if (expected !== undefined) {
                showExpectedConversionOutcome(message, expected);
            } else {
                const ownedFailure =
                    failure ??
                    BrowserLogger.error(
                        'djvu',
                        'Conversion crashed',
                        {
                            path: sourcePath,
                            error,
                        },
                        {code: 'RENDERER_DJVU_OPERATION_FAILED'},
                    );
                showConversionError(message, ownedFailure);
            }
        } finally {
            if (activeConversion === run) {
                activeConversion = null;
                resetConversionState();
            }
            if (shouldCleanupSavePath) {
                await cleanupBrowserOutputRef(savePath, 'Failed to cleanup DjVu browser output ref');
            }
        }
        return null;
    }

    async function ensurePdfProjectionForAction(reason: TPdfProjectionReason, openConvertedPdf: TOpenConvertedPdf, signal: AbortSignal) {
        const sourcePath = djvuSourcePath.value;
        if (!sourcePath) {
            return false;
        }
        const session =
            activeProjectionSession?.originalRef === sourcePath ? activeProjectionSession : createDjvuProjectionSession(sourcePath);
        activeProjectionSession = session;
        try {
            await ensurePdfProjection(
                session,
                {
                    build: async () => {
                        const documentRef = await convertToPdf(1, true, 'direct', openConvertedPdf);
                        if (!documentRef) {
                            throw new DOMException('PDF projection canceled', 'AbortError');
                        }
                        return {
                            documentRef,
                            source: createProjectionSourceIdentity('pdf', documentRef),
                            capabilities: PDF_SOURCE_CAPABILITIES,
                        };
                    },
                },
                reason,
                signal,
            );
            return true;
        } catch (error) {
            if (isAbortError(error)) {
                return false;
            }
            throw error;
        }
    }

    async function cancelActiveJobs() {
        const viewing = activeViewingRun;
        activeViewingRun = null;
        const conversion = activeConversion;
        activeConversion = null;
        resetConversionState();
        BrowserLogger.info('djvu', 'Cancelling active jobs', {
            viewing: viewing !== null,
            conversion: conversion !== null,
        });
        if (!viewing && !conversion) {
            return false;
        }

        await Promise.all([
            viewing?.cancel().catch((cancelError: unknown) => {
                logSuppressedError('Failed to cancel DjVu open', cancelError);
            }),
            conversion?.cancel().catch((cancelError: unknown) => {
                logSuppressedError('Failed to cancel DjVu conversion', cancelError);
            }),
        ]);
        return true;
    }

    const source = computed<IDjvuSourceSnapshot>(() => ({
        isDjvuMode: isDjvuMode.value,
        sourcePath: djvuSourcePath.value,
        openingPath: openingPath.value,
        sourceError: sourceError.value,
        sourceSizeBytes: sourceSizeBytes.value,
    }));

    return {
        source,
        conversionState: computed<Readonly<IDjvuConversionState>>(() => conversionState.value),
        openDjvuFile,
        convertToPdf,
        ensurePdfProjectionForAction,
        cancelActiveJobs,
        supersedePendingOpen,
        releaseActiveSource,
    };
};
