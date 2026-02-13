<template>
    <div
        v-if="shape"
        class="annotation-properties"
        :style="positionStyle"
        @pointerdown.stop
        @click.stop
    >
        <div class="annotation-properties-header">
            <span class="annotation-properties-title">{{ shapeLabel }}</span>
            <UButton
                icon="i-lucide-x"
                variant="ghost"
                color="neutral"
                size="xs"
                :aria-label="t('annotationProperties.close')"
                @click="emit('close')"
            />
        </div>

        <div class="annotation-properties-body">
            <label class="annotation-properties-field">
                <span class="annotation-properties-label">{{ t('annotationProperties.color') }}</span>
                <input
                    type="color"
                    :value="shape.color"
                    class="annotation-properties-color"
                    @input="updateProperty('color', ($event.target as HTMLInputElement).value)"
                >
            </label>

            <label v-if="shape.type === 'rectangle' || shape.type === 'circle'" class="annotation-properties-field">
                <span class="annotation-properties-label">{{ t('annotationProperties.fill') }}</span>
                <div class="annotation-properties-fill-row">
                    <input
                        type="color"
                        :value="effectiveFillColor"
                        class="annotation-properties-color"
                        :disabled="!hasFill"
                        @input="updateProperty('fillColor', ($event.target as HTMLInputElement).value)"
                    >
                    <label class="annotation-properties-checkbox">
                        <input
                            type="checkbox"
                            :checked="hasFill"
                            @change="toggleFill"
                        >
                        {{ t('annotationProperties.fill') }}
                    </label>
                </div>
            </label>

            <label class="annotation-properties-field">
                <span class="annotation-properties-label">{{ t('annotationProperties.stroke') }}</span>
                <input
                    type="range"
                    :value="shape.strokeWidth"
                    min="1"
                    max="10"
                    step="0.5"
                    class="annotation-properties-range"
                    @input="updateProperty('strokeWidth', Number(($event.target as HTMLInputElement).value))"
                >
                <span class="annotation-properties-value">{{ shape.strokeWidth }}px</span>
            </label>

            <label class="annotation-properties-field">
                <span class="annotation-properties-label">{{ t('annotationProperties.opacity') }}</span>
                <input
                    type="range"
                    :value="shape.opacity"
                    min="0.1"
                    max="1"
                    step="0.1"
                    class="annotation-properties-range"
                    @input="updateProperty('opacity', Number(($event.target as HTMLInputElement).value))"
                >
                <span class="annotation-properties-value">{{ Math.round(shape.opacity * 100) }}%</span>
            </label>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { IShapeAnnotation } from '@app/types/annotations';

const { t } = useI18n();

interface IProps {
    shape: IShapeAnnotation | null;
    x: number;
    y: number;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update', updates: Partial<IShapeAnnotation>): void;
    (e: 'close'): void;
}>();

const shapeLabel = computed(() => {
    switch (props.shape?.type) {
        case 'rectangle': return t('annotationProperties.rectangle');
        case 'circle': return t('annotationProperties.ellipse');
        case 'line': return t('annotationProperties.line');
        case 'arrow': return t('annotationProperties.arrow');
        default: return t('annotationProperties.shape');
    }
});

const hasFill = computed(() => {
    const fill = props.shape?.fillColor;
    return !!fill && fill !== 'transparent' && fill !== 'none';
});

const effectiveFillColor = computed(() => {
    if (hasFill.value) {
        return props.shape?.fillColor ?? '#ffffff';
    }
    return '#ffffff';
});

const positionStyle = computed(() => ({
    left: `${props.x}px`,
    top: `${props.y}px`,
}));

function updateProperty<K extends keyof IShapeAnnotation>(key: K, value: IShapeAnnotation[K]) {
    emit('update', { [key]: value });
}

function toggleFill() {
    if (hasFill.value) {
        emit('update', { fillColor: 'transparent' });
    } else {
        emit('update', { fillColor: props.shape?.color ?? '#2563eb' });
    }
}
</script>

<style scoped>
.annotation-properties {
    position: fixed;
    z-index: 100;
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 0.15);
    min-width: 200px;
    max-width: 260px;
    font-size: 12px;
}

.annotation-properties-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 6px 6px 10px;
    border-bottom: 1px solid var(--ui-border);
}

.annotation-properties-title {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--ui-text-muted);
}

.annotation-properties-body {
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.annotation-properties-field {
    display: flex;
    align-items: center;
    gap: 8px;
}

.annotation-properties-label {
    flex-shrink: 0;
    width: 44px;
    font-size: 11px;
    color: var(--ui-text-muted);
}

.annotation-properties-color {
    width: 28px;
    height: 28px;
    padding: 1px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    cursor: pointer;
    background: transparent;
}

.annotation-properties-color:disabled {
    opacity: 0.4;
    cursor: default;
}

.annotation-properties-fill-row {
    display: flex;
    align-items: center;
    gap: 8px;
}

.annotation-properties-checkbox {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--ui-text-muted);
    cursor: pointer;
}

.annotation-properties-range {
    flex: 1;
    min-width: 60px;
    appearance: none;
    height: 4px;
    border-radius: 2px;
    background: var(--ui-border);
    outline: none;
    cursor: pointer;
}

.annotation-properties-range::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--ui-primary);
    border: 2px solid var(--ui-bg);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
    cursor: pointer;
}

.annotation-properties-value {
    flex-shrink: 0;
    width: 36px;
    text-align: right;
    font-size: 11px;
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
}
</style>
