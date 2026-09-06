import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { IAnnotationContextMenuPayload } from '@app/modules/pdf-viewer/engine/annotationContextMenuPayload';
import type { IAnnotationCreationFailureReport } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationInventoryCompleteness,
    IAnnotationModifiedPayload,
    IAnnotationSettings,
    TAnnotationSettingChange,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdfImagePlacement';
import type {
    TFitMode,
    TPdfViewRotation,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    TPdfSource,
} from '@app/types/pdfUi';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfRasterDisplayProfile } from '@app/types/pdfRasterDisplayProfile';
import type { IPdfPageRasterScheduler } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import type { IAnnotationEnrichmentState } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';

export interface IPdfViewerProps {
    src: TPdfSource | null;
    reloadSrc?: TPdfSource | null | undefined;
    sourcePdfData?: Uint8Array | null | undefined;
    rasterDisplayProfile?: TPdfRasterDisplayProfile | null | undefined;
    suppressLoadingOverlay?: boolean | undefined;
    bufferPages?: number | undefined;
    isAnySaving?: boolean | undefined;
    zoom?: number | undefined;
    zoomMode?: TZoomMode | undefined;
    dragMode?: boolean | undefined;
    fitMode?: TFitMode | undefined;
    viewMode?: TPdfViewMode | undefined;
    viewRotation?: TPdfViewRotation | undefined;
    continuousScroll?: boolean | undefined;
    isActive?: boolean | undefined;
    /** Keep the document session alive without mounting the reader presentation. */
    mountPresentation?: boolean | undefined;
    isResizing?: boolean | undefined;
    invertColors?: boolean | undefined;
    showAnnotations?: boolean | undefined;
    annotationTool?: TAnnotationTool | undefined;
    annotationCursorMode?: boolean | undefined;
    annotationKeepActive?: boolean | undefined;
    annotationSettings?: IAnnotationSettings | null | undefined;
    searchPageMatches?: Map<number, IPdfPageMatches> | undefined;
    currentSearchMatch?: IPdfSearchMatch | null | undefined;
    currentSearchMatchNavigationId?: number | undefined;
    currentPage?: number | undefined;
    workingCopyPath?: string | null | undefined;
    originalPath?: string | null | undefined;
    documentRevisionToken?: TDocumentRevisionToken | null | undefined;
    authorName?: string | null | undefined;
    /**
     * Completes a pending stamp through the owning document session.
     *
     * This command stays here until #193 removes the legacy workspace stamp
     * persistence route. It is deliberately a prop rather than a viewer
     * event so the editor layer remains the only caller-facing owner.
     */
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    finalizeImagePlacement?: ((payload: IPdfPlacedImageFinalizePayload) => void | Promise<boolean>) | undefined;
}

export interface IPdfViewerEmit {
    (e: 'update:zoom', value: number): void;
    (e: 'update:zoomMode', mode: TZoomMode): void;
    (e: 'update:fitMode', mode: TFitMode): void;
    (e: 'update:effectiveZoom', value: number): void;
    (e: 'update:currentPage', page: number): void;
    (e: 'update:navigationFeedbackPage', page: number | null): void;
    (e: 'update:totalPages', total: number): void;
    (e: 'update:loading', loading: boolean): void;
    (e: 'update:document', document: IPdfDocument | null): void;
    (e: 'update:rasterScheduler', scheduler: IPdfPageRasterScheduler | null): void;
    (e: 'loading', loading: boolean): void;
    (e: 'load-error', error: unknown): void;
    (e: 'annotation-state', state: IAnnotationEditorState): void;
    (e: 'annotation-modified', payload?: IAnnotationModifiedPayload): void;
    (e: 'annotation-comments', comments: IAnnotationCommentSummary[]): void;
    (e: 'annotation-inventory', completeness: IAnnotationInventoryCompleteness | null): void;
    (e: 'annotation-enrichment-state', state: IAnnotationEnrichmentState): void;
    (e: 'annotation-open-note', comment: IAnnotationCommentSummary): void;
    (e: 'annotation-context-menu', payload: IAnnotationContextMenuPayload): void;
    (e: 'annotation-tool-auto-reset'): void;
    (e: 'annotation-setting', payload: TAnnotationSettingChange): void;
    (e: 'annotation-comment-click', comment: IAnnotationCommentSummary): void;
    (e: 'annotation-tool-cancel'): void;
    (e: 'annotation-failure', failure: IAnnotationCreationFailureReport): void;
    (e: 'shape-context-menu', payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }): void;
    (e: 'initial-visual-pending'): void;
    (e: 'initial-visual-ready', payload: {pageNumber: number;}): void;
}
