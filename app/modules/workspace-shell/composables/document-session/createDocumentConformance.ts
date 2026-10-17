import type {
    IPdfConformanceProfile,
    TPdfSaveMode,
} from '@app/types/pdfContracts';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {createStaleRevisionError} from '@contracts/documentMutationErrors';
import type { IDocumentSessionState } from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getDocumentPdfCapability } from '@app/utils/platformDocuments';
import { shouldForcePdfSaveAs } from '@app/services/pdf-file/shouldForcePdfSaveAs';

interface IConformanceProfileRequest {
    path: TDocumentRef;
    promise: Promise<IPdfConformanceProfile | null>;
    requestId: number;
}

interface IPendingConformanceProfileRequest {
    fileSize: number | null;
    path: TDocumentRef;
    requestId: number;
}

interface IPdfSaveRestrictionRequest {
    path: TDocumentRef;
    promise: Promise<IPdfConformanceProfile | null>;
    requestId: number;
    revision: TDocumentRevisionToken | null;
}

export interface IPdfConformanceIdleScheduler {
    cancel: (handle: number) => void;
    schedule: (callback: () => void) => number;
}

export interface IPdfConformanceDeferralOptions { fileSize?: number | null }

export const MAX_EAGER_PDF_CONFORMANCE_BYTES = 64 * 1024 * 1024;

function createDefaultIdleScheduler(): IPdfConformanceIdleScheduler {
    if (
        typeof window !== 'undefined'
        && typeof window.requestIdleCallback === 'function'
        && typeof window.cancelIdleCallback === 'function'
    ) {
        return {
            cancel: handle => window.cancelIdleCallback(handle),
            schedule: callback => window.requestIdleCallback(callback, {timeout: 2_000}),
        };
    }
    return {
        cancel: handle => window.clearTimeout(handle),
        schedule: callback => window.setTimeout(callback, 0),
    };
}

export function createDocumentConformance(
    state: IDocumentSessionState,
    idleScheduler: IPdfConformanceIdleScheduler = createDefaultIdleScheduler(),
) {
    let conformanceProfileRequestId = 0;
    let conformanceProfileInFlight: IConformanceProfileRequest | null = null;
    let pendingConformanceProfile: IPendingConformanceProfileRequest | null = null;
    let saveRestrictionInFlight: IPdfSaveRestrictionRequest | null = null;
    let scheduledConformanceHandle: number | null = null;

    function cancelScheduledConformanceAnalysis() {
        if (scheduledConformanceHandle !== null) {
            idleScheduler.cancel(scheduledConformanceHandle);
            scheduledConformanceHandle = null;
        }
    }

    function clearPdfConformanceProfile() {
        conformanceProfileRequestId += 1;
        cancelScheduledConformanceAnalysis();
        conformanceProfileInFlight = null;
        pendingConformanceProfile = null;
        saveRestrictionInFlight = null;
        state.pdfConformanceAnalysisState.value = 'none';
        state.pdfConformanceProfile.value = null;
    }

    function startPdfSaveRestrictionAnalysis(path: TDocumentRef, requestId: number) {
        const revision = state.documentRevisionToken.value;
        if (
            saveRestrictionInFlight?.path === path
            && saveRestrictionInFlight.requestId === requestId
            && saveRestrictionInFlight.revision === revision
        ) {
            return saveRestrictionInFlight.promise;
        }

        const promise = getDocumentPdfCapability().analyzePdfConformance(path, {purpose: 'save-restrictions'})
            .catch((error: unknown) => {
                if (conformanceProfileRequestId === requestId && state.workingCopyPath.value === path
                    && state.documentRevisionToken.value === revision) {
                    BrowserLogger.warn('pdf-file', 'PDF save restriction analysis failed', {
                        path,
                        error,
                    });
                    throw error;
                }
                return null;
            })
            .finally(() => {
                if (saveRestrictionInFlight?.promise === promise) {
                    saveRestrictionInFlight = null;
                }
            });
        saveRestrictionInFlight = {
            path,
            promise,
            requestId,
            revision,
        };
        return promise;
    }

    function applyPdfConformanceProfile(
        path: TDocumentRef,
        requestId: number,
        profile: IPdfConformanceProfile | null,
    ) {
        if (
            conformanceProfileRequestId === requestId
            && state.workingCopyPath.value === path
        ) {
            state.pdfConformanceProfile.value = profile;
            state.pdfConformanceAnalysisState.value = 'ready';
            pendingConformanceProfile = null;
            return true;
        }
        return false;
    }

    function startPdfConformanceAnalysis(request: IPendingConformanceProfileRequest) {
        const inFlight = conformanceProfileInFlight;
        if (inFlight?.path === request.path && inFlight.requestId === request.requestId) {
            return inFlight.promise;
        }

        cancelScheduledConformanceAnalysis();
        state.pdfConformanceAnalysisState.value = 'analyzing';
        const promise = getDocumentPdfCapability().analyzePdfConformance(request.path).then((profile) => {
            applyPdfConformanceProfile(request.path, request.requestId, profile);
            return profile;
        }).catch((conformanceError: unknown) => {
            if (
                conformanceProfileRequestId === request.requestId
                && state.workingCopyPath.value === request.path
            ) {
                state.pdfConformanceAnalysisState.value = 'failed';
                BrowserLogger.warn('pdf-file', 'Deferred conformance analysis failed', {
                    path: request.path,
                    error: conformanceError,
                });
                throw conformanceError;
            }
            return null;
        }).finally(() => {
            if (conformanceProfileInFlight?.requestId === request.requestId) {
                conformanceProfileInFlight = null;
            }
        });
        conformanceProfileInFlight = {
            path: request.path,
            promise,
            requestId: request.requestId,
        };
        return promise;
    }

    function deferPdfConformanceProfile(
        path: TDocumentRef,
        options?: IPdfConformanceDeferralOptions,
    ) {
        const requestId = ++conformanceProfileRequestId;
        cancelScheduledConformanceAnalysis();
        conformanceProfileInFlight = null;
        saveRestrictionInFlight = null;
        state.pdfConformanceProfile.value = null;
        pendingConformanceProfile = {
            fileSize: options?.fileSize ?? null,
            path,
            requestId,
        };
        if (
            typeof options?.fileSize === 'number'
            && options.fileSize > MAX_EAGER_PDF_CONFORMANCE_BYTES
        ) {
            state.pdfConformanceAnalysisState.value = 'on-demand-only';
            BrowserLogger.debug('pdf-file', 'Skipped eager conformance analysis for large PDF', {
                path,
                size: options.fileSize,
                maxEagerBytes: MAX_EAGER_PDF_CONFORMANCE_BYTES,
            });
            return;
        }
        state.pdfConformanceAnalysisState.value = 'waiting-initial-visual';
    }

    function notifyPdfInitialVisualReady(path: TDocumentRef | null = state.workingCopyPath.value) {
        const pending = pendingConformanceProfile;
        if (
            !path
            || !pending
            || pending.path !== path
            || pending.requestId !== conformanceProfileRequestId
            || state.workingCopyPath.value !== path
            || state.pdfConformanceAnalysisState.value !== 'waiting-initial-visual'
        ) {
            return false;
        }

        state.pdfConformanceAnalysisState.value = 'waiting-idle';
        scheduledConformanceHandle = idleScheduler.schedule(() => {
            scheduledConformanceHandle = null;
            if (
                pendingConformanceProfile !== pending
                || pending.requestId !== conformanceProfileRequestId
                || state.workingCopyPath.value !== pending.path
                || state.pdfConformanceAnalysisState.value !== 'waiting-idle'
            ) {
                return;
            }
            void startPdfConformanceAnalysis(pending).catch(() => {});
        });
        return true;
    }

    async function refreshPdfConformanceProfile(path: TDocumentRef | null) {
        if (!path) {
            clearPdfConformanceProfile();
            return null;
        }

        const inFlight = conformanceProfileInFlight;
        if (inFlight?.path === path) {
            return inFlight.promise;
        }

        const pending = pendingConformanceProfile;
        const request = pending?.path === path
            && pending.requestId === conformanceProfileRequestId
            ? pending
            : {
                fileSize: null,
                path,
                requestId: ++conformanceProfileRequestId,
            };
        pendingConformanceProfile = request;
        return startPdfConformanceAnalysis(request);
    }

    function shouldForceSaveAs(mode: TPdfSaveMode) {
        return shouldForcePdfSaveAs(
            mode,
            state.pdfConformanceProfile.value,
            state.requiresSaveAsOnFirstSave.value,
        );
    }

    async function shouldForceSaveAsForWorkingCopy(
        mode: TPdfSaveMode,
        workingPath: TDocumentRef,
    ) {
        if (state.requiresSaveAsOnFirstSave.value) {
            return true;
        }
        const revision = state.documentRevisionToken.value;
        const requestId = conformanceProfileRequestId;
        const profile = await startPdfSaveRestrictionAnalysis(workingPath, requestId);
        if (state.documentRevisionToken.value !== revision || state.workingCopyPath.value !== workingPath
            || conformanceProfileRequestId !== requestId) {
            throw createStaleRevisionError({
                expectedRevision: revision,
                actualRevision: state.documentRevisionToken.value,
                message: 'Document changed during PDF save restriction analysis',
            });
        }
        return shouldForcePdfSaveAs(mode, profile, state.requiresSaveAsOnFirstSave.value);
    }

    return {
        clearPdfConformanceProfile,
        deferPdfConformanceProfile,
        notifyPdfInitialVisualReady,
        refreshPdfConformanceProfile,
        shouldForceSaveAs,
        shouldForceSaveAsForWorkingCopy,
    };
}
