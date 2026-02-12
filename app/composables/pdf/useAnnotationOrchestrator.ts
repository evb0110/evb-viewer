import type {
    Ref,
    ShallowRef,
    ComputedRef,
} from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/pdfAnnotationUtils';
import { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import { useAnnotationCommentSync } from '@app/composables/pdf/useAnnotationCommentSync';
import { useInlineCommentIndicators } from '@app/composables/pdf/useInlineCommentIndicators';
import { useAnnotationHighlight } from '@app/composables/pdf/useAnnotationHighlight';
import { useAnnotationCommentCrud } from '@app/composables/pdf/useAnnotationCommentCrud';
import { useAnnotationEditor } from '@app/composables/pdf/useAnnotationEditor';

interface IUseAnnotationOrchestratorOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    effectiveScale: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number 
    }>;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationCursorMode: ComputedRef<boolean>;
    annotationKeepActive: ComputedRef<boolean>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationL10n: ShallowRef<GenericL10n | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    authorName: Ref<string | null | undefined>;
    stopDrag: () => void;
    scrollToPage: (pageNumber: number) => void;
    renderVisiblePages: (range: {
        start: number;
        end: number 
    }, options?: { preserveRenderedPages?: boolean }) => Promise<void>;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    emitAnnotationModified: () => void;
    emitAnnotationState: (state: IAnnotationEditorState) => void;
    emitAnnotationComments: (comments: IAnnotationCommentSummary[]) => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationContextMenu: (payload: IAnnotationContextMenuPayload) => void;
    emitAnnotationToolAutoReset: () => void;
    emitAnnotationSetting: (payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings] 
    }) => void;
    emitAnnotationCommentClick: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationToolCancel: () => void;
    emitAnnotationNotePlacementChange: (active: boolean) => void;
}

export const useAnnotationOrchestrator = (options: IUseAnnotationOrchestratorOptions) => {
    const {
        viewerContainer,
        pdfDocument,
        numPages,
        currentPage,
        effectiveScale,
        visibleRange,
        annotationTool,
        annotationCursorMode,
        annotationKeepActive,
        annotationSettings,
        annotationUiManager,
        annotationL10n,
        annotationCommentsCache,
        activeCommentStableKey,
        authorName,
        stopDrag,
        scrollToPage,
        renderVisiblePages,
        updateVisibleRange,
        emitAnnotationModified,
        emitAnnotationState,
        emitAnnotationComments,
        emitAnnotationOpenNote,
        emitAnnotationContextMenu,
        emitAnnotationToolAutoReset,
        emitAnnotationSetting,
        emitAnnotationCommentClick,
        emitAnnotationToolCancel,
        emitAnnotationNotePlacementChange,
    } = options;

    const identity = useAnnotationCommentIdentity(annotationCommentsCache);

    const editor = useAnnotationEditor({
        viewerContainer,
        pdfDocument,
        numPages,
        currentPage,
        effectiveScale,
        annotationTool,
        annotationCursorMode,
        annotationKeepActive,
        annotationSettings,
        annotationUiManager,
        annotationL10n,
        identity,
        getCommentSync: () => commentSync,
        emitAnnotationModified,
        emitAnnotationState,
        emitAnnotationOpenNote,
        emitAnnotationToolAutoReset,
        emitAnnotationSetting,
    });

    const commentSync = useAnnotationCommentSync({
        pdfDocument,
        numPages,
        currentPage,
        annotationUiManager,
        authorName,
        identity,
        markupSubtype: editor.markupSubtype,
        annotationCommentsCache,
        activeCommentStableKey,
        emitAnnotationComments,
        syncInlineCommentIndicators: () => inlineIndicators.syncInlineCommentIndicators(),
    });

    const inlineIndicators = useInlineCommentIndicators({
        viewerContainer,
        numPages,
        annotationUiManager,
        annotationCommentsCache,
        activeCommentStableKey,
        setActiveCommentStableKey: (key) => commentSync.setActiveCommentStableKey(key),
        identity,
        commentSync,
        emitAnnotationOpenNote,
        emitAnnotationContextMenu,
        buildAnnotationContextMenuPayload: (comment, clientX, clientY) =>
            highlight.buildAnnotationContextMenuPayload(comment, clientX, clientY),
    });

    const highlight = useAnnotationHighlight({
        viewerContainer,
        annotationUiManager,
        numPages,
        currentPage,
        annotationTool,
        identity,
        markupSubtype: editor.markupSubtype,
        commentSync,
        toolManager: editor.toolManager,
        stopDrag,
        emitAnnotationOpenNote,
        emitAnnotationNotePlacementChange,
    });

    const crud = useAnnotationCommentCrud({
        viewerContainer,
        pdfDocument,
        annotationUiManager,
        numPages,
        currentPage,
        visibleRange,
        annotationTool,
        identity,
        commentSync,
        freeTextResize: editor.freeTextResize,
        toolManager: editor.toolManager,
        inlineIndicators,
        highlight,
        scrollToPage,
        renderVisiblePages,
        updateVisibleRange,
        emitAnnotationModified,
        emitAnnotationOpenNote,
        emitAnnotationCommentClick,
        emitAnnotationContextMenu,
        emitAnnotationToolCancel,
    });

    return {
        identity,
        editor,
        commentSync,
        inlineIndicators,
        highlight,
        crud,
    };
};
