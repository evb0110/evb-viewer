import {
    computed,
    type Ref,
    type ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdf';
import { usePdfSerialization } from '@app/composables/pdf/usePdfSerialization';
import { rewriteBookmarks } from '@app/composables/pdf/usePdfBookmarkSerialization';
import { useFileOperations } from '@app/composables/useFileOperations';

interface IPdfViewerForSave {
    saveDocument: () => Promise<Uint8Array | null>;
    getMarkupSubtypeOverrides: () => Map<string, TMarkupSubtype> | undefined;
    getAllShapes: () => IShapeAnnotation[];
}

interface IOcrPopupForSave {
    exportDocx: () => Promise<boolean>;
    open: () => void;
    isExporting: { value: boolean };
}

export interface IPageSaveOrchestrationDeps {
    pdfData: Ref<Uint8Array | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    pdfViewerRef: Ref<IPdfViewerForSave | null>;
    ocrPopupRef: Ref<IOcrPopupForSave | null>;
    workingCopyPath: Ref<string | null>;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    totalPages: Ref<number>;
    pageLabelsDirty: Ref<boolean>;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    bookmarksDirty: Ref<boolean>;
    bookmarkItems: Ref<IPdfBookmarkEntry[]>;
    isSaving: Ref<boolean>;
    isSavingAs: Ref<boolean>;
    annotationDirty: Ref<boolean>;
    annotationNoteWindowsCount: Ref<number>;
    hasAnnotationChanges: () => boolean;
    markAnnotationSaved: () => void;
    markPageLabelsSaved: () => void;
    markBookmarksSaved: () => void;
    isDirty: Ref<boolean>;
    saveFile: (data: Uint8Array) => Promise<boolean>;
    saveWorkingCopy: () => Promise<boolean>;
    saveWorkingCopyAs: (data?: Uint8Array) => Promise<string | null>;
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    loadRecentFiles: () => void;
    clearOcrCache: (path: string) => void;
    loadPdfFromData: (data: Uint8Array, opts?: {
        pushHistory?: boolean;
        persistWorkingCopy?: boolean;
    }) => Promise<void>;
    currentPage: Ref<number>;
    waitForPdfReload: (page: number) => Promise<void>;
}

export const usePageSaveOrchestration = (deps: IPageSaveOrchestrationDeps) => {
    const { t } = useTypedI18n();

    const {
        pdfData,
        pdfDocument,
        pdfViewerRef,
        ocrPopupRef,
        workingCopyPath,
        annotationComments,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        bookmarksDirty,
        bookmarkItems,
        isSaving,
        isSavingAs,
        annotationDirty,
        annotationNoteWindowsCount,
        hasAnnotationChanges,
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        isDirty,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        persistAllAnnotationNotes,
        loadRecentFiles,
        clearOcrCache,
        loadPdfFromData,
        currentPage,
        waitForPdfReload,
    } = deps;

    const {
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        updateEmbeddedAnnotationByRef: updateEmbeddedByRef,
        deleteEmbeddedAnnotationByRef: deleteEmbeddedByRef,
        rewritePageLabels,
    } = usePdfSerialization({
        pdfData,
        workingCopyPath,
        annotationComments,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        getMarkupSubtypeOverrides: () => pdfViewerRef.value?.getMarkupSubtypeOverrides(),
        getAllShapes: () => pdfViewerRef.value?.getAllShapes() ?? [],
    });

    const {
        handleSave,
        handleSaveAs,
    } = useFileOperations({
        isSaving,
        isSavingAs,
        workingCopyPath,
        annotationDirty,
        pageLabelsDirty,
        bookmarksDirty,
        pdfDocument,
        saveDocument: () => pdfViewerRef.value?.saveDocument() ?? Promise.resolve(null),
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        hasAnnotationChanges,
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        rewritePageLabels,
        rewriteBookmarks: (data) => rewriteBookmarks(data, {
            bookmarksDirty,
            bookmarkItems,
            totalPages,
            untitledLabel: t('bookmarks.untitled'),
        }),
        persistAllAnnotationNotes,
        annotationNoteWindowsCount,
        loadRecentFiles,
    });

    const isAnySaving = computed(() => isSaving.value || isSavingAs.value);
    const isExportingDocx = computed(() => ocrPopupRef.value?.isExporting?.value ?? false);
    const canSave = computed(() => isDirty.value || annotationDirty.value || pageLabelsDirty.value || bookmarksDirty.value);

    async function handleExportDocx() {
        if (!ocrPopupRef.value) {
            return;
        }
        const result = await ocrPopupRef.value.exportDocx();
        if (result === false) {
            ocrPopupRef.value.open();
        }
    }

    async function handleOcrComplete(ocrPdfData: Uint8Array) {
        const pageToRestore = currentPage.value;

        if (workingCopyPath.value) {
            clearOcrCache(workingCopyPath.value);
        }

        const restorePromise = waitForPdfReload(pageToRestore);

        await loadPdfFromData(ocrPdfData, {
            pushHistory: true,
            persistWorkingCopy: !!workingCopyPath.value,
        });

        await restorePromise;
    }

    return {
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        updateEmbeddedByRef,
        deleteEmbeddedByRef,
        rewritePageLabels,
        handleSave,
        handleSaveAs,
        handleExportDocx,
        handleOcrComplete,
        isAnySaving,
        isExportingDocx,
        canSave,
    };
};
