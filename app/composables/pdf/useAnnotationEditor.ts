import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
    ComputedRef,
} from 'vue';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type { PDFDocumentProxy } from '@app/types/pdf';
import { useFreeTextResize } from '@app/composables/pdf/useFreeTextResize';
import { useAnnotationMarkupSubtype } from '@app/composables/pdf/useAnnotationMarkupSubtype';
import { useAnnotationToolManager } from '@app/composables/pdf/useAnnotationToolManager';
import { useAnnotationEditorLifecycle } from '@app/composables/pdf/useAnnotationEditorLifecycle';
import type { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import type { useAnnotationCommentSync } from '@app/composables/pdf/useAnnotationCommentSync';

type TIdentity = ReturnType<typeof useAnnotationCommentIdentity>;
type TCommentSync = ReturnType<typeof useAnnotationCommentSync>;

interface IUseAnnotationEditorOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    effectiveScale: Ref<number>;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationCursorMode: ComputedRef<boolean>;
    annotationKeepActive: ComputedRef<boolean>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationL10n: ShallowRef<GenericL10n | null>;
    identity: TIdentity;
    getCommentSync: () => TCommentSync;
    emitAnnotationModified: () => void;
    emitAnnotationState: (state: IAnnotationEditorState) => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationToolAutoReset: () => void;
    emitAnnotationSetting: (payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings]
    }) => void;
}

export const useAnnotationEditor = (options: IUseAnnotationEditorOptions) => {
    const {
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
        getCommentSync,
        emitAnnotationModified,
        emitAnnotationState,
        emitAnnotationOpenNote,
        emitAnnotationToolAutoReset,
        emitAnnotationSetting,
    } = options;

    const markupSubtype = useAnnotationMarkupSubtype({
        annotationUiManager,
        annotationSettings,
        numPages,
        getEditorIdentity: identity.getEditorIdentity,
    });

    const lazyCommentSync = new Proxy({} as TCommentSync, {get(_target, prop, receiver) {
        return Reflect.get(getCommentSync(), prop, receiver);
    }});

    const freeTextResize = useFreeTextResize({
        getAnnotationUiManager: () => annotationUiManager.value,
        getNumPages: () => numPages.value,
        emitAnnotationModified,
        emitAnnotationSetting,
        scheduleAnnotationCommentsSync: () => getCommentSync().scheduleAnnotationCommentsSync(),
    });

    const toolManager = useAnnotationToolManager({
        annotationUiManager,
        currentPage,
        annotationTool,
        annotationCursorMode,
        annotationKeepActive,
        freeTextResize,
        markupSubtype,
        emitAnnotationToolAutoReset,
    });

    const lifecycle = useAnnotationEditorLifecycle({
        viewerContainer,
        pdfDocument,
        numPages,
        currentPage,
        effectiveScale,
        annotationTool,
        annotationUiManager,
        annotationL10n,
        freeTextResize,
        markupSubtype,
        commentSync: lazyCommentSync,
        toolManager,
        identity,
        emitAnnotationModified,
        emitAnnotationState,
        emitAnnotationOpenNote,
    });

    return {
        markupSubtype,
        freeTextResize,
        toolManager,
        lifecycle,
        initAnnotationEditor: lifecycle.initAnnotationEditor,
        destroyAnnotationEditor: lifecycle.destroyAnnotationEditor,
        setAnnotationTool: toolManager.setAnnotationTool,
        applyAnnotationSettings: toolManager.applyAnnotationSettings,
        updateModeWithRetry: toolManager.updateModeWithRetry,
        getMarkupSubtypeOverrides: markupSubtype.getMarkupSubtypeOverrides,
        ensureFreeTextEditorCanResize: freeTextResize.ensureFreeTextEditorCanResize,
    };
};
