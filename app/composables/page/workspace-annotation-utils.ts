import type {
    ShallowRef,
    Ref,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IShapeAnnotation } from '@app/types/annotations';
import { BrowserLogger } from '@app/utils/browser-logger';

interface IWorkspacePdfViewerForAnnotationUtils {
    saveDocument: () => Promise<Uint8Array | null>;
    hasShapes?: { value: boolean };
    getAllShapes: () => IShapeAnnotation[];
}

interface ISerializeEmbeddedFallbackDeps {
    pdfViewerRef: Ref<IWorkspacePdfViewerForAnnotationUtils | null>;
    currentPage: Ref<number>;
    workingCopyPath: Ref<string | null>;
    waitForPdfReload: (page: number) => Promise<void>;
    loadPdfFromData: (
        data: Uint8Array,
        opts?: {
            pushHistory?: boolean;
            persistWorkingCopy?: boolean;
        },
    ) => Promise<void>;
}

interface IHasAnnotationChangesDeps {
    pdfViewerRef: Ref<IWorkspacePdfViewerForAnnotationUtils | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
}

export function createSerializeCurrentPdfForEmbeddedFallback(deps: ISerializeEmbeddedFallbackDeps) {
    return async function serializeCurrentPdfForEmbeddedFallback() {
        if (!deps.pdfViewerRef.value) {
            return false;
        }

        const rawData = await deps.pdfViewerRef.value.saveDocument();
        if (!rawData) {
            return false;
        }

        const pageToRestore = deps.currentPage.value;
        const restorePromise = deps.waitForPdfReload(pageToRestore);
        await deps.loadPdfFromData(rawData, {
            pushHistory: true,
            persistWorkingCopy: !!deps.workingCopyPath.value,
        });
        await restorePromise;
        return true;
    };
}

export function hasAnnotationChanges(deps: IHasAnnotationChangesDeps) {
    if (deps.pdfViewerRef.value?.hasShapes?.value) {
        return true;
    }

    const document = deps.pdfDocument.value;
    if (!document) {
        return false;
    }

    try {
        const storage = document.annotationStorage;
        if (!storage) {
            return false;
        }

        // PDF.js keeps modified annotation IDs in an internal set-like structure.
        const modifiedIds = storage.modifiedIds?.ids;
        if (modifiedIds && typeof modifiedIds.size === 'number') {
            return modifiedIds.size > 0;
        }

        return false;
    } catch (error) {
        BrowserLogger.debug('workspace', 'Failed to inspect annotation storage dirty state', error);
        return false;
    }
}
