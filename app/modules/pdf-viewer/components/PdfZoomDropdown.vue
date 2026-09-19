<template>
    <div :class="['zoom-controls', `zoom-controls--compact-${effectiveCompactLevel}`]">
        <div v-if="showStepButtons" class="zoom-controls-item">
            <ToolbarButton
                icon="ph:minus"
                :tooltip="t('zoom.zoomOut')"
                :shortcut="shortcutLabels.zoomOut"
                :disabled="disabled || normalizedEffectiveZoom <= ZOOM.MIN"
                grouped
                icon-class="size-[var(--app-toolbar-icon-size)]"
                @click="handleZoomOut"
            />
        </div>

        <div class="zoom-controls-item zoom-controls-item--display">
            <button
                v-if="disabled"
                class="zoom-controls-display"
                disabled
            >
                <span class="zoom-controls-display-value">{{ zoomDisplay }}</span>
            </button>

            <UPopover v-else v-model:open="isOpen" mode="click">
                <button
                    class="zoom-controls-display"
                >
                    <span class="zoom-controls-display-value">{{ zoomDisplay }}</span>
                </button>

                <template #content>
                    <div class="zoom-dropdown app-floating-scroll-region app-scrollbar app-scroll-region--balanced">
                        <div class="zoom-chip-grid">
                            <button
                                v-for="preset in zoomPresets"
                                :key="preset.value"
                                :class="['zoom-chip', { 'is-active': isPresetActive(preset.value) }]"
                                @click="handleSetZoom(preset.value)"
                            >
                                {{ preset.label }}
                            </button>
                            <div class="zoom-chip zoom-chip-custom">
                                <input
                                    ref="customInputRef"
                                    v-model="customZoomValue"
                                    class="zoom-chip-custom-input"
                                    type="text"
                                    inputmode="decimal"
                                    :aria-label="t('zoom.custom')"
                                    @keydown.enter.prevent="applyCustomZoom"
                                    @focus="selectCustomZoomInput"
                                />
                                <span class="zoom-chip-custom-suffix">%</span>
                            </div>
                        </div>

                        <div class="zoom-divider" />

                        <div class="zoom-toggle-group">
                            <button
                                :class="['zoom-toggle-btn', { 'is-active': isFitModeActive('width') }]"
                                @click="handleSetFitMode('width')"
                            >
                                <UIcon name="i-ph-arrows-out-line-horizontal" class="zoom-toggle-icon" />
                                <span class="zoom-toggle-label">{{ t('zoom.fitWidth') }}</span>
                            </button>
                            <button
                                :class="['zoom-toggle-btn', { 'is-active': isFitModeActive('height') }]"
                                @click="handleSetFitMode('height')"
                            >
                                <UIcon name="i-ph-arrows-out-line-vertical" class="zoom-toggle-icon" />
                                <span class="zoom-toggle-label">{{ t('zoom.fitHeight') }}</span>
                            </button>
                        </div>

                        <div v-if="canUseViewModes" class="zoom-divider" />

                        <div v-if="canUseViewModes" class="zoom-toggle-group zoom-toggle-group--view-modes">
                            <button
                                :class="['zoom-toggle-btn', { 'is-active': isViewModeActive('single') }]"
                                :aria-label="t('zoom.singlePage')"
                                @click="handleSetViewMode('single')"
                            >
                                <UIcon name="i-ph-file" class="zoom-toggle-icon" />
                                <span class="zoom-toggle-label">{{ t('zoom.singleShort') }}</span>
                            </button>
                            <button
                                :class="['zoom-toggle-btn', { 'is-active': isViewModeActive('facing') }]"
                                :aria-label="t('zoom.facingPages')"
                                @click="handleSetViewMode('facing')"
                            >
                                <UIcon name="i-ph-book-open" class="zoom-toggle-icon" />
                                <span class="zoom-toggle-label">{{ t('zoom.facingShort') }}</span>
                            </button>
                            <button
                                :class="['zoom-toggle-btn', { 'is-active': isViewModeActive('facing-first-single') }]"
                                :aria-label="t('zoom.facingWithFirstSingle')"
                                @click="handleSetViewMode('facing-first-single')"
                            >
                                <span class="zoom-toggle-icon-badge">
                                    <UIcon name="i-ph-book-open" class="size-4" />
                                    <span class="zoom-badge">1</span>
                                </span>
                                <span class="zoom-toggle-label">{{ t('zoom.facingFirstShort') }}</span>
                            </button>
                        </div>
                    </div>
                </template>
            </UPopover>
        </div>

        <div v-if="showStepButtons" class="zoom-controls-item">
            <ToolbarButton
                icon="ph:plus"
                :tooltip="t('zoom.zoomIn')"
                :shortcut="shortcutLabels.zoomIn"
                :disabled="disabled || normalizedEffectiveZoom >= ZOOM.MAX"
                grouped
                icon-class="size-[var(--app-toolbar-icon-size)]"
                @click="handleZoomIn"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import { clamp } from 'es-toolkit/math';
import { useClamp } from '@vueuse/math';
import type {
    TFitMode,
    TZoomMode,
    TPdfViewMode,
} from '@contracts/shared';
import { ZOOM } from '@app/constants/pdfLayout';
import { clampPdfManualZoom } from '@app/modules/pdf-viewer/runtime/zoom/resolvePdfZoomScale';
import { useShortcutLabels } from '@app/constants/shortcuts';
import ToolbarButton from '@app/components/ToolbarButton.vue';

const { t } = useTypedI18n();

interface IProps {
    zoom: number;
    effectiveZoom: number;
    zoomMode: TZoomMode;
    fitMode: TFitMode;
    viewMode: TPdfViewMode;
    open: boolean;
    disabled?: boolean;
    canUseViewModes?: boolean;
    compactLevel?: number;
}

const {
    zoom,
    effectiveZoom,
    zoomMode,
    viewMode,
    open,
    canUseViewModes = true,
    disabled = false,
    compactLevel = 0,
} = defineProps<IProps>();

const emit = defineEmits<{
    'update:zoom': [level: number];
    'update:effectiveZoom': [level: number];
    'update:zoomMode': [mode: TZoomMode];
    'update:fitMode': [mode: TFitMode];
    'update:viewMode': [mode: TPdfViewMode];
    'update:open': [value: boolean];
    'fit-width': [];
    'fit-height': [];
}>();

const isOpen = computed({
    get: () => open,
    set: (value: boolean) => emit('update:open', value),
});
const customZoomValue = ref(formatZoomValue(zoom));
const customInputRef = ref<HTMLInputElement | null>(null);

const effectiveCompactLevel = useClamp(() => compactLevel, 0, 2);

const showStepButtons = computed(() => true);
const shortcutLabels = useShortcutLabels();

function normalizeZoomLevel(value: number) {
    return clampPdfManualZoom(value);
}

function normalizeDisplayZoomLevel(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
        return 1;
    }
    return clamp(value, ZOOM.FIT_MIN, ZOOM.MAX);
}

const normalizedZoom = computed(() => normalizeZoomLevel(zoom));
const normalizedEffectiveZoom = computed(() => {
    if (typeof effectiveZoom === 'number' && Number.isFinite(effectiveZoom)) {
        return normalizeDisplayZoomLevel(effectiveZoom);
    }
    return normalizedZoom.value;
});

function close() {
    isOpen.value = false;
}

watch(isOpen, (open) => {
    if (open) {
        customZoomValue.value = formatZoomValue(normalizedEffectiveZoom.value);
        void nextTick(() => {
            customInputRef.value?.focus();
            customInputRef.value?.select();
        });
    }
});

watch(
    () => normalizedEffectiveZoom.value,
    (value) => {
        customZoomValue.value = formatZoomValue(value);
    },
    { immediate: true },
);

function formatZoomValue(value: number) {
    return Math.round(value * 100).toString();
}

const zoomDisplay = computed(() => {
    if (disabled) {
        return '-';
    }
    return `${Math.round(normalizedEffectiveZoom.value * 100)}%`;
});

const zoomPresets = ZOOM.PRESETS;

function handleZoomIn() {
    setCustomZoomFromDisplay(Math.min(normalizedEffectiveZoom.value + ZOOM.STEP, ZOOM.MAX));
}

function handleZoomOut() {
    if (normalizedEffectiveZoom.value <= ZOOM.MIN) {
        return;
    }
    setCustomZoomFromDisplay(Math.max(normalizedEffectiveZoom.value - ZOOM.STEP, ZOOM.MIN));
}

function isPresetActive(presetValue: number) {
    return Math.abs(normalizedEffectiveZoom.value - presetValue) < 0.01;
}

function isFitModeActive(mode: TFitMode) {
    const expectedZoomMode: TZoomMode = mode === 'height'
        ? 'fit-height'
        : 'fit-width';
    return zoomMode === expectedZoomMode;
}

function setCustomZoomFromDisplay(displayZoom: number) {
    const nextDisplayZoom = normalizeZoomLevel(displayZoom);
    emit('update:zoom', nextDisplayZoom);
    emit('update:effectiveZoom', nextDisplayZoom);
    emit('update:zoomMode', 'custom');
}

function handleSetZoom(level: number) {
    setCustomZoomFromDisplay(normalizeZoomLevel(level));
    close();
}

function handleSetFitMode(mode: TFitMode) {
    emit('update:fitMode', mode);
    if (mode === 'height') {
        emit('fit-height');
    } else {
        emit('fit-width');
    }
    close();
}

function isViewModeActive(mode: TPdfViewMode) {
    return viewMode === mode;
}

function handleSetViewMode(mode: TPdfViewMode) {
    emit('update:viewMode', mode);
    close();
}

function applyCustomZoom() {
    const parsed = Number.parseFloat(customZoomValue.value);
    if (!Number.isFinite(parsed)) {
        customZoomValue.value = formatZoomValue(normalizedEffectiveZoom.value);
        void nextTick(() => {
            customInputRef.value?.select();
        });
        return;
    }

    const displayZoom = normalizeZoomLevel(parsed / 100);
    setCustomZoomFromDisplay(displayZoom);
    customZoomValue.value = formatZoomValue(displayZoom);
    close();
}

function selectCustomZoomInput(event: FocusEvent) {
    if (event.target instanceof HTMLInputElement) {
        event.target.select();
    }
}
</script>

<style scoped>
.zoom-controls {
    --zoom-control-side-width: var(--toolbar-control-height, 2.25rem);
    --zoom-control-display-width: 6.5rem;

    display: flex;
    align-items: center;
    gap: 0;
    padding: 0;
    border: 1px solid var(--app-toolbar-group-border);
    border-radius: var(--app-toolbar-segmented-radius);
    background: var(--app-toolbar-group-bg);
    overflow: hidden;
}

.zoom-controls-item {
    display: flex;
    align-items: stretch;
}

.zoom-controls-item :deep(.toolbar-btn) {
    width: var(--zoom-control-side-width);
    min-width: var(--zoom-control-side-width);
    max-width: var(--zoom-control-side-width);
    height: var(--toolbar-control-height, 2.25rem);
    border-radius: 0;
}

.zoom-controls-item--display {
    flex: 0 0 var(--zoom-control-display-width);
}

.zoom-controls-display {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    width: 100%;
    min-width: 100%;
    max-width: 100%;
    height: var(--toolbar-control-height, 2.25rem);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 0;
    cursor: pointer;
    color: var(--ui-text);
    transition: background-color 0.1s ease, border-color 0.1s ease, box-shadow 0.1s ease;
}

.zoom-controls--compact-2 .zoom-controls-display {
    width: 100%;
    min-width: 100%;
    max-width: 100%;
}

.zoom-controls--compact-2 {
    --zoom-control-display-width: 5.5rem;
}

.zoom-controls-display:disabled {
    opacity: 0.5;
}

.zoom-controls-display:focus {
    outline: none;
}

.zoom-controls-display:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.zoom-controls-display:hover:not(:disabled) {
    background-color: var(--app-toolbar-control-hover-bg);
    border-color: var(--app-toolbar-control-hover-border);
}

.zoom-controls-display-value {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--app-text-size-body);
    line-height: 1;
    font-family: var(--app-font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--ui-text);
}

.zoom-dropdown {
    padding: 0.375rem;
    width: min(var(--app-pdf-zoom-menu-width), var(--app-overlay-viewport-width));
    max-width: var(--app-overlay-viewport-width);
    background: var(--app-toolbar-group-bg);
}

.zoom-divider {
    height: var(--app-zoom-menu-separator-height);
    background-color: var(--app-toolbar-separator);
    margin: 0.375rem 0;
}

.zoom-chip-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.125rem;
}

.zoom-chip,
.zoom-toggle-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: var(--app-zoom-control-min-height);
    padding: 0 0.375rem;
    border: 1px solid transparent;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--app-toolbar-control-inactive-fg);
    font-size: var(--app-text-size-body-sm);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition: background-color 100ms ease, border-color 100ms ease, color 100ms ease;
}

.zoom-chip:hover,
.zoom-toggle-btn:hover {
    background-color: var(--app-toolbar-control-hover-bg);
    border-color: var(--app-toolbar-control-hover-border);
    color: var(--app-toolbar-control-hover-fg);
}

.zoom-chip.is-active,
.zoom-toggle-btn.is-active {
    background-color: var(--app-toolbar-control-active-bg);
    border-color: var(--app-toolbar-control-active-border);
    color: var(--app-toolbar-control-hover-fg);
    font-weight: 600;
}

.zoom-chip.is-active:hover,
.zoom-toggle-btn.is-active:hover {
    background-color: var(--app-toolbar-control-active-hover-bg);
    border-color: var(--app-toolbar-control-active-hover-border);
}

.zoom-chip:focus-visible,
.zoom-toggle-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.zoom-chip-custom {
    position: relative;
    cursor: text;
    background-color: var(--app-toolbar-control-active-bg);
    border-color: var(--app-toolbar-control-active-border);
    color: var(--app-toolbar-control-hover-fg);
    padding: 0;
}

.zoom-chip-custom:hover {
    background-color: var(--app-toolbar-control-active-bg);
    border-color: var(--app-toolbar-control-active-border);
}

.zoom-chip-custom:focus-within {
    border-color: var(--app-toolbar-focus-ring);
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.zoom-chip-custom-input {
    min-width: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    border: none;
    text-align: center;
    font-size: var(--app-text-size-body-sm);
    font-variant-numeric: tabular-nums;
    color: var(--ui-text);
    padding: 0 0.875rem 0 0;
    outline: none;
}

.zoom-chip-custom-suffix {
    position: absolute;
    right: 0.375rem;
    top: 50%;
    transform: translateY(-50%);
    font-size: var(--app-text-size-micro);
    color: var(--ui-text-dimmed);
    pointer-events: none;
}

.zoom-toggle-group {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(7rem, 100%), 1fr));
    gap: 0.125rem;
}

.zoom-toggle-group--view-modes {
    grid-template-columns: repeat(3, minmax(0, 1fr));
}

.zoom-toggle-btn {
    gap: 0.375rem;
    min-width: 0;
    padding: 0.25rem 0.5rem;
}

.zoom-toggle-icon {
    width: var(--app-zoom-icon-size);
    height: var(--app-zoom-icon-size);
    flex-shrink: 0;
}

.zoom-toggle-label {
    min-width: 0;
    overflow-wrap: anywhere;
    line-height: 1.15;
}

.zoom-toggle-icon-badge {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
    width: var(--app-zoom-icon-size);
    height: var(--app-zoom-icon-size);
}

.zoom-badge {
    position: absolute;
    top: -0.125rem;
    right: -0.3125rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 0.75rem;
    height: 0.75rem;
    padding: 0 0.125rem;
    border-radius: var(--app-radius-full);
    border: 1px solid var(--ui-border);
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-tiny);
    line-height: 1;
    font-weight: 700;
}

.zoom-toggle-btn.is-active .zoom-badge {
    color: var(--ui-text);
}

</style>
