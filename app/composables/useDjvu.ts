import { getErrorMessage } from '@app/utils/error';
import type { TDocumentRef } from '@contracts/documentRef';
import { parseDocumentRef } from '@contracts/documentRef';
import { createRequestId } from '@contracts/shared';
import {
    decodeFailureReceipt,
    isExpectedOutcome,
    type ExpectedOutcome,
    type FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import type {
    IDjvuConvertResult,
    IDjvuJobStartHandle,
    IDjvuOpenResult,
    IDjvuProgress,
    IDjvuPageSize,
    TDjvuPdfExportStrategy,
} from '@contracts/electronApiDjvu';
import {
    normalizeDjvuPdfSubsample,
    resolveDjvuPdfExportStrategy,
} from '@contracts/djvuConversionPolicy';
import {
    didOpenDocument,
    type TDocumentOpenOutcome,
} from '@app/types/documentOpenOutcome';
import type {
    IPdfRasterDisplayProfileOpenOptions,
    TPdfRasterDisplayProfile,
} from '@app/types/pdfRasterDisplayProfile';
import {
    createDocumentProjectionSession,
    ensurePdfProjection,
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
import {
    type IDocumentSourceActivation,
    useDocumentSourceSession,
} from '@app/modules/workspace-shell/document-sessions/useDocumentSourceSession';
import { BrowserLogger } from '@app/utils/browserLogger';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import { useFailureToast } from '@app/composables/useFailureToast';
import {
    getDocumentRefBaseName,
    isBrowserDocumentRef,
} from '@app/utils/documentRef';
import { getDjvuCapability } from '@app/utils/getDjvuCapability';
import {
    JobCanceledError,
    runJob,
    type IJobRun,
} from '@app/utils/jobs/runJob';
import {
    getDocumentFilesCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';

interface IDjvuConversionState {
    isConverting: boolean;
    phase: 'converting' | 'bookmarks' | 'optimizing' | null;
    percent: number;
}

interface IDjvuLoadingProgress {
    current: number;
    total: number;
}

export interface IOpenDjvuFileOptions {
    closeActiveDocument?: () => void | Promise<void>;
    setOriginalPath?: (path: TDocumentRef | null) => void;
}

export type TOpenDjvuFile = (
    djvuPath: string,
    options?: IOpenDjvuFileOptions,
) => Promise<boolean>;

type TOpenConvertedPdf = (
    path: TDocumentRef,
    options?: IPdfRasterDisplayProfileOpenOptions,
) => Promise<TDocumentOpenOutcome>;

function isPromiseLike(value: unknown): value is PromiseLike<void> {
    return typeof value === 'object'
        && value !== null
        && 'then' in value
        && typeof value.then === 'function';
}

function getDjvuFailureReceipt(value: unknown): FailureReceipt | undefined {
    if (typeof value !== 'object' || value === null || !('failure' in value)) {
        return undefined;
    }
    return decodeFailureReceipt(value.failure) ?? undefined;
}

function getDjvuExpectedOutcome(value: unknown): ExpectedOutcome | undefined {
    if (typeof value !== 'object' || value === null || !('expected' in value)) {
        return undefined;
    }
    return isExpectedOutcome(value.expected) ? value.expected : undefined;
}

function classifyDjvuConversionExpectedOutcome(error: unknown): ExpectedOutcome | undefined {
    if (
        error instanceof DOMException && error.name === 'AbortError'
        || error instanceof Error && (
            error.name === 'AbortError'
            || error.name === 'DjvuCanceledError'
        )
    ) {
        return {
            kind: 'expected',
            code: 'canceled',
        };
    }

    if (error instanceof Error && getErrorMessage(error).trim().toLowerCase() === 'djvu conversion canceled') {
        return {
            kind: 'expected',
            code: 'canceled',
        };
    }
    return undefined;
}

const DJVU_JOB_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1_000;

const DJVU_PROJECTION_SOURCE_CAPABILITIES: IDocumentSourceCapabilities = {
    annotations: false,
    directImageExport: true,
    outline: true,
    pageEdits: false,
    search: true,
    text: true,
};

const PDF_PROJECTION_SOURCE_CAPABILITIES: IDocumentSourceCapabilities = {
    annotations: true,
    directImageExport: true,
    outline: true,
    pageEdits: true,
    search: true,
    text: true,
};

function createProjectionSourceIdentity(
    kind: IDocumentPageSource['kind'],
    documentRef: TDocumentRef,
): IDocumentPageSource {
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
    const sourcePixelScale = resolvedStrategy === 'direct'
        ? normalizeDjvuPdfSubsample(options.subsample)
        : 1;
    const sourcePagePixels = pageSizes.map(size => normalizePdfRasterSourcePagePixels({
        width: size.width / sourcePixelScale,
        height: size.height / sourcePixelScale,
    }));
    return sourcePagePixels.some(Boolean)
        ? {
            kind: 'trusted-raster-djvu',
            sourcePagePixels,
        }
        : null;
}

export const useDjvu = (config: {openSurface?: IDocumentOpenSurfaceSession | undefined} = {}) => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const {presentFailureToast} = useFailureToast();

    const {
        isDjvuSource: isDjvuMode,
        sourceRef: djvuSourcePath,
        projectionRef: djvuTempPdfPath,
        activateDocumentSource,
        captureDocumentSourceActivation,
        clearDocumentSource,
    } = useDocumentSourceSession();

    const conversionState = ref<IDjvuConversionState>({
        isConverting: false,
        phase: null,
        percent: 0,
    });

    const isLoadingPages = ref(false);
    const loadingProgress = ref<IDjvuLoadingProgress>({
        current: 0,
        total: 0,
    });

    const showBanner = ref(true);
    const showConvertDialog = ref(false);
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

    function resetViewingProgressState() {
        isLoadingPages.value = false;
        loadingProgress.value = {
            current: 0,
            total: 0,
        };
    }

    function isCurrentDjvuOpen(generation: number, path: TDocumentRef) {
        return generation === openDjvuGeneration && openingPath.value === path;
    }

    async function releaseStaleViewingPath(generation: number, path: TDocumentRef) {
        const newerOpenOwnsSamePath = generation !== openDjvuGeneration
            && openingPath.value === path;
        if (!newerOpenOwnsSamePath && djvuSourcePath.value !== path) {
            await releaseViewingPath(path);
        }
    }

    function invalidatePendingDjvuOpen() {
        openDjvuGeneration += 1;
        openingPath.value = null;
        const viewing = activeViewingRun;
        activeViewingRun = null;
        void viewing?.cancel().catch((error: unknown) => logSuppressedError('Failed to cancel DjVu open', error));
        resetViewingProgressState();
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

    function presentConversionFailure(
        message: string,
        existingFailure?: FailureReceipt,
        expected?: ExpectedOutcome,
    ) {
        if (expected !== undefined) {
            showExpectedConversionOutcome(message, expected);
            return;
        }
        const failure = existingFailure ?? BrowserLogger.error(
            'djvu',
            'Conversion failed',
            message,
            {code: 'RENDERER_DJVU_OPERATION_FAILED'},
        );
        showConversionError(message, failure);
    }

    function toConversionPhase(phase: IDjvuProgress['phase']): IDjvuConversionState['phase'] {
        return phase === 'converting' || phase === 'bookmarks' || phase === 'optimizing'
            ? phase
            : null;
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

    function isCurrentSourceActivation(activation: IDocumentSourceActivation) {
        const current = captureDocumentSourceActivation();
        return current?.generation === activation.generation
            && current.kind === activation.kind
            && current.documentRef === activation.documentRef;
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
        const activation = captureDjvuActivation();
        if (activation) {
            exitDjvuMode(activation);
        }
    });

    async function openDjvuFile(
        inputPath: string,
        options: IOpenDjvuFileOptions = {},
    ) {
        const djvuPath = parseDocumentRef(inputPath);
        if (djvuPath === null) {
            throw new TypeError('DjVu path must be a valid document reference');
        }
        const generation = invalidatePendingDjvuOpen();
        const previousDjvuPath = djvuSourcePath.value;
        showBanner.value = true;
        clearSourceError();
        openingPath.value = djvuPath;
        isLoadingPages.value = true;
        loadingProgress.value = {
            current: 0,
            total: 0,
        };
        BrowserLogger.info('djvu-open-generation', 'Open started', {
            generation,
            djvuPath,
            previousDjvuPath,
        });
        let run: IJobRun<IDjvuOpenResult, {canceled: boolean}> | null = null;
        try {
            const djvu = getDjvuCapability();
            const requestId = createRequestId('djvu-open');
            let admission: Promise<IDjvuJobStartHandle> | null = null;
            run = runJob<IDjvuProgress, IDjvuOpenResult, {canceled: boolean}>({
                onProgress: djvu.onProgress,
                onComplete: djvu.onOpenComplete,
                cancel: async () => admission
                    ? djvu.cancel((await admission).jobId)
                    : {canceled: false},
            }, {
                requestId,
                inactivityTimeoutMs: DJVU_JOB_INACTIVITY_TIMEOUT_MS,
                releaseLateResult: (result) => {
                    if (result.success) {
                        void releaseStaleViewingPath(generation, djvuPath);
                    }
                },
                start: async () => {
                    admission = djvu.startOpenForViewing(djvuPath, requestId);
                    await admission;
                },
            });
            activeViewingRun = run;
            const result = await run.result;
            BrowserLogger.info('djvu-open-generation', 'Native result received', {
                generation,
                djvuPath,
                jobId: result.jobId ?? null,
                success: result.success,
            });
            if (!isCurrentDjvuOpen(generation, djvuPath)) {
                BrowserLogger.warn('djvu-open-generation', 'Open superseded', {
                    reason: 'stale-after-native-result',
                    generation,
                    currentGeneration: openDjvuGeneration,
                    djvuPath,
                    openingPath: openingPath.value,
                });
                await releaseStaleViewingPath(generation, djvuPath);
                return false;
            }
            if (!result.success) {
                BrowserLogger.error('djvu', 'Open failed', result.error, {code: 'RENDERER_DJVU_OPERATION_FAILED'});
                throw new Error(result.error ?? t('errors.djvu.open'));
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
                const closeResult = options.closeActiveDocument?.();
                if (isPromiseLike(closeResult)) {
                    await closeResult;
                }
            } catch (closeError) {
                await releaseStaleViewingPath(generation, djvuPath);
                throw closeError;
            }
            if (!isCurrentDjvuOpen(generation, djvuPath)) {
                BrowserLogger.warn('djvu-open-generation', 'Open superseded', {
                    reason: 'stale-after-pdf-close',
                    generation,
                    currentGeneration: openDjvuGeneration,
                    djvuPath,
                    openingPath: openingPath.value,
                });
                await releaseStaleViewingPath(generation, djvuPath);
                return false;
            }
            loadingProgress.value = {
                current: result.pageCount ?? loadingProgress.value.current,
                total: result.pageCount ?? loadingProgress.value.total,
            };

            const sourceInfo = result.pageSourceInfo;
            const surfaceSnapshot = config.openSurface?.snapshot.value;
            if (
                sourceInfo?.sourceSize !== undefined
                && sourceInfo.sourceModifiedAt !== undefined
                && surfaceSnapshot
                && surfaceSnapshot.identity?.documentId === String(djvuPath)
            ) {
                const {
                    widthPoints,
                    heightPoints,
                } = resolveDjvuPageSizeInPoints(sourceInfo.pageSize);
                config.openSurface?.commitOpeningPageGeometry(surfaceSnapshot.generation, {
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

            BrowserLogger.info('djvu', 'Native DjVu viewing ready', { pageCount: result.pageCount ?? 0 });
            resetViewingProgressState();
            if (previousDjvuPath && previousDjvuPath !== djvuPath) {
                await releaseViewingPath(previousDjvuPath);
            }
            if (!isCurrentDjvuOpen(generation, djvuPath)) {
                BrowserLogger.warn('djvu-open-generation', 'Open superseded', {
                    reason: 'stale-before-source-activation',
                    generation,
                    currentGeneration: openDjvuGeneration,
                    djvuPath,
                    openingPath: openingPath.value,
                });
                await releaseStaleViewingPath(generation, djvuPath);
                return false;
            }
            options.setOriginalPath?.(djvuPath);
            const activation = activateDocumentSource('djvu', djvuPath);
            sourceSizeBytes.value = typeof sourceInfo?.sourceSize === 'number'
                ? sourceInfo.sourceSize
                : null;
            activeProjectionSession = createDocumentProjectionSession({
                id: `djvu:${String(djvuPath)}`,
                originalRef: djvuPath,
                source: createProjectionSourceIdentity('djvu', djvuPath),
                capabilities: DJVU_PROJECTION_SOURCE_CAPABILITIES,
            });
            BrowserLogger.info('djvu-open-generation', 'Source activated', {
                generation,
                djvuPath,
                isDjvuMode: isDjvuMode.value,
                sourcePath: djvuSourcePath.value,
                activationGeneration: activation.generation,
            });
            return true;
        } catch (e) {
            if (e instanceof JobCanceledError) {
                return false;
            }
            if (!isCurrentDjvuOpen(generation, djvuPath)) {
                await releaseStaleViewingPath(generation, djvuPath);
                return false;
            }
            resetViewingProgressState();
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
        const djvu = getDjvuCapability();
        const requestId = createRequestId('djvu-convert');
        let admission: Promise<IDjvuJobStartHandle> | null = null;
        return runJob<IDjvuProgress, IDjvuConvertResult, {canceled: boolean}>({
            onProgress: djvu.onProgress,
            onComplete: djvu.onConvertComplete,
            cancel: async () => admission
                ? djvu.cancel((await admission).jobId)
                : {canceled: false},
        }, {
            requestId,
            inactivityTimeoutMs: DJVU_JOB_INACTIVITY_TIMEOUT_MS,
            onProgress: (progress: IDjvuProgress) => {
                conversionState.value = {
                    isConverting: true,
                    phase: toConversionPhase(progress.phase),
                    percent: progress.percent,
                };
            },
            releaseLateResult: (result) => {
                if (result.pdfPath && isBrowserDocumentRef(result.pdfPath)) {
                    void getDocumentWorkingCopyCapability().cleanupFile(result.pdfPath).catch((cleanupError: unknown) => {
                        logSuppressedError('Failed to cleanup late DjVu browser output ref', cleanupError);
                    });
                }
            },
            start: async () => {
                admission = djvu.startConvertToPdf(sourcePath, savePath, {
                    ...options,
                    requestId,
                    documentRef: sourcePath,
                    hostTier: getPerformanceProfile().tier,
                });
                await admission;
            },
        });
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

        const documentWorkingCopy = getDocumentWorkingCopyCapability();
        const sourceBaseName = getDocumentRefBaseName(sourcePath)?.trim();
        const suggestedName = sourceBaseName
            ? ensurePdfSuggestedName(sourceBaseName.replace(/\.djvu?$/i, ''))
            : ensurePdfSuggestedName(t('djvu.documentFallback'));
        const savePath = parseDocumentRef(await getDocumentFilesCapability().savePdfDialog(suggestedName));
        if (savePath === null || activeConversion !== null || djvuSourcePath.value !== sourcePath) {
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
        const isCurrent = () => activeConversion === run && djvuSourcePath.value === sourcePath;
        try {
            // Paint the progress overlay before the job can finish, as OCR does.
            await nextTick();
            await waitForVisualFrames({ frames: 2 });
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
                    getDjvuFailureReceipt(result),
                    getDjvuExpectedOutcome(result),
                );
                return null;
            }
            shouldCleanupSavePath = false;
            BrowserLogger.info('djvu', 'Conversion completed', {
                jobId: result.jobId,
                pdfPath: result.pdfPath,
            });

            let rasterDisplayProfile: TPdfRasterDisplayProfile | null = null;
            try {
                rasterDisplayProfile = createTrustedRasterDjvuPdfDisplayProfile(
                    await getDjvuCapability().getPageSizes(sourcePath),
                    {
                        pdfStrategy,
                        subsample,
                    },
                );
            } catch (profileError) {
                BrowserLogger.warn('djvu', 'Failed to resolve trusted raster PDF display profile', {
                    path: sourcePath,
                    error: profileError,
                });
            }

            if (!isCurrent()) {
                return null;
            }

            registerPdfRasterDisplayProfile(savePath, rasterDisplayProfile);
            registerPdfRasterDisplayProfile(result.pdfPath, rasterDisplayProfile);
            let openResult: TDocumentOpenOutcome;
            try {
                openResult = rasterDisplayProfile
                    ? await openConvertedPdf(result.pdfPath, {rasterDisplayProfile})
                    : await openConvertedPdf(result.pdfPath);
            } finally {
                unregisterPdfRasterDisplayProfiles(savePath, result.pdfPath);
            }
            if (!isCurrent()) {
                return null;
            }
            if (openResult.status === 'failed') {
                sourceError.value = openResult.error || t('errors.file.open');
                return null;
            }
            return didOpenDocument(openResult) ? result.pdfPath : null;
        } catch (error) {
            if (!isCurrent() || error instanceof JobCanceledError) {
                return null;
            }
            const message = error instanceof Error && getErrorMessage(error).trim().length > 0
                ? getErrorMessage(error)
                : t('errors.djvu.convert');
            const expected = getDjvuExpectedOutcome(error)
                ?? classifyDjvuConversionExpectedOutcome(error);
            const failure = getDjvuFailureReceipt(error);
            if (expected !== undefined) {
                showExpectedConversionOutcome(message, expected);
            } else {
                const ownedFailure = failure ?? BrowserLogger.error('djvu', 'Conversion crashed', {
                    path: sourcePath,
                    error,
                }, {code: 'RENDERER_DJVU_OPERATION_FAILED'});
                showConversionError(message, ownedFailure);
            }
        } finally {
            if (activeConversion === run) {
                activeConversion = null;
                resetConversionState();
            }
            if (shouldCleanupSavePath && isBrowserDocumentRef(savePath)) {
                await documentWorkingCopy.cleanupFile(savePath).catch((cleanupError: unknown) => {
                    logSuppressedError('Failed to cleanup DjVu browser output ref', cleanupError);
                });
            }
        }
        return null;
    }

    async function ensurePdfProjectionForAction(
        reason: TPdfProjectionReason,
        openConvertedPdf: TOpenConvertedPdf,
        signal: AbortSignal,
    ) {
        const sourcePath = djvuSourcePath.value;
        if (!sourcePath) {
            return false;
        }
        const session = activeProjectionSession?.originalRef === sourcePath
            ? activeProjectionSession
            : createDocumentProjectionSession({
                id: `djvu:${String(sourcePath)}`,
                originalRef: sourcePath,
                source: createProjectionSourceIdentity('djvu', sourcePath),
                capabilities: DJVU_PROJECTION_SOURCE_CAPABILITIES,
            });
        activeProjectionSession = session;
        try {
            await ensurePdfProjection(session, {build: async () => {
                const documentRef = await convertToPdf(1, true, 'direct', openConvertedPdf);
                if (!documentRef) {
                    throw new DOMException('PDF projection canceled', 'AbortError');
                }
                return {
                    documentRef,
                    source: createProjectionSourceIdentity('pdf', documentRef),
                    capabilities: PDF_PROJECTION_SOURCE_CAPABILITIES,
                };
            }}, reason, signal);
            return true;
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
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
        resetViewingProgressState();
        return true;
    }

    async function cleanupDjvuTemp(expectedActivation: IDocumentSourceActivation) {
        if (!isCurrentSourceActivation(expectedActivation)) {
            return false;
        }
        const tempPath = djvuTempPdfPath.value;
        if (!tempPath) {
            return true;
        }

        try {
            await getDjvuCapability().cleanupTemp(tempPath);
        } catch (cleanupError) {
            logSuppressedError('Failed to cleanup DjVu temp PDF', cleanupError);
        }
        return true;
    }

    function openConvertDialog() {
        if (!isDjvuMode.value) {
            return;
        }
        showConvertDialog.value = true;
    }

    function closeConvertDialog() {
        showConvertDialog.value = false;
    }

    function dismissBanner() {
        showBanner.value = false;
    }

    return {
        isDjvuMode,
        djvuSourcePath,
        djvuTempPdfPath,
        conversionState,
        isLoadingPages,
        loadingProgress,
        showBanner,
        showConvertDialog,
        sourceError,
        openingPath,
        sourceSizeBytes,
        openDjvuFile,
        invalidatePendingDjvuOpen,
        convertToPdf,
        ensurePdfProjectionForAction,
        cancelActiveJobs,
        cleanupDjvuTemp,
        captureDjvuActivation,
        exitDjvuMode,
        openConvertDialog,
        closeConvertDialog,
        dismissBanner,
        clearSourceError,
    };
};
