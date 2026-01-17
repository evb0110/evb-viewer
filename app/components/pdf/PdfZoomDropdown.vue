<template>
    <div class="zoom-controls">
        <UButton
            icon="i-lucide-minus"
            variant="ghost"
            color="neutral"
            size="sm"
            :disabled="disabled || zoom <= 0.25"
            class="h-8 rounded-l-md rounded-r-none"
            @click="handleZoomOut"
        />

        <UPopover v-model:open="isOpen" mode="click" :disabled="disabled">
            <button
                class="zoom-controls-display"
                :disabled="disabled"
            >
                <span class="zoom-controls-display-value">{{ zoomDisplay }}</span>
            </button>

            <template #content>
                <div class="zoom-dropdown">
                    <div class="zoom-dropdown-section">
                        <button
                            v-for="preset in zoomPresets"
                            :key="preset.value"
                            :class="[
                                'zoom-dropdown-item',
                                {
                                    'is-active': isPresetActive(preset.value),
                                },
                            ]"
                            @click="handleSetZoom(preset.value)"
                        >
                            <span class="zoom-dropdown-label">{{ preset.label }}</span>
                            <UIcon
                                v-if="isPresetActive(preset.value)"
                                name="i-lucide-check"
                                class="zoom-dropdown-check size-4"
                            />
                        </button>
                    </div>

                    <div class="zoom-dropdown-divider" />

                    <div class="zoom-dropdown-section">
                        <div class="zoom-dropdown-custom">
                            <UInput
                                v-model="customZoomValue"
                                class="zoom-dropdown-input"
                                type="number"
                                inputmode="decimal"
                                min="25"
                                max="500"
                                step="1"
                                placeholder="Custom"
                                @keydown.enter.prevent="applyCustomZoom"
                            >
                                <template #trailing>%</template>
                            </UInput>
                            <UButton
                                size="xs"
                                variant="soft"
                                @click="applyCustomZoom"
                            >
                                Apply
                            </UButton>
                        </div>
                    </div>

                    <div class="zoom-dropdown-divider" />

                    <div class="zoom-dropdown-section">
                        <button
                            :class="[
                                'zoom-dropdown-item',
                                {
                                    'is-active': isFitModeActive('width'),
                                },
                            ]"
                            @click="handleSetFitMode('width')"
                        >
                            <UIcon
                                name="i-lucide-move-horizontal"
                                class="zoom-dropdown-icon size-5"
                            />
                            <span class="zoom-dropdown-label">Fit Width</span>
                            <UIcon
                                v-if="isFitModeActive('width')"
                                name="i-lucide-check"
                                class="zoom-dropdown-check size-4"
                            />
                        </button>
                        <button
                            :class="[
                                'zoom-dropdown-item',
                                {
                                    'is-active': isFitModeActive('height'),
                                },
                            ]"
                            @click="handleSetFitMode('height')"
                        >
                            <UIcon
                                name="i-lucide-move-vertical"
                                class="zoom-dropdown-icon size-5"
                            />
                            <span class="zoom-dropdown-label">Fit Height</span>
                            <UIcon
                                v-if="isFitModeActive('height')"
                                name="i-lucide-check"
                                class="zoom-dropdown-check size-4"
                            />
                        </button>
                    </div>
                </div>
            </template>
        </UPopover>

        <UButton
            icon="i-lucide-plus"
            variant="ghost"
            color="neutral"
            size="sm"
            :disabled="disabled || zoom >= 5"
            class="h-8 rounded-r-md rounded-l-none"
            @click="handleZoomIn"
        />
    </div>
</template>

<script setup lang="ts">
import type { TFitMode } from 'app/types/shared';

interface IProps {
    zoom: number;
    fitMode: TFitMode;
    disabled?: boolean;
}

const {
    zoom,
    fitMode,
    disabled = false,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:zoom', level: number): void;
    (e: 'update:fitMode', mode: TFitMode): void;
    (e: 'open'): void;
}>();

const isOpen = ref(false);
const customZoomValue = ref(formatZoomValue(zoom));

function close() {
    isOpen.value = false;
}

defineExpose({ close });

watch(isOpen, (value) => {
    if (value) {
        emit('open');
    }
});

watch(
    () => zoom,
    (value) => {
        customZoomValue.value = formatZoomValue(value);
    },
);

function formatZoomValue(value: number) {
    return Math.round(value * 100).toString();
}

const zoomDisplay = computed(() => `${Math.round(zoom * 100)}%`);

const zoomPresets = [
    {
        value: 0.5,
        label: '50%', 
    },
    {
        value: 0.75,
        label: '75%', 
    },
    {
        value: 1,
        label: '100%', 
    },
    {
        value: 1.25,
        label: '125%', 
    },
    {
        value: 1.5,
        label: '150%', 
    },
    {
        value: 2,
        label: '200%', 
    },
    {
        value: 3,
        label: '300%', 
    },
];

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;

function handleZoomIn() {
    const newZoom = Math.min(zoom + ZOOM_STEP, ZOOM_MAX);
    emit('update:zoom', newZoom);
}

function handleZoomOut() {
    const newZoom = Math.max(zoom - ZOOM_STEP, ZOOM_MIN);
    emit('update:zoom', newZoom);
}

function isPresetActive(presetValue: number) {
    return Math.abs(zoom - presetValue) < 0.01;
}

function isFitModeActive(mode: TFitMode) {
    return fitMode === mode && Math.abs(zoom - 1) < 0.01;
}

function handleSetZoom(level: number) {
    emit('update:zoom', level);
    close();
}

function handleSetFitMode(mode: TFitMode) {
    emit('update:fitMode', mode);
    close();
}

function applyCustomZoom() {
    const parsed = Number.parseFloat(customZoomValue.value);

    if (Number.isFinite(parsed) && parsed >= 25 && parsed <= 500) {
        const normalizedZoom = parsed / 100;
        emit('update:zoom', normalizedZoom);
        customZoomValue.value = '';
        close();
    }
}
</script>

<style scoped>
.zoom-controls {
    display: flex;
    align-items: center;
    gap: 0;
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
}


.zoom-controls-display {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.5rem;
    min-width: 4rem;
    height: 2rem;
    background: transparent;
    border: none;
    border-left: 1px solid var(--ui-border);
    border-right: 1px solid var(--ui-border);
    cursor: pointer;
    transition: background-color 150ms ease;
}

.zoom-controls-display:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.zoom-controls-display:hover:not(:disabled) {
    background-color: var(--ui-bg-elevated);
}

.zoom-controls-display-value {
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
    color: var(--ui-text);
}

.zoom-dropdown {
    padding: 0.25rem;
    min-width: 12rem;
}

.zoom-dropdown-section {
    display: flex;
    flex-direction: column;
}

.zoom-dropdown-divider {
    height: 1px;
    background-color: var(--ui-border);
    margin: 0.25rem 0;
}

.zoom-dropdown-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 0.375rem;
    color: var(--ui-text);
    font-size: 0.875rem;
    text-align: left;
    transition: background-color 150ms ease;
}

.zoom-dropdown-item:hover {
    background-color: var(--ui-bg-elevated);
}

.zoom-dropdown-item.is-active {
    color: var(--ui-primary);
}

.zoom-dropdown-label {
    flex: 1;
}

.zoom-dropdown-icon {
    color: var(--ui-text-muted);
}

.zoom-dropdown-item.is-active .zoom-dropdown-icon {
    color: var(--ui-primary);
}

.zoom-dropdown-check {
    color: var(--ui-primary);
}

.zoom-dropdown-custom {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
}

.zoom-dropdown-input {
    flex: 1;
}

.zoom-dropdown-input :deep(input) {
    text-align: center;
    padding-right: 1.75rem;
}

.zoom-dropdown-input :deep([data-slot='trailing']) {
    pointer-events: none;
}
</style>
