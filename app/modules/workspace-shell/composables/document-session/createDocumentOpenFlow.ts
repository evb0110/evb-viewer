/* eslint-disable max-lines -- Open flow stages picker, password, and PDF state transitions together. */
import { clamp } from 'es-toolkit/math';
import type {
    IAnalyticsDocumentScope,
    useAnalytics,
} from '@app/composables/useAnalytics';
import type { TTranslateFn } from '@i18n-app';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    getFailureReceipt,
    type ExpectedOutcome,
} from '@contracts/diagnostics/failureReceipt';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type {
    IDocumentMutationRevisionOptions,
    TOpenFileResult,
} from '@contracts/electronApiDocuments';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { IPdfRasterDisplayProfileOpenOptions } from '@app/types/pdfRasterDisplayProfile';
import {consumeRegisteredPdfRasterDisplayProfile} from '@app/types/pdfRasterDisplayProfile';
import type { TPdfSource } from '@app/types/pdfUi';
import type {
    createEpochGuard,
    IDocumentSessionState,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import type { IPdfLoadedState } from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';
import type { IPdfConformanceDeferralOptions } from '@app/modules/workspace-shell/composables/document-session/createDocumentConformance';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import {
    bucketFileSize,
    getLowercaseExtension,
} from '@app/utils/analytics';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { getDocumentRefBaseName } from '@app/utils/documentRef';
import { getErrorMessage } from '@app/utils/error';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import { resolveOpenPathSecondaryPerformancePolicy } from '@app/utils/openPathSecondaryPerformancePolicy';
import {
    getDocumentFilesCapability,
    getDocumentOpenCapability,
    getDocumentPdfCapability,
    getDocumentPickerCapability,
} from '@app/utils/platformDocuments';
import type { IDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import {validatePdfRevision} from '@app/modules/workspace-shell/composables/document-session/pdfValidationRevisionCache';
import {
    stagePdfOpeningPreview,
    type IPdfOpeningGeometryResolution,
} from '@app/modules/workspace-shell/composables/document-session/stagePdfOpeningPreview';
import {shouldStageNativePdfOpeningPreview} from '@app/modules/pdf-viewer/public/nativePreviewRouting';
import {resolvePdfOpeningGeometry} from '@app/modules/workspace-shell/composables/document-session/resolvePdfOpeningGeometry';
import {openPdfAfterPasswordPrompt as runPasswordPromptFlow} from '@app/modules/workspace-shell/composables/document-session/openPdfAfterPasswordPrompt';
import {
    isPdfPasswordFailureResult,
    type TPdfPasswordFailureResult,
} from '@app/modules/workspace-shell/composables/document-session/isPdfPasswordFailureResult';
import {classifyDocumentOpenError} from '@app/modules/workspace-shell/composables/document-session/classifyDocumentOpenError';
import {useDocumentPasswordPrompt} from '@app/modules/workspace-shell/composables/useDocumentPasswordPrompt';

type TAnalytics = ReturnType<typeof useAnalytics>;
type TEpochGuard = ReturnType<typeof createEpochGuard>;
type TOpenedFileResult = Extract<TOpenFileResult, {kind: 'pdf' | 'djvu'}>;
export type TDocumentDirectOpenOptions = IPdfRasterDisplayProfileOpenOptions;

interface ICreateDocumentOpenFlowDeps {
    analytics: TAnalytics;
    analyticsDocumentScope: IAnalyticsDocumentScope;
    cleanupAbandonedWorkingCopy: (path: TDocumentRef) => Promise<void>;
    clearPdfConformanceProfile: () => void;
    cleanupPreviousWorkingCopy: (path: TDocumentRef, nextPath: TDocumentRef) => Promise<void>;
    deferPdfConformanceProfile: (
        path: TDocumentRef,
        options?: IPdfConformanceDeferralOptions,
    ) => void;
    incrementSessionVersion: () => void;
    ensureHistoryBaselineForMutation: () => Promise<boolean>;
    loadEpoch: TEpochGuard;
    openSurface?: IDocumentOpenSurfaceSession | undefined;
    openEpoch: TEpochGuard;
    pushHistorySnapshot: (
        snapshot: Uint8Array,
        options?: { reuseSnapshot?: boolean },
    ) => Promise<boolean>;
    resetHistory: (
        snapshot: Uint8Array | null,
        options?: {
            reuseSnapshot?: boolean;
            isCurrent?: (() => boolean) | undefined;
        },
    ) => Promise<boolean>;
    syncDirtyFromHistory: () => void;
    reportOpenFailure?: (
        operationId: string,
        reason: 'unsupported-encryption',
        detail?: string | null,
    ) => boolean;
    t: TTranslateFn;
}

const RECENT_OPEN_LOG_SECTION = 'recent-open';
const MAX_EAGER_HISTORY_BASELINE_BYTES = 8 * 1024 * 1024;
function createDocumentMutationRevisionOptions(
    expectedDocumentRevisionToken: TDocumentRevisionToken | null | undefined,
): IDocumentMutationRevisionOptions | undefined {
    if (expectedDocumentRevisionToken === null || expectedDocumentRevisionToken === undefined) {
        return undefined;
    }
    return { expectedDocumentRevisionToken };
}

export function createDocumentOpenFlow(
    state: IDocumentSessionState,
    deps: ICreateDocumentOpenFlowDeps,
) {
    let cancelActiveSpeculativeOpen: ((reason: string) => void) | null = null;
    const performancePolicy = resolveOpenPathSecondaryPerformancePolicy(getPerformanceProfile());
    const {
        deferMediumHistoryBaseline,
        geometryPreflightMode,
        maxInMemoryPdfBytes,
    } = performancePolicy;
    const {
        requestPassword,
        cancelPasswordPrompt,
    } = useDocumentPasswordPrompt();
    function assertPdfHasBytes(size: number) {
        if (size > 0) {
            return;
        }

        throw new Error(deps.t('errors.file.emptyPdf'));
    }

    function toPdfBlob(snapshot: Uint8Array) {
        const ownedSnapshot = (
            snapshot.buffer instanceof ArrayBuffer
            && snapshot.byteOffset === 0
            && snapshot.byteLength === snapshot.buffer.byteLength
        )
            ? snapshot as Uint8Array<ArrayBuffer>
            : (
                snapshot.byteOffset === 0
                && snapshot.byteLength === snapshot.buffer.byteLength
            )
                ? new Uint8Array(snapshot)
                : snapshot.slice();
        return new Blob([ownedSnapshot], { type: 'application/pdf' });
    }

    function getLoadedPdfFileSize(nextState: IPdfLoadedState) {
        if (nextState.pdfData) {
            return nextState.pdfData.byteLength;
        }
        const source = nextState.pdfSrc;
        if (
            source
            && typeof source === 'object'
            && 'kind' in source
            && source.kind === 'path'
        ) {
            return source.size;
        }
        return null;
    }

    async function pickFileToOpen() {
        return getDocumentPickerCapability().openDocumentDialog();
    }

    async function trackOpenedDocument(
        result: TOpenedFileResult,
        openMethod: 'picker' | 'preselected' | 'direct' | 'batch',
    ) {
        const fileName = getDocumentRefBaseName(result.originalPath);
        let fileSizeBucket: string | null = null;

        if (result.kind === 'pdf') {
            try {
                // The open result has already adopted a managed working copy.
                // Renderer file capabilities deliberately cannot stat an
                // arbitrary original path; the byte-identical working copy is
                // the authoritative readable source for analytics size.
                const { size } = await getDocumentFilesCapability().statFile(result.workingPath);
                fileSizeBucket = bucketFileSize(size);
            } catch {
                fileSizeBucket = null;
            }
        }

        deps.analyticsDocumentScope.set({
            documentKind: result.kind,
            fileExtension: getLowercaseExtension(fileName),
            fileSizeBucket,
            isGenerated: result.kind === 'pdf' ? Boolean(result.isGenerated) : false,
            pageCountBucket: null,
            totalPages: null,
        });
        deps.analytics.track('document_opened', {
            documentKind: result.kind,
            fileExtension: getLowercaseExtension(fileName),
            fileSizeBucket,
            isGenerated: result.kind === 'pdf' ? Boolean(result.isGenerated) : false,
            openMethod,
            requiresSaveAsOnFirstSave: result.kind === 'pdf' ? Boolean(result.isGenerated) : false,
        });
    }

    function beginOpenRequest() {
        cancelPasswordPrompt();
        cancelActiveSpeculativeOpen?.('open-superseded');
        cancelActiveSpeculativeOpen = null;
        deps.loadEpoch.invalidate();
        return deps.openEpoch.begin();
    }

    function recordOpenFailure(message: string, error: unknown, data?: unknown) {
        const receipt = BrowserLogger.error(
            RECENT_OPEN_LOG_SECTION,
            'Document open failed',
            data ?? error,
            getFailureReceipt(error) ?? {
                code: 'RENDERER_PDF_DOCUMENT_LOAD_FAILED',
                context: {},
            },
        );
        state.error.value = message;
        state.failurePresentation.value = {
            failure: receipt,
            title: deps.t('errors.file.open'),
            description: message,
        };
        return receipt;
    }

    function recordHandledOpenAbsence(message: string, data?: unknown) {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Document open returned no document', data);
        BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Document open returned no document', {
            kind: 'expected',
            code: 'handled-absence',
        } satisfies ExpectedOutcome);
        state.error.value = message;
        state.failurePresentation.value = null;
    }

    function isCurrentOpenRequest(requestId: number) {
        return deps.openEpoch.isCurrent(requestId);
    }

    function isCurrentLoadRequest(requestId: number) {
        return deps.loadEpoch.isCurrent(requestId);
    }

    function isCurrentOpenLoadRequest(openRequestId: number, loadRequestId: number) {
        return isCurrentOpenRequest(openRequestId) && isCurrentLoadRequest(loadRequestId);
    }

    async function cleanupAbandonedPdfWorkingCopy(
        result: TOpenFileResult,
        reason: string,
    ) {
        if (result.kind !== 'pdf' || state.isActiveWorkingCopy(result.workingPath)) {
            return;
        }

        try {
            await deps.cleanupAbandonedWorkingCopy(result.workingPath);
        } catch (cleanupError) {
            BrowserLogger.warn(
                RECENT_OPEN_LOG_SECTION,
                'Failed to cleanup abandoned PDF working copy',
                {
                    path: result.workingPath,
                    reason,
                    error: cleanupError,
                },
            );
        }
    }

    function reportUnsupportedEncryption(openRequestId: number) {
        const message = deps.t('errors.file.unsupportedEncryption');
        state.error.value = message;
        deps.reportOpenFailure?.(`open:${openRequestId}`, 'unsupported-encryption');
        return {
            status: 'failed',
            error: message,
        } satisfies TDocumentOpenOutcome;
    }

    async function openFile(preSelected?: TOpenFileResult) {
        const openRequestId = beginOpenRequest();
        state.error.value = null;
        state.failurePresentation.value = null;
        state.pendingDjvu.value = null;
        state.openBatchProgress.value = null;
        try {
            const result = preSelected ?? (await pickFileToOpen());
            if (!isCurrentOpenRequest(openRequestId)) {
                if (result) {
                    await cleanupAbandonedPdfWorkingCopy(result, 'stale-picker-result');
                    return {
                        status: 'stale',
                        result,
                    } satisfies TDocumentOpenOutcome;
                }
                return { status: 'cancelled' } satisfies TDocumentOpenOutcome;
            }
            if (!result) {
                return { status: 'cancelled' } satisfies TDocumentOpenOutcome;
            }
            if (isPdfPasswordFailureResult(result)) {
                return await openPdfWithPasswordPrompt(
                    openRequestId,
                    result,
                    preSelected ? 'preselected' : 'picker',
                );
            }
            if (result.kind === 'djvu') {
                state.pendingDjvu.value = result.originalPath;
                BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'DjVu open prepared', {
                    reason: 'picker-result-ready',
                    openRequestId,
                    path: result.originalPath,
                });
                await trackOpenedDocument(result, preSelected ? 'preselected' : 'picker');
                return {
                    status: 'prepared',
                    result,
                } satisfies TDocumentOpenOutcome;
            }
            return await finishPdfOpenResult(
                openRequestId,
                result,
                preSelected ? 'preselected' : 'picker',
            );
        } catch (e) {
            if (!isCurrentOpenRequest(openRequestId)) {
                return {
                    status: 'failed',
                    error: classifyDocumentOpenError(e, preSelected?.originalPath ?? null, deps.t),
                } satisfies TDocumentOpenOutcome;
            }
            const message = classifyDocumentOpenError(e, preSelected?.originalPath ?? null, deps.t);
            recordOpenFailure(message, e, {
                path: preSelected?.originalPath ?? null,
                error: e,
            });
            return {
                status: 'failed',
                error: message,
            } satisfies TDocumentOpenOutcome;
        }
    }

    async function finishPdfOpenResult(
        openRequestId: number,
        result: Extract<TOpenFileResult, { kind: 'pdf' }>,
        openMethod: 'picker' | 'preselected' | 'direct' | 'batch',
        options: IPdfRasterDisplayProfileOpenOptions = {},
    ) {
        const registeredRasterDisplayProfile = consumeRegisteredPdfRasterDisplayProfile(
            result.originalPath,
            result.workingPath,
        );
        const rasterDisplayProfile = options.rasterDisplayProfile
            ?? registeredRasterDisplayProfile;
        const readOpeningGeometry = getDocumentFilesCapability().getPdfOpeningGeometry;
        const openingGeometry = resolvePdfOpeningGeometry({
            concurrent: geometryPreflightMode === 'concurrent',
            isCurrent: () => isCurrentOpenRequest(openRequestId),
            openSurface: deps.openSurface,
            readOpeningGeometry: readOpeningGeometry
                ? () => readOpeningGeometry(result.workingPath)
                : undefined,
            readSourceRevision: () => getDocumentFilesCapability().statFile(result.originalPath)
                .then(file => ({
                    fileSize: file.size,
                    ...(file.modifiedAt === undefined ? {} : {modifiedAt: file.modifiedAt}),
                })),
            result,
        });
        try {
            await loadPdfFromPath(result.workingPath, {
                markDirty: !!result.isGenerated,
                openRequestId,
                openingGeometryResolution: openingGeometry.resolution,
                validationRevision: openingGeometry.validationRevision,
                resetSourceBeforeCommit: true,
            });
        } catch (error) {
            await cleanupAbandonedPdfWorkingCopy(result, 'failed-pdf-load');
            throw error;
        }
        if (!isCurrentOpenRequest(openRequestId) || state.workingCopyPath.value !== result.workingPath) {
            await cleanupAbandonedPdfWorkingCopy(result, 'stale-pdf-load');
            return {
                status: 'stale',
                result,
            } satisfies TDocumentOpenOutcome;
        }
        state.wasEncrypted.value = result.wasEncrypted === true;
        await trackOpenedDocument(result, openMethod);
        if (!isCurrentOpenRequest(openRequestId) || state.workingCopyPath.value !== result.workingPath) {
            await cleanupAbandonedPdfWorkingCopy(result, 'stale-pdf-track');
            return {
                status: 'stale',
                result,
            } satisfies TDocumentOpenOutcome;
        }
        state.originalPath.value = result.originalPath;
        state.requiresSaveAsOnFirstSave.value = !!result.isGenerated;
        state.pdfRasterDisplayProfile.value = rasterDisplayProfile;
        return {
            status: 'opened',
            result,
        } satisfies TDocumentOpenOutcome;
    }

    function openPdfWithPasswordPrompt(
        openRequestId: number,
        initialFailure: TPdfPasswordFailureResult,
        openMethod: 'picker' | 'preselected' | 'direct' | 'batch',
        options: IPdfRasterDisplayProfileOpenOptions = {},
    ) {
        return runPasswordPromptFlow(openRequestId, initialFailure, openMethod, options, {
            requestPassword,
            isCurrentOpenRequest,
            openDocumentDirect: (path, password) => getDocumentOpenCapability().openDocumentDirect(path, password),
            cleanupAbandonedPdfWorkingCopy,
            setError: message => { state.error.value = message; },
            reportUnsupportedEncryption,
            trackOpenedDocument,
            setPendingDjvuPath: path => { state.pendingDjvu.value = path; },
            finishPdfOpenResult,
            t: deps.t,
        });
    }

    async function openFileDirect(path: TDocumentRef, options: TDocumentDirectOpenOptions = {}) {
        const openRequestId = beginOpenRequest();
        state.error.value = null;
        state.failurePresentation.value = null;
        state.pendingDjvu.value = null;
        state.openBatchProgress.value = null;
        logPdfRenderTrace('pdf-open-direct-start', {
            openRequestId,
            path,
            wallTimeMs: Date.now(),
            performanceTimeOrigin: typeof performance === 'undefined' ? null : performance.timeOrigin,
        });
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openFileDirect started', {path});
        try {
            const openCapabilityStartedAt = performance.now();
            logPdfRenderTrace('pdf-open-capability-start', {
                openRequestId,
                path,
            });
            const result = await getDocumentOpenCapability().openDocumentDirect(path);
            logPdfRenderTrace('pdf-open-capability-end', {
                openRequestId,
                path,
                elapsedMs: performance.now() - openCapabilityStartedAt,
                resultKind: result?.kind ?? null,
                workingPath: result?.kind === 'pdf' ? result.workingPath : null,
            });
            if (!isCurrentOpenRequest(openRequestId)) {
                if (result) {
                    await cleanupAbandonedPdfWorkingCopy(result, 'stale-direct-result');
                    return {
                        status: 'stale',
                        result,
                    } satisfies TDocumentOpenOutcome;
                }
                return {
                    status: 'failed',
                    error: deps.t('errors.file.invalid'),
                } satisfies TDocumentOpenOutcome;
            }
            if (!result) {
                const message = deps.t('errors.file.invalid');
                recordHandledOpenAbsence(message, {
                    path,
                    reason: 'null-open-result',
                });
                return {
                    status: 'failed',
                    error: message,
                } satisfies TDocumentOpenOutcome;
            }
            if (isPdfPasswordFailureResult(result)) {
                return await openPdfWithPasswordPrompt(openRequestId, result, 'direct', options);
            }

            BrowserLogger.debug(
                RECENT_OPEN_LOG_SECTION,
                'openDocumentDirect returned result',
                {
                    path,
                    kind: result.kind,
                    isGenerated:
                        result.kind === 'pdf' ? Boolean(result.isGenerated) : undefined,
                    workingPath: result.kind === 'pdf' ? result.workingPath : undefined,
                },
            );

            if (result.kind === 'djvu') {
                state.pendingDjvu.value = result.originalPath;
                BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'DjVu open prepared', {
                    reason: 'direct-result-ready',
                    openRequestId,
                    path: result.originalPath,
                });
                await trackOpenedDocument(result, 'direct');
                BrowserLogger.debug(
                    RECENT_OPEN_LOG_SECTION,
                    'openFileDirect entered DjVu mode',
                    {
                        path,
                        djvuPath: result.originalPath,
                    },
                );
                return {
                    status: 'prepared',
                    result,
                } satisfies TDocumentOpenOutcome;
            }
            BrowserLogger.debug(
                RECENT_OPEN_LOG_SECTION,
                'Loading PDF from working path',
                {
                    path,
                    workingPath: result.workingPath,
                },
            );
            const outcome = await finishPdfOpenResult(openRequestId, result, 'direct', options);
            if (outcome.status === 'stale') {
                BrowserLogger.debug(
                    RECENT_OPEN_LOG_SECTION,
                    'openFileDirect skipped stale load result',
                    {
                        path,
                        workingPath: result.workingPath,
                    },
                );
                return outcome;
            }
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openFileDirect completed', {
                path,
                workingPath: result.workingPath,
                originalPath: result.originalPath,
                requiresSaveAsOnFirstSave: state.requiresSaveAsOnFirstSave.value,
            });
            logPdfRenderTrace('pdf-open-direct-end', {
                openRequestId,
                path,
                status: outcome.status,
                workingPath: result.workingPath,
            });
            return outcome;
        } catch (e) {
            if (!isCurrentOpenRequest(openRequestId)) {
                return {
                    status: 'failed',
                    error: classifyDocumentOpenError(e, path, deps.t),
                } satisfies TDocumentOpenOutcome;
            }
            const message = classifyDocumentOpenError(e, path, deps.t);
            recordOpenFailure(message, e, {
                path,
                error: e,
            });
            logPdfRenderTrace('pdf-open-direct-end', {
                openRequestId,
                path,
                status: 'failed',
                error: getErrorMessage(e),
            });
            return {
                status: 'failed',
                error: message,
            } satisfies TDocumentOpenOutcome;
        }
    }

    async function openFileDirectBatch(paths: TDocumentRef[]) {
        const openRequestId = beginOpenRequest();
        state.error.value = null;
        state.failurePresentation.value = null;
        state.pendingDjvu.value = null;
        state.openBatchProgress.value = null;
        try {
            const documentOpen = getDocumentOpenCapability();
            const normalizedPaths = paths
                .map((path) => path.trim())
                .filter((path) => path.length > 0);

            if (normalizedPaths.length === 0) {
                const message = deps.t('errors.file.invalid');
                if (isCurrentOpenRequest(openRequestId)) {
                    state.error.value = message;
                }
                return {
                    status: 'failed',
                    error: message,
                } satisfies TDocumentOpenOutcome;
            }

            const requestId = crypto.randomUUID();
            state.openBatchProgress.value = {
                processed: 0,
                total: normalizedPaths.length,
                percent: 0,
                elapsedMs: 0,
                estimatedRemainingMs: null,
            };

            const stopProgress = documentOpen.onOpenDocumentDirectBatchProgress(
                (progress) => {
                    if (
                        progress.operation !== 'document-open'
                        || progress.requestId !== requestId
                        || !isCurrentOpenRequest(openRequestId)
                    ) {
                        return;
                    }

                    state.openBatchProgress.value = {
                        processed: Math.max(0, progress.processed),
                        total: Math.max(0, progress.total),
                        percent: clamp(progress.percent, 0, 100),
                        elapsedMs: Math.max(0, progress.elapsedMs),
                        estimatedRemainingMs:
                            typeof progress.estimatedRemainingMs === 'number'
                                ? Math.max(0, progress.estimatedRemainingMs)
                                : null,
                    };
                },
            );

            let result: TOpenFileResult | null = null;
            try {
                result = await documentOpen.openDocumentDirectBatch(
                    normalizedPaths,
                    requestId,
                );
            } finally {
                stopProgress();
            }

            if (!isCurrentOpenRequest(openRequestId)) {
                if (result) {
                    await cleanupAbandonedPdfWorkingCopy(result, 'stale-batch-result');
                    return {
                        status: 'stale',
                        result,
                    } satisfies TDocumentOpenOutcome;
                }
                return {
                    status: 'failed',
                    error: deps.t('errors.file.invalid'),
                } satisfies TDocumentOpenOutcome;
            }
            if (!result) {
                state.openBatchProgress.value = null;
                const message = deps.t('errors.file.invalid');
                recordHandledOpenAbsence(message, {reason: 'null-batch-open-result'});
                return {
                    status: 'failed',
                    error: message,
                } satisfies TDocumentOpenOutcome;
            }
            if (isPdfPasswordFailureResult(result)) {
                state.openBatchProgress.value = null;
                return await openPdfWithPasswordPrompt(openRequestId, result, 'batch');
            }
            if (result.kind === 'djvu') {
                state.openBatchProgress.value = null;
                state.pendingDjvu.value = result.originalPath;
                BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'DjVu open prepared', {
                    reason: 'batch-result-ready',
                    openRequestId,
                    path: result.originalPath,
                });
                await trackOpenedDocument(result, 'batch');
                return {
                    status: 'prepared',
                    result,
                } satisfies TDocumentOpenOutcome;
            }
            state.openBatchProgress.value = null;
            return await finishPdfOpenResult(openRequestId, result, 'batch');
        } catch (e) {
            if (!isCurrentOpenRequest(openRequestId)) {
                return {
                    status: 'failed',
                    error: e instanceof Error ? e.message : deps.t('errors.file.open'),
                } satisfies TDocumentOpenOutcome;
            }
            state.openBatchProgress.value = null;
            const message = e instanceof Error ? e.message : deps.t('errors.file.open');
            recordOpenFailure(message, e);
            return {
                status: 'failed',
                error: message,
            } satisfies TDocumentOpenOutcome;
        }
    }

    async function applyLoadedPdfState(
        path: TDocumentRef,
        nextState: IPdfLoadedState,
        options?: {
            markDirty?: boolean;
            preserveHistory?: boolean;
            previousPath?: TDocumentRef | null;
            preparedDocumentRevision?: IDocumentRevisionInfo | null;
            isCurrent?: (() => boolean) | undefined;
        },
    ) {
        if (options?.isCurrent?.() === false) {
            return false;
        }

        const didRefreshRevision = options && 'preparedDocumentRevision' in options
            ? applyPreparedDocumentRevision(options.preparedDocumentRevision ?? null, options.isCurrent)
            : await refreshDocumentRevisionToken(path, options?.isCurrent);
        if (!didRefreshRevision) {
            return false;
        }

        state.workingCopyPath.value = path;
        state.pdfData.value = nextState.pdfData;
        state.pdfSrc.value = nextState.pdfSrc;
        state.pdfReloadSrc.value = nextState.pdfSrc;
        deps.clearPdfConformanceProfile();

        if (!options?.preserveHistory) {
            deps.incrementSessionVersion();
            if (
                nextState.pdfData
                && (
                    !deferMediumHistoryBaseline
                    || nextState.pdfData.byteLength <= MAX_EAGER_HISTORY_BASELINE_BYTES
                )
            ) {
                const didResetHistory = await deps.resetHistory(nextState.pdfData, {
                    reuseSnapshot: true,
                    isCurrent: options?.isCurrent,
                });
                if (!didResetHistory || options?.isCurrent?.() === false) {
                    return false;
                }
                deps.syncDirtyFromHistory();
            } else {
                const didResetHistory = await deps.resetHistory(null, { isCurrent: options?.isCurrent });
                if (!didResetHistory || options?.isCurrent?.() === false) {
                    return false;
                }
            }
        }

        if (options?.isCurrent?.() === false) {
            return false;
        }

        if (typeof options?.markDirty === 'boolean') {
            state.isDirty.value = options.markDirty;
        }

        if (
            options?.previousPath
            && options.previousPath !== path
            && options.isCurrent?.() !== false
        ) {
            await deps.cleanupPreviousWorkingCopy(options.previousPath, path);
            if (options.isCurrent?.() === false) {
                return false;
            }
        }

        deps.deferPdfConformanceProfile(path, { fileSize: getLoadedPdfFileSize(nextState) });
        return true;
    }

    async function refreshDocumentRevisionToken(
        path: TDocumentRef,
        isCurrent?: (() => boolean) | undefined,
    ) {
        if (isCurrent?.() === false) {
            return false;
        }

        const revision = await resolveDocumentRevision(path, isCurrent);
        return applyPreparedDocumentRevision(revision, isCurrent);
    }

    function applyPreparedDocumentRevision(
        revision: IDocumentRevisionInfo | null,
        isCurrent?: (() => boolean) | undefined,
    ) {
        if (isCurrent?.() === false) {
            return false;
        }
        state.documentRevisionInfo.value = revision;
        state.documentRevisionToken.value = revision?.token ?? null;
        return true;
    }

    async function resolveDocumentRevision(
        path: TDocumentRef,
        isCurrent?: (() => boolean) | undefined,
    ) {
        try {
            const revision = await getDocumentFilesCapability().getDocumentRevision(path);
            return isCurrent?.() === false ? null : revision;
        } catch (error) {
            if (isCurrent?.() === false) {
                return null;
            }
            BrowserLogger.warn('pdf-file', 'Failed to resolve document revision', {
                path,
                error,
            });
            return null;
        }
    }

    async function readPdfStateFromPath(
        path: TDocumentRef,
        traceContext?: {
            openRequestId?: number;
            loadRequestId: number
        },
    ): Promise<IPdfLoadedState> {
        const statStartedAt = performance.now();
        logPdfRenderTrace('pdf-open-source-stat-start', {
            path,
            ...traceContext,
        });
        const { size } = await getDocumentFilesCapability().statFile(path);
        logPdfRenderTrace('pdf-open-source-stat-end', {
            path,
            ...traceContext,
            size,
            elapsedMs: performance.now() - statStartedAt,
        });
        assertPdfHasBytes(size);

        if (size > maxInMemoryPdfBytes) {
            logPdfRenderTrace('pdf-open-source-ready', {
                path,
                ...traceContext,
                sourceKind: 'path',
                declaredSize: size,
                directBinaryPayloadLimit: maxInMemoryPdfBytes,
            });
            return {
                pdfData: null,
                pdfSrc: {
                    kind: 'path' as const,
                    path,
                    size,
                },
            };
        }

        const readStartedAt = performance.now();
        logPdfRenderTrace('pdf-open-source-read-start', {
            path,
            ...traceContext,
            declaredSize: size,
        });
        const data = await readDocumentBytes(path, {
            knownSize: size,
            maxBytes: maxInMemoryPdfBytes,
        });
        logPdfRenderTrace('pdf-open-source-read-end', {
            path,
            ...traceContext,
            sourceKind: 'data',
            declaredSize: size,
            bytesRead: data.byteLength,
            elapsedMs: performance.now() - readStartedAt,
        });
        return {
            pdfData: data,
            pdfSrc: toPdfBlob(data) as TPdfSource,
        };
    }

    async function loadPdfFromPath(path: TDocumentRef, opts?: {
        markDirty?: boolean;
        openRequestId?: number;
        openingGeometryResolution?: Promise<IPdfOpeningGeometryResolution>;
        resetSourceBeforeCommit?: boolean;
        validationRevision?: ReturnType<typeof resolvePdfOpeningGeometry>['validationRevision'];
    }) {
        const requestId = deps.loadEpoch.begin();
        const traceContext = {
            ...(opts?.openRequestId === undefined ? {} : { openRequestId: opts.openRequestId }),
            loadRequestId: requestId,
        };
        const isCurrent = () => (
            isCurrentLoadRequest(requestId)
            && (
                opts?.openRequestId === undefined
                || isCurrentOpenLoadRequest(opts.openRequestId, requestId)
            )
        );
        // Yield one visual frame so upstream loading indicators (e.g. the
        // workspace host spinner) can paint before the potentially heavy file
        // read blocks the renderer thread during IPC deserialization.
        const visualYieldStartedAt = performance.now();
        logPdfRenderTrace('pdf-open-visual-yield-start', {
            path,
            ...traceContext,
        });
        await waitForVisualFrames();
        logPdfRenderTrace('pdf-open-visual-yield-end', {
            path,
            ...traceContext,
            elapsedMs: performance.now() - visualYieldStartedAt,
        });
        if (!isCurrent()) {
            return;
        }

        // Verify and read file BEFORE committing any reactive state.
        // This prevents an inconsistent UI where the tab shows metadata
        // (filename, dirty dot) but the content area shows the empty state
        // because pdfSrc remained unset after a failed read.
        // Only the file state is needed for rendering; conformance analysis
        // (used only for save restrictions) is deferred so it does not block
        // the initial display of the document.
        const nextState = await readPdfStateFromPath(path, traceContext);

        if (!isCurrent()) {
            BrowserLogger.debug('pdf-file', 'Skipped stale PDF load result', {
                path,
                requestId,
                currentLoadRequestId: deps.loadEpoch.current(),
            });
            return;
        }

        const stagedPreview = nextState.pdfSrc
            && typeof nextState.pdfSrc === 'object'
            && 'kind' in nextState.pdfSrc
            && nextState.pdfSrc.kind === 'path'
            && opts?.openingGeometryResolution
            && deps.openSurface
            ? stagePdfOpeningPreview({
                documentFiles: getDocumentFilesCapability(),
                geometryResolution: opts.openingGeometryResolution,
                isCurrent,
                openSurface: deps.openSurface,
                source: nextState.pdfSrc,
                traceContext,
            })
            : null;
        let allowSpeculativePdfjs = true;
        const clearSpeculativeSource = () => {
            if (state.pdfOpeningSrc.value !== nextState.pdfSrc) {
                return;
            }
            state.pdfOpeningSrc.value = null;
            state.pdfOpeningRevisionToken.value = null;
        };
        cancelActiveSpeculativeOpen = (reason) => {
            allowSpeculativePdfjs = false;
            stagedPreview?.cancel(reason);
            clearSpeculativeSource();
        };

        // The open capability only stages a working copy. Keep the currently
        // displayed document intact until a real PDF parser accepts that copy.
        // This is intentionally before the transient source reset and before
        // any working-copy/history ownership changes, which also means a slow
        // validation is time the user spends looking at the previous document
        // under the new document's title.
        const validateStartedAt = performance.now();
        logPdfRenderTrace('pdf-open-validate-start', {
            path,
            ...traceContext,
        });
        const validationTask = (opts?.validationRevision ?? Promise.resolve(null))
            .then(revision => validatePdfRevision(
                revision,
                () => getDocumentPdfCapability().validatePdfPath(path, {purpose: 'opening'}),
                'opening',
            ));
        const pdfjsPreparation: {
            preparedDocumentRevision: IDocumentRevisionInfo | null | undefined;
            readyHold: {
                generation: number;
                sourceRevisionKey: string;
            } | null;
        } = {
            preparedDocumentRevision: undefined,
            readyHold: null,
        };
        const speculativePathSource = nextState.pdfSrc
            && typeof nextState.pdfSrc === 'object'
            && 'kind' in nextState.pdfSrc
            && nextState.pdfSrc.kind === 'path'
            ? nextState.pdfSrc
            : null;
        const openSurface = deps.openSurface;
        const preparePdfjsConcurrently = opts?.openingGeometryResolution
            && speculativePathSource
            && openSurface
            ? opts.openingGeometryResolution.then(async (resolution) => {
                if (
                    !allowSpeculativePdfjs
                    || !isCurrent()
                    || resolution.openingGeometry === null
                    || resolution.sourceRevision === null
                    || !shouldStageNativePdfOpeningPreview(speculativePathSource, resolution.openingGeometry)
                ) {
                    return;
                }
                const revision = await resolveDocumentRevision(path, isCurrent);
                const snapshot = openSurface.snapshot.value;
                const sourceRevisionKey = `${String(resolution.sourceRevision.size)}:${String(resolution.sourceRevision.modifiedAt)}`;
                if (
                    !allowSpeculativePdfjs
                    || !isCurrent()
                    || !openSurface.holdReadyForValidation(snapshot.generation, sourceRevisionKey)
                ) {
                    return;
                }
                pdfjsPreparation.preparedDocumentRevision = revision;
                pdfjsPreparation.readyHold = {
                    generation: snapshot.generation,
                    sourceRevisionKey,
                };
                state.pdfOpeningRevisionToken.value = revision?.token ?? null;
                state.pdfOpeningSrc.value = speculativePathSource;
                logPdfRenderTrace('pdf-open-pdfjs-speculative-source-committed', {
                    path,
                    ...traceContext,
                    generation: snapshot.generation,
                    sourceRevisionKey,
                });
            })
            : Promise.resolve();
        void preparePdfjsConcurrently.catch((error: unknown) => {
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Speculative PDF.js preparation unavailable', {
                path,
                error: getErrorMessage(error),
            });
        });
        let validationResult;
        try {
            validationResult = await validationTask;
            allowSpeculativePdfjs = false;
        } catch (error) {
            allowSpeculativePdfjs = false;
            stagedPreview?.cancel('validation-error');
            clearSpeculativeSource();
            throw error;
        }
        const {
            validation,
            cacheResult,
        } = validationResult;
        logPdfRenderTrace('pdf-open-validate-end', {
            path,
            ...traceContext,
            isValid: validation.isValid,
            cacheResult,
            elapsedMs: performance.now() - validateStartedAt,
        });
        if (!isCurrent()) {
            stagedPreview?.cancel('stale-after-validation');
            clearSpeculativeSource();
            return;
        }
        if (!validation.isValid) {
            stagedPreview?.cancel('validation-failed');
            clearSpeculativeSource();
            BrowserLogger.warn('pdf-file', 'Rejected invalid staged PDF', {
                path,
                requestId,
                validationErrors: validation.errors,
            });
            throw new Error(deps.t('errors.file.invalid'));
        }

        if (opts?.resetSourceBeforeCommit && state.pdfSrc.value) {
            state.pdfSrc.value = null;
            state.pdfReloadSrc.value = null;
            await nextTick();
            if (!isCurrent()) {
                stagedPreview?.cancel('stale-after-source-reset');
                clearSpeculativeSource();
                return;
            }
        }

        // Keep the previous working copy until the new file is fully validated and loaded.
        // This avoids dropping recoverable state when opening the next file fails midway.
        const commitStartedAt = performance.now();
        logPdfRenderTrace('pdf-open-state-commit-start', {
            path,
            ...traceContext,
            sourceKind: nextState.pdfData ? 'data' : 'path',
        });
        const didCommit = await applyLoadedPdfState(path, nextState, {
            isCurrent,
            markDirty: !!opts?.markDirty,
            previousPath: state.workingCopyPath.value,
            ...(pdfjsPreparation.preparedDocumentRevision === undefined
                ? {}
                : {preparedDocumentRevision: pdfjsPreparation.preparedDocumentRevision}),
        });
        logPdfRenderTrace('pdf-open-state-commit-end', {
            path,
            ...traceContext,
            didCommit,
            elapsedMs: performance.now() - commitStartedAt,
        });
        if (!didCommit) {
            stagedPreview?.cancel('state-commit-rejected');
            clearSpeculativeSource();
        } else {
            clearSpeculativeSource();
            const validationHold = pdfjsPreparation.readyHold;
            if (validationHold) {
                const readyRelease = deps.openSurface?.releaseReadyAfterValidation(
                    validationHold.generation,
                    validationHold.sourceRevisionKey,
                );
                logPdfRenderTrace('pdf-open-pdfjs-validation-authorized', {
                    path,
                    ...traceContext,
                    authorized: readyRelease?.authorized ?? false,
                    generation: validationHold.generation,
                    ready: readyRelease?.ready ?? false,
                    sourceRevisionKey: validationHold.sourceRevisionKey,
                });
            }
            cancelActiveSpeculativeOpen = null;
        }
    }

    async function applySnapshot(
        snapshot: Uint8Array,
        persist = false,
        expectedWorkingPath: TDocumentRef | null = state.workingCopyPath.value,
    ) {
        if (expectedWorkingPath !== state.workingCopyPath.value) {
            return false;
        }
        if (persist && expectedWorkingPath) {
            await getDocumentFilesCapability().writeFile(
                expectedWorkingPath,
                snapshot,
                createDocumentMutationRevisionOptions(state.documentRevisionToken.value),
            );
            if (!state.isActiveWorkingCopy(expectedWorkingPath)) {
                return false;
            }
        }

        state.pdfData.value = snapshot;
        state.pdfSrc.value = toPdfBlob(snapshot);
        state.pdfReloadSrc.value = state.pdfSrc.value;
        return true;
    }

    async function loadPdfFromData(
        data: Uint8Array,
        opts?: {
            pushHistory?: boolean;
            persistWorkingCopy?: boolean;
        },
    ) {
        const requestId = deps.loadEpoch.begin();
        const expectedWorkingPath = state.workingCopyPath.value;
        const snapshot = data.slice();
        assertPdfHasBytes(snapshot.byteLength);
        if (!deps.loadEpoch.isCurrent(requestId)) {
            return;
        }
        if (!await deps.ensureHistoryBaselineForMutation()) {
            return;
        }
        if (
            !deps.loadEpoch.isCurrent(requestId)
            || expectedWorkingPath !== state.workingCopyPath.value
        ) {
            return;
        }
        const didApplySnapshot = await applySnapshot(
            snapshot,
            opts?.persistWorkingCopy ?? false,
            expectedWorkingPath,
        );
        if (!didApplySnapshot || !deps.loadEpoch.isCurrent(requestId)) {
            BrowserLogger.debug('pdf-file', 'Skipped stale PDF data load result', {
                requestId,
                currentLoadRequestId: deps.loadEpoch.current(),
                bytes: snapshot.byteLength,
                expectedWorkingPath,
                currentWorkingPath: state.workingCopyPath.value,
            });
            return;
        }

        if (opts?.pushHistory !== false) {
            await deps.pushHistorySnapshot(snapshot, { reuseSnapshot: true });
        } else {
            state.isDirty.value = true;
        }

        if (opts?.persistWorkingCopy && expectedWorkingPath && state.isActiveWorkingCopy(expectedWorkingPath)) {
            deps.deferPdfConformanceProfile(expectedWorkingPath);
        }
    }

    return {
        applyLoadedPdfState,
        loadPdfFromData,
        loadPdfFromPath,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        pickFileToOpen,
        readPdfStateFromPath,
        toPdfBlob,
    };
}
