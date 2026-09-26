import {
    parsePageNumber,
    requirePageNumber,
} from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type { IDocumentViewerRuntime } from '@app/modules/document-viewer/public';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import { resolvePdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import { summarizeViewerMetrics } from '@app/modules/pdf-viewer/engine/pdf-viewer-metrics/summarizeViewerMetrics';
import { isStandaloneSpreadPage } from '@app/utils/pdfViewMode';
import { shouldShowPdfNavigationSkeleton } from '@app/modules/pdf-viewer/runtime/rendering/pdf-navigation-skeleton-eligibility/shouldShowPdfNavigationSkeleton';
import { usePdfRenderViewModel } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRenderViewModel';
import { createPdfRenderPagePredicate } from '@app/modules/pdf-viewer/runtime/rendering/createPdfRenderPagePredicate';
import { createPdfDocumentSession } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import {
    createPdfViewportSession,
    type TPdfViewportSession,
} from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import {
    createPdfRenderingSession,
    type TPdfRenderingSession,
} from '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession';
import {
    createPdfAnnotationSession,
    type TPdfAnnotationSession,
} from '@app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession';
import { usePdfViewerPublicApiController } from '@app/modules/pdf-viewer/runtime/usePdfViewerPublicApiController';
import { getRequestAnchor } from '@app/modules/pdf-viewer/runtime/navigation/pdfNavigationRequestAnchors';
import type { IBrowserPrintDocument } from '@app/utils/pdfPrintShared';
import { usePdfViewerNavigationDiagnostics } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerNavigationDiagnostics';
import { usePdfViewerMouseInteractions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerMouseInteractions';
import { usePdfViewerWheelZoom } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerWheelZoom';
import { usePdfViewerOutputScale } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerOutputScale';
import { usePdfCropSelection } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCropSelection';
import { usePdfImagePlacement } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfImagePlacement';
import { usePdfRegionSnip } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfRegionSnip';
import { usePdfViewerSelectionToolState } from '@app/modules/pdf-viewer/tools/public';
import { createPdfViewerEventAdapter } from '@app/modules/pdf-viewer/runtime/contracts/createPdfViewerEventAdapter';
import { usePdfViewerPropModel } from '@app/modules/pdf-viewer/runtime/contracts/usePdfViewerPropModel';
import type {
    IPdfViewerProps,
    IPdfViewerEmit,
} from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';
import type { ILinkAnnotation } from '@app/types/annotations';

/**
 * Composition root for the PDF viewer feature.
 *
 * It constructs the four sessions in topological order and adapts their read
 * models and commands to `PdfViewer.vue` and the exposed viewer API. It owns
 * no lifecycle of its own.
 */
export const usePdfViewerFeatureController = (
    props: IPdfViewerProps,
    emit: IPdfViewerEmit,
    chassisAuthority: IDocumentViewerRuntime,
) => {
    const openSurfaceRenderOwner = chassisAuthority.openSurface.claimRenderOwner();
    const {
        src,
        reloadSrc,
        sourcePdfData,
        rasterDisplayProfile,
        suppressLoadingOverlay,
        bufferPages,
        isAnySaving,
        zoom,
        dragMode,
        fitMode,
        zoomMode,
        viewMode,
        viewRotation,
        isResizing,
        showAnnotations,
        annotationTool,
        annotationCursorMode,
        annotationKeepActive,
        annotationSettings,
        searchPageMatches,
        currentSearchMatch,
        currentSearchMatchNavigationId,
        workingCopyPath,
        documentRevisionToken,
        continuousScroll,
        isActive,
        authorName,
    } = usePdfViewerPropModel(props);
    const { t } = useTypedI18n();
    const viewerEvents = createPdfViewerEventAdapter(emit);
    const viewerHost = ref<HTMLElement | null>(null);
    const viewerContainer = ref<HTMLElement | null>(null);
    const summarizeViewerStateForLog = () => summarizeViewerMetrics(viewerContainer.value);
    const performanceProfile = getPerformanceProfile();
    const performancePolicy = resolvePdfRenderPerformancePolicy(performanceProfile);
    const outputScale = usePdfViewerOutputScale(performancePolicy);
    const viewportWritePort = chassisAuthority.viewportWritePort;
    const regionSnip = usePdfRegionSnip({ viewerContainer });
    const cropSelection = usePdfCropSelection({ viewerContainer });
    const viewportSessionRef = shallowRef<TPdfViewportSession | null>(null);
    const renderingSessionRef = shallowRef<TPdfRenderingSession | null>(null);
    const annotationSessionRef = shallowRef<TPdfAnnotationSession | null>(null);
    const linkAnnotations = ref<ILinkAnnotation[]>([]);
    const viewerCurrentPage = computed(() => viewportSessionRef.value?.currentPage.value ?? 1);
    const viewerEffectiveScale = computed(() => viewportSessionRef.value?.scale.effectiveScale.value ?? 1);

    const documentSession = createPdfDocumentSession({
        chassisAuthority,
        openSurfaceDocumentId: () => {
            const source = src.value;
            return props.originalPath
                ?? workingCopyPath.value
                ?? (typeof source === 'object' && source !== null && 'path' in source
                    ? source.path
                    : 'pdf-open');
        },
        emitInitialVisualPending: viewerEvents.initialVisualPending,
        src,
        reloadSrc,
        documentLifecycleKey: computed(() => props.originalPath ?? null),
        documentRevisionToken,
        originalDocumentId: computed(() => props.originalPath ?? null),
        currentPage: viewerCurrentPage,
        isActive,
        isAnySaving,
        emitDocument: document => emit('update:document', document),
        emitTotalPages: total => emit('update:totalPages', total),
        emitLoading: (loading) => {
            emit('update:loading', loading);
            emit('loading', loading);
        },
        emitLoadError: viewerEvents.loadError,
    });

    const {
        pendingImagePlacement,
        isPendingImagePlacementFinalizing,
        startImagePlacement,
        updatePendingImagePlacementRect,
        requestPendingImagePlacementFinalize,
        clearPendingImagePlacement,
        restorePendingImagePlacement,
    } = usePdfImagePlacement({
        viewerContainer,
        currentPage: viewerCurrentPage,
        numPages: documentSession.numPages,
        effectiveScale: viewerEffectiveScale,
        viewRotation,
        getPageDimensions: pageNumber => documentSession.pageMetrics.value[pageNumber - 1] ?? null,
        finalizePlacement: payload => annotationSessionRef.value?.finalizeImagePlacement(payload)
            ?? Promise.resolve(false),
    });

    const {
        isDragging,
        startDrag,
        onDrag,
        stopDrag,
        isViewerPanDragModeActive,
        isSelectionMarkupToolActive,
        isTextSelectionModeActive,
        selectionMarkupStyle,
    } = usePdfViewerSelectionToolState({
        dragMode,
        annotationTool,
        annotationCursorMode,
        annotationSettings,
        pendingImagePlacement,
        viewportWritePort,
    });

    const viewportSession = createPdfViewportSession({
        document: documentSession,
        chassisAuthority,
        performancePolicy,
        maxBufferCanvasPixels: performanceProfile.maxBufferCanvasPixels,
        settledMaxCanvasPixels: performanceProfile.settledMaxCanvasPixels,
        viewerContainer,
        viewportWritePort,
        zoom,
        zoomMode,
        fitMode,
        viewMode,
        viewRotation,
        continuousScroll,
        bufferPages,
        isActive,
        isResizing,
        outputScale,
        isPageFreshlyRenderedForNavigation: pageNumber => (
            renderingSessionRef.value?.isPageVisualReady(pageNumber) ?? false
        ),
        waitForPageTextLayerReady: (pageNumber, signal) => (
            renderingSessionRef.value?.waitForPageTextLayerReady(pageNumber, signal)
                ?? Promise.resolve(false)
        ),
        getCommittedPageScale: pageNumber => (
            renderingSessionRef.value?.getCommittedPageScale(pageNumber) ?? null
        ),
        selectionMarkupStyle,
        classState: {
            isAnySaving,
            isDragging,
            isViewerPanDragModeActive,
            isSelectionMarkupToolActive,
            isTextSelectionModeActive,
            fitMode,
            zoomMode,
        },
        emitCurrentPage: viewerEvents.updateCurrentPage,
        emitNavigationFeedbackPage: viewerEvents.updateNavigationFeedbackPage,
        emitZoomState: viewerEvents.updateZoomState,
        emitEffectiveZoom: viewerEvents.updateEffectiveZoom,
        summarizeViewerStateForLog,
        clearPendingImagePlacement,
    });
    viewportSessionRef.value = viewportSession;

    const { handleViewerWheel } = usePdfViewerWheelZoom({
        viewerContainer,
        isReady: () => Boolean(src.value) && !documentSession.isLoading.value,
        effectiveScale: viewportSession.scale.effectiveScale,
        zoomMode,
        handlePagedWheel: viewportSession.singlePageScroll.handleWheel,
        cancelPendingSearchScroll: () => renderingSessionRef.value?.cancelPendingSearchScroll(),
        markUserViewportInteraction: viewportSession.markUserViewportInteraction,
        captureRelayoutAnchor: viewportSession.singlePageScroll.captureRelayoutAnchor,
        relayout: viewportSession.singlePageScroll.relayout,
        isSnipActive: () => regionSnip.isActive.value || cropSelection.isSelecting.value,
        emit,
    });

    let markDelayedSkeletonPageRendered = (_pageNumber: TPageNumber) => {};
    const renderingSession = createPdfRenderingSession({
        document: documentSession,
        viewport: viewportSession,
        chassisAuthority,
        openSurfaceRenderOwner,
        performancePolicy,
        viewerContainer,
        isActive,
        isResizing,
        isAnySaving,
        viewMode,
        viewRotation,
        outputScale,
        rasterDisplayProfile,
        bufferPages,
        showAnnotations,
        searchPageMatches,
        currentSearchMatch,
        currentSearchMatchNavigationId,
        workingCopyPath,
        documentRevisionToken,
        maxBufferCanvasPixels: performanceProfile.maxBufferCanvasPixels,
        markDelayedSkeletonPageRendered: pageNumber => markDelayedSkeletonPageRendered(pageNumber),
        emitInitialVisualReady: viewerEvents.initialVisualReady,
        emitLoadError: viewerEvents.loadError,
        linkAnnotations,
    });
    renderingSessionRef.value = renderingSession;

    const annotationSession = createPdfAnnotationSession({
        document: documentSession,
        viewport: viewportSession,
        rendering: renderingSession,
        viewerContainer,
        originalPath: computed(() => props.originalPath ?? null),
        src,
        sourcePdfData,
        workingCopyPath,
        documentRevisionToken,
        isAnySaving,
        isActive,
        bufferPages,
        annotationTool,
        annotationCursorMode,
        annotationKeepActive,
        annotationSettings,
        authorName,
        clearPendingImagePlacement,
        emitAnnotationModified: payload => viewerEvents.annotationModified(payload),
        emitAnnotationState: viewerEvents.annotationState,
        emitAnnotationComments: viewerEvents.annotationComments,
        emitAnnotationInventory: viewerEvents.annotationInventory,
        emitAnnotationEnrichmentState: viewerEvents.annotationEnrichmentState,
        emitAnnotationOpenNote: viewerEvents.annotationOpenNote,
        emitAnnotationContextMenu: viewerEvents.annotationContextMenu,
        viewRotation,
        emitAnnotationToolAutoReset: viewerEvents.annotationToolAutoReset,
        emitAnnotationToolCancel: viewerEvents.annotationToolCancel,
        emitAnnotationSetting: viewerEvents.annotationSetting,
        emitAnnotationCommentClick: viewerEvents.annotationCommentClick,
        reportAnnotationFailure: viewerEvents.annotationFailure,
        emitShapeContextMenu: viewerEvents.shapeContextMenu,
        linkAnnotations,
    });
    annotationSessionRef.value = annotationSession;

    const getLivePageCount = () => documentSession.numPages.value;
    const isPageBuffered = createPdfRenderPagePredicate(
        getLivePageCount,
        pageNumber => viewportSession.viewModel.isPageBuffered(pageNumber),
    );
    const isPageRenderedForClass = createPdfRenderPagePredicate(
        getLivePageCount,
        pageNumber => renderingSession.isPageRenderedForClass(pageNumber),
    );
    const isPageRendering = createPdfRenderPagePredicate(
        getLivePageCount,
        pageNumber => renderingSession.isPageRendering(pageNumber),
    );
    const isPageRenderFailed = createPdfRenderPagePredicate(
        getLivePageCount,
        pageNumber => renderingSession.isPageRenderFailed(pageNumber),
    );

    const renderViewModel = usePdfRenderViewModel({
        src,
        isLoading: documentSession.isLoading,
        pdfDocument: documentSession.pdfDocument,
        getPage: pageNumber => documentSession.getPage(
            requirePageNumber(pageNumber, documentSession.numPages.value),
        ),
        openSurface: chassisAuthority.openSurface,
        isVisualReloadTransitionActive: viewportSession.reloadTransition.isVisualReloadTransitionActive,
        suppressLoadingOverlay,
        skeletonContentInsets: viewportSession.skeletonInsets.skeletonContentInsets,
        pagesToRender: viewportSession.viewModel.pagesToRender,
        isPageBuffered,
        isPageRenderedForClass,
        isPageRendering,
        isPageRenderFailed,
        shouldShowSkeleton: pageNumber => {
            const totalPages = documentSession.numPages.value;
            const brandedPageNumber = parsePageNumber(pageNumber, totalPages);
            if (brandedPageNumber === null) {
                return false;
            }
            const navigationAnchorPageValue = viewportSession.singlePageScroll.navigationAnchorPage.value;
            const navigationAnchorPage = navigationAnchorPageValue === null
                ? (viewportSession.singlePageScroll.isProgrammaticNavigationActive.value
                    ? parsePageNumber(viewportSession.currentPage.value, totalPages)
                    : null)
                : parsePageNumber(navigationAnchorPageValue, totalPages);
            return shouldShowPdfNavigationSkeleton({
                pageNumber: brandedPageNumber,
                navigationAnchorPage,
                totalPages,
                viewMode: viewMode.value,
                isPageRendered: renderingSession.isPageVisualReady,
                shouldShowSkeleton: isPageNearVisibleAndUnrendered,
            });
        },
        visibleRange: viewportSession.visibleRange,
        currentPage: viewportSession.currentPage,
        zoom,
        zoomMode,
        fitMode,
        effectiveScale: viewportSession.scale.effectiveScale,
        continuousScroll,
        numPages: documentSession.numPages,
        linksByPage: annotationSession.linksByPage,
    });
    markDelayedSkeletonPageRendered = renderViewModel.markPageRendered;

    const SKELETON_BUFFER = 3;
    function isPageNearVisibleAndUnrendered(pageNumber: TPageNumber) {
        const start = Math.max(1, viewportSession.visibleRange.value.start - SKELETON_BUFFER);
        const end = Math.min(documentSession.numPages.value, viewportSession.visibleRange.value.end + SKELETON_BUFFER);
        return pageNumber >= start
            && pageNumber <= end
            && !renderingSession.isPageRendered(pageNumber);
    }

    const {
        handleViewerMouseDown,
        handleViewerMouseMove,
        handleViewerMouseUp,
        handleViewerMouseLeave,
        handleSelectStart,
        handleViewerClick,
        handleViewerDblClick,
        handleViewerContextMenu,
    } = usePdfViewerMouseInteractions({
        isSnipActive: () => regionSnip.isActive.value || cropSelection.isSelecting.value,
        isViewerPanDragModeActive,
        markUserViewportInteraction: viewportSession.markUserViewportInteraction,
        cancelPendingSearchScroll: () => renderingSession.cancelPendingSearchScroll(),
        handleDragStart: event => startDrag(event, viewerContainer.value),
        handleDragMove: event => onDrag(event, viewerContainer.value),
        stopDrag,
        handleViewerClickAnnotation: event => annotationSession.commentCrud.handleAnnotationCommentClick(event),
        handleViewerDblClickAnnotation: event => annotationSession.commentCrud.handleAnnotationEditorDblClick(event),
        handleViewerContextMenuAnnotation: event => annotationSession.commentCrud.handleAnnotationCommentContextMenu(event),
    });

    usePdfViewerNavigationDiagnostics({
        currentPage: viewportSession.currentPage,
        visibleRange: viewportSession.visibleRange,
        isLoading: documentSession.isLoading,
        continuousScroll,
        fitMode,
        viewMode,
        zoom,
        navigationAnchorWindow: viewportSession.viewModel.navigationAnchorWindow,
        virtualizedContinuousMode: viewportSession.viewModel.virtualizedContinuousMode,
        virtualWindowStart: viewportSession.viewModel.virtualWindowStart,
        virtualWindowEnd: viewportSession.viewModel.virtualWindowEnd,
        searchNavigationTargetPage: viewportSession.singlePageScroll.searchNavigationTargetPage,
        searchNavigationState: viewportSession.singlePageScroll.searchNavigationState,
        getRasterSchedulerSnapshot: () => documentSession.rasterScheduler?.snapshot() ?? null,
        summarizeViewerStateForLog,
    });

    async function renderLoadedPdfPagesForBrowserPrint(
        targetDocument: IBrowserPrintDocument,
        pageNumbers: TPageNumber[],
        renderOptions?: { signal?: AbortSignal },
    ) {
        const pdfDocument = documentSession.pdfDocument.value;
        if (!pdfDocument) {
            throw new Error('Missing loaded PDF document');
        }
        const { renderPdfDocumentPagesForBrowserPrint } = await import('@app/utils/pdfPrint');
        await renderPdfDocumentPagesForBrowserPrint(targetDocument, pdfDocument, pageNumbers, renderOptions);
    }

    // Rotated pages change size (and Fit Width may change the scale) under
    // the reader. The relayout keeps the committed page in place, the same
    // placement the revision swap restores.
    function updatePageMutationFitWidth() {
        const page = requirePageNumber(
            viewportSession.currentPage.value,
            documentSession.numPages.value,
        );
        viewportSession.singlePageScroll.relayout(() => {
            if (zoomMode.value === 'fit-width') {
                viewportSession.scale.invalidateScaleCache();
                viewportSession.scale.computeFitWidthScale(viewerContainer.value, {page});
                viewportSession.reloadTransition.commitEffectiveZoom(viewportSession.scale.effectiveScale.value);
            }
        }, getRequestAnchor(undefined, page));
    }

    async function beginPageRotationPreview(input: {
        invalidatedPages: readonly number[];
        rotationDelta: 90 | 180 | 270;
    }) {
        if (!documentSession.beginPageMutationRotationPreview(input.invalidatedPages, input.rotationDelta)) {
            return false;
        }
        updatePageMutationFitWidth();
        await nextTick();
        renderingSession.preparePageRotationPreview(input.invalidatedPages, input.rotationDelta);
        return true;
    }

    function cancelPageRotationPreview(input: {invalidatedPages: readonly number[]}) {
        const didCancelGeometry = documentSession.cancelPageMutationRotationPreview();
        const didCancelRaster = renderingSession.cancelPageRotationPreview(input.invalidatedPages);
        if (didCancelGeometry) {
            updatePageMutationFitWidth();
        }
        return didCancelGeometry || didCancelRaster;
    }

    const pdfViewerPublicApi = usePdfViewerPublicApiController({
        viewerContainer,
        documentSession,
        viewportSession,
        getUserViewportInteractionEpoch: () => viewportSession.userViewportInteractionEpoch.value,
        cancelPendingSearchScroll: () => renderingSession.cancelPendingSearchScroll(),
        annotationSession,
        waitForViewerLoadSettled: documentSession.waitForLoadSettled,
        renderVisiblePages: renderingSession.renderVisiblePages,
        renderLoadedPdfPagesForBrowserPrint,
        startImagePlacement,
        clearPendingImagePlacement,
        restorePendingImagePlacement,
        invalidatePages: renderingSession.invalidatePages,
        beginPageRotationPreview,
        cancelPageRotationPreview,
        preparePageMutationRevisionSwap: async (input) => {
            const didPrepare = documentSession.preparePageMutationRevisionSwap(
                String(input.documentRevision),
                input.invalidatedPages,
                input.pageNumber,
                input.rotationDelta,
            );
            if (!didPrepare) {
                return false;
            }
            if (
                input.rotationDelta !== undefined
                && documentSession.pendingPageMutationRevisionSwap?.rotationDelta !== undefined
                && documentSession.pendingPageMutationRevisionSwap.revision === String(input.documentRevision)
            ) {
                updatePageMutationFitWidth();
                await nextTick();
                renderingSession.preparePageRotationPreview(input.invalidatedPages, input.rotationDelta);
            }
            return true;
        },
        captureRegionToClipboard: regionSnip.startCaptureSession,
        isCapturingRegion: regionSnip.isActive,
        startCropSelection: cropSelection.startCropSelection,
        cancelCropSelection: cropSelection.cancelSelection,
        isCropSelecting: cropSelection.isSelecting,
        requestScrollToCurrentResult: renderingSession.requestScrollToCurrentResult,
    });

    return {
        t,
        viewerHost,
        viewerContainer,
        renderedPageStateVersion: readonly(renderingSession.renderedPageStateVersion),
        viewerClass: viewportSession.viewModel.viewerClass,
        containerStyle: viewportSession.viewModel.containerStyle,
        scaledMargin: viewportSession.scale.scaledMargin,
        openingVirtualExtentMinimumScrollHeight:
            viewportSession.openVirtualSurfaceGeometry.openingVirtualExtentMinimumScrollHeight,
        pagesToRender: viewportSession.viewModel.pagesToRender,
        virtualPageSegments: viewportSession.viewModel.virtualPageSegments,
        shouldShowPageSkeleton: renderViewModel.shouldShowPageSkeleton,
        isPageRenderFailed,
        isSpreadSingle: (page: number) => isStandaloneSpreadPage(page, viewMode.value, documentSession.numPages.value),
        isPageBuffered,
        pageRaster: (pageNumber: TPageNumber) => {
            if (!isPageRenderedForClass(pageNumber)) {
                return null;
            }
            return renderingSession.isPageVisualReady(pageNumber) ? 'current' as const : 'stale' as const;
        },
        getPageScale: viewportSession.viewModel.getPageScale,
        getPagePlaceholderStyle: viewportSession.viewModel.getPagePlaceholderStyle,
        getExactPagePlaceholderStyle: viewportSession.openVirtualSurfaceGeometry.getExactPagePlaceholderStyle,
        topVirtualSpacerStyle: viewportSession.viewModel.topVirtualSpacerStyle,
        bottomVirtualSpacerStyle: viewportSession.openVirtualSurfaceGeometry.bottomVirtualSpacerStyle,
        flingBackdrop: viewportSession.flingBackdrop,
        pendingImagePlacement,
        isPendingImagePlacementFinalizing,
        handleViewportScroll: viewportSession.handleTrustedScroll,
        handleViewerWheel,
        handleViewerMouseDown,
        handleViewerMouseMove,
        handleViewerMouseUp,
        handleViewerMouseLeave,
        handleViewerClick,
        handleViewerDblClick,
        handleViewerContextMenu,
        handleSelectStart,
        handlePageContainerMounted: (pageNumber: TPageNumber) => viewportSession.markPageMounted(pageNumber),
        handlePageContainerUnmounted: (pageNumber: TPageNumber) => {
            viewportSession.markPageUnmounted(pageNumber);
            renderingSession.releaseUnmountedPage(pageNumber);
        },
        updatePendingImagePlacementRect,
        requestPendingImagePlacementFinalize,
        clearPendingImagePlacement,
        regionSnip,
        cropSelection,
        visibleLinksByPage: renderViewModel.visibleLinksByPage,
        isViewerLoadingOverlayVisible: renderViewModel.isViewerLoadingOverlayVisible,
        handleLinkDestination: viewportSession.handleLinkDestination,
        handleViewerContainerRef: viewportSession.handleViewerContainerRef,
        pdfViewerPublicApi,
    };
};
