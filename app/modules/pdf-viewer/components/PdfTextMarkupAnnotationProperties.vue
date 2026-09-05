<template>
    <div
        v-if="markup"
        class="annotation-properties"
        :style="positionStyle"
        @pointerdown.stop
        @click.stop
    >
        <div class="annotation-properties-header">
            <span class="annotation-properties-title">{{ markupLabel }}</span>
            <UButton
                icon="i-ph-x"
                variant="ghost"
                color="neutral"
                size="xs"
                :aria-label="t('annotationProperties.close')"
                @click="close"
            />
        </div>

        <div class="annotation-properties-body flex flex-col gap-2">
            <label class="annotation-properties-field">
                <span class="annotation-properties-label">{{ t('annotationProperties.color') }}</span>
                <input
                    type="color"
                    :value="markup.color"
                    class="annotation-properties-color"
                    data-testid="annotation-properties-color"
                    @input="updateColor"
                >
            </label>

            <label class="annotation-properties-field">
                <span class="annotation-properties-label">{{ t('annotationProperties.opacity') }}</span>
                <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    class="annotation-properties-range"
                    :aria-label="t('annotationProperties.opacity')"
                    data-testid="annotation-properties-opacity"
                    :value="opacity"
                    @input="updateOpacityPreview"
                    @change="commitOpacity"
                >
                <span class="annotation-properties-value">{{ Math.round(opacity * 100) }}%</span>
            </label>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { ITextMarkupAnnotationProperties } from '@app/types/annotations';

const { t } = useTypedI18n();

const {
    markup,
    x,
    y,
} = defineProps<{
    markup: ITextMarkupAnnotationProperties | null;
    x: number;
    y: number;
}>();

const opacity = ref(1);

const emit = defineEmits<{
    'update-color': [color: string];
    'update-opacity': [opacity: number];
    close: [];
}>();

const markupLabel = computed(() => {
    if (markup?.subtype === 'Underline') {
        return t('annotations.underline');
    }
    if (markup?.subtype === 'StrikeOut') {
        return t('annotations.strikethrough');
    }
    if (markup?.subtype === 'Squiggly') {
        return t('annotations.squiggly');
    }
    return t('annotations.highlight');
});

const positionStyle = computed(() => ({
    left: `${x}px`,
    top: `${y}px`,
}));

function normalizeOpacity(value: unknown) {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : null;
}

watch(() => markup?.opacity, (value) => {
    opacity.value = normalizeOpacity(value) ?? 1;
}, {immediate: true});

function updateColor(event: Event) {
    if (event.target instanceof HTMLInputElement) {
        emit('update-color', event.target.value);
    }
}

function updateOpacityPreview(event: Event) {
    if (event.target instanceof HTMLInputElement) {
        const nextOpacity = normalizeOpacity(event.target.value);
        if (nextOpacity !== null) {
            opacity.value = nextOpacity;
        }
    }
}

function commitOpacity(event: Event) {
    const source = event.target instanceof HTMLInputElement
        ? event.target.value
        : opacity.value;
    const nextOpacity = normalizeOpacity(source);
    if (nextOpacity !== null) {
        opacity.value = nextOpacity;
        emit('update-opacity', nextOpacity);
    }
}

function close() {
    emit('close');
}
</script>

<style scoped>
.annotation-properties {
    position: fixed;
    z-index: var(--app-pdf-annotation-properties-z-index);
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-pdf-annotation-properties-radius);
    box-shadow: var(--app-pdf-popover-shadow);
    width: min(var(--app-pdf-annotation-properties-width), var(--app-pdf-annotation-properties-max-inline-size));
    min-width: min(var(--app-pdf-annotation-properties-min-width), var(--app-pdf-annotation-properties-max-inline-size));
    max-width: var(--app-pdf-annotation-properties-max-inline-size);
    font-size: var(--app-pdf-annotation-properties-font-size);
}

.annotation-properties-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--app-pdf-annotation-properties-header-padding);
    border-bottom: 1px solid var(--ui-border);
}

.annotation-properties-title {
    font-weight: 600;
    font-size: var(--app-pdf-annotation-properties-title-font-size);
    text-transform: uppercase;
    letter-spacing: var(--app-pdf-annotation-properties-title-letter-spacing);
    color: var(--ui-text-muted);
    overflow-wrap: anywhere;
}

.annotation-properties-body {
    padding: var(--app-pdf-annotation-properties-body-padding);
}

.annotation-properties-field {
    display: grid;
    grid-template-columns: minmax(88px, auto) minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--app-space-3xl) var(--app-space-6xl);
}

.annotation-properties-label {
    font-size: var(--app-pdf-annotation-properties-title-font-size);
    color: var(--ui-text-muted);
    line-height: 1.25;
    overflow-wrap: anywhere;
}

.annotation-properties-color {
    grid-column: -1;
    justify-self: start;
    width: var(--app-pdf-annotation-properties-color-size);
    height: var(--app-pdf-annotation-properties-color-size);
    padding: var(--app-pdf-annotation-properties-color-padding);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-xs);
    background: transparent;
}

.annotation-properties-range {
    min-width: 0;
    width: 100%;
    height: var(--app-range-track-height);
    accent-color: var(--ui-text);
}

.annotation-properties-value {
    width: var(--app-pdf-annotation-properties-value-min-width);
    text-align: right;
    font-size: var(--app-text-size-micro);
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
}
</style>
