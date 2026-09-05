import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationInventoryCompleteness,
    IAnnotationModifiedPayload,
    TAnnotationSettingChange,
} from '@app/types/annotations';
import type { IAnnotationContextMenuPayload } from '@app/modules/pdf-viewer/engine/annotationContextMenuPayload';
import type { IAnnotationEnrichmentState } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import type { IAnnotationCreationFailureReport } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import type {
    PDFDocumentProxy,
    TFitMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type { IPdfViewerEmit } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';

export interface IPdfViewerEventAdapter {
    updateZoom(value: number): void;
    updateZoomMode(mode: TZoomMode): void;
    updateFitMode(mode: TFitMode): void;
    updateEffectiveZoom(value: number): void;
    updateCurrentPage(page: number): void;
    updateNavigationFeedbackPage(page: number | null): void;
    updateTotalPages(total: number): void;
    updateLoading(loading: boolean): void;
    updateDocument(document: PDFDocumentProxy | null): void;
    loading(loading: boolean): void;
    loadError(error: unknown): void;
    annotationState(state: IAnnotationEditorState): void;
    annotationModified(payload?: IAnnotationModifiedPayload): void;
    annotationComments(comments: IAnnotationCommentSummary[]): void;
    annotationInventory(completeness: IAnnotationInventoryCompleteness | null): void;
    annotationEnrichmentState(state: IAnnotationEnrichmentState): void;
    annotationOpenNote(comment: IAnnotationCommentSummary): void;
    annotationContextMenu(payload: IAnnotationContextMenuPayload): void;
    annotationToolAutoReset(): void;
    annotationSetting(payload: TAnnotationSettingChange): void;
    annotationCommentClick(comment: IAnnotationCommentSummary): void;
    annotationToolCancel(): void;
    annotationFailure(failure: IAnnotationCreationFailureReport): void;
    shapeContextMenu(payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }): void;
    initialVisualPending(): void;
    initialVisualReady(payload: {pageNumber: number;}): void;
}

export function createPdfViewerEventAdapter(emit: IPdfViewerEmit): IPdfViewerEventAdapter {
    return {
        updateZoom: value => emit('update:zoom', value),
        updateZoomMode: mode => emit('update:zoomMode', mode),
        updateFitMode: mode => emit('update:fitMode', mode),
        updateEffectiveZoom: value => emit('update:effectiveZoom', value),
        updateCurrentPage: page => emit('update:currentPage', page),
        updateNavigationFeedbackPage: page => emit('update:navigationFeedbackPage', page),
        updateTotalPages: total => emit('update:totalPages', total),
        updateLoading: loading => emit('update:loading', loading),
        updateDocument: document => emit('update:document', document),
        loading: loading => emit('loading', loading),
        loadError: error => emit('load-error', error),
        annotationState: state => emit('annotation-state', state),
        annotationModified: payload => emit('annotation-modified', payload),
        annotationComments: comments => emit('annotation-comments', comments),
        annotationInventory: completeness => emit('annotation-inventory', completeness),
        annotationEnrichmentState: state => emit('annotation-enrichment-state', state),
        annotationOpenNote: comment => emit('annotation-open-note', comment),
        annotationContextMenu: payload => emit('annotation-context-menu', payload),
        annotationToolAutoReset: () => emit('annotation-tool-auto-reset'),
        annotationSetting: payload => emit('annotation-setting', payload),
        annotationCommentClick: comment => emit('annotation-comment-click', comment),
        annotationToolCancel: () => emit('annotation-tool-cancel'),
        annotationFailure: failure => emit('annotation-failure', failure),
        shapeContextMenu: payload => emit('shape-context-menu', payload),
        initialVisualPending: () => emit('initial-visual-pending'),
        initialVisualReady: payload => emit('initial-visual-ready', payload),
    };
}
