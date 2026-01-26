import {
    computed,
    onUnmounted,
    ref,
} from 'vue';
import type {
    IOutputSettings,
    IProcessingProject,
} from 'electron/page-processing/project';
import { getElectronAPI } from '@app/utils/electron';

/**
 * Output generation progress
 */
interface IOutputProgress {
    phase: 'preparing' | 'processing' | 'assembling' | 'finalizing';
    currentPage: number;
    totalPages: number;
    percentage: number;
    message: string;
}

/**
 * Output generation result
 */
interface IOutputResult {
    success: boolean;
    outputPath: string | null;
    errors: string[];
    stats: {
        totalPagesInput: number;
        totalPagesOutput: number;
        processingTimeMs: number;
    };
}

/**
 * Composable for managing output generation.
 * Handles triggering output assembly, progress tracking, and cancellation.
 */
export const useProcessingOutput = (
    projectRef: () => IProcessingProject | null,
    updateProjectFn: (updates: Partial<IProcessingProject>) => void,
) => {
    const outputProgress = ref<IOutputProgress | null>(null);
    const outputResult = ref<IOutputResult | null>(null);
    const isGenerating = ref(false);
    const error = ref<string | null>(null);

    let currentJobId: string | null = null;
    let progressCleanup: (() => void) | null = null;
    let completeCleanup: (() => void) | null = null;

    const progressPercentage = computed(() => {
        if (!outputProgress.value) {
            return 0;
        }
        return outputProgress.value.percentage;
    });

    const progressMessage = computed(() => {
        if (!outputProgress.value) {
            return '';
        }
        return outputProgress.value.message;
    });

    const hasResult = computed(() => outputResult.value !== null);

    const wasSuccessful = computed(() => outputResult.value?.success ?? false);

    const outputPath = computed(() => outputResult.value?.outputPath ?? null);

    /**
     * Sets up IPC listeners for progress and completion events.
     */
    function setupListeners(jobId: string): void {
        try {
            const api = getElectronAPI();

            progressCleanup = api.pageProcessing.onOutputProgress((progress) => {
                if (progress.jobId === jobId) {
                    outputProgress.value = {
                        phase: 'processing',
                        currentPage: progress.currentPage,
                        totalPages: progress.totalPages,
                        percentage: progress.percentage,
                        message: progress.message,
                    };
                }
            });

            completeCleanup = api.pageProcessing.onOutputComplete((result) => {
                if (result.jobId === jobId) {
                    handleCompletion(result);
                }
            });
        } catch {
            // API not available
        }
    }

    /**
     * Cleans up IPC listeners.
     */
    function cleanupListeners(): void {
        progressCleanup?.();
        progressCleanup = null;
        completeCleanup?.();
        completeCleanup = null;
    }

    /**
     * Handles output completion.
     */
    function handleCompletion(result: {
        jobId: string;
        success: boolean;
        outputPath?: string;
        error?: string;
        stats?: {
            totalPagesInput: number;
            totalPagesOutput: number;
            processingTimeMs: number;
        };
    }): void {
        const project = projectRef();
        const errors = result.error ? [result.error] : [];

        outputResult.value = {
            success: result.success,
            outputPath: result.outputPath ?? null,
            errors,
            stats: {
                totalPagesInput: result.stats?.totalPagesInput ?? project?.totalPages ?? 0,
                totalPagesOutput: result.stats?.totalPagesOutput ?? 0,
                processingTimeMs: result.stats?.processingTimeMs ?? 0,
            },
        };

        isGenerating.value = false;
        currentJobId = null;
        cleanupListeners();
    }

    /**
     * Generates the output PDF.
     */
    async function generateOutput(outputSettings?: Partial<IOutputSettings>): Promise<boolean> {
        const project = projectRef();
        if (!project) {
            error.value = 'No project loaded';
            return false;
        }

        if (isGenerating.value) {
            return false;
        }

        // Reset state
        error.value = null;
        outputResult.value = null;
        isGenerating.value = true;

        // Merge output settings if provided
        if (outputSettings) {
            updateProjectFn({outputSettings: {
                ...project.outputSettings,
                ...outputSettings,
            }});
        }

        const jobId = `output-${crypto.randomUUID()}`;
        currentJobId = jobId;

        // Initialize progress
        outputProgress.value = {
            phase: 'preparing',
            currentPage: 0,
            totalPages: project.totalPages,
            percentage: 0,
            message: 'Preparing output generation...',
        };

        // Setup listeners
        setupListeners(jobId);

        try {
            const api = getElectronAPI();

            // Start output generation
            const startResult = await api.pageProcessing.generateOutput({projectId: project.id});

            if (!startResult.success) {
                throw new Error(startResult.error ?? 'Failed to start output generation');
            }

            // The completion will be handled by the listener
            return true;
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to start output generation';
            isGenerating.value = false;
            currentJobId = null;
            cleanupListeners();
            return false;
        }
    }

    /**
     * Cancels the current output generation.
     */
    async function cancelOutput(): Promise<void> {
        if (!isGenerating.value || !currentJobId) {
            return;
        }

        try {
            const api = getElectronAPI();
            await api.pageProcessing.cancelStage(currentJobId);
        } catch {
            // Ignore cancellation errors
        }

        isGenerating.value = false;
        currentJobId = null;
        outputProgress.value = null;
        cleanupListeners();
    }

    /**
     * Updates the output settings.
     */
    function updateOutputSettings(settings: Partial<IOutputSettings>): void {
        const project = projectRef();
        if (!project) {
            return;
        }

        updateProjectFn({outputSettings: {
            ...project.outputSettings,
            ...settings,
        }});
    }

    /**
     * Gets the current output settings.
     */
    function getOutputSettings(): IOutputSettings | null {
        const project = projectRef();
        return project?.outputSettings ?? null;
    }

    /**
     * Resets the output state.
     */
    function resetOutput(): void {
        outputResult.value = null;
        outputProgress.value = null;
        error.value = null;
    }

    /**
     * Gets an estimated output page count based on splits.
     */
    const estimatedOutputPages = computed(() => {
        const project = projectRef();
        if (!project) {
            return 0;
        }

        let count = 0;

        for (const page of project.pages) {
            const splitParams = page.split ?? page.autoDetected.split;
            if (splitParams && splitParams.type !== 'none') {
                count += 2;
            } else {
                count += 1;
            }
        }

        return count;
    });

    /**
     * Validates that all prerequisites are met for output generation.
     */
    function canGenerateOutput(): {
        valid: boolean;
        reasons: string[] 
    } {
        const project = projectRef();
        const reasons: string[] = [];

        if (!project) {
            reasons.push('No project loaded');
            return {
                valid: false,
                reasons, 
            };
        }

        if (project.pages.length === 0) {
            reasons.push('No pages in project');
            return {
                valid: false,
                reasons, 
            };
        }

        // Check for errors on any page
        for (const page of project.pages) {
            if (page.status === 'error') {
                reasons.push(`Page ${page.originalPageNumber} has an error: ${page.error ?? 'Unknown error'}`);
            }
        }

        return {
            valid: reasons.length === 0,
            reasons, 
        };
    }

    // Cleanup on unmount
    onUnmounted(() => {
        cleanupListeners();
    });

    return {
        // State
        outputProgress,
        outputResult,
        isGenerating,
        error,

        // Computed
        progressPercentage,
        progressMessage,
        hasResult,
        wasSuccessful,
        outputPath,
        estimatedOutputPages,

        // Methods
        generateOutput,
        cancelOutput,
        updateOutputSettings,
        getOutputSettings,
        resetOutput,
        canGenerateOutput,
    };
};
