import {
    computed,
    ref,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';

type TOcrPageRange = 'all' | 'current' | 'custom';

interface IOcrLanguage {
    code: string;
    name: string;
    script: 'latin' | 'cyrillic' | 'rtl';
}

interface IOcrSettings {
    pageRange: TOcrPageRange;
    customRange: string;
    selectedLanguages: string[];
}

interface IOcrProgress {
    isRunning: boolean;
    currentPage: number;
    totalPages: number;
    processedCount: number;
}

interface IOcrQualityMetrics {
    totalWords: number;
    avgConfidence: number;
    lowConfidenceWords: number;
    successRate: number; // percentage 0-100
    pagesProcessed: number;
    dpiUsed: number;
    estimatedQuality: 'excellent' | 'good' | 'fair' | 'poor';
    recommendedDpi?: number;
    embedSuccess: boolean;
    embedError?: string;
}

interface IOcrResults {
    pages: Map<number, string>;
    languages: string[];
    completedAt: number | null;
    searchablePdfData: Uint8Array | null;
    metrics?: IOcrQualityMetrics;
}

function getElectronAPI() {
    if (typeof window === 'undefined' || !window.electronAPI) {
        throw new Error('Electron API not available');
    }
    return window.electronAPI;
}

export const useOcr = () => {
    const availableLanguages = ref<IOcrLanguage[]>([]);
    const settings = ref<IOcrSettings>({
        pageRange: 'current',
        customRange: '',
        selectedLanguages: ['eng'],
    });
    const progress = ref<IOcrProgress>({
        isRunning: false,
        currentPage: 0,
        totalPages: 0,
        processedCount: 0,
    });
    const results = ref<IOcrResults>({
        pages: new Map(),
        languages: [],
        completedAt: null,
        searchablePdfData: null,
    });
    const error = ref<string | null>(null);

    let progressCleanup: (() => void) | null = null;

    async function loadLanguages() {
        try {
            const api = getElectronAPI();
            availableLanguages.value = await api.ocrGetLanguages();
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to load languages';
        }
    }

    function parsePageRange(
        rangeType: TOcrPageRange,
        customRange: string,
        currentPage: number,
        totalPages: number,
    ): number[] {
        if (rangeType === 'current') {
            return [currentPage];
        }

        if (rangeType === 'all') {
            return Array.from({ length: totalPages }, (_, i) => i + 1);
        }

        // Parse custom range: "1-5, 8, 10-12"
        const pages = new Set<number>();
        const parts = customRange.split(',').map(p => p.trim());

        for (const part of parts) {
            if (part.includes('-')) {
                const parts = part.split('-');
                const startStr = parts[0];
                const endStr = parts[1];
                if (startStr && endStr) {
                    const start = parseInt(startStr.trim(), 10);
                    const end = parseInt(endStr.trim(), 10);
                    if (!isNaN(start) && !isNaN(end)) {
                        for (let i = Math.max(1, start); i <= Math.min(totalPages, end); i++) {
                            pages.add(i);
                        }
                    }
                }
            } else {
                const num = parseInt(part, 10);
                if (!isNaN(num) && num >= 1 && num <= totalPages) {
                    pages.add(num);
                }
            }
        }

        return Array.from(pages).sort((a, b) => a - b);
    }

    async function renderPageToImage(
        pdfDocument: PDFDocumentProxy,
        pageNumber: number,
        scale = 2,
    ): Promise<number[]> {
        try {
            console.log(`[renderPageToImage] Starting render for page ${pageNumber}, scale=${scale}`);
            const page = await pdfDocument.getPage(pageNumber);
            const viewport = page.getViewport({ scale });

            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            const context = canvas.getContext('2d');
            if (!context) {
                throw new Error('Failed to get 2D canvas context');
            }

            console.log(`[renderPageToImage] Canvas created: ${canvas.width}x${canvas.height}`);

            const renderTask = page.render({
                canvasContext: context,
                viewport,
                canvas,
            });

            console.log(`[renderPageToImage] Render task started, waiting for promise...`);
            await renderTask.promise;
            console.log(`[renderPageToImage] Render promise completed`);

            // Convert to PNG blob, then array
            const blob = await new Promise<Blob>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('canvas.toBlob timeout'));
                }, 5000);

                canvas.toBlob(
                    (b) => {
                        clearTimeout(timeout);
                        if (!b) {
                            reject(new Error('canvas.toBlob returned null'));
                        } else {
                            resolve(b);
                        }
                    },
                    'image/png'
                );
            });

            console.log(`[renderPageToImage] PNG blob created: ${blob.size} bytes`);

            const arrayBuffer = await blob.arrayBuffer();
            const result = Array.from(new Uint8Array(arrayBuffer));
            console.log(`[renderPageToImage] Converted to array: ${result.length} bytes`);
            return result;
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[renderPageToImage] Error for page ${pageNumber}: ${errMsg}`);
            throw err;
        }
    }

    // OCR render scale: 1x to render at actual page dimensions
    // This ensures Tesseract PDFs have identical page size to original pages
    function getOcrRenderScale() {
        return 1.0;
    }

    async function runOcr(
        pdfDocument: PDFDocumentProxy,
        originalPdfData: Uint8Array,
        currentPage: number,
        totalPages: number,
    ) {
        console.log('[useOcr] runOcr called', { currentPage, totalPages, pdfDataLength: originalPdfData?.length });

        if (progress.value.isRunning) {
            console.log('[useOcr] Already running, returning');
            return;
        }

        error.value = null;
        const pages = parsePageRange(
            settings.value.pageRange,
            settings.value.customRange,
            currentPage,
            totalPages,
        );

        console.log('[useOcr] Pages to process:', pages);

        if (pages.length === 0) {
            error.value = 'No valid pages selected';
            return;
        }

        progress.value = {
            isRunning: true,
            currentPage: pages[0] ?? 1,
            totalPages: pages.length,
            processedCount: 0,
        };

        const requestId = `ocr-${Date.now()}`;
        console.log('[useOcr] Request ID:', requestId);

        try {
            const api = getElectronAPI();

            // Setup progress listener
            progressCleanup = api.onOcrProgress((p) => {
                console.log('[useOcr] Progress update:', p);
                if (p.requestId === requestId) {
                    progress.value.currentPage = p.currentPage;
                    progress.value.processedCount = p.processedCount;
                }
            });

            // Render pages to images and build requests
            const languages = [...settings.value.selectedLanguages];
            const renderScale = getOcrRenderScale();
            const pageRequests = [];
            for (const pageNum of pages) {
                console.log('[useOcr] Rendering page', pageNum, `scale=${renderScale.toFixed(2)}x`);
                const page = await pdfDocument.getPage(pageNum);

                // Get original page dimensions (at scale 1.0)
                const originalViewport = page.getViewport({ scale: 1.0 });

                // Get rendered dimensions (at our rendering scale)
                const viewport = page.getViewport({ scale: renderScale });
                const imageData = await renderPageToImage(pdfDocument, pageNum, renderScale);
                console.log('[useOcr] Page rendered, imageData length:', imageData.length);
                pageRequests.push({
                    pageNumber: pageNum,
                    imageData,
                    languages,
                    imageWidth: viewport.width,
                    imageHeight: viewport.height,
                    originalPageWidth: originalViewport.width,
                    originalPageHeight: originalViewport.height,
                });
            }

            console.log('[useOcr] Sending to backend, originalPdfData length:', originalPdfData.length);
            // Create searchable PDF with OCR text embedded
            const response = await api.ocrCreateSearchablePdf(
                Array.from(originalPdfData),
                pageRequests,
                requestId,
            );
            console.log('[useOcr] Backend response:', { success: response.success, errors: response.errors });

            if (response.errors.length > 0) {
                error.value = response.errors.join('; ');
            }

            if (response.success && (response.pdfData || response.pdfPath)) {
                let pdfBytes: Uint8Array;

                if (response.pdfPath) {
                    // Large PDF saved to temp file - read it back
                    console.log('[useOcr] OCR successful, reading from temp file:', response.pdfPath);
                    const fileData = await api.readFile(response.pdfPath);
                    pdfBytes = new Uint8Array(fileData);
                    console.log('[useOcr] PDF size:', pdfBytes.length);
                } else {
                    // Small PDF returned directly as array
                    console.log('[useOcr] OCR successful, PDF size:', response.pdfData.length);
                    pdfBytes = new Uint8Array(response.pdfData);
                }

                results.value = {
                    pages: new Map(), // Text stored in PDF, not separately
                    languages: [...settings.value.selectedLanguages],
                    completedAt: Date.now(),
                    searchablePdfData: pdfBytes,
                };
            } else if (!response.success) {
                error.value = error.value || 'Failed to create searchable PDF';
            }
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            const errStack = e instanceof Error ? e.stack : undefined;
            console.error('[useOcr] Error message:', errMsg);
            if (errStack) console.error('[useOcr] Error stack:', errStack);
            error.value = errMsg;
        } finally {
            progress.value.isRunning = false;
            progressCleanup?.();
            progressCleanup = null;
        }
    }

    function cancelOcr() {
        progress.value.isRunning = false;
        progressCleanup?.();
        progressCleanup = null;
    }

    function clearResults() {
        results.value = {
            pages: new Map(),
            languages: [],
            completedAt: null,
            searchablePdfData: null,
        };
    }

    function toggleLanguage(code: string, selected: boolean) {
        if (selected) {
            if (!settings.value.selectedLanguages.includes(code)) {
                settings.value.selectedLanguages.push(code);
            }
        } else {
            const index = settings.value.selectedLanguages.indexOf(code);
            if (index !== -1) {
                settings.value.selectedLanguages.splice(index, 1);
            }
        }
    }

    const hasResults = computed(() => results.value.searchablePdfData !== null);

    const progressPercent = computed(() => {
        if (progress.value.totalPages === 0) return 0;
        return Math.round(
            (progress.value.processedCount / progress.value.totalPages) * 100,
        );
    });

    const latinCyrillicLanguages = computed(() =>
        availableLanguages.value.filter(l => l.script !== 'rtl'),
    );

    const rtlLanguages = computed(() =>
        availableLanguages.value.filter(l => l.script === 'rtl'),
    );

    return {
        availableLanguages,
        settings,
        progress,
        results,
        error,
        hasResults,
        progressPercent,
        latinCyrillicLanguages,
        rtlLanguages,
        loadLanguages,
        runOcr,
        cancelOcr,
        clearResults,
        toggleLanguage,
    };
};
