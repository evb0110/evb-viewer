import { getErrorMessage } from '@app/utils/error';
import type { TDocumentRef } from '@contracts/documentRef';
import { parseDocumentRef } from '@contracts/documentRef';
import {
    createRequestId,
    type TJobId,
} from '@contracts/shared';
import {
    decodeFailureReceipt,
    isExpectedOutcome,
    type ExpectedOutcome,
    type FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import type {
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
import type {
    IDocumentPageSource,
    IDocumentSourceCapabilities, IDocumentOpenSurfaceSession,
    createDocumentSession,
    ensurePdfProjection,
    type IDocumentSession,
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
import { useFailureToast } from '@app/composables/useFailureToast';
import {
    getDocumentRefBaseName,
    isBrowserDocumentRef,
} from '@app/utils/documentRef';
import { getDjvuCapability } from '@app/utils/getDjvuCapability';
import { cacheTrustedDjvuOpenGeometry } from '@app/modules/djvu-viewer/runtime/djvuTrustedOpenGeometryCache';
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
    const activeViewingJobId = ref<TJobId | null>(null);
    const activeConvertJobId = ref<TJobId | null>(null);

    let unsubProgress: (() => void) | null = null;
    let openDjvuGeneration = 0;
    let conversionGeneration = 0;
    let activeConversionGeneration: number | null = null;
    let isUnmounted = false;
    let activeProjectionSession: IDocumentSession | null = null;

    function logSuppressedError(action: string, error: unknown) {
        BrowserLogger.warn('djvu', action, error);
    }

    function resetViewingProgressState() {
        activeViewingJobId.value = null;
        isLoadingPages.value = false;
        loadingProgress.value = {
            current: 0,
            total: 0,
        };
    }

    function isCurrentDjvuOpen(generation: number, path: TDocumentRef) {
        return generation === openDjvuGeneration && openingPath.value === path;
    }

    function isCurrentConversion(generation: number, sourcePath: TDocumentRef) {
        return ownsConversion(generation)
            && djvuSourcePath.value === sourcePath;
    }

    function ownsConversion(generation: number) {
        return generation === conversionGeneration
            && activeConversionGeneration === generation;
    }

    async function releaseStaleViewingPath(generation: number, path: TDocumentRef) {
        const newerOpenOwnsSamePath = generation !== openDjvuGeneration
            && openingPath.value === path;
        if (!newerOpenOwnsSamePath && djvuSourcePath.value !== path) {
            await releaseViewingPath(path);
        }
    }

    async function cancelJobWhenAdmitted(jobId: TJobId) {
        try {
            await getDjvuCapability().cancel(jobId);
        } catch (error) {
            logSuppressedError(`Failed to cancel stale DjVu job ${jobId}`, error);
        }
    }

    function invalidatePendingDjvuOpen() {
        openDjvuGeneration += 1;
        openingPath.value = null;
        resetViewingProgressState();
    }

    function clearSourceError() {
        sourceError.value = null;
    }

    function showConversionError(message: string, failure: FailureReceipt) {
        presentFailureToast({
            failure,
            title: t('errors.djvu.convert'),
            description: message,
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
            {
                code: 'RENDERER_DJVU_OPERATION_FAILED',
                context: {},
            },
        );
        showConversionError(message, failure);
    }

    function createConversionRequestId() {
        return createRequestId('djvu-convert');
    }

    function toConversionPhase(phase: IDjvuProgress['phase']): IDjvuConversionState['phase'] {
        return phase === 'converting' || phase === 'bookmarks' || phase === 'optimizing'
            ? phase
            : null;
    }

    function isProgressForCurrentConversion(progress: IDjvuProgress) {
        return activeConvertJobId.value !== null
            && progress.jobId === activeConvertJobId.value;
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

    function setupProgressListener() {
        if (unsubProgress) {
            return;
        }

        try {
            unsubProgress = getDjvuCapability().onProgress((progress) => {
                if (!isProgressForCurrentConversion(progress)) {
                    return;
                }

                if (activeConvertJobId.value && progress.jobId !== activeConvertJobId.value) {
                    return;
                }
                activeConvertJobId.value ??= progress.jobId;
                isLoadingPages.value = false;
                if (progress.phase === 'loading') {
                    conversionState.value = {
                        isConverting: true,
                        phase: null,
                        percent: progress.percent,
                    };
                    return;
                }
                conversionState.value = {
                    isConverting: true,
                    phase: toConversionPhase(progress.phase),
                    percent: progress.percent,
                };
            });
        } catch (error) {
            logSuppressedError('DjVu progress listener unavailable', error);
        }
    }

    function teardownListeners() {
        if (unsubProgress) {
            unsubProgress();
            unsubProgress = null;
        }
        resetViewingProgressState();
        activeConvertJobId.value = null;
    }

    setupProgressListener();
    onUnmounted(() => {
        isUnmounted = true;
        invalidatePendingDjvuOpen();
        conversionGeneration += 1;
        void cancelActiveJobs();
        const activation = captureDjvuActivation();
        if (activation) {
            exitDjvuMode(activation);
        }
        teardownListeners();
    });

    async function openDjvuFile(
        inputPath: string,
        options: IOpenDjvuFileOptions = {},
    ) {
        const djvuPath = parseDocumentRef(inputPath);
        if (djvuPath === null) {
            throw new TypeError('DjVu path must be a valid document reference');
        }
        const generation = ++openDjvuGeneration;
        const djvu = getDjvuCapability();
        const previousDjvuPath = djvuSourcePath.value;
        showBanner.value = true;
        clearSourceError();
        openingPath.value = djvuPath;
        activeConvertJobId.value = null;
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
        try {
            const openHandle = await djvu.startOpenForViewing(
                djvuPath,
                createRequestId('djvu-open'),
            );
            BrowserLogger.info('djvu-open-generation', 'Native job admitted', {
                generation,
                djvuPath,
                jobId: openHandle.jobId,
                current: isCurrentDjvuOpen(generation, djvuPath),
            });
            if (!isCurrentDjvuOpen(generation, djvuPath)) {
                BrowserLogger.warn('djvu-open-generation', 'Open superseded', {
                    reason: 'stale-after-admission',
                    generation,
                    currentGeneration: openDjvuGeneration,
                    djvuPath,
                    openingPath: openingPath.value,
                });
                await cancelJobWhenAdmitted(openHandle.jobId);
                await releaseStaleViewingPath(generation, djvuPath);
                return false;
            }
            activeViewingJobId.value = openHandle.jobId;
            await djvu.subscribeJob(openHandle.jobId);
            const result = await djvu.awaitOpenJob(openHandle.jobId);
            BrowserLogger.info('djvu-open-generation', 'Native result received', {
                generation,
                djvuPath,
                jobId: openHandle.jobId,
                success: result.success,
                pageCount: result.pageCount ?? null,
                current: isCurrentDjvuOpen(generation, djvuPath),
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
                BrowserLogger.error('djvu', 'Open failed', result.error, {
                    code: 'RENDERER_DJVU_OPERATION_FAILED',
                    context: {},
                });
                throw new Error(result.error ?? t('errors.djvu.open'));
            }

            if (result.jobId) {
                activeViewingJobId.value = result.jobId;
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
            const sourceRevision = sourceInfo?.sourceSize !== undefined
                && sourceInfo.sourceModifiedAt !== undefined
                ? {
                    size: sourceInfo.sourceSize,
                    modifiedAt: sourceInfo.sourceModifiedAt,
                }
                : null;
            const openingGeometry = sourceInfo && sourceRevision
                ? cacheTrustedDjvuOpenGeometry(String(djvuPath), sourceRevision, sourceInfo)
                : null;
            if (
                openingGeometry
                && surfaceSnapshot
                && surfaceSnapshot.identity?.documentId === String(djvuPath)
            ) {
                config.openSurface?.commitOpeningPageGeometry(surfaceSnapshot.generation, openingGeometry);
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
            activeProjectionSession = createDocumentSession({
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
            if (!isCurrentDjvuOpen(generation, djvuPath)) {
                await releaseStaleViewingPath(generation, djvuPath);
                return false;
            }
            resetViewingProgressState();
            throw e;
        } finally {
            if (isCurrentDjvuOpen(generation, djvuPath)) {
                openingPath.value = null;
            }
        }
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

        const generation = ++conversionGeneration;
        const djvu = getDjvuCapability();
        const documentFiles = getDocumentFilesCapability();
        const documentWorkingCopy = getDocumentWorkingCopyCapability();
        const requestId = createConversionRequestId();

        const sourceBaseName = getDocumentRefBaseName(sourcePath)?.trim();
        const suggestedName = sourceBaseName
            ? ensurePdfSuggestedName(sourceBaseName.replace(/\.djvu?$/i, ''))
            : ensurePdfSuggestedName(t('djvu.documentFallback'));
        const savePath = parseDocumentRef(await documentFiles.savePdfDialog(suggestedName));
        if (savePath === null || generation !== conversionGeneration || djvuSourcePath.value !== sourcePath) {
            return null;
        }

        conversionState.value = {
            isConverting: true,
            phase: 'converting',
            percent: 0,
        };
        activeConversionGeneration = generation;
        activeConvertJobId.value = null;
        let shouldCleanupSavePath = true;

        BrowserLogger.info('djvu', 'Starting conversion to PDF', {
            subsample,
            preserveBookmarks,
            pdfStrategy,
        });

        try {
            clearSourceError();
            const convertHandle = await djvu.startConvertToPdf(
                sourcePath,
                savePath,
                {
                    subsample,
                    preserveBookmarks,
                    pdfStrategy,
                    requestId,
                    documentRef: sourcePath,
                    hostTier: getPerformanceProfile().tier,
                },
            );
            if (!isCurrentConversion(generation, sourcePath)) {
                await cancelJobWhenAdmitted(convertHandle.jobId);
                return null;
            }
            activeConvertJobId.value = convertHandle.jobId;
            await djvu.subscribeJob(convertHandle.jobId);
            const result = await djvu.awaitConvertJob(convertHandle.jobId);

            if (!ownsConversion(generation)) {
                return null;
            }

            if (
                result.requestId
                && result.requestId !== requestId
            ) {
                return null;
            }
            if (result.jobId) {
                activeConvertJobId.value = result.jobId;
            }

            const outputState = result.jobId
                ? await djvu.subscribeJob(result.jobId)
                : null;
            const outputError = outputState && 'error' in outputState
                ? outputState.error
                : undefined;
            const failure = getDjvuFailureReceipt(result)
                ?? getDjvuFailureReceipt(outputState);
            const expected = getDjvuExpectedOutcome(result)
                ?? getDjvuExpectedOutcome(outputState);

            if (
                !result.success
                || !result.pdfPath
                || !outputState
                || outputState.operation !== 'djvu-convert'
                || (outputState.status !== 'completed' && outputState.status !== 'handoff')
            ) {
                presentConversionFailure(
                    result.error ?? outputError ?? t('errors.djvu.convert'),
                    failure,
                    expected,
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
                    await djvu.getPageSizes(sourcePath),
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

            if (!isCurrentConversion(generation, sourcePath)) {
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
            if (!isCurrentConversion(generation, sourcePath)) {
                return null;
            }
            if (openResult.status === 'failed') {
                sourceError.value = openResult.error || t('errors.file.open');
                return null;
            }
            return didOpenDocument(openResult) ? result.pdfPath : null;
        } catch (error) {
            if (!isCurrentConversion(generation, sourcePath)) {
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
                }, {
                    code: 'RENDERER_DJVU_OPERATION_FAILED',
                    context: {},
                });
                showConversionError(message, ownedFailure);
            }
        } finally {
            if (activeConversionGeneration === generation) {
                activeConversionGeneration = null;
                activeConvertJobId.value = null;
                conversionState.value = {
                    isConverting: false,
                    phase: null,
                    percent: 0,
                };
            }
            if (shouldCleanupSavePath && isBrowserDocumentRef(savePath)) {
                await documentWorkingCopy.cleanupFile(savePath).catch((cleanupError: unknown) => {
                    logSuppressedError('Failed to cleanup DjVu browser output ref', cleanupError);
                });
            }
            if (isUnmounted) {
                teardownListeners();
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
            : createDocumentSession({
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
        const invalidatedConversion = activeConversionGeneration !== null;
        if (invalidatedConversion) {
            conversionGeneration += 1;
            activeConversionGeneration = null;
            conversionState.value = {
                isConverting: false,
                phase: null,
                percent: 0,
            };
        }
        const ids = new Set<TJobId>();
        if (activeViewingJobId.value) {
            ids.add(activeViewingJobId.value);
        }
        if (activeConvertJobId.value) {
            ids.add(activeConvertJobId.value);
        }
        BrowserLogger.info('djvu', 'Cancelling active jobs', { jobIds: [...ids] });
        if (ids.size === 0) {
            return false;
        }

        try {
            await Promise.all(Array.from(ids, async (jobId) => {
                try {
                    await getDjvuCapability().cancel(jobId);
                } catch (cancelError) {
                    logSuppressedError(`Failed to cancel DjVu job ${jobId}`, cancelError);
                }
            }));
        } catch (error) {
            logSuppressedError('Failed to cancel active DjVu jobs', error);
            return false;
        }

        activeViewingJobId.value = null;
        activeConvertJobId.value = null;
        isLoadingPages.value = false;
        loadingProgress.value = {
            current: 0,
            total: 0,
        };
        conversionState.value = {
            isConverting: false,
            phase: null,
            percent: 0,
        };
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
