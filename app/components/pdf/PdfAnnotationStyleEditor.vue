<template>
    <section class="notes-section notes-style">
        <header class="notes-section-header">
            <h3 class="notes-section-title">{{ t('annotations.style') }}</h3>
            <p class="notes-section-description">{{ t('annotations.styleDescription') }}</p>
        </header>

        <div class="style-row">
            <label class="style-label" for="annotation-color-input">{{ t('annotations.color') }}</label>
            <input
                id="annotation-color-input"
                class="style-color"
                type="color"
                :value="activeToolColor"
                @input="handleColorInput(($event.target as HTMLInputElement).value)"
            />
        </div>

        <div class="swatch-row">
            <button
                v-for="swatch in colorSwatches"
                :key="swatch"
                type="button"
                class="swatch"
                :style="{ backgroundColor: swatch }"
                :title="swatch"
                @click="handleColorInput(swatch)"
            />
        </div>

        <div v-if="activeWidthControl" class="style-row style-row-width">
            <label class="style-label" for="annotation-width-input">
                {{ activeWidthControl.label }} {{ activeWidthValue }}
            </label>
            <div class="style-width-control">
                <button
                    type="button"
                    class="style-step-button"
                    :aria-label="t('annotations.decreaseWidth')"
                    @click="nudgeWidth(-activeWidthControl.step)"
                >
                    -
                </button>
                <input
                    id="annotation-width-input"
                    class="style-range"
                    type="range"
                    :min="activeWidthControl.min"
                    :max="activeWidthControl.max"
                    :step="activeWidthControl.step"
                    :value="activeWidthValue"
                    @input="handleWidthInput(Number(($event.target as HTMLInputElement).value))"
                />
                <button
                    type="button"
                    class="style-step-button"
                    :aria-label="t('annotations.increaseWidth')"
                    @click="nudgeWidth(activeWidthControl.step)"
                >
                    +
                </button>
            </div>
        </div>

        <div v-if="tool === 'draw'" class="draw-style-row">
            <span class="style-label">{{ t('annotations.penType') }}</span>
            <div class="draw-style-list">
                <button
                    v-for="preset in drawStylePresets"
                    :key="preset.id"
                    type="button"
                    class="draw-style-button"
                    :class="{ 'is-active': activeDrawStyle === preset.id }"
                    @click="applyDrawStyle(preset.id)"
                >
                    {{ preset.label }}
                </button>
            </div>
        </div>
    </section>
</template>

<script setup lang="ts">
import type {
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdf-colors';
import { ANNOTATION_PROPERTY_RANGES } from '@app/constants/annotation-defaults';

type TDrawStyle = 'pen' | 'pencil' | 'marker';

interface IWidthControl {
    key: 'inkThickness' | 'highlightThickness' | 'shapeStrokeWidth' | 'textSize';
    min: number;
    max: number;
    step: number;
    label: string;
}

interface IDrawStylePreset {
    id: TDrawStyle;
    label: string;
    thickness: number;
    opacity: number;
}

interface IProps {
    tool: TAnnotationTool;
    settings: IAnnotationSettings;
}

const { t } = useI18n();

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'set-tool', tool: TAnnotationTool): void;
    (e: 'update-setting', payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }): void;
}>();

const colorSwatches = ANNOTATION_COLOR_SWATCHES;

const drawStylePresets = computed<IDrawStylePreset[]>(() => [
    {
        id: 'pen',
        label: t('annotations.pen'),
        thickness: 2,
        opacity: 0.95,
    },
    {
        id: 'pencil',
        label: t('annotations.pencil'),
        thickness: 1,
        opacity: 0.55,
    },
    {
        id: 'marker',
        label: t('annotations.marker'),
        thickness: 6,
        opacity: 0.42,
    },
]);

function isShapeTool(tool: TAnnotationTool) {
    return tool === 'rectangle' || tool === 'circle' || tool === 'line' || tool === 'arrow';
}

function updateSetting<K extends keyof IAnnotationSettings>(key: K, value: IAnnotationSettings[K]) {
    emit('update-setting', {
        key,
        value,
    });
}

const activeToolColor = computed(() => {
    if (props.tool === 'draw') {
        return props.settings.inkColor;
    }
    if (props.tool === 'text') {
        return props.settings.textColor;
    }
    if (props.tool === 'underline') {
        return props.settings.underlineColor;
    }
    if (props.tool === 'strikethrough') {
        return props.settings.strikethroughColor;
    }
    if (isShapeTool(props.tool)) {
        return props.settings.shapeColor;
    }

    return props.settings.highlightColor;
});

const activeWidthControl = computed<IWidthControl | null>(() => {
    if (props.tool === 'draw') {
        return {
            key: 'inkThickness',
            ...ANNOTATION_PROPERTY_RANGES.inkThickness,
            label: t('annotations.drawThickness'),
        };
    }

    if (props.tool === 'highlight') {
        return {
            key: 'highlightThickness',
            ...ANNOTATION_PROPERTY_RANGES.highlightThickness,
            label: t('annotations.thickness'),
        };
    }

    if (isShapeTool(props.tool)) {
        return {
            key: 'shapeStrokeWidth',
            ...ANNOTATION_PROPERTY_RANGES.shapeStrokeWidth,
            label: t('annotations.stroke'),
        };
    }

    if (props.tool === 'text') {
        return {
            key: 'textSize',
            ...ANNOTATION_PROPERTY_RANGES.textSize,
            label: t('annotations.textSize'),
        };
    }

    return null;
});

const activeWidthValue = computed(() => {
    if (!activeWidthControl.value) {
        return 0;
    }
    return props.settings[activeWidthControl.value.key];
});

const activeDrawStyle = computed<TDrawStyle>(() => {
    const thickness = props.settings.inkThickness;
    const opacity = props.settings.inkOpacity;

    if (thickness >= 5 || opacity <= 0.45) {
        return 'marker';
    }

    if (thickness <= 1.5 || opacity < 0.75) {
        return 'pencil';
    }

    return 'pen';
});

function handleColorInput(color: string) {
    if (props.tool === 'draw') {
        updateSetting('inkColor', color);
        return;
    }

    if (props.tool === 'underline') {
        updateSetting('underlineColor', color);
        return;
    }

    if (props.tool === 'text') {
        updateSetting('textColor', color);
        return;
    }

    if (props.tool === 'strikethrough') {
        updateSetting('strikethroughColor', color);
        return;
    }

    if (isShapeTool(props.tool)) {
        updateSetting('shapeColor', color);
        return;
    }

    updateSetting('highlightColor', color);
}

function handleWidthInput(width: number) {
    const control = activeWidthControl.value;
    if (!control) {
        return;
    }

    updateSetting(control.key, width);
}

function nudgeWidth(delta: number) {
    const control = activeWidthControl.value;
    if (!control) {
        return;
    }

    const next = Math.max(
        control.min,
        Math.min(control.max, activeWidthValue.value + delta),
    );
    updateSetting(control.key, next);
}

function applyDrawStyle(style: TDrawStyle) {
    const preset = drawStylePresets.value.find(item => item.id === style);
    if (!preset) {
        return;
    }

    emit('set-tool', 'draw');
    updateSetting('inkThickness', preset.thickness);
    updateSetting('inkOpacity', preset.opacity);
}
</script>

<style scoped>
.notes-section {
    border: 1px solid var(--ui-border-muted);
    border-radius: 0.7rem;
    background: var(--ui-bg);
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.04);
}

.notes-section-header {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
}

.notes-section-title {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.2;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-text-highlighted);
}

.notes-section-description {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.35;
    color: var(--ui-text-muted);
}

.style-row {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
}

.style-label {
    font-size: 0.8rem;
    color: var(--ui-text-muted);
}

.style-color {
    width: 100%;
    height: 2rem;
    border-radius: 0.45rem;
    border: 1px solid var(--ui-border);
    background: transparent;
    cursor: pointer;
}

.swatch-row {
    display: grid;
    grid-template-columns: repeat(9, minmax(0, 1fr));
    gap: 0.25rem;
}

.swatch {
    border: 1px solid color-mix(in srgb, var(--ui-border) 80%, #000 20%);
    border-radius: 0.3rem;
    height: 1.1rem;
    cursor: pointer;
}

.style-range {
    width: 100%;
    appearance: none;
    height: 4px;
    border-radius: 2px;
    background: var(--ui-border);
    outline: none;
    cursor: pointer;
}

.style-range::-webkit-slider-thumb {
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--ui-primary);
    border: 2px solid var(--ui-bg);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
    cursor: pointer;
}

.style-width-control {
    display: flex;
    align-items: center;
    gap: 0.45rem;
}

.style-step-button {
    border: 1px solid var(--ui-border);
    border-radius: 0.4rem;
    background: var(--ui-bg);
    color: var(--ui-text-highlighted);
    width: 1.8rem;
    height: 1.8rem;
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
}

.style-step-button:hover {
    border-color: color-mix(in srgb, var(--ui-primary) 55%, var(--ui-border) 45%);
}

.draw-style-row {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
}

.draw-style-list {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.35rem;
}

.draw-style-button {
    border: 1px solid var(--ui-border);
    border-radius: 0.45rem;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    min-height: 1.9rem;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
}

.draw-style-button.is-active {
    border-color: color-mix(in srgb, var(--ui-primary) 65%, var(--ui-border) 35%);
    color: var(--ui-text-highlighted);
    background: color-mix(in srgb, var(--ui-primary) 14%, var(--ui-bg) 86%);
}

@media (width <= 860px) {
    .swatch-row {
        grid-template-columns: repeat(6, minmax(0, 1fr));
    }
}
</style>
