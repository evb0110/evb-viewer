<template>
    <div class="stage-rotation">
        <div class="stage-section">
            <div class="section-header">
                <span class="section-title">Page Rotation</span>
            </div>

            <div class="rotation-buttons">
                <button
                    v-for="option in rotationOptions"
                    :key="option.value"
                    class="rotation-button"
                    :class="{ 'is-active': rotation === option.value }"
                    :title="option.label"
                    @click="handleRotationSelect(option.value)"
                >
                    <UIcon
                        name="i-lucide-arrow-up"
                        class="size-5 rotation-icon"
                        :style="{ transform: `rotate(${option.value}deg)` }"
                    />
                    <span class="rotation-label">{{ option.label }}</span>
                </button>
            </div>
        </div>

        <div v-if="autoDetectedRotation !== null" class="stage-section">
            <div class="section-header">
                <span class="section-title">Auto-Detected</span>
            </div>

            <div class="auto-detect-info">
                <div class="auto-detect-value">
                    <UIcon
                        name="i-lucide-arrow-up"
                        class="size-4"
                        :style="{ transform: `rotate(${autoDetectedRotation}deg)` }"
                    />
                    <span>{{ autoDetectedRotation }}°</span>
                </div>

                <div v-if="confidence !== null" class="confidence-badge">
                    <span class="confidence-label">Confidence:</span>
                    <span
                        class="confidence-value"
                        :class="confidenceClass"
                    >
                        {{ Math.round(confidence * 100) }}%
                    </span>
                </div>

                <UButton
                    v-if="rotation !== autoDetectedRotation"
                    size="xs"
                    variant="soft"
                    color="primary"
                    @click="handleUseAutoDetected"
                >
                    Use detected
                </UButton>
            </div>
        </div>

        <div class="stage-section">
            <div class="section-header">
                <span class="section-title">Apply To</span>
            </div>

            <label class="toggle-option">
                <input
                    type="checkbox"
                    :checked="applyToAll"
                    @change="handleApplyToAllChange"
                >
                <span class="toggle-label">Apply to all pages</span>
            </label>
        </div>

        <div class="stage-actions">
            <UButton
                size="sm"
                variant="soft"
                color="neutral"
                @click="handleReset"
            >
                Reset to 0°
            </UButton>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface IRotationOption {
    value: number;
    label: string;
}

interface IProps {
    rotation: number;
    autoDetectedRotation?: number | null;
    confidence?: number | null;
    applyToAll: boolean;
}

const {
    rotation,
    autoDetectedRotation = null,
    confidence = null,
    applyToAll,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:rotation', value: number): void;
    (e: 'update:applyToAll', value: boolean): void;
}>();

const rotationOptions: IRotationOption[] = [
    {
        value: 0,
        label: '0°', 
    },
    {
        value: 90,
        label: '90°', 
    },
    {
        value: 180,
        label: '180°', 
    },
    {
        value: 270,
        label: '270°', 
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

function handleRotationSelect(value: number) {
    emit('update:rotation', value);
}

function handleUseAutoDetected() {
    if (autoDetectedRotation !== null) {
        emit('update:rotation', autoDetectedRotation);
    }
}

function handleApplyToAllChange(event: Event) {
    const target = event.target as HTMLInputElement;
    emit('update:applyToAll', target.checked);
}

function handleReset() {
    emit('update:rotation', 0);
}
</script>

<style scoped>
.stage-rotation {
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

.rotation-buttons {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
}

.rotation-button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 12px;
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    cursor: pointer;
    transition: all 0.15s;
}

.rotation-button:hover {
    border-color: var(--ui-border-hover);
    background-color: var(--ui-bg-muted);
    color: var(--ui-text);
}

.rotation-button.is-active {
    border-color: var(--ui-primary);
    background-color: var(--ui-primary-alpha);
    color: var(--ui-primary);
}

.rotation-icon {
    transition: transform 0.2s ease;
}

.rotation-label {
    font-size: 0.75rem;
    font-weight: 500;
}

.auto-detect-info {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    background-color: var(--ui-bg-muted);
    border-radius: 6px;
}

.auto-detect-value {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.875rem;
    font-weight: 500;
}

.confidence-badge {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.75rem;
}

.confidence-label {
    color: var(--ui-text-muted);
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

.toggle-option {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
}

.toggle-option input {
    accent-color: var(--ui-primary);
}

.toggle-label {
    font-size: 0.875rem;
}

.stage-actions {
    display: flex;
    gap: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--ui-border);
}
</style>
