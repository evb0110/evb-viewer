import {
    pageNumberToPageIndex,
    requirePageNumber,
} from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type { Ref } from 'vue';
import type { Merge } from 'type-fest';
import type { TPdfDocumentView } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type { TPdfAnnotationSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession';
import type { IPdfViewerExpose } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import type { TAnnotationCreationFailureReason } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import { projectAnnotationCreationOutcome } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/projectAnnotationCreationOutcome';
import { asAnnotationId } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { getPageContainerByNumber } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageContainerByNumber';
import { buildShapeAnnotation } from '@app/modules/pdf-viewer/tools/annotationShapeDrawing';

const POINT_NOTE_CANCELLED_REASON = 'The document changed before the point note was created.';
const DOCUMENT_CHANGED_REASON = 'The document changed before the annotation was created.';

type TPdfViewerPublicApiRefBackedKeys =
    | 'hasShapes'
    | 'isCropSelecting'
    | 'pageMetrics'
    | 'pageMetricsVersion'
    | 'selectedAnnotations';

type TPdfViewerRefBackedSource = {
    [TKey in TPdfViewerPublicApiRefBackedKeys]-?: Readonly<Ref<Exclude<IPdfViewerExpose[TKey], undefined>>>;
};

type TPdfViewerPublicApiSource = Merge<
    Omit<IPdfViewerExpose, TPdfViewerPublicApiRefBackedKeys | 'captureRegionToClipboard' | 'captureVisibleRegionAsPng' | 'isCapturingRegion'>,
    TPdfViewerRefBackedSource
>;

interface IUsePdfViewerPublicApiControllerOptions {
    viewerContainer: Ref<HTMLElement | null>;
    documentSession: TPdfDocumentView;
    viewportSession: TPdfViewportSession;
    getUserViewportInteractionEpoch: () => number;
    cancelPendingSearchScroll: () => void;
    annotationSession: TPdfAnnotationSession;
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
    preparePageMutationRevisionSwap?: IPdfViewerExpose['preparePageMutationRevisionSwap'];
    beginPageRotationPreview?: IPdfViewerExpose['beginPageRotationPreview'];
    cancelPageRotationPreview?: IPdfViewerExpose['cancelPageRotationPreview'];
    startCropSelection: IPdfViewerExpose['startCropSelection'];
    cancelCropSelection: IPdfViewerExpose['cancelCropSelection'];
    isCropSelecting: TPdfViewerPublicApiSource['isCropSelecting'];
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
        annotationSettings,
        commentCrud,
        shapeTool,
    } = annotationRuntime;
    const {focusAnnotationComment} = commentCrud;
    const currentPage = viewportSession.currentPage;

    // No page-count bound here. The annotation flows check the page against the
    // document themselves and refuse a target outside it, so bounding the page
    // first would move an out-of-range annotation onto the last page instead.
    // The safe integer cap stays, because a public caller can hand over a finite
    // page beyond that range and requirePageNumber rejects one.
    function normalizePublicPageNumber(requestedPage: number | null | undefined) {
        const fallbackPage = Number.isFinite(currentPage.value) ? currentPage.value : 1;
        const page = typeof requestedPage === 'number' && Number.isFinite(requestedPage)
            ? requestedPage
            : fallbackPage;
        return requirePageNumber(Math.min(Math.max(1, Math.trunc(page)), Number.MAX_SAFE_INTEGER));
    }

    // Navigation is the one caller that should bound an overshooting page, since
    // scrolling past the end means scrolling to the end. Before the document
    // reports a count there is nothing to bound against.
    function resolveNavigationPageNumber(requestedPage: number | null | undefined) {
        const totalPages = documentSession.numPages.value;
        const normalizedPage = normalizePublicPageNumber(requestedPage);
        return totalPages > 0
            ? requirePageNumber(Math.min(normalizedPage, totalPages), totalPages)
            : normalizedPage;
    }

    /**
     * Brings the page an annotation request names into view. The request
     * belongs to the document it arrived on: a reload or replacement while
     * the page renders answers false through `isCurrent`.
     */
    async function ensurePublicAnnotationTargetPageReady(pageNumber: TPageNumber) {
        const fence = documentSession.captureFence();
        const isCurrent = () => documentSession.isCurrent(fence);
        if (documentSession.numPages.value > 0 && pageNumber > documentSession.numPages.value) {
            return {
                ready: false,
                isCurrent,
            };
        }
        options.cancelPendingSearchScroll();
        viewportSession.singlePageScroll.scrollToPage(pageNumber);
        await nextTick();
        if (documentSession.numPages.value > 0 && pageNumber > documentSession.numPages.value) {
            return {
                ready: false,
                isCurrent,
            };
        }
        await options.waitForViewerLoadSettled();
        await documentSession.ensurePageMetricsInRange(pageNumber, pageNumber);
        await options.renderVisiblePages(
            {
                start: pageNumber,
                end: pageNumber,
            },
            {
                preserveRenderedPages: true,
                bufferOverride: 0,
            },
        );
        await nextTick();
        const container = options.viewerContainer.value;
        return {
            ready: Boolean(container && getPageContainerByNumber(container, pageNumber)),
            isCurrent,
        };
    }

    return {
        getViewerContainer: () => options.viewerContainer.value,
        getEffectiveZoom: () => viewportSession.scale.effectiveScale.value,
        getCurrentPage: () => currentPage.value,
        getUserViewportInteractionEpoch: options.getUserViewportInteractionEpoch,
        scrollToPage: (pageNumber, scrollOptions) => {
            options.cancelPendingSearchScroll();
            viewportSession.singlePageScroll.scrollToPage(
                resolveNavigationPageNumber(pageNumber),
                scrollOptions,
            );
        },
        captureReadingAnchor: () => viewportSession.singlePageScroll.captureRelayoutAnchor(),
        ensurePageMetricsInRange: documentSession.ensurePageMetricsInRange,
        pageMetrics: documentSession.pageMetrics,
        pageMetricsVersion: documentSession.pageMetricsVersion,
        waitForViewerLoadSettled: options.waitForViewerLoadSettled,
        commitPdfEditorsForSave: annotationSession.commitPdfEditorsForSave,
        runSaveTransaction: annotationSession.runSaveTransaction,
        renderLoadedPdfPagesForBrowserPrint: options.renderLoadedPdfPagesForBrowserPrint,
        highlightSelection: annotationRuntime.highlightComposable.highlightSelection,
        commentSelection: annotationRuntime.highlightComposable.commentSelection,
        createTextMarkupFromText: async (target) => {
            const pageNumber = normalizePublicPageNumber(target.pageNumber);
            const normalizedTarget = {
                ...target,
                pageNumber,
            };
            const {isCurrent} = await ensurePublicAnnotationTargetPageReady(pageNumber);
            return annotationRuntime.highlightComposable.createTextMarkupFromText(normalizedTarget, isCurrent);
        },
        // The narrow boolean surface predates typed outcomes. It answers the
        // same question as `createPointNoteAnnotation`, so it derives its
        // answer from the same rule rather than testing the status by hand.
        commentAtPoint: async (pageNumber, pageX, pageY, pointOptions) => projectAnnotationCreationOutcome(
            await Promise.resolve(annotationRuntime.highlightComposable.commentAtPoint(
                pageNumber,
                pageX,
                pageY,
                pointOptions ?? {},
            )),
            POINT_NOTE_CANCELLED_REASON,
        ).created,
        createPointNoteAnnotation: async (target) => {
            const pageNumber = normalizePublicPageNumber(target.pageNumber);
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

            const prepared = await ensurePublicAnnotationTargetPageReady(pageNumber);
            if (!prepared.isCurrent()) {
                return result(false, DOCUMENT_CHANGED_REASON);
            }
            if (!prepared.ready) {
                return result(false, `Page ${pageNumber} is not rendered.`);
            }
            const pointOptions = target.preferTextAnchor === undefined
                ? {}
                : {preferTextAnchor: target.preferTextAnchor};
            const outcome = annotationRuntime.highlightComposable.commentAtPoint(
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
            const pageNumber = normalizePublicPageNumber(target.pageNumber);
            const result = (
                created: boolean,
                shape: IAnnotationCommentSummary | null,
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

            const prepared = await ensurePublicAnnotationTargetPageReady(pageNumber);
            if (!prepared.isCurrent()) {
                return result(false, null, DOCUMENT_CHANGED_REASON);
            }
            if (!prepared.ready) {
                return result(false, null, `Page ${pageNumber} is not rendered.`);
            }

            const shape = buildShapeAnnotation(
                {
                    ...target,
                    pageIndex: pageNumberToPageIndex(pageNumber),
                },
                annotationSettings.value ?? DEFAULT_ANNOTATION_SETTINGS,
            );
            if (!shape) {
                return result(false, null, 'Shape geometry is too small or invalid.');
            }

            shapeTool.createShape(shape);
            return result(true, annotationSession.annotationApplication.value.listCommentSummaries()
                .find(comment => comment.appAnnotationId === shape.id) ?? null);
        },
        hasCanonicalAnnotationChanges: annotationRuntime.hasCanonicalAnnotationChanges,
        getAnnotationDirtyEntityCount: () => annotationSession.annotationApplication.value.store.dirtyEntities().length,
        hasCanonicalShapeChanges: annotationRuntime.hasCanonicalShapeChanges,
        getDeletedCanonicalAnnotationIds: annotationRuntime.getDeletedCanonicalAnnotationIds,
        getDeletedPersistedCanonicalAnnotationCount: annotationRuntime.getDeletedPersistedCanonicalAnnotationCount,
        setWorkspaceCommandSink: annotationSession.appAnnotationHistory.setWorkspaceCommandSink,
        registerAnnotationHistoryCommand: annotationRuntime.registerShapeHistoryCommand,
        selectAllAnnotations: () => {
            const focused = typeof document === 'undefined' ? null : document.activeElement;
            if (!(focused instanceof HTMLElement) || !focused.closest('.pdf-annotation-editor-layer')
                || focused.isContentEditable || focused.closest('input, textarea, select, [contenteditable="true"]')) {
                return false;
            }
            return annotationRuntime.annotationEditorSurface.selectAll();
        },
        focusSelectedAnnotation: (annotationId: string) => annotationRuntime.annotationEditorSurface.focusSelectedAnnotation(asAnnotationId(annotationId)),
        selectAnnotationById: (annotationId: string) => {
            const id = asAnnotationId(annotationId);
            const entity = annotationSession.annotationApplication.value.store.get(id);
            if (!entity || entity.deleted) {
                return false;
            }
            annotationRuntime.annotationEditorSurface.select([id]);
            return true;
        },
        editAnnotationTextBox: async (comment) => {
            if (!comment.appAnnotationId) {
                return;
            }
            await focusAnnotationComment(comment);
            await annotationRuntime.annotationEditorSurface.beginTextEditing(asAnnotationId(comment.appAnnotationId));
        },
        selectedAnnotations: annotationRuntime.annotationEditorSurface.selectedAnnotations,
        updateSelectedAnnotationProperties: annotationRuntime.annotationEditorSurface.updateSelectedAnnotationProperties,
        canRotateSelectedAnnotations: annotationRuntime.annotationEditorSurface.canRotateSelectedAnnotations,
        prepareAnnotationToolChange: annotationRuntime.annotationEditorSurface.prepareToolChange,
        handleAnnotationEscape: annotationRuntime.annotationEditorSurface.handleEscape,
        captureCanonicalAnnotationRecovery: annotationRuntime.captureCanonicalAnnotationRecovery,
        getCanonicalAnnotationRecoveryChangeSignature: annotationRuntime.getCanonicalAnnotationRecoveryChangeSignature,
        restoreCanonicalAnnotationRecovery: annotationRuntime.restoreCanonicalAnnotationRecovery,
        focusAnnotationComment,
        updateAnnotationComment: commentCrud.updateAnnotationComment,
        moveAnnotationMarker: commentCrud.moveAnnotationMarker,
        deleteAnnotationComment: commentCrud.deleteAnnotationComment,
        deleteReopenedEditorAnnotation: commentCrud.deleteReopenedEditorAnnotation,
        updateTextMarkupAnnotationColor: commentCrud.updateTextMarkupAnnotationColor,
        deleteEmbeddedAnnotationDeferred: commentCrud.deleteEmbeddedAnnotationDeferred,
        getAllShapes: shapeTool.getAllShapes,
        getDeletedEmbeddedShapeAnnotationIds: shapeTool.getDeletedEmbeddedAnnotationIds,
        getDeletedEmbeddedShapeStableKeys: shapeTool.getDeletedEmbeddedShapeStableKeys,
        deleteSelectedShape: annotationRuntime.annotationEditorSurface.deleteSelection,
        hasShapes: shapeTool.hasShapes,
        startImagePlacement: options.startImagePlacement,
        ...(options.preparePageMutationRevisionSwap
            ? {preparePageMutationRevisionSwap: options.preparePageMutationRevisionSwap}
            : {}),
        ...(options.beginPageRotationPreview
            ? {beginPageRotationPreview: options.beginPageRotationPreview}
            : {}),
        ...(options.cancelPageRotationPreview
            ? {cancelPageRotationPreview: options.cancelPageRotationPreview}
            : {}),
        startCropSelection: options.startCropSelection,
        cancelCropSelection: options.cancelCropSelection,
        isCropSelecting: options.isCropSelecting,
    };
};
