import {
    computed,
    onMounted,
    onUnmounted,
    ref,
} from 'vue';
import type {
    IProcessingProgress,
    IProcessingResult,
    IProcessingSettings,
    TProcessingOperation,
} from '@app/types/page-processing';
import { DEFAULT_PROCESSING_SETTINGS } from '@app/types/page-processing';
import { getElectronAPI } from '@app/utils/electron';

export const usePageProcessing = () => {
    const isProcessing = ref(false);
    const settings = ref<IProcessingSettings>(structuredClone(DEFAULT_PROCESSING_SETTINGS));
    const progress = ref<IProcessingProgress | null>(null);
    const lastResult = ref<IProcessingResult | null>(null);
    const toolsValidated = ref(false);
    const toolsAvailable = ref(false);
    const isValidatingTools = ref(false);
    const validationErrors = ref<string[]>([]);
    const currentJobId = ref<string | null>(null);
    let validationPromise: Promise<boolean> | null = null;

    let progressCleanup: (() => void) | null = null;
    let completeCleanup: (() => void) | null = null;
    let logCleanup: (() => void) | null = null;

    const progressPercentage = computed(() => {
        if (!progress.value) {
            return 0;
        }
        return progress.value.percentage;
    });

    const progressMessage = computed(() => {
        if (!progress.value) {
            return '';
        }
        return progress.value.message;
    });

    const hasErrors = computed(() => {
        return lastResult.value !== null && lastResult.value.errors.length > 0;
    });

    const selectedOperations = computed<TProcessingOperation[]>(() => {
        const ops: TProcessingOperation[] = [];
        if (settings.value.operations.split) ops.push('split');
        if (settings.value.operations.dewarp) ops.push('dewarp');
        if (settings.value.operations.deskew) ops.push('deskew');
        // Auto-crop is intentionally disabled; we only support split + deskew/dewarp.
        return ops;
    });

    function setupIpcListeners() {
        try {
            const api = getElectronAPI();

            // Listen for progress updates
            progressCleanup = api.pageProcessing.onProgress((p) => {
                if (p.jobId === currentJobId.value) {
                    progress.value = p;
                }
            });

            // Listen for completion
            completeCleanup = api.pageProcessing.onComplete((result) => {
                if (result.jobId !== currentJobId.value) {
                    return;
                }

                lastResult.value = result;
                isProcessing.value = false;
                currentJobId.value = null;
            });

            // Forward worker logs to renderer console (helpful for debugging)
            logCleanup = api.pageProcessing.onLog((entry) => {
                if (entry.jobId !== currentJobId.value) {
                    return;
                }
                const message = `[page-processing:${entry.level}] ${entry.message}`;
                if (entry.level === 'error') {
                    console.error(message);
                } else if (entry.level === 'warn') {
                    console.warn(message);
                } else {
                    console.log(message);
                }
            });
        } catch {
            // Electron API not available (SSR or web context)
        }
    }

    function cleanupIpcListeners() {
        progressCleanup?.();
        progressCleanup = null;
        completeCleanup?.();
        completeCleanup = null;
        logCleanup?.();
        logCleanup = null;
    }

    async function validateTools(): Promise<boolean> {
        if (toolsValidated.value) {
            return toolsAvailable.value;
        }

        if (validationPromise) {
            return validationPromise;
        }

        validationErrors.value = [];
        isValidatingTools.value = true;

        validationPromise = (async () => {
            try {
                const api = getElectronAPI();
                const result = await api.pageProcessing.validateTools();

                toolsValidated.value = true;
                toolsAvailable.value = result.valid;

                if (!result.valid) {
                    validationErrors.value = result.errors;
                }

                return result.valid;
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                validationErrors.value = [errMsg];
                toolsValidated.value = true;
                toolsAvailable.value = false;
                return false;
            } finally {
                isValidatingTools.value = false;
                validationPromise = null;
            }
        })();

        return validationPromise;
    }

    function parsePageRange(
        rangeString: string,
        totalPages: number,
    ): number[] {
        const pages = new Set<number>();
        const parts = rangeString.split(',').map(p => p.trim()).filter(Boolean);

        for (const part of parts) {
            if (part.includes('-')) {
                const rangeParts = part.split('-');
                const startStr = rangeParts[0];
                const endStr = rangeParts[1];

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

    async function startProcessing(
        pdfPath: string,
        currentPage: number,
        totalPages: number,
        workingCopyPath?: string,
    ): Promise<boolean> {
        if (isProcessing.value) {
            return false;
        }

        if (!toolsValidated.value) {
            const ok = await validateTools();
            if (!ok) {
                lastResult.value = {
                    jobId: 'page-processing',
                    success: false,
                    errors: validationErrors.value.length > 0
                        ? validationErrors.value
                        : ['Processing tools not available'],
                    stats: {
                        totalPagesInput: 0,
                        totalPagesOutput: 0,
                        processingTimeMs: 0,
                    },
                };
                return false;
            }
        }

        if (!toolsAvailable.value) {
            lastResult.value = {
                jobId: 'page-processing',
                success: false,
                errors: ['Processing tools not available'],
                stats: {
                    totalPagesInput: 0,
                    totalPagesOutput: 0,
                    processingTimeMs: 0,
                },
            };
            return false;
        }

        // Determine pages to process
        let pagesToProcess: number[];
        switch (settings.value.rangeType) {
            case 'current':
                pagesToProcess = [currentPage];
                break;
            case 'custom':
                pagesToProcess = parsePageRange(settings.value.customRange, totalPages);
                break;
            case 'all':
            default:
                pagesToProcess = Array.from({ length: totalPages }, (_, i) => i + 1);
                break;
        }

        if (pagesToProcess.length === 0) {
            lastResult.value = {
                jobId: 'page-processing',
                success: false,
                errors: ['No valid pages selected'],
                stats: {
                    totalPagesInput: 0,
                    totalPagesOutput: 0,
                    processingTimeMs: 0,
                },
            };
            return false;
        }

        const jobId = `page-processing-${crypto.randomUUID()}`;
        currentJobId.value = jobId;
        isProcessing.value = true;
        lastResult.value = null;
        progress.value = {
            jobId,
            currentPage: pagesToProcess[0] ?? 1,
            currentOperation: 'Starting...',
            processedCount: 0,
            totalPages: pagesToProcess.length,
            percentage: 0,
            message: 'Initializing page processing...',
        };

        try {
            const api = getElectronAPI();

            const startResult = await api.pageProcessing.process(
                pdfPath,
                pagesToProcess,
                {
                    operations: selectedOperations.value,
                    autoDetectFacingPages: settings.value.autoDetect,
                    forceSplit: settings.value.operations.split && !settings.value.autoDetect,
                    minSkewAngle: settings.value.advanced.minSkewAngle,
                    minCurvatureThreshold: 0.1,
                    cropPadding: settings.value.advanced.cropPadding,
                    outputDpi: settings.value.advanced.outputDpi,
                    extractionDpi: settings.value.advanced.extractionDpi,
                },
                jobId,
                workingCopyPath,
            );

            if (!startResult.started) {
                throw new Error(startResult.error ?? 'Failed to start processing');
            }

            return true;
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            lastResult.value = {
                jobId,
                success: false,
                errors: [errMsg],
                stats: {
                    totalPagesInput: pagesToProcess.length,
                    totalPagesOutput: 0,
                    processingTimeMs: 0,
                },
            };
            isProcessing.value = false;
            currentJobId.value = null;
            return false;
        }
    }

    async function cancelProcessing(): Promise<void> {
        if (!isProcessing.value || !currentJobId.value) {
            return;
        }

        try {
            const api = getElectronAPI();
            await api.pageProcessing.cancel(currentJobId.value);
        } catch {
            // Ignore cancellation errors
        } finally {
            isProcessing.value = false;
            currentJobId.value = null;
            progress.value = null;
        }
    }

    function resetSettings(): void {
        settings.value = structuredClone(DEFAULT_PROCESSING_SETTINGS);
    }

    onMounted(() => {
        setupIpcListeners();
        // Warm tool validation in the background so opening the popup doesn't feel laggy.
        void validateTools();
    });

    onUnmounted(() => {
        cleanupIpcListeners();
    });

    return {
        // State
        isProcessing,
        settings,
        progress,
        lastResult,
        toolsValidated,
        toolsAvailable,
        validationErrors,
        currentJobId,

        // Computed
        progressPercentage,
        progressMessage,
        hasErrors,
        selectedOperations,
        isValidatingTools,

        // Methods
        validateTools,
        parsePageRange,
        startProcessing,
        cancelProcessing,
        resetSettings,
    };
};
