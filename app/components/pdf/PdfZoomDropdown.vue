<template>
    <div class="zoom-controls">
        <div class="zoom-controls-item">
            <UTooltip :text="t('zoom.zoomOut')" :delay-duration="1200">
                <UButton
                    icon="i-lucide-minus"
                    variant="ghost"
                    color="neutral"
                    :disabled="disabled || zoom <= ZOOM.MIN"
                    class="zoom-controls-button"
                    :aria-label="t('zoom.zoomOut')"
                    @click="handleZoomOut"
                />
            </UTooltip>
        </div>

        <div class="zoom-controls-item">
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
                                    ref="customZoomInputRef"
                                    v-model="customZoomValue"
                                    class="zoom-dropdown-input"
                                    type="number"
                                    inputmode="decimal"
                                    min="25"
                                    max="500"
                                    step="1"
                                    :placeholder="t('zoom.custom')"
                                    @keydown.enter.prevent="applyCustomZoom"
                                >
                                    <template #trailing>%</template>
                                </UInput>
                                <UTooltip :text="t('zoom.apply')" :delay-duration="1200">
                                    <UButton
                                        icon="i-lucide-check"
                                        size="xs"
                                        variant="soft"
                                        :aria-label="t('zoom.apply')"
                                        @click="applyCustomZoom"
                                    />
                                </UTooltip>
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
                                <span class="zoom-dropdown-label">{{ t('zoom.fitWidth') }}</span>
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
                                <span class="zoom-dropdown-label">{{ t('zoom.fitHeight') }}</span>
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
        </div>

        <div class="zoom-controls-item">
            <UTooltip :text="t('zoom.zoomIn')" :delay-duration="1200">
                <UButton
                    icon="i-lucide-plus"
                    variant="ghost"
                    color="neutral"
                    :disabled="disabled || zoom >= ZOOM.MAX"
                    class="zoom-controls-button"
                    :aria-label="t('zoom.zoomIn')"
                    @click="handleZoomIn"
                />
            </UTooltip>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { TFitMode } from '@app/types/shared';
import { nextTick } from 'vue';
import { ZOOM } from '@app/constants/pdf-layout';

const { t } = useI18n();

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
const customZoomInputRef = ref<{ $el: HTMLElement } | null>(null);

function close() {
    isOpen.value = false;
}

defineExpose({ close });

watch(isOpen, (value) => {
    if (value) {
        emit('open');
        void nextTick(() => {
            const input = customZoomInputRef.value?.$el?.querySelector('input') as HTMLInputElement | null;
            input?.focus();
            input?.select();
        });
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

const zoomPresets = ZOOM.PRESETS;

function handleZoomIn() {
    const newZoom = Math.min(zoom + ZOOM.STEP, ZOOM.MAX);
    emit('update:zoom', newZoom);
}

function handleZoomOut() {
    const newZoom = Math.max(zoom - ZOOM.STEP, ZOOM.MIN);
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
    emit('update:zoom', 1);
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
    border: 1px solid var(--app-toolbar-group-border);
    border-radius: 0.375rem;
    overflow: hidden;
}

.zoom-controls-item {
    display: flex;
    border-radius: 0;
}

.zoom-controls-item + .zoom-controls-item {
    border-left: 1px solid var(--app-toolbar-group-border);
}

.zoom-controls-button {
    border-radius: 0 !important;
    height: var(--toolbar-control-height, 2.25rem);
    min-width: var(--toolbar-control-height, 2.25rem);
    padding: 0.25rem;
    font-size: var(--toolbar-icon-size, 18px);
}

.zoom-controls-button :deep(svg) {
    width: 1.1rem;
    height: 1.1rem;
}

.zoom-controls-display {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.5rem;
    min-width: 4rem;
    height: var(--toolbar-control-height, 2.25rem);
    background: transparent;
    border: none;
    border-radius: 0;
    cursor: pointer;
    color: var(--ui-text);
    transition: background-color 0.1s ease, box-shadow 0.1s ease;
}

.zoom-controls-display:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.zoom-controls-display:focus {
    outline: none;
}

.zoom-controls-display:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.zoom-controls-display:hover:not(:disabled) {
    background-color: var(--app-toolbar-control-hover-bg);
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
    color: var(--ui-text);
}

.zoom-dropdown-label {
    flex: 1;
}

.zoom-dropdown-icon {
    color: var(--ui-text-muted);
}

.zoom-dropdown-item.is-active .zoom-dropdown-icon {
    color: var(--ui-text);
}

.zoom-dropdown-check {
    color: var(--ui-text);
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
