import type { Ref } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { useDocumentTransitions } from '@app/modules/workspace-shell/composables/useDocumentTransitions';
import type { IDocumentTransitionDeps } from '@app/modules/workspace-shell/composables/useDocumentTransitions';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {getDocumentFilesCapability} from '@app/utils/platformDocuments';
import { getOcrCapability } from '@app/utils/getOcrCapability';
import { getSearchCapability } from '@app/utils/getSearchCapability';
import { isStaleRevisionError } from '@contracts/documentMutationErrors';
import type { IOcrSearchablePdfResult } from '@app/utils/ocr/ocrTypes';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useFailureToast } from '@app/composables/useFailureToast';
import { getFailureReceipt } from '@contracts/diagnostics/failureReceipt';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';

interface IOcrCompletePayload extends IOcrSearchablePdfResult {
    sourceWorkingCopyPath: TDocumentRef;
    sourcePageToRestore?: number;
}

interface IOcrApplyReloadResult {
    restorePromise: Promise<void>;
    getRestoreError: () => unknown;
}

interface IWorkspaceDocumentLifecycleEffectsOptions extends IDocumentTransitionDeps {
    documentRevisionInfo: Ref<IDocumentRevisionInfo | null>;
    documentRevisionToken: Ref<TDocumentRevisionToken | null>;
    pdfViewerRef: Ref<{
        scrollToPage: (page: number) => void;
        clearShapes: () => void;
    } | null>;
    showSettings: Ref<boolean>;
    emitOpenSettings: () => void;
    clearOcrCache: (path: TDocumentRef) => void;
    ensureHistoryBaselineForMutation: () => Promise<boolean>;
    reloadWorkingCopyIntoHistory: (opts?: {markDirty?: boolean}) => Promise<boolean>;
    waitForPdfReload: (page: number) => Promise<void>;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}

export const useWorkspaceDocumentLifecycleEffects = (options: IWorkspaceDocumentLifecycleEffectsOptions) => {
    const {
        documentRevisionInfo,
        documentRevisionToken,
        currentPage,
        pdfViewerRef,
        showSettings,
        emitOpenSettings,
        pdfSrc,
        totalPages,
        pdfDocument,
        workingCopyPath,
        isDjvuMode,
        djvuSourcePath,
        pdfError,
        dragMode,
        showSidebar,
        sidebarTab,
        annotationTool,
        annotationComments,
        markAnnotationCommentsLoading,
        clearAnnotationComments,
        annotationActiveCommentStableKey,
        annotationEditorState,
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        resetAnnotationTracking,
        resetSearchCache,
        closeSearch,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeAllAnnotationNotes,
        loadRecentFiles,
        consumePreservedSourceReloadMetadata,
        hasPendingProgrammaticPageNavigation,
        clearProgrammaticPageNavigation,
        clearOcrCache,
        ensureHistoryBaselineForMutation,
        reloadWorkingCopyIntoHistory,
        waitForPdfReload,
        runWithDocumentOperationLease,
    } = options;

    const documentFiles = getDocumentFilesCapability();
    const {t} = useTypedI18n();
    const toast = useToast();
    const { presentFailureToast } = useFailureToast();
    let revisionRefreshRequestId = 0;

    async function refreshDocumentRevision(path: TDocumentRef) {
        const requestId = ++revisionRefreshRequestId;
        try {
            const revision = await documentFiles.getDocumentRevision(path);
            if (
                requestId === revisionRefreshRequestId
                && workingCopyPath.value === path
            ) {
                documentRevisionInfo.value = revision;
                documentRevisionToken.value = revision.token;
            }
        } catch {
            if (
                requestId === revisionRefreshRequestId
                && workingCopyPath.value === path
            ) {
                documentRevisionInfo.value = null;
                documentRevisionToken.value = null;
            }
        }
    }

    watch(workingCopyPath, (path) => {
        revisionRefreshRequestId += 1;
        documentRevisionInfo.value = null;
        documentRevisionToken.value = null;
        if (path) {
            void refreshDocumentRevision(path);
        }
    }, {immediate: true});

    const unsubscribeDocumentRevision = documentFiles.onDocumentRevisionChanged?.((event) => {
        if (event.documentRef !== workingCopyPath.value) {
            return;
        }
        revisionRefreshRequestId += 1;
        documentRevisionInfo.value = event;
        documentRevisionToken.value = event.token;
    }) ?? null;

    tryOnScopeDispose(() => {
        unsubscribeDocumentRevision?.();
    });

    watch(showSettings, (value) => {
        if (!value) {
            return;
        }

        emitOpenSettings();
        showSettings.value = false;
    });

    useDocumentTransitions({
        pdfSrc,
        currentPage,
        totalPages,
        pdfDocument,
        workingCopyPath,
        isDjvuMode,
        djvuSourcePath,
        pdfError,
        dragMode,
        showSidebar,
        sidebarTab,
        annotationTool,
        annotationComments,
        markAnnotationCommentsLoading,
        clearAnnotationComments,
        annotationActiveCommentStableKey,
        annotationEditorState,
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        pdfViewerRef,
        resetAnnotationTracking,
        resetSearchCache,
        closeSearch,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeAllAnnotationNotes,
        loadRecentFiles,
        consumePreservedSourceReloadMetadata,
        hasPendingProgrammaticPageNavigation,
        clearProgrammaticPageNavigation,
    });

    async function acknowledgeOcrResultFile(payload: IOcrCompletePayload) {
        if (!payload.requiresCleanupAck) {
            return;
        }
        try {
            const result = await getOcrCapability().acknowledgeResultFile(
                payload.requestId,
                payload.pdfPath,
            );
            if (!result.cleaned && result.error) {
                BrowserLogger.warn('ocr', 'OCR cleanup acknowledgement was rejected', {
                    requestId: payload.requestId,
                    path: payload.pdfPath,
                    error: result.error,
                });
            }
        } catch (error) {
            BrowserLogger.warn('ocr', 'Failed to acknowledge OCR temp result file', {
                requestId: payload.requestId,
                path: payload.pdfPath,
                error,
            });
        }
    }

    async function replaceOcrWorkingCopy(
        payload: IOcrCompletePayload,
        pageToRestore: number,
    ): Promise<IOcrApplyReloadResult | null> {
        if (workingCopyPath.value !== payload.sourceWorkingCopyPath) {
            await acknowledgeOcrResultFile(payload);
            return null;
        }

        let restoreError: unknown = null;
        let restorePromise: Promise<void> | null = null;
        let didReplaceWorkingCopy = false;
        clearOcrCache(payload.sourceWorkingCopyPath);
        resetSearchCache();
        try {
            if (!await ensureHistoryBaselineForMutation()) {
                await acknowledgeOcrResultFile(payload);
                throw new Error('Failed to prime OCR history before applying searchable PDF result');
            }
            if (workingCopyPath.value !== payload.sourceWorkingCopyPath) {
                await acknowledgeOcrResultFile(payload);
                return null;
            }
            await documentFiles.replaceWorkingCopyFromPath(
                payload.sourceWorkingCopyPath,
                payload.pdfPath,
                {expectedDocumentRevisionToken: payload.sourceDocumentRevisionToken},
            );
            didReplaceWorkingCopy = true;
            if (workingCopyPath.value !== payload.sourceWorkingCopyPath) {
                return null;
            }

            restorePromise = waitForPdfReload(pageToRestore).catch((error: unknown) => {
                restoreError = error;
            });
            if (!await reloadWorkingCopyIntoHistory({markDirty: true})) {
                void restorePromise;
                return null;
            }
        } catch (error) {
            void restorePromise;
            throw error;
        } finally {
            if (didReplaceWorkingCopy) {
                await acknowledgeOcrResultFile(payload);
            }
        }
        return {
            restorePromise,
            getRestoreError: () => restoreError,
        };
    }

    async function applyOcrCompleteResult(payload: IOcrCompletePayload) {
        const pageToRestore = payload.sourcePageToRestore ?? currentPage.value;
        const warmupPageCountHint = totalPages.value > 0
            ? totalPages.value
            : undefined;
        const applyReload = () => replaceOcrWorkingCopy(payload, pageToRestore);
        const result = runWithDocumentOperationLease
            ? await runWithDocumentOperationLease('ocr-apply', applyReload)
            : await applyReload();
        if (!result) {
            return;
        }

        await result.restorePromise;
        if (workingCopyPath.value !== payload.sourceWorkingCopyPath) {
            return;
        }
        const restoreError = result.getRestoreError();
        if (restoreError) {
            BrowserLogger.warn('ocr', 'OCR result was applied but page restore failed', {
                sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                pageToRestore,
                error: restoreError,
            });
        }
        void getSearchCapability().warmIndex(payload.sourceWorkingCopyPath, {...(warmupPageCountHint === undefined
            ? {}
            : {pageCount: warmupPageCountHint})}).catch((error: unknown) => {
            BrowserLogger.debug('pdf-search', 'Failed to prewarm search index after OCR', {
                path: payload.sourceWorkingCopyPath,
                pageCount: warmupPageCountHint,
                error,
            });
        });
        toast.add({
            color: 'success',
            title: t('ocr.complete'),
        });
    }

    async function handleOcrComplete(payload: IOcrCompletePayload) {
        try {
            await applyOcrCompleteResult(payload);
        } catch (error) {
            if (isStaleRevisionError(error)) {
                await acknowledgeOcrResultFile(payload);
                const failure = BrowserLogger.error(
                    'ocr',
                    'OCR result could not be applied because the document changed',
                    error,
                    getFailureReceipt(error) ?? {
                        code: 'RENDERER_OCR_RUN_FAILED',
                        context: {},
                    },
                );
                presentFailureToast({
                    failure,
                    title: t('errors.ocr.changedReload'),
                });
                return;
            }
            const failure = BrowserLogger.error('ocr', 'Failed to apply OCR result', {
                requestId: payload.requestId,
                sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                pdfPath: payload.pdfPath,
                error,
            }, {
                code: 'RENDERER_OCR_RUN_FAILED',
                context: {},
            });
            presentFailureToast({
                failure,
                title: t('errors.ocr.createSearchablePdf'),
            });
        }
    }

    return {handleOcrComplete};
};
