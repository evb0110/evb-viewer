<template>
    <div class="stage-split">
        <div class="stage-section">
            <div class="section-header">
                <span class="section-title">Split Mode</span>
            </div>

            <div class="split-mode-buttons">
                <button
                    v-for="mode in splitModes"
                    :key="mode.value"
                    class="split-mode-button"
                    :class="{ 'is-active': splitMode === mode.value }"
                    @click="handleModeSelect(mode.value)"
                >
                    <UIcon :name="mode.icon" class="size-4" />
                    <span class="mode-label">{{ mode.label }}</span>
                </button>
            </div>
        </div>

        <div v-if="splitMode !== 'none'" class="stage-section">
            <div class="section-header">
                <span class="section-title">Split Position</span>
            </div>

            <div class="split-position-control">
                <div class="split-preview">
                    <div class="split-preview-page">
                        <div
                            class="split-preview-left"
                            :style="{ width: `${splitPosition * 100}%` }"
                        />
                        <div
                            class="split-preview-gutter"
                            :style="{ left: `${splitPosition * 100}%` }"
                            @mousedown="handleGutterMouseDown"
                        >
                            <div class="gutter-handle" />
                        </div>
                        <div class="split-preview-right" />
                    </div>
                </div>

                <div class="position-value">
                    <span class="position-label">Position:</span>
                    <span class="position-number">{{ Math.round(splitPosition * 100) }}%</span>
                </div>

                <div class="position-slider">
                    <input
                        type="range"
                        min="0.1"
                        max="0.9"
                        step="0.01"
                        :value="splitPosition"
                        :disabled="splitMode === 'auto'"
                        @input="handleSliderInput"
                    >
                </div>
            </div>
        </div>

        <div v-if="autoDetectedPosition !== null && splitMode !== 'none'" class="stage-section">
            <div class="section-header">
                <span class="section-title">Auto-Detected</span>
            </div>

            <div class="auto-detect-info">
                <div class="auto-detect-row">
                    <span class="auto-detect-label">Center detected at:</span>
                    <span class="auto-detect-value">{{ Math.round(autoDetectedPosition * 100) }}%</span>
                </div>

                <div v-if="confidence !== null" class="confidence-row">
                    <span class="confidence-label">Confidence:</span>
                    <span
                        class="confidence-value"
                        :class="confidenceClass"
                    >
                        {{ Math.round(confidence * 100) }}%
                    </span>
                </div>

                <UButton
                    v-if="splitMode === 'manual' && splitPosition !== autoDetectedPosition"
                    size="xs"
                    variant="soft"
                    color="primary"
                    class="use-detected-button"
                    @click="handleUseAutoDetected"
                >
                    Use detected position
                </UButton>
            </div>
        </div>

        <div class="stage-section">
            <div class="section-header">
                <span class="section-title">Batch Actions</span>
            </div>

            <UButton
                size="sm"
                variant="soft"
                color="neutral"
                :disabled="splitMode === 'none'"
                @click="handleApplyToSimilar"
            >
                <UIcon name="i-lucide-copy" class="size-4" />
                Apply to similar pages
            </UButton>
        </div>

        <div class="stage-actions">
            <UButton
                size="sm"
                variant="soft"
                color="neutral"
                @click="handleReset"
            >
                Reset
            </UButton>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    ref,
} from 'vue';
import type { TSplitMode } from '@app/types/page-processing';

interface ISplitModeOption {
    value: TSplitMode;
    label: string;
    icon: string;
}

interface IProps {
    splitMode: TSplitMode;
    splitPosition: number;
    autoDetectedPosition?: number | null;
    confidence?: number | null;
}

const {
    splitMode,
    splitPosition,
    autoDetectedPosition = null,
    confidence = null,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:splitMode', value: TSplitMode): void;
    (e: 'update:splitPosition', value: number): void;
    (e: 'applyToSimilar'): void;
}>();

const isDragging = ref(false);

const splitModes: ISplitModeOption[] = [
    {
        value: 'none',
        label: 'No Split',
        icon: 'i-lucide-minus', 
    },
    {
        value: 'auto',
        label: 'Auto',
        icon: 'i-lucide-wand-2', 
    },
    {
        value: 'manual',
        label: 'Manual',
        icon: 'i-lucide-move-vertical', 
    },
];

const confidenceClass = computed(() => {
    if (confidence === null) {
        return '';
    }
    if (confidence >= 0.9) {
        return 'confidence-high';
    }
    if (confidence >= 0.7) {
        return 'confidence-medium';
    }
    return 'confidence-low';
});

function handleModeSelect(mode: TSplitMode) {
    emit('update:splitMode', mode);

    if (mode === 'auto' && autoDetectedPosition !== null) {
        emit('update:splitPosition', autoDetectedPosition);
    }
}

function handleSliderInput(event: Event) {
    const target = event.target as HTMLInputElement;
    const value = parseFloat(target.value);
    emit('update:splitPosition', value);
}

function handleGutterMouseDown(event: MouseEvent) {
    if (splitMode !== 'manual') {
        return;
    }

    isDragging.value = true;
    const preview = (event.target as HTMLElement).closest('.split-preview-page');
    if (!preview) {
        return;
    }

    const rect = preview.getBoundingClientRect();

    function handleMouseMove(e: MouseEvent) {
        const x = e.clientX - rect.left;
        const position = Math.max(0.1, Math.min(0.9, x / rect.width));
        emit('update:splitPosition', position);
    }

    function handleMouseUp() {
        isDragging.value = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
}

function handleUseAutoDetected() {
    if (autoDetectedPosition !== null) {
        emit('update:splitPosition', autoDetectedPosition);
    }
}

function handleApplyToSimilar() {
    emit('applyToSimilar');
}

function handleReset() {
    emit('update:splitMode', 'auto');
    emit('update:splitPosition', 0.5);
}
</script>

<style scoped>
.stage-split {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 20px;
}

.stage-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.section-title {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ui-text-muted);
}

.split-mode-buttons {
    display: flex;
    gap: 8px;
}

.split-mode-button {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 10px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    cursor: pointer;
    transition: all 0.15s;
}

.split-mode-button:hover {
    border-color: var(--ui-border-hover);
    background-color: var(--ui-bg-muted);
    color: var(--ui-text);
}

.split-mode-button.is-active {
    border-color: var(--ui-primary);
    background-color: var(--ui-primary-alpha);
    color: var(--ui-primary);
}

.mode-label {
    font-size: 0.6875rem;
    font-weight: 500;
}

.split-position-control {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.split-preview {
    padding: 8px;
    background-color: var(--ui-bg-muted);
    border-radius: 6px;
}

.split-preview-page {
    position: relative;
    height: 100px;
    background-color: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    display: flex;
}

.split-preview-left {
    background-color: var(--ui-primary-alpha);
    transition: width 0.1s ease;
}

.split-preview-gutter {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 12px;
    margin-left: -6px;
    cursor: ew-resize;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1;
}

.gutter-handle {
    width: 4px;
    height: 40px;
    background-color: var(--ui-primary);
    border-radius: 2px;
    transition: transform 0.15s;
}

.split-preview-gutter:hover .gutter-handle {
    transform: scaleX(1.5);
}

.split-preview-right {
    flex: 1;
}

.position-value {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.75rem;
}

.position-label {
    color: var(--ui-text-muted);
}

.position-number {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
}

.position-slider {
    padding: 0 4px;
}

.position-slider input[type="range"] {
    width: 100%;
    accent-color: var(--ui-primary);
}

.position-slider input[type="range"]:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.auto-detect-info {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    background-color: var(--ui-bg-muted);
    border-radius: 6px;
}

.auto-detect-row,
.confidence-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.75rem;
}

.auto-detect-label,
.confidence-label {
    color: var(--ui-text-muted);
}

.auto-detect-value {
    font-weight: 500;
}

.confidence-value {
    font-weight: 500;
}

.confidence-high {
    color: var(--ui-success);
}

.confidence-medium {
    color: var(--ui-warning);
}

.confidence-low {
    color: var(--ui-error);
}

.use-detected-button {
    margin-top: 4px;
}

.stage-actions {
    display: flex;
    gap: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--ui-border);
}
</style>
