<template>
    <div :class="['zoom-controls', `zoom-controls--compact-${effectiveCompactLevel}`]">
        <div v-if="showStepButtons" class="zoom-controls-item">
            <ToolbarButton
                icon="lucide:minus"
                :tooltip="t('zoom.zoomOut')"
                :disabled="disabled || zoom <= ZOOM.MIN"
                grouped
                icon-class="size-[1.1rem]"
                @click="handleZoomOut"
            />
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
                                    :ui="{ base: 'text-center pe-7', trailing: 'pointer-events-none' }"
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

                        <div class="zoom-dropdown-divider" />

                        <div class="zoom-dropdown-section">
                            <button
                                :class="[
                                    'zoom-dropdown-item',
                                    {
                                        'is-active': isViewModeActive('single'),
                                    },
                                ]"
                                @click="handleSetViewMode('single')"
                            >
                                <UIcon
                                    name="i-lucide-file"
                                    class="zoom-dropdown-icon size-5"
                                />
                                <span class="zoom-dropdown-label">{{ t('zoom.singlePage') }}</span>
                                <UIcon
                                    v-if="isViewModeActive('single')"
                                    name="i-lucide-check"
                                    class="zoom-dropdown-check size-4"
                                />
                            </button>
                            <button
                                :class="[
                                    'zoom-dropdown-item',
                                    {
                                        'is-active': isViewModeActive('facing'),
                                    },
                                ]"
                                @click="handleSetViewMode('facing')"
                            >
                                <UIcon
                                    name="i-lucide-book-open"
                                    class="zoom-dropdown-icon size-5"
                                />
                                <span class="zoom-dropdown-label">{{ t('zoom.facingPages') }}</span>
                                <UIcon
                                    v-if="isViewModeActive('facing')"
                                    name="i-lucide-check"
                                    class="zoom-dropdown-check size-4"
                                />
                            </button>
                            <button
                                :class="[
                                    'zoom-dropdown-item',
                                    {
                                        'is-active': isViewModeActive('facing-first-single'),
                                    },
                                ]"
                                @click="handleSetViewMode('facing-first-single')"
                            >
                                <span class="zoom-dropdown-icon zoom-dropdown-icon--facing-first-single">
                                    <UIcon
                                        name="i-lucide-book-open"
                                        class="size-5"
                                    />
                                    <span class="zoom-dropdown-icon-badge">1</span>
                                </span>
                                <span class="zoom-dropdown-label">{{ t('zoom.facingWithFirstSingle') }}</span>
                                <UIcon
                                    v-if="isViewModeActive('facing-first-single')"
                                    name="i-lucide-check"
                                    class="zoom-dropdown-check size-4"
                                />
                            </button>
                        </div>
                    </div>
                </template>
            </UPopover>
        </div>

        <div v-if="showStepButtons" class="zoom-controls-item">
            <ToolbarButton
                icon="lucide:plus"
                :tooltip="t('zoom.zoomIn')"
                :disabled="disabled || zoom >= ZOOM.MAX"
                grouped
                icon-class="size-[1.1rem]"
                @click="handleZoomIn"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import type {
    TFitMode,
    TPdfViewMode,
} from '@app/types/shared';
import { nextTick } from 'vue';
import { ZOOM } from '@app/constants/pdf-layout';

const { t } = useTypedI18n();

interface IProps {
    zoom: number;
    fitMode: TFitMode;
    viewMode: TPdfViewMode;
    open: boolean;
    disabled?: boolean;
    compactLevel?: number;
}

const {
    zoom,
    fitMode,
    viewMode,
    open,
    disabled = false,
    compactLevel = 0,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:zoom', level: number): void;
    (e: 'update:fitMode', mode: TFitMode): void;
    (e: 'update:viewMode', mode: TPdfViewMode): void;
    (e: 'update:open', value: boolean): void;
}>();

const isOpen = computed({
    get: () => open,
    set: (value: boolean) => emit('update:open', value),
});
const customZoomValue = ref(formatZoomValue(zoom));
const customZoomInputRef = ref<{ $el: HTMLElement } | null>(null);

const effectiveCompactLevel = computed(() => {
    return Math.max(0, Math.min(compactLevel, 2));
});

const showStepButtons = computed(() => effectiveCompactLevel.value < 1);

function close() {
    isOpen.value = false;
}

watch(isOpen, (value) => {
    if (value) {
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

function isViewModeActive(mode: TPdfViewMode) {
    return viewMode === mode;
}

function handleSetViewMode(mode: TPdfViewMode) {
    emit('update:viewMode', mode);
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

.zoom-controls--compact-2 .zoom-controls-display {
    min-width: 3.5rem;
    padding: 0 0.375rem;
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

.zoom-dropdown-icon--facing-first-single {
    position: relative;
}

.zoom-dropdown-icon-badge {
    position: absolute;
    top: -0.125rem;
    right: -0.3125rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 0.75rem;
    height: 0.75rem;
    padding: 0 0.125rem;
    border-radius: 999px;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: 0.5625rem;
    line-height: 1;
    font-weight: 700;
}

.zoom-dropdown-item.is-active .zoom-dropdown-icon-badge {
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

</style>
