import {
    ref,
    shallowRef,
} from 'vue';
import * as pdfjsLib from 'pdfjs-dist';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.min.mjs';

export const usePdfDocument = () => {
    const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
    const numPages = ref(0);
    const isLoading = ref(false);
    const basePageWidth = ref<number | null>(null);
    const basePageHeight = ref<number | null>(null);

    let renderVersion = 0;
    let isLoadingPdf = false;
    const pdfPageCache = new Map<number, PDFPageProxy>();
    let objectUrl: string | null = null;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;

    function getRenderVersion() {
        return renderVersion;
    }

    function incrementRenderVersion() {
        return ++renderVersion;
    }

    async function loadPdf(src: Blob) {
        if (isLoadingPdf) {
            return null;
        }

        isLoadingPdf = true;
        const version = incrementRenderVersion();
        isLoading.value = true;
        basePageWidth.value = null;
        basePageHeight.value = null;

        cleanup();

        objectUrl = URL.createObjectURL(src);
        loadingTask = pdfjsLib.getDocument({
            url: objectUrl,
            verbosity: pdfjsLib.VerbosityLevel.ERRORS,
            standardFontDataUrl: '/pdf/standard_fonts/',
            cMapUrl: '/pdf/cmaps/',
            cMapPacked: true,
            wasmUrl: '/pdf/wasm/',
            iccUrl: '/pdf/iccs/',
            useSystemFonts: false,
        });

        try {
            const pdfDoc = await loadingTask.promise;
            pdfDocument.value = pdfDoc;
            numPages.value = pdfDoc.numPages;

            const firstPage = await pdfDoc.getPage(1);
            const viewport = firstPage.getViewport({ scale: 1 });
            basePageWidth.value = viewport.width;
            basePageHeight.value = viewport.height;

            return {
                version,
                document: pdfDoc, 
            };
        } catch (error) {
            console.error('Failed to load PDF:', error);
            return null;
        } finally {
            isLoading.value = false;
            isLoadingPdf = false;
        }
    }

    async function getPage(pageNumber: number) {
        if (!pdfDocument.value) {
            throw new Error('No PDF document loaded');
        }

        let page = pdfPageCache.get(pageNumber);
        if (!page) {
            page = await pdfDocument.value.getPage(pageNumber);
            pdfPageCache.set(pageNumber, page);
        }
        return page;
    }

    function evictPage(pageNumber: number) {
        const page = pdfPageCache.get(pageNumber);
        if (!page) {
            return;
        }

        page.cleanup();
        pdfPageCache.delete(pageNumber);
    }

    function cleanupPageCache() {
        for (const [
            , page,
        ] of pdfPageCache) {
            page.cleanup();
        }
        pdfPageCache.clear();
    }

    async function saveDocument(): Promise<Uint8Array | null> {
        if (!pdfDocument.value) {
            return null;
        }
        return pdfDocument.value.saveDocument();
    }

    function cleanup() {
        cleanupPageCache();

        if (loadingTask) {
            try {
                void loadingTask.destroy();
            } catch (error) {
                console.error('Failed to destroy PDF loading task:', error);
            } finally {
                loadingTask = null;
            }
        }

        if (pdfDocument.value) {
            try {
                pdfDocument.value.destroy();
            } catch (error) {
                console.error('Failed to destroy PDF document:', error);
            }
            pdfDocument.value = null;
        }

        if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
        }

        numPages.value = 0;
        basePageWidth.value = null;
        basePageHeight.value = null;
    }

    return {
        pdfDocument,
        numPages,
        isLoading,
        basePageWidth,
        basePageHeight,
        getRenderVersion,
        incrementRenderVersion,
        loadPdf,
        getPage,
        evictPage,
        cleanupPageCache,
        saveDocument,
        cleanup,
    };
};
