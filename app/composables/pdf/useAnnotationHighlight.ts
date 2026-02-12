import type {AnnotationEditorUIManager} from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/pdfAnnotationUtils';
import type { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import type { useAnnotationMarkupSubtype } from '@app/composables/pdf/useAnnotationMarkupSubtype';
import type { useAnnotationCommentSync } from '@app/composables/pdf/useAnnotationCommentSync';
import type { useAnnotationToolManager } from '@app/composables/pdf/useAnnotationToolManager';
import { useSelectionHighlight } from '@app/composables/pdf/useSelectionHighlight';
import { useAnnotationNotePlacement } from '@app/composables/pdf/useAnnotationNotePlacement';

type TIdentity = ReturnType<typeof useAnnotationCommentIdentity>;
type TMarkupSubtypeComposable = ReturnType<typeof useAnnotationMarkupSubtype>;
type TCommentSync = ReturnType<typeof useAnnotationCommentSync>;
type TToolManager = ReturnType<typeof useAnnotationToolManager>;

interface IUseAnnotationHighlightOptions {
    viewerContainer: Ref<HTMLElement | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    annotationTool: Ref<TAnnotationTool>;
    identity: TIdentity;
    markupSubtype: TMarkupSubtypeComposable;
    commentSync: TCommentSync;
    toolManager: TToolManager;
    stopDrag: () => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationNotePlacementChange: (active: boolean) => void;
}

export function useAnnotationHighlight(options: IUseAnnotationHighlightOptions) {
    const {
        viewerContainer,
        annotationUiManager,
        currentPage,
        annotationTool,
        identity,
        markupSubtype,
        commentSync,
        toolManager,
        stopDrag,
        emitAnnotationOpenNote,
        emitAnnotationNotePlacementChange,
    } = options;

    const notePlacement = useAnnotationNotePlacement({
        viewerContainer,
        annotationUiManager,
        currentPage,
        identity,
        commentSync,
        toolManager,
        emitAnnotationOpenNote,
        emitAnnotationNotePlacementChange,
        highlightSelectionInternal: (withComment, explicitRange) =>
            selectionHighlight.highlightSelectionInternal(withComment, explicitRange),
    });

    const selectionHighlight = useSelectionHighlight({
        viewerContainer,
        annotationUiManager,
        currentPage,
        annotationTool,
        identity,
        markupSubtype,
        commentSync,
        toolManager,
        emitAnnotationOpenNote,
        isPlacingComment: notePlacement.isPlacingComment,
    });

    function handleViewerMouseUp() {
        stopDrag();
    }

    function handleDocumentPointerUp(event: PointerEvent) {
        if (event.button !== 0) {
            return;
        }
        void selectionHighlight.maybeApplySelectionMarkup();
    }

    function buildAnnotationContextMenuPayload(
        comment: IAnnotationCommentSummary | null,
        clientX: number,
        clientY: number,
    ): IAnnotationContextMenuPayload {
        const target = notePlacement.resolvePagePointTarget(clientX, clientY);
        return {
            comment,
            clientX,
            clientY,
            hasSelection: Boolean(selectionHighlight.getSelectionRangeForCommentAction()),
            pageNumber: target?.pageNumber ?? null,
            pageX: target?.pageX ?? null,
            pageY: target?.pageY ?? null,
        };
    }

    return {
        isPlacingComment: notePlacement.isPlacingComment,
        highlightSelection: selectionHighlight.highlightSelection,
        commentSelection: selectionHighlight.commentSelection,
        commentAtPoint: notePlacement.commentAtPoint,
        placeCommentAtClientPoint: notePlacement.placeCommentAtClientPoint,
        startCommentPlacement: notePlacement.startCommentPlacement,
        cancelCommentPlacement: notePlacement.cancelCommentPlacement,
        handleViewerMouseUp,
        handleDocumentPointerUp,
        cacheCurrentTextSelection: selectionHighlight.cacheCurrentTextSelection,
        maybeApplySelectionMarkup: selectionHighlight.maybeApplySelectionMarkup,
        buildAnnotationContextMenuPayload,
        resolvePagePointTarget: notePlacement.resolvePagePointTarget,
        findPageContainerFromClientPoint: notePlacement.findPageContainerFromClientPoint,
        clearSelectionCache: selectionHighlight.clearSelectionCache,
    };
}
