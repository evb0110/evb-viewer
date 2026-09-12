export type {
    IDocumentViewerExpose,
    IPdfViewerAnnotationCommandExpose,
    IPdfViewerAnnotationCommentExpose,
    IPdfViewerCropExpose,
    IPdfViewerExpose,
    IPdfViewerRegionCaptureExpose,
    IPdfViewerSaveExpose,
    IPdfViewerShapeExpose,
    TAgentTextMarkupKind,
    TPdfSidebarTab,
} from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
export type {
    IAnnotationCreationFailureReport,
    TAnnotationCreationFailureReason,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
export { useBookmarkState } from '@app/modules/pdf-viewer/runtime/composables/pdf/useBookmarkState';
export { useOcrTextContent } from '@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent';
export { usePageContextMenu } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePageContextMenu';
export { usePageLabelState } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePageLabelState';
export { usePageOperations } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePageOperations';
export { usePdfHistory } from '@app/modules/pdf-viewer/runtime/composables/usePdfHistory';
export { usePdfSearch } from '@app/modules/pdf-viewer/runtime/composables/usePdfSearch';
export type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
export {annotationIdForSummary} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
export {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
export type {AnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
export {
    captureCanonicalAnnotationRecovery,
    restoreCanonicalAnnotationRecovery,
    validateCanonicalAnnotationRecovery,
    AnnotationRecoveryAdmissionError,
    CANONICAL_ANNOTATION_RECOVERY_VERSION,
} from '@app/modules/pdf-viewer/annotations/domain/annotationRecovery';
export type {
    IAnnotationRecoveryDraft,
    ICanonicalAnnotationRecovery,
} from '@app/modules/pdf-viewer/annotations/domain/annotationRecovery';
export type {
    INativePdfMutationProjection,
    IPdfSaveByteRouteDecision,
    IPdfViewerNativeRequiredFailure,
    IPdfViewerSaveTransactionDocumentStructure,
    IPdfViewerSaveTransactionNativeCapabilities,
    IPdfViewerSaveTransactionRequest,
    IPdfViewerSaveTransactionResult,
} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';
export { escapeCssAttr } from '@app/modules/pdf-viewer/engine/annotation-css-utils/escapeCssAttr';
export { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
export { isAuthoringAnnotationTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isAuthoringAnnotationTool';
export { isNoteEligibleComment } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isNoteEligibleComment';
export { PENDING_ANNOTATION_ENRICHMENT_STATE } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
export type { IAnnotationEnrichmentState } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
export { markerRectFromPoint } from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/markerRectFromPoint';
export { resolveVisiblePageLabelsDuringMetadataRefresh } from '@app/modules/pdf-viewer/engine/page-labels/resolveVisiblePageLabelsDuringMetadataRefresh';
export { capturePdfRegionAsPngBlob } from '@app/modules/pdf-viewer/engine/pdf-region-capture/capturePdfRegionAsPngBlob';
export { resolvePdfReloadPage } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/resolvePdfReloadPage';
export { createPdfReloadWaiter } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/createPdfReloadWaiter';
export type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/annotation-subtype-hints/pdfSerializationSubtypeHintsTypes';
export { findPdfPageContainer } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/findPdfPageContainer';
export { pdfViewerDomSelectors } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomSelectors';
export { clampPdfManualZoom } from '@app/modules/pdf-viewer/runtime/zoom/resolvePdfZoomScale';
export { readPrevalidatedTrustedPdfOpenGeometry } from '@app/modules/pdf-viewer/public/openGeometry';
export {isPathPdfSource} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfNativePreviewRouting';
export type { IPdfPageRasterScheduler } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
export type { IPdfThumbnailPageGeometry } from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailComponentContract';

export { createPdfSourceDataReader } from '@app/modules/pdf-viewer/runtime/composables/pdf/createPdfSourceDataReader';
