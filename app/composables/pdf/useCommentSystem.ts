import {
    ref,
    type Ref,
    type ShallowRef,
} from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/pdfAnnotationUtils';
import { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import { useAnnotationCommentSync } from '@app/composables/pdf/useAnnotationCommentSync';
import { useInlineCommentIndicators } from '@app/composables/pdf/useInlineCommentIndicators';
import type { useAnnotationMarkupSubtype } from '@app/composables/pdf/useAnnotationMarkupSubtype';
import type { useAnnotationHighlight } from '@app/composables/pdf/useAnnotationHighlight';

type TMarkupSubtype = ReturnType<typeof useAnnotationMarkupSubtype>;
type THighlight = ReturnType<typeof useAnnotationHighlight>;

interface IUseCommentSystemOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    authorName: Ref<string | null | undefined>;
    markupSubtype: TMarkupSubtype;
    getHighlight: () => THighlight;
    emitAnnotationComments: (comments: IAnnotationCommentSummary[]) => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationContextMenu: (payload: IAnnotationContextMenuPayload) => void;
}

export const useCommentSystem = (options: IUseCommentSystemOptions) => {
    const {
        viewerContainer,
        pdfDocument,
        numPages,
        currentPage,
        annotationUiManager,
        authorName,
        markupSubtype,
        getHighlight,
        emitAnnotationComments,
        emitAnnotationOpenNote,
        emitAnnotationContextMenu,
    } = options;

    const annotationCommentsCache = ref<IAnnotationCommentSummary[]>([]);
    const activeCommentStableKey = ref<string | null>(null);

    const identity = useAnnotationCommentIdentity(annotationCommentsCache);

    const commentSync = useAnnotationCommentSync({
        pdfDocument,
        numPages,
        currentPage,
        annotationUiManager,
        authorName,
        identity,
        markupSubtype,
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
            getHighlight().buildAnnotationContextMenuPayload(comment, clientX, clientY),
    });

    return {
        annotationCommentsCache,
        activeCommentStableKey,
        identity,
        commentSync,
        inlineIndicators,
    };
};
