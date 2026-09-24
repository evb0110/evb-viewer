export {
    createPageNavigationRequest, type IDocumentNavigationRequest, type IDocumentNavigationTicket, type IDocumentTextAnchorNavigationOptions, type TDocumentNavigationOutcome, type TDocumentNavigationReport, type TDocumentNavigationTarget,
} from '@app/modules/document-viewer/navigation/documentNavigationRequest';
export { default as DocumentViewportHost } from '@app/modules/document-viewer/runtime/DocumentViewportHost.vue';
export * from '@app/modules/document-viewer/thumbnails/documentThumbnailRenderMetrics';
export {
    applyPageLabelRange, applySparsePageLabelUpdates, buildPageLabelSegments, buildPageLabelsFromRanges, buildWholeDocumentPageLabelRanges, countPageLabelDifferences, createPageLabelModel, derivePageLabelRangesFromLabels, findPageByPageLabelInput, formatPageIndicatorWithOptions, formatPageRange, getPageIndicatorLayoutMetrics, getPageLabelWindow, getVisiblePageLabel, isImplicitDefaultPageLabels, materializePageLabelsForCompatibility, normalizePageLabelRanges, PAGE_LABEL_DENSE_READ_MAX_PAGES, PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES, parsePageRangeInput, type IDocumentPageLabelModel, type TDocumentPageLabelLookup,
} from '@app/modules/document-viewer/pageLabels';
export {
    canDocumentViewportTransactionSupersede, createDocumentViewportTransactionMachineState, reduceDocumentViewportTransactionMachine,
} from '@app/modules/document-viewer/viewport/documentViewportTransactionReducer';
export {
    canScrollWithinPageBounds, resolveWheelDirection, resolveWheelTargetPage,
} from '@app/modules/document-viewer/single-page-wheel/singlePageWheelNavigation';
export {
    captureDocumentViewportResizeAnchor, resolveDocumentViewportResizeAnchorPosition, type IDocumentViewportResizeAnchor,
} from '@app/modules/document-viewer/runtime/documentViewportResizeAnchor';
export { clampClientPointToRect } from '@app/modules/document-viewer/region-geometry/clampClientPointToRect';
export {
    clampDocumentFitScale, clampDocumentManualZoom, type IDocumentZoomLimits,
} from '@app/modules/document-viewer/zoomPolicy';
export {
    clampKeyboardSelection, createKeyboardSelection, updateKeyboardSelection,
} from '@app/modules/document-viewer/region-geometry/keyboardSelection';
export {
    createDocumentOpenSurfaceSession, documentOpenSurfaceSessionKey, hasCommittedDocumentOpeningLayout, injectDocumentOpenSurfaceSession, isDocumentOpenEmptySurfaceTransition, resolveDocumentOpenSurfaceViewportPolicy, shouldPresentDocumentOpenEmptyPlaceholder, shouldProjectDocumentViewportScroll, type IDocumentOpenSurfaceRenderFence, type IDocumentOpenSurfaceRenderOwner, type IDocumentOpenSurfaceSession, type IDocumentOpenSurfaceSnapshot, type TDocumentOpenSurfacePhase, type TDocumentViewportVisualOwner,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
export {
    createAnchorPageWindow, createLazyIndexedCollection, isLazyIndexedCollection, type ILazyIndexedCollection,
} from '@app/modules/document-viewer/virtualization/pageVirtualization';
export { createDjvuPageSource } from '@app/modules/document-viewer/source/createDjvuPageSource';
export { createDocumentOpenGenerationErrorLatch } from '@app/modules/document-viewer/runtime/createDocumentOpenGenerationErrorLatch';
export {
    createDocumentOpeningPageFrame, resolveDocumentOpeningPageMargin, resolveDocumentOpeningPageShellId, type IDocumentOpeningPageFrame,
} from '@app/modules/document-viewer/runtime/documentOpeningPageFrame';
export { createDocumentPageSourceSearchBackend } from '@app/modules/document-viewer/search/createDocumentPageSourceSearchBackend';
export {
    createDocumentProjectionSession, ensurePdfProjection, type IDocumentProjectionSession, type TPdfProjectionReason,
} from '@app/modules/document-viewer/session/documentProjectionSession';
export {
    createDocumentSinglePageRange, doDocumentPageRangesIntersect, normalizeDocumentPageRange, type IDocumentPageRange,
} from '@app/modules/document-viewer/documentPageRange';
export { createDocumentThumbnailResizeAnchorLifecycle } from '@app/modules/document-viewer/thumbnails/createDocumentThumbnailResizeAnchorLifecycle';
export { createDocumentThumbnailScrollRestorer } from '@app/modules/document-viewer/thumbnails/createDocumentThumbnailScrollRestorer';
export {
    createDocumentTransitionChannel, type IDocumentTransition,
} from '@app/modules/document-viewer/lifecycle/createDocumentTransitionChannel';
export { createDocumentViewerActivationRunGuard } from '@app/modules/document-viewer/lifecycle/createDocumentViewerActivationRunGuard';
export {
    createDocumentViewerRuntime, documentViewerRuntimeKey, injectDocumentViewerRuntime, shouldAcceptFeaturePackRuntimePage, type IDocumentViewerRuntime,
} from '@app/modules/document-viewer/runtime/documentViewerRuntime';
export type {
    IDocumentViewportFlingBackdrop, IDocumentViewportFlingBackdropPage,
} from '@app/modules/document-viewer/runtime/documentViewportFlingBackdrop';
export {
    createDocumentViewportNavigationMachineState, type IDocumentViewportNavigationState,
} from '@app/modules/document-viewer/viewport/createDocumentViewportNavigationMachineState';
export {
    clearDocumentViewportPaneRelocationScrollFence, consumeDocumentViewportPaneRelocationScrollFence, createDocumentViewportWritePort, fenceDocumentViewportPaneRelocationScroll, observeDocumentViewportWheelInteraction, type IDocumentViewportWrite, type IDocumentViewportWritePort,
} from '@app/modules/document-viewer/runtime/documentViewportWritePort';
export {
    createDocumentWheelZoomHandler, DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS, resolveDocumentWheelInteraction, resolveDocumentWheelZoomTarget, type IDocumentWheelInteraction, type IDocumentWheelSourceEvent,
} from '@app/modules/document-viewer/input/documentWheelInteraction';
export {
    createDocumentPageSlotRegistry, type IDocumentPageSlotOwner, type IDocumentPageSlotRegistry,
} from '@app/modules/document-viewer/page-slots/createDocumentPageSlotRegistry';
export { createPdfPageSource } from '@app/modules/document-viewer/source/createPdfPageSource';
export { createWheelFlipGate } from '@app/modules/document-viewer/single-page-wheel/createWheelFlipGate';
export {
    DEFAULT_DOCUMENT_SEARCH_OPTIONS, type IDocumentSearchMatch,
} from '@app/modules/document-viewer/providers/documentSearch';
export {
    DEFAULT_DOCUMENT_THUMBNAIL_ITEM_CHROME_HEIGHT, DocumentThumbnailLayout, type IDocumentThumbnailLayoutAnchor, type IDocumentThumbnailScrollSegmentTransition,
} from '@app/modules/document-viewer/thumbnails/documentThumbnailLayout';
export { DOCUMENT_PAGE_GUTTER_PX } from '@app/modules/document-viewer/layout/documentPageGutterPx';
export {
    DOCUMENT_THUMBNAIL_AUTO_FOLLOW_COOLDOWN_MS, DOCUMENT_THUMBNAIL_PROGRAMMATIC_SCROLL_GUARD_MS, getDocumentThumbnailComfortPadding, isDocumentThumbnailWithinComfortViewport, resolveDocumentThumbnailRevealScrollTop, type IDocumentThumbnailPageBounds, type IDocumentThumbnailViewport,
} from '@app/modules/document-viewer/thumbnails/documentThumbnailViewport';
export { formatDocumentSearchResultsSummary } from '@app/modules/document-viewer/providers/formatDocumentSearchResultsSummary';
export {
    getDocumentBookmarkVisibleRows, isDocumentBookmarkExpanded, resolveDocumentBookmarkRevealRowIndex, type IDocumentBookmarkTreeItem, type TDocumentBookmarkDisplayMode, type TDocumentBookmarkPersistenceRefusal, type TDocumentBookmarkStatus,
} from '@app/modules/document-viewer/bookmarks/documentBookmarks';
export {
    type IDocumentPreviewPageState, type IPagePreviewOutlineItem, type IPagePreviewRenderedObjectUrl, type IPagePreviewSource,
} from '@app/modules/document-viewer/pagePreviewSource';
export { getRectHeight } from '@app/modules/document-viewer/region-geometry/getRectHeight';
export { getRectWidth } from '@app/modules/document-viewer/region-geometry/getRectWidth';
export {
    type IClientPoint, type IClientRect, type ILocalRect, type IOverlayRect,
} from '@app/modules/document-viewer/region-geometry/regionGeometryTypes';
export {
    resolveDocumentPageDisplayLayouts, resolveDocumentPageDisplayScale, type IDocumentPageDisplayLayout,
} from '@app/modules/document-viewer/layout/resolveDocumentPageDisplayLayout';
export {
    type IDocumentPageMetrics, type IDocumentPageRenderRequest, type IDocumentPageSource, type IDocumentSourceCapabilities, type IDocumentRenderLease, type TDocumentPageSourceKind, type TDocumentRenderPriority,
} from '@app/modules/document-viewer/source/documentPageSource';
export {
    resolveDocumentRasterResidencyPlan, type IDocumentRasterResidencyPlan,
} from '@app/modules/document-viewer/rendering/resolveDocumentRasterResidencyPlan';
export {
    type IDocumentSearchBackend, type IDocumentSearchProgress, type IDocumentSearchSession, type TDocumentSearchDirection,
} from '@app/modules/document-viewer/search/documentSearch';
export { type IDocumentThumbnailListEmits } from '@app/modules/document-viewer/thumbnails/documentThumbnailListEmits';
export { type IDocumentViewerRenderSession } from '@app/modules/document-viewer/runtime/createDocumentViewerRenderCoordinator';
export {
    type IDocumentViewportDocumentRef, type IDocumentViewportRenderRequest, type IDocumentViewportTransactionAdvanceEvent, type IDocumentViewportTransactionBase, type IDocumentViewportTransactionBeginEvent, type IDocumentViewportTransactionCancelEvent, type IDocumentViewportTransactionCancellation, type IDocumentViewportTransactionConsumeFitRenderHandoffEvent, type IDocumentViewportTransactionMachineState, type TDocumentViewportTransactionState,
} from '@app/modules/document-viewer/viewport/documentViewportTransactionTypes';
export { type IDocumentViewportSessionState } from '@app/modules/document-viewer/runtime/documentOpenSurfaceReducer';
export {
    captureDocumentZoomAnchor,
    resolveDocumentZoomAnchorScroll,
    type IDocumentZoomAnchor,
    type IDocumentZoomPageLayout,
} from '@app/modules/document-viewer/zoomAnchor';
export { intersectClientRects } from '@app/modules/document-viewer/region-geometry/intersectClientRects';
export {
    normalizeMemoryPressureLevel, resolveInactiveViewerResidencyState, resolvePostReclaimResidencyState, selectViewerReclaimCandidates, shouldReclaimViewerResidencyState, type IRuntimeMemoryPressureSignal, type IViewerReclaimCandidate, type TMemoryPressureLevel, type TViewerResidencyState,
} from '@app/utils/viewerResidencyPolicy';
export type {
    IWorkspaceSurfaceBudgetController, IWorkspaceSurfaceLease, 
} from '@app/modules/workspace-shell/public/workspaceSurfaceBudget';
export { normalizeClientRect } from '@app/modules/document-viewer/region-geometry/normalizeClientRect';
export {
    reconcileDocumentSidebarTab, type TDocumentSidebarTab,
} from '@app/modules/document-viewer/sidebar/documentSidebarTabs';
export { resolveBoundedRasterDimensions } from '@app/modules/document-viewer/resolveBoundedRasterDimensions';
export { resolveDjvuPageSizeInPoints } from '@app/modules/document-viewer/source/resolveDjvuPageSizeInPoints';
export {
    resolveDocumentContinuousScrollWindow, resolveNearestDocumentPageToViewportCenter,
} from '@app/modules/document-viewer/viewport/resolveDocumentContinuousScrollWindow';
export { resolveDocumentPageSourceOpeningFrame } from '@app/modules/document-viewer/layout/resolveDocumentPageSourceOpeningFrame';
export { resolveVirtualRowRevealScrollTop } from '@app/modules/document-viewer/virtualization/resolveVirtualRowRevealScrollTop';
export {
    runDocumentViewerActivationPresentation, waitForDocumentViewerVisibleLayout,
} from '@app/modules/document-viewer/lifecycle/documentViewerActivationPresentation';
export { toClientRect } from '@app/modules/document-viewer/region-geometry/toClientRect';
export { toLocalRect } from '@app/modules/document-viewer/region-geometry/toLocalRect';
export { type TPageSnapAnchor } from '@app/modules/document-viewer/single-page-wheel/singlePageWheelTypes';
export { unionClientRects } from '@app/modules/document-viewer/region-geometry/unionClientRects';
export { useDocumentBookmarkSession } from '@app/modules/document-viewer/bookmarks/useDocumentBookmarkSession';
export { useDocumentSidebarCapabilitySession } from '@app/modules/document-viewer/sidebar/useDocumentSidebarCapabilitySession';
export { useDocumentThumbnailController } from '@app/modules/document-viewer/thumbnails/useDocumentThumbnailController';
export { useDocumentViewportLayoutLifecycle } from '@app/modules/document-viewer/lifecycle/useDocumentViewportLayoutLifecycle';
export { useDocumentWheelZoomSessionBoundaries } from '@app/modules/document-viewer/input/useDocumentWheelZoomSessionBoundaries';
