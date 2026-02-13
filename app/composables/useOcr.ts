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
    const { t } = useI18n();
    const REMOTE_METHOD_PREFIX_RE = /^Error invoking remote method '[^']+':\s*/u;

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

    function normalizeErrorMessage(message: string): string {
        return message.replace(REMOTE_METHOD_PREFIX_RE, '').trim();
    }

    function isKnownLocalizedOcrError(message: string): boolean {
        return [
            t('errors.file.invalid'),
            t('errors.ocr.loadLanguages'),
            t('errors.ocr.noValidPages'),
            t('errors.ocr.timeout'),
            t('errors.ocr.start'),
            t('errors.ocr.noPdfData'),
            t('errors.ocr.createSearchablePdf'),
            t('errors.ocr.noText'),
            t('errors.ocr.exportDocx'),
        ].includes(message);
    }

    function localizeOcrError(errorValue: unknown, fallbackKey: string): string {
        const rawMessage = typeof errorValue === 'string'
            ? errorValue
            : (errorValue instanceof Error ? errorValue.message : '');
        if (!rawMessage) {
            return t(fallbackKey);
        }

        const normalized = normalizeErrorMessage(rawMessage);
        if (isKnownLocalizedOcrError(rawMessage)) {
            return rawMessage;
        }
        if (isKnownLocalizedOcrError(normalized)) {
            return normalized;
        }

        if (
            normalized === 'Invalid file path'
            || normalized === 'Invalid file path: path must be a non-empty string'
        ) {
            return t('errors.file.invalid');
        }
        if (
            normalized === 'Invalid file path: reads only allowed within temp directory'
            || normalized === 'Invalid file path: writes only allowed within temp directory'
        ) {
            return t(fallbackKey);
        }

        return t(fallbackKey);
    }

    async function loadLanguages() {
        try {
            const api = getElectronAPI();
            availableLanguages.value = await api.ocrGetLanguages();
        } catch (e) {
            error.value = localizeOcrError(e, 'errors.ocr.loadLanguages');
        }
    }

    async function runOcr(
        pdfDocument: PDFDocumentProxy,
        originalPdfData: Uint8Array,
        currentPage: number,
        totalPages: number,
        workingCopyPath: string | null = null,
    ) {
        BrowserLogger.debug('ocr', 'runOcr called', {
            currentPage,
            totalPages,
            pdfDataLength: originalPdfData?.length,
        });

        if (progress.value.isRunning) {
            BrowserLogger.debug('ocr', 'runOcr ignored; already running');
            return;
        }

        error.value = null;
        const pages = parsePageRange(
            settings.value.pageRange,
            settings.value.customRange,
            currentPage,
            totalPages,
        );

        BrowserLogger.debug('ocr', 'Pages selected', pages);

        if (pages.length === 0) {
            error.value = t('errors.ocr.noValidPages');
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

        const requestId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        activeRequestId.value = requestId;
        BrowserLogger.info('ocr', 'Request created', {
            requestId,
            pages: pages.length, 
        });

        try {
            const api = getElectronAPI();

            progressCleanup = api.onOcrProgress((p) => {
                BrowserLogger.debug('ocr', 'Progress update', {
                    ...p,
                    requestId,
                });
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

            BrowserLogger.debug('ocr', 'Starting backend job', {
                requestId,
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
                    BrowserLogger.debug('ocr', 'Complete event received', {
                        requestId,
                        resultRequestId: result.requestId,
                        success: result.success,
                        didResolve,
                    });
                    if (result.requestId === requestId) {
                        if (didResolve) {
                            BrowserLogger.debug('ocr', 'Ignoring duplicate completion', { requestId });
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
                        reject(new Error(t('errors.ocr.timeout')));
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

            BrowserLogger.debug('ocr', 'Job started', {
                requestId,
                ...startResult, 
            });

            if (!startResult.started) {
                throw new Error(localizeOcrError(startResult.error, 'errors.ocr.start'));
            }

            const response = await ocrPromise;

            BrowserLogger.debug('ocr', 'Backend response', {
                requestId,
                success: response.success,
                errors: response.errors,
            });

            if (response.errors.length > 0) {
                const localizedErrors = response.errors.map(err =>
                    localizeOcrError(err, 'errors.ocr.createSearchablePdf'),
                );
                error.value = [...new Set(localizedErrors)].join('; ');
            }

            if (response.success && (response.pdfData || response.pdfPath)) {
                let pdfBytes: Uint8Array;

                if (response.pdfPath) {
                    BrowserLogger.debug('ocr', 'Reading OCR PDF from temp path', {
                        requestId,
                        path: response.pdfPath, 
                    });
                    const fileData = await api.readFile(response.pdfPath);
                    pdfBytes = new Uint8Array(fileData);
                    BrowserLogger.debug('ocr', 'Loaded OCR PDF', {
                        requestId,
                        bytes: pdfBytes.length, 
                    });

                    try {
                        await api.cleanupOcrTemp(response.pdfPath);
                    } catch (cleanupErr) {
                        BrowserLogger.warn('ocr', 'Failed to cleanup temp file', {
                            requestId,
                            path: response.pdfPath,
                            error: cleanupErr, 
                        });
                    }
                } else if (response.pdfData) {
                    BrowserLogger.debug('ocr', 'OCR PDF ready in response', {
                        requestId,
                        bytes: response.pdfData.length, 
                    });
                    pdfBytes = new Uint8Array(response.pdfData);
                } else {
                    throw new Error(t('errors.ocr.noPdfData'));
                }

                results.value = {
                    pages: new Map(),
                    languages: [...settings.value.selectedLanguages],
                    completedAt: Date.now(),
                    searchablePdfData: pdfBytes,
                };
            } else if (!response.success) {
                error.value = error.value || t('errors.ocr.createSearchablePdf');
            }
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            const errStack = e instanceof Error ? e.stack : undefined;
            BrowserLogger.error('ocr', 'OCR run failed', {
                requestId,
                error: errMsg, 
            });
            if (errStack) {
                BrowserLogger.error('ocr', 'OCR stack trace', {
                    requestId,
                    stack: errStack, 
                });
            }
            error.value = localizeOcrError(e, 'errors.ocr.createSearchablePdf');
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
            BrowserLogger.info('ocr', 'Cancelling OCR', { requestId: activeRequestId.value });
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
                error.value = t('errors.ocr.noText');
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
            error.value = localizeOcrError(e, 'errors.ocr.exportDocx');
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
