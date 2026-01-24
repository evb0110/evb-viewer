import {
    computed,
    nextTick,
    ref,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IOcrLanguage } from '@app/types/shared';
import { getElectronAPI } from '@app/utils/electron';

type TOcrPageRange = 'all' | 'current' | 'custom';

interface IOcrSettings {
    pageRange: TOcrPageRange;
    customRange: string;
    selectedLanguages: string[];
    renderDpi: number;
}

interface IOcrProgress {
    isRunning: boolean;
    phase: 'preparing' | 'processing';
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

export const useOcr = () => {
    const availableLanguages = ref<IOcrLanguage[]>([]);
    const settings = ref<IOcrSettings>({
        pageRange: 'current',
        customRange: '',
        selectedLanguages: ['eng'],
        renderDpi: 300,
    });
    const progress = ref<IOcrProgress>({
        isRunning: false,
        phase: 'preparing',
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
    let completeCleanup: (() => void) | null = null;

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


    async function runOcr(
        pdfDocument: PDFDocumentProxy,
        originalPdfData: Uint8Array,
        currentPage: number,
        totalPages: number,
        workingCopyPath: string | null = null,
    ) {
        console.log('[useOcr] runOcr called', {
            currentPage,
            totalPages,
            pdfDataLength: originalPdfData?.length, 
        });

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
            phase: 'preparing',
            currentPage: pages[0] ?? 1,
            totalPages: pages.length,
            processedCount: 0,
        };

        // Force Vue to flush the UI update immediately so user sees feedback
        await nextTick();

        // Double requestAnimationFrame ensures the browser has actually painted
        // Single rAF only schedules, double rAF waits for paint to complete
        await new Promise<void>(resolve => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => resolve());
            });
        });

        const requestId = `ocr-${Date.now()}`;
        console.log('[useOcr] Request ID:', requestId);

        try {
            const api = getElectronAPI();

            // Setup progress listener
            progressCleanup = api.onOcrProgress((p) => {
                console.log('[useOcr] Progress update:', p);
                if (p.requestId === requestId) {
                    progress.value.phase = 'processing';
                    progress.value.currentPage = p.currentPage;
                    progress.value.processedCount = p.processedCount;
                }
            });

            // Build OCR request with page numbers and languages
            // Backend will extract pages directly from the source PDF file
            const languages = [...settings.value.selectedLanguages];
            const pageRequests = pages.map(pageNum => ({
                pageNumber: pageNum,
                languages,
            }));

            console.log('[useOcr] Sending to backend, pages:', pages, ', originalPdfData length:', originalPdfData.length);

            // Create a promise that resolves when OCR completes
            // The OCR worker runs in a separate thread and sends results via 'ocr:complete' event
            const ocrPromise = new Promise<{
                success: boolean;
                pdfData: number[] | null;
                pdfPath?: string;
                errors: string[];
            }>((resolve, reject) => {
                completeCleanup = api.onOcrComplete((result) => {
                    console.log('[useOcr] OCR complete event:', {
                        requestId: result.requestId,
                        success: result.success,
                    });
                    if (result.requestId === requestId) {
                        resolve(result);
                    }
                });

                // Timeout after 30 minutes (very long OCR jobs)
                setTimeout(() => {
                    reject(new Error('OCR operation timed out after 30 minutes'));
                }, 30 * 60 * 1000);
            });

            // Start the OCR job (returns immediately, doesn't block)
            const startResult = await api.ocrCreateSearchablePdf(
                originalPdfData,
                pageRequests,
                requestId,
                workingCopyPath,
            );

            console.log('[useOcr] OCR job started:', startResult);

            if (!startResult.started) {
                throw new Error(startResult.error || 'Failed to start OCR job');
            }

            // Wait for the OCR worker to complete
            const response = await ocrPromise;

            console.log('[useOcr] Backend response:', {
                success: response.success,
                errors: response.errors,
            });

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
                } else if (response.pdfData) {
                    // Small PDF returned directly as array
                    console.log('[useOcr] OCR successful, PDF size:', response.pdfData.length);
                    pdfBytes = new Uint8Array(response.pdfData);
                } else {
                    throw new Error('No PDF data or path in response');
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
            completeCleanup?.();
            completeCleanup = null;
        }
    }

    function cancelOcr() {
        progress.value.isRunning = false;
        progressCleanup?.();
        progressCleanup = null;
        completeCleanup?.();
        completeCleanup = null;
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
        // Return null during preparing phase to trigger indeterminate progress bar
        if (progress.value.phase === 'preparing') {
            return null;
        }
        if (progress.value.totalPages === 0) {
            return 0;
        }
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
