<template>
    <UPopover v-model:open="isOpen" mode="click" :disabled="disabled">
        <UButton
            icon="i-lucide-zoom-in"
            variant="ghost"
            color="neutral"
            :disabled="disabled"
        >
            <span>Zoom</span>
        </UButton>

        <template #content>
            <div class="zoom-dropdown">
                <div class="zoom-dropdown__section">
                    <button
                        v-for="preset in zoomPresets"
                        :key="preset.value"
                        :class="[
                            'zoom-dropdown__item',
                            {
                                'zoom-dropdown__item--active': isPresetActive(
                                    preset.value,
                                ),
                            },
                        ]"
                        @click="handleSetZoom(preset.value)"
                    >
                        <span class="zoom-dropdown__label">{{
                            preset.label
                        }}</span>
                        <UIcon
                            v-if="isPresetActive(preset.value)"
                            name="i-lucide-check"
                            class="zoom-dropdown__check size-4"
                        />
                    </button>
                </div>

                <div class="zoom-dropdown__divider" />

                <div class="zoom-dropdown__section">
                    <div class="zoom-dropdown__custom">
                        <UInput
                            v-model="customZoomValue"
                            class="zoom-dropdown__input"
                            type="number"
                            inputmode="decimal"
                            min="50"
                            max="1000"
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

                <div class="zoom-dropdown__divider" />

                <div class="zoom-dropdown__section">
                    <button
                        :class="[
                            'zoom-dropdown__item',
                            {
                                'zoom-dropdown__item--active':
                                    isFitModeActive('width'),
                            },
                        ]"
                        @click="handleSetFitMode('width')"
                    >
                        <UIcon
                            name="i-lucide-move-horizontal"
                            class="zoom-dropdown__icon size-5"
                        />
                        <span class="zoom-dropdown__label">Fit Width</span>
                        <UIcon
                            v-if="isFitModeActive('width')"
                            name="i-lucide-check"
                            class="zoom-dropdown__check size-4"
                        />
                    </button>
                    <button
                        :class="[
                            'zoom-dropdown__item',
                            {
                                'zoom-dropdown__item--active':
                                    isFitModeActive('height'),
                            },
                        ]"
                        @click="handleSetFitMode('height')"
                    >
                        <UIcon
                            name="i-lucide-move-vertical"
                            class="zoom-dropdown__icon size-5"
                        />
                        <span class="zoom-dropdown__label">Fit Height</span>
                        <UIcon
                            v-if="isFitModeActive('height')"
                            name="i-lucide-check"
                            class="zoom-dropdown__check size-4"
                        />
                    </button>
                </div>
            </div>
        </template>
    </UPopover>
</template>

<script setup lang="ts">
type TFitMode = 'width' | 'height';

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
        value: 1.5,
        label: '150%', 
    },
    {
        value: 2,
        label: '200%', 
    },
    {
        value: 4,
        label: '400%', 
    },
];

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

    if (Number.isFinite(parsed) && parsed >= 50 && parsed <= 1000) {
        const normalizedZoom = parsed / 100;
        emit('update:zoom', normalizedZoom);
        customZoomValue.value = '';
        close();
    }
}
</script>

<style scoped>
.zoom-dropdown {
    padding: 0.25rem;
    min-width: 12rem;
}

.zoom-dropdown__section {
    display: flex;
    flex-direction: column;
}

.zoom-dropdown__divider {
    height: 1px;
    background-color: var(--ui-border);
    margin: 0.25rem 0;
}

.zoom-dropdown__item {
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

.zoom-dropdown__item:hover {
    background-color: var(--ui-bg-elevated);
}

.zoom-dropdown__item--active {
    color: var(--ui-primary);
}

.zoom-dropdown__label {
    flex: 1;
}

.zoom-dropdown__icon {
    color: var(--ui-text-muted);
}

.zoom-dropdown__item--active .zoom-dropdown__icon {
    color: var(--ui-primary);
}

.zoom-dropdown__check {
    color: var(--ui-primary);
}

.zoom-dropdown__custom {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
}

.zoom-dropdown__input {
    flex: 1;
}

.zoom-dropdown__input :deep(input) {
    text-align: center;
    padding-right: 1.75rem;
}

.zoom-dropdown__input :deep([data-slot='trailing']) {
    pointer-events: none;
}
</style>
