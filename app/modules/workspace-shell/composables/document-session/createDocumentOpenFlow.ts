import { trackWebEvent } from '@app/utils/trackWebEvent';
import type { TTranslateFn } from '@i18n-app';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    getFailureReceipt,
    type ExpectedOutcome,
} from '@contracts/diagnostics/failureReceipt';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {
    IDocumentDirectOpenRequest,
    IDocumentsOpenCapability,
    TOpenFileResult,
} from '@contracts/electronApiDocuments';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { IPdfRasterDisplayProfileOpenOptions } from '@app/types/pdfRasterDisplayProfile';
import {consumeRegisteredPdfRasterDisplayProfile} from '@app/types/pdfRasterDisplayProfile';
import type { TPdfSource } from '@app/types/pdfUi';
import { createRequestId } from '@contracts/shared';
import { parseEpochMs } from '@contracts/timestamps';
import { isRecord } from '@contracts/runtimeGuards';
import { DocumentOpenRefusalError } from '@contracts/documentOpenErrors';
import type { IDocumentSessionState } from '@app/modules/workspace-shell/composables/document-session/documentSessionState';
import type { IPdfLoadedState } from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';
import type { IPdfConformanceDeferralOptions } from '@app/modules/workspace-shell/composables/document-session/createDocumentConformance';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useFailureToast } from '@app/composables/useFailureToast';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { getErrorMessage } from '@app/utils/error';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import { resolveOpenPathSecondaryPerformancePolicy } from '@app/utils/resolveOpenPathSecondaryPerformancePolicy';
import {
    getDocumentFilesCapability,
    getDocumentOpenCapability,
    getDocumentPdfCapability,
    getDocumentPickerCapability,
} from '@app/utils/platformDocuments';
import {
    validatePdfRevision,
    type IPdfValidationSourceRevision,
} from '@app/modules/workspace-shell/composables/document-session/pdfValidationRevisionCache';
import {
    isDjvuOpenResult,
    isPdfOpenResult,
    openPdfAfterPasswordPrompt as runPasswordPromptFlow,
} from '@app/modules/workspace-shell/composables/document-session/openPdfAfterPasswordPrompt';
import {
    isPdfPasswordFailureResult,
    type TPdfPasswordFailureResult,
} from '@app/modules/workspace-shell/composables/document-session/isPdfPasswordFailureResult';
import {classifyDocumentOpenError} from '@app/modules/workspace-shell/composables/document-session/classifyDocumentOpenError';
import {useDocumentPasswordPrompt} from '@app/modules/workspace-shell/composables/useDocumentPasswordPrompt';
import {
    isDocumentOpenWorkingCopyRetained,
    releaseDocumentOpenWorkingCopyRetention,
    retainDocumentOpenWorkingCopyForRetry,
} from '@app/modules/workspace-shell/document-sessions/retainDocumentOpenWorkingCopyForRetry';

type TOpenedFileResult = Extract<TOpenFileResult, {kind: 'pdf' | 'djvu'}>;
export interface IDocumentDirectOpenOptions extends IPdfRasterDisplayProfileOpenOptions {
    /** False when a session restore reopens a tab it held: Recent Files keeps the reader's last open. */
    recordRecent?: boolean;
}

function readDirectOpenRequest(
    options: IDocumentDirectOpenOptions,
    password?: string,
): IDocumentDirectOpenRequest | undefined {
    const request: IDocumentDirectOpenRequest = {
        ...(password === undefined ? {} : {password}),
        ...(options.recordRecent === false ? {recordRecent: false} : {}),
    };
    return Object.keys(request).length > 0 ? request : undefined;
}

function openDocumentDirectWith(
    capability: Pick<IDocumentsOpenCapability, 'openDocumentDirect'>,
    path: TDocumentRef,
    request: IDocumentDirectOpenRequest | undefined,
) {
    return request === undefined
        ? capability.openDocumentDirect(path)
        : capability.openDocumentDirect(path, request);
}

export interface ICreateDocumentOpenFlowDeps {
    cleanupAbandonedWorkingCopy: (path: TDocumentRef) => Promise<void>;
    clearPdfConformanceProfile: () => void;
    cleanupPreviousWorkingCopy: (path: TDocumentRef, nextPath: TDocumentRef) => Promise<void>;
    deferPdfConformanceProfile: (
        path: TDocumentRef,
        options?: IPdfConformanceDeferralOptions,
    ) => void;
    resetCommandSink: () => void;
    /** The controller's open transaction this file open runs under: a newer claim or a close ends it. */
    readOpenTransactionId: () => string | null;
    /** Empties the views of the document a new one replaces, before its source is published. */
    resetDocumentPresentation: () => void;
    resetHistory: (options?: {isCurrent?: (() => boolean) | undefined}) => Promise<boolean>;
    setOpeningLabel: (label: string | null) => void;
    syncDirtyFromHistory: () => void;
    t: TTranslateFn;
}

const RECENT_OPEN_LOG_SECTION = 'recent-open';

export function createDocumentOpenFlow(
    state: IDocumentSessionState,
    deps: ICreateDocumentOpenFlowDeps,
) {
    const {maxInMemoryPdfBytes} = resolveOpenPathSecondaryPerformancePolicy(getPerformanceProfile());
    const {
        requestPassword,
        cancelPasswordPrompt,
        closePasswordPrompt,
    } = useDocumentPasswordPrompt();
    const { presentNoticeToast } = useFailureToast();
    function assertPdfHasBytes(size: number) {
        if (!(size > 0)) {
            throw new DocumentOpenRefusalError('empty-pdf', 'The PDF file is empty (0 bytes)');
        }
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

    function trackOpenedDocument(
        result: TOpenedFileResult,
        openMethod: 'picker' | 'preselected' | 'direct' | 'batch',
    ) {
        trackWebEvent('document_opened', {
            documentKind: result.kind,
            openMethod,
        });
    }

    function prepareDjvuOpen(
        result: Extract<TOpenFileResult, {kind: 'djvu'}>,
        openMethod: 'picker' | 'preselected' | 'direct' | 'batch',
    ): TDocumentOpenOutcome {
        state.pendingDjvu.value = result.originalPath;
        BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'DjVu open prepared', {path: result.originalPath});
        trackOpenedDocument(result, openMethod);
        return {
            status: 'prepared',
            result,
        };
    }
    function publishBatchOpeningLabel(processed: number, total: number) {
        const normalizedTotal = Math.max(0, total);
        deps.setOpeningLabel(normalizedTotal > 0
            ? deps.t('tabs.preparingBatch', {
                processed: Math.min(Math.max(processed, 0), normalizedTotal),
                total: normalizedTotal,
            })
            : null);
    }

    function resetOpenState() {
        state.error.value = null;
        state.failurePresentation.value = null;
        state.pendingDjvu.value = null;
        deps.setOpeningLabel(null);
    }

    function beginOpenRequest() {
        cancelPasswordPrompt();
        return deps.readOpenTransactionId();
    }

    function recordOpenFailure(message: string, error: unknown, data?: unknown) {
        const receipt = BrowserLogger.error(
            RECENT_OPEN_LOG_SECTION,
            'Document open failed',
            data ?? error,
            getFailureReceipt(error) ?? {code: 'RENDERER_PDF_DOCUMENT_LOAD_FAILED'},
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

    function isCurrentOpenRequest(requestId: string | null) {
        return deps.readOpenTransactionId() === requestId;
    }

    async function cleanupAbandonedPdfWorkingCopy(
        result: TOpenFileResult,
        reason: string,
    ) {
        if (
            !isPdfOpenResult(result)
            || state.isActiveWorkingCopy(result.workingPath)
            || isDocumentOpenWorkingCopyRetained(result)
        ) {
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

    function reportUnsupportedEncryption() {
        const message = deps.t('errors.file.unsupportedEncryption');
        state.error.value = message;
        return {
            status: 'failed',
            error: message,
        } satisfies TDocumentOpenOutcome;
    }

    async function openFile(preSelected?: TOpenFileResult) {
        const openRequestId = beginOpenRequest();
        resetOpenState();
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
            if (isDjvuOpenResult(result)) {
                return prepareDjvuOpen(result, preSelected ? 'preselected' : 'picker');
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
        openRequestId: string | null,
        result: Extract<TOpenFileResult, { kind: 'pdf' }>,
        openMethod: 'picker' | 'preselected' | 'direct' | 'batch',
        options: IPdfRasterDisplayProfileOpenOptions = {},
    ) {
        if (result.keptOriginalPath) {
            // A save kept a file beside the PDF; every open says so until the person dismisses it, as one notice per PDF.
            const originalPath = result.originalPath;
            presentNoticeToast({
                id: `kept-original:${originalPath}`,
                tone: 'warning',
                title: deps.t('errors.file.recoveryKeptOriginalTitle'),
                description: deps.t('errors.file.recoveryKeptOriginal', {path: result.keptOriginalPath}),
                duration: Number.POSITIVE_INFINITY,
                progress: false,
                onDismiss: () => void getDocumentOpenCapability().forgetKeptOriginal?.(originalPath).catch((error: unknown) => {
                    if (isRecord(error) && (error.code === 'ENOENT' || error.name === 'NotFoundError')) return;
                    BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Could not dismiss a kept-original notice', {
                        originalPath,
                        error: getErrorMessage(error),
                    });
                }),
            });
        }
        if (result.recoveryDirtyBaseline === true) {
            // A failed first read must leave the checkpoint-owned bytes for a
            // later retry. The main cleanup boundary also enforces this, but
            // avoiding the renderer cleanup request keeps the ownership
            // intent explicit at the open transaction boundary.
            retainDocumentOpenWorkingCopyForRetry(result);
        }
        const registeredRasterDisplayProfile = consumeRegisteredPdfRasterDisplayProfile(
            result.originalPath,
            result.workingPath,
        );
        const rasterDisplayProfile = options.rasterDisplayProfile
            ?? registeredRasterDisplayProfile;
        const documentFiles = getDocumentFilesCapability();
        // The source's revision lets a cached validation of the same bytes stand.
        const validationRevision = documentFiles.statFile(result.originalPath)
            .catch(() => documentFiles.statFile(result.workingPath))
            .then((source): IPdfValidationSourceRevision | null => {
                const modifiedAt = parseEpochMs(source.modifiedAt);
                return modifiedAt === null
                    ? null
                    : {
                        documentId: result.originalPath,
                        size: source.size,
                        modifiedAt,
                    };
            }, () => null);
        const job = await loadPdfFromPath(result.workingPath, {
            originalPath: result.originalPath,
            markDirty: result.isGenerated === true || result.recoveryDirtyBaseline === true,
            recoveryDirtyBaseline: result.recoveryDirtyBaseline === true,
            openRequestId,
            validationRevision,
        }).catch(async (error: unknown) => {
            await cleanupAbandonedPdfWorkingCopy(result, 'failed-pdf-load');
            throw error;
        });
        if (!job || !isCurrentOpenRequest(openRequestId) || state.workingCopyPath.value !== result.workingPath) {
            await cleanupAbandonedPdfWorkingCopy(result, 'stale-pdf-load');
            return {
                status: 'stale',
                result,
            } satisfies TDocumentOpenOutcome;
        }
        state.wasEncrypted.value = result.wasEncrypted === true;
        trackOpenedDocument(result, openMethod);
        if (!isCurrentOpenRequest(openRequestId) || state.workingCopyPath.value !== result.workingPath) {
            await cleanupAbandonedPdfWorkingCopy(result, 'stale-pdf-track');
            return {
                status: 'stale',
                result,
            } satisfies TDocumentOpenOutcome;
        }
        if (result.recoveryDirtyBaseline === true) {
            // Opening a retained working copy must finish dirty even if a
            // path-backed projection adopted a clean history entry meanwhile.
            state.recoveryDirtyBaseline.value = true;
            state.isDirty.value = true;
        }
        state.requiresSaveAsOnFirstSave.value = !!result.isGenerated;
        state.pdfRasterDisplayProfile.value = rasterDisplayProfile;
        releaseDocumentOpenWorkingCopyRetention(result);
        return {
            status: 'opened',
            result,
            presentation: job.finished,
        } satisfies TDocumentOpenOutcome;
    }

    function openPdfWithPasswordPrompt(
        openRequestId: string | null,
        initialFailure: TPdfPasswordFailureResult,
        openMethod: 'picker' | 'preselected' | 'direct' | 'batch',
        options: IDocumentDirectOpenOptions = {},
    ) {
        return runPasswordPromptFlow(openRequestId, initialFailure, openMethod, options, {
            requestPassword,
            closePasswordPrompt,
            isCurrentOpenRequest,
            openDocumentDirect: (path, password) => openDocumentDirectWith(
                getDocumentOpenCapability(),
                path,
                readDirectOpenRequest(options, password),
            ),
            cleanupAbandonedPdfWorkingCopy,
            setError: message => { state.error.value = message; },
            reportUnsupportedEncryption,
            trackOpenedDocument,
            setPendingDjvuPath: path => { state.pendingDjvu.value = path; },
            finishPdfOpenResult,
            t: deps.t,
        });
    }

    async function openFileDirect(path: TDocumentRef, options: IDocumentDirectOpenOptions = {}) {
        const openRequestId = beginOpenRequest();
        resetOpenState();
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
            const result = await openDocumentDirectWith(
                getDocumentOpenCapability(),
                path,
                readDirectOpenRequest(options),
            );
            logPdfRenderTrace('pdf-open-capability-end', {
                openRequestId,
                path,
                elapsedMs: performance.now() - openCapabilityStartedAt,
                resultKind: result?.kind ?? null,
                workingPath: result && isPdfOpenResult(result) ? result.workingPath : null,
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
                        isPdfOpenResult(result) ? Boolean(result.isGenerated) : undefined,
                    workingPath: isPdfOpenResult(result) ? result.workingPath : undefined,
                },
            );

            if (isDjvuOpenResult(result)) {
                return prepareDjvuOpen(result, 'direct');
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
        resetOpenState();
        try {
            const documentOpen = getDocumentOpenCapability();
            const normalizedPaths = paths
                .filter((path) => path.trim().length > 0)
                .map(path => parseDocumentRef(path))
                .filter((path): path is TDocumentRef => path !== null);

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

            const requestId = createRequestId('document-open');
            publishBatchOpeningLabel(0, normalizedPaths.length);

            const stopProgress = documentOpen.onOpenDocumentDirectBatchProgress(
                (progress) => {
                    if (
                        progress.operation !== 'document-open'
                        || progress.requestId !== requestId
                        || !isCurrentOpenRequest(openRequestId)
                    ) {
                        return;
                    }

                    publishBatchOpeningLabel(progress.processed, progress.total);
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
            deps.setOpeningLabel(null);
            if (!result) {
                const message = deps.t('errors.file.invalid');
                recordHandledOpenAbsence(message, {reason: 'null-batch-open-result'});
                return {
                    status: 'failed',
                    error: message,
                } satisfies TDocumentOpenOutcome;
            }
            if (isPdfPasswordFailureResult(result)) {
                return await openPdfWithPasswordPrompt(openRequestId, result, 'batch');
            }
            if (isDjvuOpenResult(result)) {
                return prepareDjvuOpen(result, 'batch');
            }
            return await finishPdfOpenResult(openRequestId, result, 'batch');
        } catch (e) {
            const message = classifyDocumentOpenError(e, paths.length === 1 ? paths[0] ?? null : null, deps.t);
            if (isCurrentOpenRequest(openRequestId)) {
                deps.setOpeningLabel(null);
                recordOpenFailure(message, e);
            }
            return {
                status: 'failed',
                error: message,
            } satisfies TDocumentOpenOutcome;
        }
    }

    /** Publishes the loaded PDF as the document's source and returns its source job; null when the load is no longer current. */
    async function publishLoadedPdfState(
        path: TDocumentRef,
        nextState: IPdfLoadedState,
        options?: {
            originalPath?: TDocumentRef;
            markDirty?: boolean;
            recoveryDirtyBaseline?: boolean;
            preserveHistory?: boolean;
            previousPath?: TDocumentRef | null;
            beforeSourceCommit?: (revision: TDocumentRevisionToken | null) => Promise<(() => void) | undefined>;
            isCurrent?: (() => boolean) | undefined;
        },
    ) {
        if (options?.isCurrent?.() === false) {
            return null;
        }

        const didRefreshRevision = await refreshDocumentRevisionToken(path, options?.isCurrent);
        if (!didRefreshRevision) {
            return null;
        }

        if (!options?.preserveHistory) deps.resetCommandSink();

        const commitRevisionSwap = await options?.beforeSourceCommit?.(state.documentRevisionToken.value);
        if (options?.isCurrent?.() === false) return null;
        if (commitRevisionSwap) commitRevisionSwap();

        // A replacement can paint while history and old-copy cleanup still wait. Publish its identity with its
        // source, before either can yield; only the open's own commit, current as just checked, starts a new document.
        state.commitFile({
            ...(options?.originalPath ? {originalPath: options.originalPath} : {}),
            workingCopyPath: path,
            isDjvu: false,
        }, options?.preserveHistory ? null : deps.readOpenTransactionId());
        if (!options?.preserveHistory) {
            state.openedWorkingCopyPath.value = path;
        }
        if (!options?.preserveHistory && state.pdfSrc.value) deps.resetDocumentPresentation();
        state.pdfData.value = nextState.pdfData;
        const job = state.publishPdfSource(nextState.pdfSrc, options?.preserveHistory ? 'reload' : 'open');
        if (!options?.preserveHistory) state.recoveryDirtyBaseline.value = options?.recoveryDirtyBaseline === true;
        deps.clearPdfConformanceProfile();

        if (!options?.preserveHistory) {
            if (!await deps.resetHistory({isCurrent: options?.isCurrent}) || options?.isCurrent?.() === false) {
                return null;
            }
            deps.syncDirtyFromHistory();
        }

        if (options?.isCurrent?.() === false) {
            return null;
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
                return null;
            }
        }

        deps.deferPdfConformanceProfile(path, { fileSize: getLoadedPdfFileSize(nextState) });
        return job;
    }

    async function refreshDocumentRevisionToken(
        path: TDocumentRef,
        isCurrent?: (() => boolean) | undefined,
    ) {
        if (isCurrent?.() === false) {
            return false;
        }

        const revision = await getDocumentFilesCapability().getDocumentRevision(path).catch((error: unknown) => {
            if (isCurrent?.() === false) return null;
            BrowserLogger.warn('pdf-file', 'Failed to resolve document revision', {
                path,
                error,
            });
            return null;
        });
        if (isCurrent?.() === false) return false;
        state.documentRevisionInfo.value = revision;
        return true;
    }

    async function readPdfStateFromPath(
        path: TDocumentRef,
        traceContext?: {openRequestId: string | null},
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

    async function loadPdfFromPath(path: TDocumentRef, opts: {
        originalPath?: TDocumentRef;
        markDirty?: boolean;
        recoveryDirtyBaseline?: boolean;
        openRequestId: string | null;
        validationRevision?: Promise<IPdfValidationSourceRevision | null>;
    }) {
        const traceContext = {openRequestId: opts.openRequestId};
        const isCurrent = () => isCurrentOpenRequest(opts.openRequestId);
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
            return null;
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
                ...traceContext,
                currentOpenRequestId: deps.readOpenTransactionId(),
            });
            return null;
        }

        // The open capability only stages a working copy. Keep the currently
        // displayed document intact until a real PDF parser accepts that copy.
        // This is intentionally before the outgoing document's reset and
        // any working-copy/history ownership changes, which also means a slow
        // validation is time the user spends looking at the previous document
        // under the new document's title.
        const validateStartedAt = performance.now();
        logPdfRenderTrace('pdf-open-validate-start', {
            path,
            ...traceContext,
        });
        const {
            validation,
            cacheResult,
        } = await (opts.validationRevision ?? Promise.resolve(null))
            .then(revision => validatePdfRevision(
                revision,
                () => getDocumentPdfCapability().validatePdfPath(path, {purpose: 'opening'}),
                'opening',
            ));
        logPdfRenderTrace('pdf-open-validate-end', {
            path,
            ...traceContext,
            isValid: validation.isValid,
            cacheResult,
            elapsedMs: performance.now() - validateStartedAt,
        });
        if (!isCurrent()) {
            return null;
        }
        if (!validation.isValid) {
            BrowserLogger.warn('pdf-file', 'Rejected invalid staged PDF', {
                path,
                ...traceContext,
                validationErrors: validation.errors,
            });
            throw new DocumentOpenRefusalError('invalid-pdf', `Staged PDF failed ${validation.tool} validation`);
        }
        // Keep the previous working copy until the new file is fully validated and loaded.
        // This avoids dropping recoverable state when opening the next file fails midway.
        const commitStartedAt = performance.now();
        logPdfRenderTrace('pdf-open-state-commit-start', {
            path,
            ...traceContext,
            sourceKind: nextState.pdfData ? 'data' : 'path',
        });
        const job = await publishLoadedPdfState(path, nextState, {
            ...(opts.originalPath ? {originalPath: opts.originalPath} : {}),
            isCurrent,
            markDirty: !!opts.markDirty,
            recoveryDirtyBaseline: opts.recoveryDirtyBaseline === true,
            previousPath: state.workingCopyPath.value,
        });
        logPdfRenderTrace('pdf-open-state-commit-end', {
            path,
            ...traceContext,
            didCommit: job !== null,
            elapsedMs: performance.now() - commitStartedAt,
        });
        return job;
    }

    return {
        applyLoadedPdfState: async (...args: Parameters<typeof publishLoadedPdfState>) => await publishLoadedPdfState(...args) !== null,
        loadPdfFromPath,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        pickFileToOpen,
        readPdfStateFromPath,
        refreshDocumentRevisionToken,
        toPdfBlob,
    };
}
