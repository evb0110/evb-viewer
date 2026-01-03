import { ref } from 'vue';
import * as pdfjsLib from 'pdfjs-dist';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.min.mjs';

export const usePdfDocument = () => {
    const pdfDocument = ref<PDFDocumentProxy | null>(null);
    const numPages = ref(0);
    const isLoading = ref(false);
    const basePageWidth = ref<number | null>(null);
    const basePageHeight = ref<number | null>(null);

    let renderVersion = 0;
    let isLoadingPdf = false;
    const pdfPageCache = new Map<number, PDFPageProxy>();

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

        const loadingTask = pdfjsLib.getDocument({
            url: URL.createObjectURL(src),
            standardFontDataUrl: '/pdf/standard_fonts/',
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

    function cleanupPageCache() {
        for (const [
            , page,
        ] of pdfPageCache) {
            page.cleanup();
        }
        pdfPageCache.clear();
    }

    function cleanup() {
        cleanupPageCache();

        if (pdfDocument.value) {
            try {
                pdfDocument.value.destroy();
            } catch (error) {
                console.error('Failed to destroy PDF document:', error);
            }
            pdfDocument.value = null;
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
        cleanupPageCache,
        cleanup,
    };
};
