import {
    ref,
    shallowRef,
} from 'vue';
import * as pdfjsLib from 'pdfjs-dist';
import type {
    PDFDataRangeTransport,
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import { getElectronAPI } from '@app/utils/electron';
import type { TPdfSource } from '@app/types/pdf';
import { BrowserLogger } from '@app/utils/browser-logger';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.min.mjs';

type TPdfDataRangeTransportCtor = new (length: number, initialData: Uint8Array) => PDFDataRangeTransport;
type TPdfDataRangeTransport = PDFDataRangeTransport & { onError?: (error: unknown) => void };

export const usePdfDocument = () => {
    const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
    const numPages = ref(0);
    const isLoading = ref(false);
    const basePageWidth = ref<number | null>(null);
    const basePageHeight = ref<number | null>(null);

    let renderVersion = 0;
    const pdfPageCache = new Map<number, PDFPageProxy>();
    let objectUrl: string | null = null;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    let rangeTransport: TPdfDataRangeTransport | null = null;

    function getRenderVersion() {
        return renderVersion;
    }

    function incrementRenderVersion() {
        return ++renderVersion;
    }

    async function loadPdf(src: TPdfSource, options?: { preservePageStructure?: boolean }) {
        const savedNumPages = options?.preservePageStructure ? numPages.value : 0;
        const savedBaseWidth = options?.preservePageStructure ? basePageWidth.value : null;
        const savedBaseHeight = options?.preservePageStructure ? basePageHeight.value : null;

        // Cancel any in-progress load - latest wins
        cleanup();

        if (options?.preservePageStructure) {
            numPages.value = savedNumPages;
            basePageWidth.value = savedBaseWidth;
            basePageHeight.value = savedBaseHeight;
        }

        const version = incrementRenderVersion();
        isLoading.value = true;
        if (!options?.preservePageStructure) {
            basePageWidth.value = null;
            basePageHeight.value = null;
        }

        if (src instanceof Blob) {
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
        } else {
            // Large PDFs: avoid reading the full file into renderer memory. Use range reads via IPC.
            const api = getElectronAPI();
            const length = src.size;

            const initialLen = Math.min(1024 * 1024, length);
            const initialData = await api.readFileRange(src.path, 0, initialLen);

            const TransportCtor = (pdfjsLib as typeof pdfjsLib & { PDFDataRangeTransport?: TPdfDataRangeTransportCtor }).PDFDataRangeTransport;
            if (!TransportCtor) {
                throw new Error('PDF.js range transport API is unavailable');
            }
            rangeTransport = new TransportCtor(length, initialData) as TPdfDataRangeTransport;
            const activeRangeTransport = rangeTransport;

            // PDF.js will call this to request additional chunks.
            activeRangeTransport.requestDataRange = async (begin: number, end: number) => {
                try {
                    // Drop stale reads if a newer load has started.
                    if (version !== renderVersion) {
                        return;
                    }
                    const chunk = await api.readFileRange(src.path, begin, end - begin);
                    activeRangeTransport.onDataRange(begin, chunk);
                } catch (error) {
                    // Best-effort: surface the error to PDF.js if supported.
                    try {
                        activeRangeTransport.onError?.(error);
                    } catch (forwardError) {
                        BrowserLogger.debug('pdf-document', 'Failed to forward range read error to PDF.js', forwardError);
                    }
                }
            };

            loadingTask = pdfjsLib.getDocument({
                range: activeRangeTransport,
                length,
                rangeChunkSize: 1024 * 1024,
                verbosity: pdfjsLib.VerbosityLevel.ERRORS,
                standardFontDataUrl: '/pdf/standard_fonts/',
                cMapUrl: '/pdf/cmaps/',
                cMapPacked: true,
                wasmUrl: '/pdf/wasm/',
                iccUrl: '/pdf/iccs/',
                useSystemFonts: false,
            });
        }

        try {
            const pdfDoc = await loadingTask.promise;

            // Discard stale result if a newer load was started
            if (version !== renderVersion) {
                pdfDoc.destroy();
                return null;
            }

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
            // Ignore cancellation errors from destroyed loading tasks
            if (version !== renderVersion) {
                return null;
            }
            BrowserLogger.error('pdf-document', 'Failed to load PDF', error);
            return null;
        } finally {
            // Only clear loading state if this is still the current load
            if (version === renderVersion) {
                isLoading.value = false;
            }
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
        if (rangeTransport) {
            try {
                rangeTransport.abort();
            } catch (error) {
                BrowserLogger.debug('pdf-document', 'Failed to abort PDF range transport', error);
            } finally {
                rangeTransport = null;
            }
        }

        if (loadingTask) {
            try {
                void loadingTask.destroy();
            } catch (error) {
                BrowserLogger.error('pdf-document', 'Failed to destroy PDF loading task', error);
            } finally {
                loadingTask = null;
            }
        }

        if (pdfDocument.value) {
            try {
                pdfDocument.value.destroy();
            } catch (error) {
                BrowserLogger.error('pdf-document', 'Failed to destroy PDF document', error);
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
