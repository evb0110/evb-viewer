import type { Ref } from 'vue';
import type { Merge } from 'type-fest';
import type { TPdfDocumentSession } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type { TPdfAnnotationSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession';
import type { IPdfViewerExpose } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import type { TAnnotationCreationFailureReason } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import { projectAnnotationCreationOutcome } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/projectAnnotationCreationOutcome';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { toShapeAnnotationCommentSummary } from '@app/modules/pdf-viewer/engine/annotations/shape-annotation-comments/toShapeAnnotationCommentSummary';
import { getPageContainerByNumber } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageContainerByNumber';
import { toSelectedTextMarkupComment } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands';
import { cloneSparsePageMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';
import { collectPdfJsAnnotationStorageDebugState } from '@app/modules/pdf-viewer/runtime/save/pdfjsAnnotationDiagnostics';

const POINT_NOTE_CANCELLED_REASON = 'The document changed before the point note was created.';

type TPdfViewerPublicApiRefBackedKeys =
    | 'annotationHistoryMutationVersion'
    | 'annotationHistoryResetVersion'
    | 'hasShapes'
    | 'isCapturingRegion'
    | 'isCropSelecting'
    | 'selectedTextBox'
    | 'selectedShapeId';

type TPdfViewerRefBackedSource = {
    [TKey in TPdfViewerPublicApiRefBackedKeys]-?: Readonly<Ref<Exclude<IPdfViewerExpose[TKey], undefined>>>;
};

type TPdfViewerPublicApiSource = Merge<
    Omit<IPdfViewerExpose, TPdfViewerPublicApiRefBackedKeys>,
    TPdfViewerRefBackedSource
>;

interface IUsePdfViewerPublicApiControllerOptions {
    viewerContainer: Ref<HTMLElement | null>;
    documentSession: TPdfDocumentSession;
    viewportSession: TPdfViewportSession;
    getUserViewportInteractionEpoch: () => number;
    cancelPendingSearchScroll: () => void;
    annotationSession: TPdfAnnotationSession;
    applyFitWidthToCurrentPage: NonNullable<IPdfViewerExpose['applyFitWidthToCurrentPage']>;
    waitForViewerLoadSettled: NonNullable<IPdfViewerExpose['waitForViewerLoadSettled']>;
    renderVisiblePages: (
        range: {
            start: number;
            end: number;
        },
        options?: {
            preserveRenderedPages?: boolean;
            forceRerender?: boolean;
            bufferOverride?: number;
        },
    ) => Promise<void>;
    renderLoadedPdfPagesForBrowserPrint: NonNullable<IPdfViewerExpose['renderLoadedPdfPagesForBrowserPrint']>;
    startImagePlacement: IPdfViewerExpose['startImagePlacement'];
    clearPendingImagePlacement: IPdfViewerExpose['clearPendingImagePlacement'];
    restorePendingImagePlacement: IPdfViewerExpose['restorePendingImagePlacement'];
    invalidatePages: IPdfViewerExpose['invalidatePages'];
    captureRegionToClipboard: IPdfViewerExpose['captureRegionToClipboard'];
    isCapturingRegion: TPdfViewerPublicApiSource['isCapturingRegion'];
    startCropSelection: IPdfViewerExpose['startCropSelection'];
    cancelCropSelection: IPdfViewerExpose['cancelCropSelection'];
    isCropSelecting: TPdfViewerPublicApiSource['isCropSelecting'];
    requestScrollToCurrentResult: IPdfViewerExpose['requestScrollToCurrentResult'];
}

export const usePdfViewerPublicApiController = (
    options: IUsePdfViewerPublicApiControllerOptions,
): TPdfViewerPublicApiSource => {
    const {
        annotationSession,
        documentSession,
    } = options;
    const annotationRuntime = annotationSession;
    const viewportSession = options.viewportSession;
    const {
        annotations,
        annotationMutationService,
        annotationCommentModel,
        annotationSettings,
        focusAnnotationComment,
        shapeTool,
        shapeComposable,
        selectedShapeCommands,
    } = annotationRuntime;
    const currentPage = viewportSession.currentPage;

    async function renderAnnotationPage(pageNumber: number, optionsOverride: { forceRerender?: boolean } = {}) {
        if (!Number.isFinite(pageNumber)) {
            return false;
        }
        const normalizedPageNumber = Math.max(1, Math.trunc(pageNumber));
        if (documentSession.numPages.value > 0 && normalizedPageNumber > documentSession.numPages.value) {
            return false;
        }
        await options.waitForViewerLoadSettled();
        await documentSession.ensurePageMetricsInRange(normalizedPageNumber, normalizedPageNumber);
        await options.renderVisiblePages(
            {
                start: normalizedPageNumber,
                end: normalizedPageNumber,
            },
            {
                preserveRenderedPages: true,
                ...(optionsOverride.forceRerender !== undefined ? { forceRerender: optionsOverride.forceRerender } : {}),
                bufferOverride: 0,
            },
        );
        await nextTick();
        const container = options.viewerContainer.value;
        return Boolean(container && getPageContainerByNumber(container, normalizedPageNumber));
    }

    async function rerenderAnnotationPage(pageNumber: number) {
        return renderAnnotationPage(pageNumber, { forceRerender: true });
    }

    async function ensurePublicAnnotationTargetPageReady(pageNumber: number) {
        if (documentSession.numPages.value > 0 && pageNumber > documentSession.numPages.value) {
            return false;
        }
        options.cancelPendingSearchScroll();
        viewportSession.singlePageScroll.scrollToPage(pageNumber);
        await nextTick();
        return renderAnnotationPage(pageNumber);
    }

    return {
        getViewerContainer: () => options.viewerContainer.value,
        getCurrentPage: () => currentPage.value,
        getPendingNavigationTargetPage: () => viewportSession.singlePageScroll.navigationAnchorPage.value,
        getUserViewportInteractionEpoch: options.getUserViewportInteractionEpoch,
        scrollToPage: (pageNumber, scrollOptions) => {
            options.cancelPendingSearchScroll();
            viewportSession.singlePageScroll.scrollToPage(pageNumber, scrollOptions);
        },
        cancelProgrammaticNavigation: () => {
            options.cancelPendingSearchScroll();
            viewportSession.singlePageScroll.cancelProgrammaticNavigation('public-api');
        },
        applyFitWidthToCurrentPage: options.applyFitWidthToCurrentPage,
        ensurePageMetricsInRange: documentSession.ensurePageMetricsInRange,
        getPageMetricsSnapshot: () => cloneSparsePageMetrics(documentSession.pageMetrics.value),
        waitForViewerLoadSettled: options.waitForViewerLoadSettled,
        commitPdfEditorsForSave: annotationSession.commitPdfEditorsForSave,
        runSaveTransaction: annotationSession.runSaveTransaction,
        clearAnnotationHistory: () => annotationSession.appAnnotationHistory.clear(),
        renderLoadedPdfPagesForBrowserPrint: options.renderLoadedPdfPagesForBrowserPrint,
        markSavedShapeState: (_prepared?: unknown) => {
            // Saving changes the clean shape baseline but must not collapse the
            // app-managed undo/redo stack; re-emit so toolbar state stays current.
            annotationSession.appAnnotationHistory.emitCombinedState();
        },
        highlightSelection: annotationRuntime.highlightComposable.highlightSelection,
        commentSelection: annotationRuntime.highlightComposable.commentSelection,
        createTextMarkupFromText: async (target) => {
            const pageNumber = Number.isFinite(target.pageNumber)
                ? Math.max(1, Math.trunc(target.pageNumber))
                : currentPage.value;
            const normalizedTarget = {
                ...target,
                pageNumber,
            };
            await ensurePublicAnnotationTargetPageReady(pageNumber);
            return annotationRuntime.highlightComposable.createTextMarkupFromText(normalizedTarget);
        },
        // The narrow boolean surface predates typed outcomes. It answers the
        // same question as `createPointNoteAnnotation`, so it derives its
        // answer from the same rule rather than testing the status by hand.
        commentAtPoint: async (pageNumber, pageX, pageY, pointOptions) => projectAnnotationCreationOutcome(
            await annotationRuntime.highlightComposable.commentAtPoint(
                pageNumber,
                pageX,
                pageY,
                pointOptions ?? {},
            ),
            POINT_NOTE_CANCELLED_REASON,
        ).created,
        createPointNoteAnnotation: async (target) => {
            const pageNumber = Number.isFinite(target.pageNumber)
                ? Math.max(1, Math.trunc(target.pageNumber))
                : currentPage.value;
            const pageX = Number.isFinite(target.pageX) ? target.pageX : 0;
            const pageY = Number.isFinite(target.pageY) ? target.pageY : 0;
            const result = (
                created: boolean,
                reason?: string,
                failureReason?: TAnnotationCreationFailureReason,
                pendingEditor?: boolean,
            ) => ({
                created,
                pageNumber,
                pageX,
                pageY,
                ...(reason ? {reason} : {}),
                ...(failureReason ? {failureReason} : {}),
                ...(pendingEditor ? {pendingEditor} : {}),
            });

            if (documentSession.numPages.value > 0 && pageNumber > documentSession.numPages.value) {
                return result(false, `Page ${pageNumber} is outside the document.`);
            }

            const isTargetPageReady = await ensurePublicAnnotationTargetPageReady(pageNumber);
            if (!isTargetPageReady) {
                return result(false, `Page ${pageNumber} is not rendered.`);
            }
            const pointOptions = target.preferTextAnchor === undefined
                ? {}
                : {preferTextAnchor: target.preferTextAnchor};
            const outcome = await annotationRuntime.highlightComposable.commentAtPoint(
                pageNumber,
                pageX,
                pageY,
                pointOptions,
            );
            const projection = projectAnnotationCreationOutcome(outcome, POINT_NOTE_CANCELLED_REASON);
            return result(
                projection.created,
                projection.reason,
                projection.failureReason,
                projection.pendingEditor,
            );
        },
        createShapeAnnotation: async (target) => {
            const pageNumber = Number.isFinite(target.pageNumber)
                ? Math.max(1, Math.trunc(target.pageNumber))
                : currentPage.value;
            const result = (
                created: boolean,
                shape: ReturnType<typeof toShapeAnnotationCommentSummary> | null,
                reason?: string,
            ) => ({
                created,
                pageNumber,
                shape,
                ...(reason ? {reason} : {}),
            });

            if (documentSession.numPages.value > 0 && pageNumber > documentSession.numPages.value) {
                return result(false, null, `Page ${pageNumber} is outside the document.`);
            }

            const isTargetPageReady = await ensurePublicAnnotationTargetPageReady(pageNumber);
            if (!isTargetPageReady) {
                return result(false, null, `Page ${pageNumber} is not rendered.`);
            }

            const shape = shapeComposable.buildShapeAnnotation(
                {
                    ...target,
                    pageIndex: pageNumber - 1,
                },
                annotationSettings.value ?? DEFAULT_ANNOTATION_SETTINGS,
            );
            if (!shape) {
                return result(false, null, 'Shape geometry is too small or invalid.');
            }

            shapeTool.handleShapeCreated(shape);
            return result(true, toShapeAnnotationCommentSummary(shape));
        },
        annotationHistoryMutationVersion: annotationSession.appAnnotationHistory.annotationHistoryMutationVersion,
        annotationHistoryResetVersion: annotationSession.appAnnotationHistory.annotationHistoryResetVersion,
        hasCanonicalAnnotationChanges: annotationRuntime.hasCanonicalAnnotationChanges,
        getAnnotationDirtyEntityCount: () => annotationSession.annotationApplication.value.store.dirtyEntities().length,
        hasCanonicalShapeChanges: annotationRuntime.hasCanonicalShapeChanges,
        getAnnotationStorageDebugState: () => collectPdfJsAnnotationStorageDebugState(
            documentSession.pdfDocument.value,
        ),
        getDeletedCanonicalAnnotationIds: annotationRuntime.getDeletedCanonicalAnnotationIds,
        getDeletedPersistedCanonicalAnnotationCount: annotationRuntime.getDeletedPersistedCanonicalAnnotationCount,
        setWorkspaceCommandSink: annotationSession.appAnnotationHistory.setWorkspaceCommandSink,
        registerAnnotationHistoryCommand: annotationRuntime.registerShapeHistoryCommand,
        selectedTextBox: computed(() => annotationRuntime.annotationEditorSurface.getSelectedTextBox()),
        getSelectedTextBox: annotationRuntime.annotationEditorSurface.getSelectedTextBox,
        updateSelectedTextBoxProperties: annotationRuntime.annotationEditorSurface.updateSelectedTextBoxProperties,
        ensurePdfAnnotationNameReconciliation: annotations.commentSync.ensurePdfAnnotationNameReconciliation,
        focusAnnotationComment,
        updateAnnotationComment: (comment, text) => {
            const updated = annotationMutationService.updateComment(
                {
                    comment,
                    text,
                },
                { source: 'user' },
            );
            if (comment.source === 'pdf' && !comment.annotationName) {
                void annotations.commentSync
                    .ensurePdfAnnotationNameReconciliation('existing-annotation-mutation');
            }
            return updated;
        },
        moveAnnotationMarker: (comment, rect) => annotationMutationService.moveMarker(
            {
                comment,
                rect,
            },
            {source: 'agent'},
        ),
        deleteAnnotationComment: comment => annotationMutationService.deleteAnnotation(
            { comment },
            { source: 'user' },
        ),
        deleteAnnotationEditor: comment => annotationRuntime.deleteAnnotationComment(comment),
        deleteReopenedEditorAnnotation: comment => annotationMutationService.deleteReopenedEditorAnnotation(
            {comment},
            {source: 'user'},
        ),
        getAnnotationCommentsSnapshot: annotationCommentModel.getSnapshot,
        rerenderAnnotationPage,
        getMarkupSubtypeOverrides: annotations.editor.getMarkupSubtypeOverrides,
        getMarkupSubtypeHints: annotations.editor.getMarkupSubtypeHints,
        getSelectedTextMarkupAnnotationProperties: annotations.editor.markupSubtype.getSelectedTextMarkupAnnotationProperties,
        updateSelectedTextMarkupAnnotationColor: (color, selected) => annotationMutationService.updateColor(
            {
                color,
                comment: toSelectedTextMarkupComment(selected),
                selected: true,
            },
            { source: 'user' },
        ),
        updateSelectedTextMarkupAnnotationProperties: (updates, selected) => annotationMutationService
            .updateSelectedTextMarkupAnnotationProperties(
                {
                    updates,
                    selected,
                },
                { source: 'user' },
            ),
        updateTextMarkupAnnotationColor: (comment, color) => annotationMutationService.updateColor(
            {
                comment,
                color,
            },
            { source: 'user' },
        ),
        deleteEmbeddedAnnotationDeferred: annotationMutationService.deleteEmbeddedAnnotationDeferred,
        getAllShapes: shapeComposable.getAllShapes,
        getDeletedEmbeddedShapeAnnotationIds: shapeComposable.getDeletedEmbeddedAnnotationIds,
        getDeletedEmbeddedShapeStableKeys: shapeComposable.getDeletedEmbeddedShapeStableKeys,
        clearShapes: shapeComposable.clearShapes,
        clearSelectedShape: selectedShapeCommands.clearSelectedShape,
        deleteSelectedShape: selectedShapeCommands.deleteSelectedShape,
        deleteShapeById: selectedShapeCommands.deleteShapeById,
        hasShapes: shapeComposable.hasShapes,
        selectedShapeId: shapeComposable.selectedShapeId,
        updateShape: selectedShapeCommands.updateShape,
        getSelectedShape: selectedShapeCommands.getSelectedShape,
        startImagePlacement: options.startImagePlacement,
        clearPendingImagePlacement: options.clearPendingImagePlacement,
        restorePendingImagePlacement: options.restorePendingImagePlacement,
        invalidatePages: options.invalidatePages,
        remapPageIdentityDelta: delta => annotationRuntime.annotationApplication.value.remapPages(delta),
        removeAnnotationFromDom: annotationRuntime.removeAnnotationFromDom,
        removeAnnotationFromInternalCache: stableKey => annotationMutationService.removeAnnotationFromInternalCache(
            stableKey,
            { source: 'user' },
        ),
        restoreAnnotationToInternalCache: comment => annotationMutationService.restoreAnnotation(
            comment,
            { source: 'user' },
        ),
        clearPendingMarkerMoves: annotationMutationService.clearPendingMarkerMoves,
        captureRegionToClipboard: options.captureRegionToClipboard,
        isCapturingRegion: options.isCapturingRegion,
        startCropSelection: options.startCropSelection,
        cancelCropSelection: options.cancelCropSelection,
        isCropSelecting: options.isCropSelecting,
        requestScrollToCurrentResult: options.requestScrollToCurrentResult,
    };
};
