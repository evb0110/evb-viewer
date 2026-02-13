import {
    computed,
    nextTick,
    ref,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IOcrLanguage } from '@app/types/shared';
import { getElectronAPI } from '@app/utils/electron';
import { createDocxFromText } from '@app/utils/docx';
import { OCR_TIMEOUT_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browser-logger';
import {
    parsePageRange,
    type IOcrSettings,
    type IOcrProgress,
    type IOcrResults,
} from '@app/composables/ocrLanguages';
import {
    loadOcrText,
    extractPdfText,
} from '@app/composables/ocrProcessing';

export const useOcr = () => {
    const availableLanguages = ref<IOcrLanguage[]>([]);
    const settings = ref<IOcrSettings>({
        pageRange: 'current',
        customRange: '',
        selectedLanguages: ['eng'],
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
    const isExporting = ref(false);

    const activeRequestId = ref<string | null>(null);

    let progressCleanup: (() => void) | null = null;
    let completeCleanup: (() => void) | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    async function loadLanguages() {
        try {
            const api = getElectronAPI();
            availableLanguages.value = await api.ocrGetLanguages();
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to load languages';
        }
    }

    async function runOcr(
        pdfDocument: PDFDocumentProxy,
        originalPdfData: Uint8Array,
        currentPage: number,
        totalPages: number,
        workingCopyPath: string | null = null,
    ) {
        BrowserLogger.debug('OCR', 'runOcr called', {
            currentPage,
            totalPages,
            pdfDataLength: originalPdfData?.length,
        });

        if (progress.value.isRunning) {
            BrowserLogger.debug('OCR', 'runOcr ignored; already running');
            return;
        }

        error.value = null;
        const pages = parsePageRange(
            settings.value.pageRange,
            settings.value.customRange,
            currentPage,
            totalPages,
        );

        BrowserLogger.debug('OCR', 'Pages selected', pages);

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

        await nextTick();

        await new Promise<void>(resolve => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => resolve());
            });
        });

        const requestId = `ocr-${crypto.randomUUID()}`;
        activeRequestId.value = requestId;
        BrowserLogger.debug('OCR', `Request created: ${requestId}`);

        try {
            const api = getElectronAPI();

            progressCleanup = api.onOcrProgress((p) => {
                BrowserLogger.debug('OCR', 'Progress update', p);
                if (p.requestId === requestId) {
                    progress.value.phase = 'processing';
                    progress.value.currentPage = p.currentPage;
                    progress.value.processedCount = p.processedCount;
                }
            });

            const languages = [...settings.value.selectedLanguages];
            const pageRequests = pages.map(pageNum => ({
                pageNumber: pageNum,
                languages,
            }));

            BrowserLogger.debug('OCR', 'Starting backend job', {
                pages,
                pdfDataLength: originalPdfData.length,
            });

            const ocrPromise = new Promise<{
                success: boolean;
                pdfData: number[] | null;
                pdfPath?: string;
                errors: string[];
            }>((resolve, reject) => {
                let didResolve = false;

                completeCleanup = api.onOcrComplete((result) => {
                    BrowserLogger.debug('OCR', 'Complete event received', {
                        requestId: result.requestId,
                        success: result.success,
                        didResolve,
                    });
                    if (result.requestId === requestId) {
                        if (didResolve) {
                            BrowserLogger.debug('OCR', `Ignoring duplicate completion for ${requestId}`);
                            return;
                        }
                        didResolve = true;
                        if (timeoutId) {
                            clearTimeout(timeoutId);
                            timeoutId = null;
                        }
                        resolve(result);
                    }
                });

                timeoutId = setTimeout(() => {
                    if (!didResolve) {
                        timeoutId = null;
                        reject(new Error('OCR operation timed out after 30 minutes'));
                    }
                }, OCR_TIMEOUT_MS);
            });

            const startResult = await api.ocrCreateSearchablePdf(
                originalPdfData,
                pageRequests,
                requestId,
                workingCopyPath,
                undefined,
            );

            BrowserLogger.debug('OCR', 'Job started', startResult);

            if (!startResult.started) {
                throw new Error(startResult.error || 'Failed to start OCR job');
            }

            const response = await ocrPromise;

            BrowserLogger.debug('OCR', 'Backend response', {
                success: response.success,
                errors: response.errors,
            });

            if (response.errors.length > 0) {
                error.value = response.errors.join('; ');
            }

            if (response.success && (response.pdfData || response.pdfPath)) {
                let pdfBytes: Uint8Array;

                if (response.pdfPath) {
                    BrowserLogger.debug('OCR', `Reading OCR PDF from temp path: ${response.pdfPath}`);
                    const fileData = await api.readFile(response.pdfPath);
                    pdfBytes = new Uint8Array(fileData);
                    BrowserLogger.debug('OCR', `Loaded OCR PDF (${pdfBytes.length} bytes)`);

                    try {
                        await api.cleanupOcrTemp(response.pdfPath);
                    } catch (cleanupErr) {
                        BrowserLogger.warn('OCR', `Failed to cleanup temp file: ${response.pdfPath}`, cleanupErr);
                    }
                } else if (response.pdfData) {
                    BrowserLogger.debug('OCR', `OCR PDF ready in response (${response.pdfData.length} bytes)`);
                    pdfBytes = new Uint8Array(response.pdfData);
                } else {
                    throw new Error('No PDF data or path in response');
                }

                results.value = {
                    pages: new Map(),
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
            BrowserLogger.error('OCR', `OCR run failed: ${errMsg}`);
            if (errStack) {
                BrowserLogger.error('OCR', 'OCR stack trace', errStack);
            }
            error.value = errMsg;
        } finally {
            activeRequestId.value = null;
            progress.value.isRunning = false;
            progressCleanup?.();
            progressCleanup = null;
            completeCleanup?.();
            completeCleanup = null;
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        }
    }

    function cancelOcr() {
        if (activeRequestId.value) {
            const api = getElectronAPI();
            api.ocrCancel(activeRequestId.value).catch(() => {});
            activeRequestId.value = null;
        }
        progress.value.isRunning = false;
        progressCleanup?.();
        progressCleanup = null;
        completeCleanup?.();
        completeCleanup = null;
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
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
        availableLanguages.value.filter(l => l.script === 'latin' || l.script === 'cyrillic'),
    );

    const greekLanguages = computed(() =>
        availableLanguages.value.filter(l => l.script === 'greek'),
    );

    const rtlLanguages = computed(() =>
        availableLanguages.value.filter(l => l.script === 'rtl'),
    );

    async function exportDocx(
        workingCopyPath: string | null,
        pdfDocument: PDFDocumentProxy | null = null,
    ): Promise<boolean> {
        const workingPath = workingCopyPath ?? '';

        if (isExporting.value) {
            return false;
        }

        isExporting.value = true;
        error.value = null;

        try {
            let text = workingCopyPath ? await loadOcrText(workingCopyPath) : null;
            if (!text && pdfDocument) {
                text = await extractPdfText(pdfDocument);
            }
            if (!text) {
                error.value = 'No OCR text found. Run OCR first.';
                return false;
            }

            const api = getElectronAPI();
            const outPath = await api.saveDocxAs(workingPath);
            if (!outPath) {
                return false;
            }

            const docxBytes = createDocxFromText(text);
            await api.writeDocxFile(outPath, docxBytes);
            return true;
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to export DOCX';
            return false;
        } finally {
            isExporting.value = false;
        }
    }

    return {
        availableLanguages,
        settings,
        progress,
        results,
        error,
        isExporting,
        hasResults,
        progressPercent,
        latinCyrillicLanguages,
        greekLanguages,
        rtlLanguages,
        loadLanguages,
        runOcr,
        cancelOcr,
        clearResults,
        toggleLanguage,
        exportDocx,
    };
};
