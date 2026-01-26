<template>
    <UPopover v-model:open="isOpen" mode="click" :popper="{ placement: 'bottom-end' }">
        <UButton
            icon="i-lucide-wand-2"
            variant="ghost"
            color="neutral"
        >
            <span>Process</span>
        </UButton>

        <template #content>
            <div class="page-processing-panel">
                <div class="panel-header">
                    <h3>Process Scanned Pages</h3>
                </div>

                <!-- Warning if tools not available -->
                <div v-if="toolsValidated && !toolsAvailable" class="panel-alert panel-alert-warning">
                    <UIcon name="i-lucide-triangle-alert" class="size-4" />
                    <div class="tools-warning">
                        <span>Processing tools not available:</span>
                        <ul v-if="validationErrors.length > 0" class="tools-warning-list">
                            <li v-for="(error, i) in validationErrors" :key="i">{{ error }}</li>
                        </ul>
                    </div>
                </div>

                <!-- Page Range Selection -->
                <div class="setting-group">
                    <div class="setting-label">Page Range</div>
                    <div class="radio-group">
                        <label class="radio-option">
                            <input
                                v-model="settings.rangeType"
                                type="radio"
                                name="pageRange"
                                value="all"
                            >
                            <span>All pages ({{ totalPages }})</span>
                        </label>
                        <label class="radio-option">
                            <input
                                v-model="settings.rangeType"
                                type="radio"
                                name="pageRange"
                                value="current"
                            >
                            <span>Current page ({{ currentPage }})</span>
                        </label>
                        <label class="radio-option">
                            <input
                                v-model="settings.rangeType"
                                type="radio"
                                name="pageRange"
                                value="custom"
                            >
                            <span>Custom range</span>
                        </label>
                    </div>
                    <UInput
                        v-if="settings.rangeType === 'custom'"
                        v-model="settings.customRange"
                        placeholder="e.g., 1-5, 8, 10-12"
                        size="sm"
                        class="custom-range-input"
                    />
                </div>

                <div class="panel-divider" />

                <!-- Operations Selection -->
                <div class="setting-group">
                    <div class="setting-label">Operations</div>
                    <div class="operations-grid">
                        <label class="checkbox-option">
                            <input
                                v-model="settings.operations.split"
                                type="checkbox"
                            >
                            <span>Split pages</span>
                        </label>
                        <label class="checkbox-option">
                            <input
                                v-model="settings.operations.deskew"
                                type="checkbox"
                            >
                            <span>Deskew</span>
                        </label>
                        <label class="checkbox-option">
                            <input
                                v-model="settings.operations.dewarp"
                                type="checkbox"
                            >
                            <span>Dewarp (slow)</span>
                        </label>
                    </div>
                </div>

                <div class="panel-divider" />

                <!-- Auto-detect Toggle -->
                <div class="setting-group">
                    <label class="checkbox-option">
                        <input
                            v-model="settings.autoDetect"
                            type="checkbox"
                        >
                        <span>Auto-detect facing pages</span>
                    </label>
                </div>

                <!-- Progress Section -->
                <template v-if="isProcessing">
                    <div class="panel-divider" />
                    <div class="progress-section">
                        <UProgress :value="progressPercentage" />
                        <span class="progress-text">{{ progressMessage }}</span>
                    </div>
                </template>

                <!-- Results Section -->
                <template v-if="lastResult !== null && !isProcessing">
                    <div class="panel-divider" />
                    <div
                        :class="[
                            'panel-alert',
                            lastResult.success ? 'panel-alert-success' : 'panel-alert-error'
                        ]"
                    >
                        <UIcon
                            :name="lastResult.success ? 'i-lucide-check-circle' : 'i-lucide-circle-x'"
                            class="size-4"
                        />
                        <span>{{ resultMessage }}</span>
                    </div>
                </template>

                <div class="panel-divider" />

                <!-- Actions -->
                <div class="panel-actions">
                    <UButton
                        v-if="isProcessing"
                        color="neutral"
                        variant="soft"
                        size="sm"
                        @click="handleCancel"
                    >
                        Cancel
                    </UButton>
                    <UButton
                        v-else
                        color="primary"
                        size="sm"
                        :disabled="!hasOperationsSelected || (toolsValidated && !toolsAvailable)"
                        @click="handleStart"
                    >
                        <UIcon name="i-lucide-play" class="size-4" />
                        Process Pages
                    </UButton>
                </div>
            </div>
        </template>
    </UPopover>
</template>

<script setup lang="ts">
import { getElectronAPI } from '@app/utils/electron';

interface IProps {
    pdfPath: string;
    currentPage: number;
    totalPages: number;
    workingCopyPath?: string;
    pdfData?: Uint8Array | null;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'open'): void;
    (e: 'processed', pdfData: Uint8Array): void;
}>();

const {
    isProcessing,
    settings,
    lastResult,
    toolsValidated,
    toolsAvailable,
    isValidatingTools,
    validationErrors,
    progressPercentage,
    progressMessage,
    validateTools,
    startProcessing,
    cancelProcessing,
} = usePageProcessing();

const isOpen = ref(false);

const hasOperationsSelected = computed(() => {
    return settings.value.operations.split
        || settings.value.operations.deskew
        || settings.value.operations.dewarp;
});

const resultMessage = computed(() => {
    if (!lastResult.value) {
        return '';
    }
    if (lastResult.value.success) {
        const stats = lastResult.value.stats;
        const input = stats.totalPagesInput ?? 0;
        const output = stats.totalPagesOutput ?? 0;
        const inputLabel = `${input} page${input === 1 ? '' : 's'}`;
        const outputLabel = `${output} page${output === 1 ? '' : 's'}`;
        return `Processing complete - processed ${inputLabel}; output PDF has ${outputLabel}`;
    }
    return lastResult.value.errors[0] ?? 'Processing failed';
});

function close() {
    isOpen.value = false;
}

defineExpose({ close });

watch(isOpen, (value) => {
    if (value) {
        emit('open');
        if (!toolsValidated.value && !isValidatingTools.value) {
            void validateTools();
        }
    }
});

async function handleStart() {
    if (!props.pdfPath) {
        return;
    }
    await startProcessing(
        props.pdfPath,
        props.currentPage,
        props.totalPages,
        props.workingCopyPath,
    );
}

function handleCancel() {
    cancelProcessing();
}

let lastEmittedJobId: string | null = null;

watch(lastResult, async (result) => {
    if (!result?.success) {
        return;
    }

    if (!result.jobId || result.jobId === lastEmittedJobId) {
        return;
    }
    lastEmittedJobId = result.jobId;

    try {
        const api = getElectronAPI();

        // If we have inline PDF data
        if (result.pdfData && result.pdfData.length > 0) {
            emit('processed', new Uint8Array(result.pdfData));
            return;
        }

        // If we have a path to the processed PDF, read it
        if (result.pdfPath) {
            const pdfData = await api.readFile(result.pdfPath);
            emit('processed', pdfData);
        }
    } catch (err) {
        console.error('Failed to emit processed PDF:', err);
    }
});
</script>

<style scoped>
.page-processing-panel {
    width: 320px;
    padding: 16px;
}

.panel-header {
    margin-bottom: 16px;
}

.panel-header h3 {
    font-weight: 600;
    font-size: 0.9375rem;
    margin: 0;
}

.setting-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.setting-label {
    font-size: 0.6875rem;
    color: var(--ui-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

.panel-divider {
    height: 1px;
    background-color: var(--ui-border);
    margin: 12px 0;
}

.radio-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.radio-option {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.875rem;
    cursor: pointer;
}

.radio-option input {
    accent-color: var(--ui-primary);
}

.custom-range-input {
    margin-top: 4px;
}

.operations-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 12px;
}

.checkbox-option {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.875rem;
    cursor: pointer;
}

.checkbox-option input {
    accent-color: var(--ui-primary);
}

.progress-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.progress-text {
    font-size: 0.75rem;
    color: var(--ui-text-muted);
    text-align: center;
}

.panel-alert {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 0.8125rem;
}

.panel-alert-warning {
    background-color: var(--ui-warning-alpha);
    color: var(--ui-warning);
}

.tools-warning {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.tools-warning-list {
    margin: 0;
    padding-left: 16px;
    font-size: 0.75rem;
    opacity: 0.9;
}

.panel-alert-success {
    background-color: var(--ui-success-alpha);
    color: var(--ui-success);
}

.panel-alert-error {
    background-color: var(--ui-error-alpha);
    color: var(--ui-error);
}

.panel-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}
</style>
