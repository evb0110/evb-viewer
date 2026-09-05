<template>
    <div class="annotation-style-editor flex flex-col gap-2" :class="{ 'is-idle': !hasStyleControls }">
        <template v-if="hasStyleControls">
            <div class="swatch-row">
                <AppTooltip
                    v-for="swatch in displayColorSwatches"
                    :key="swatch"
                    :text="swatch"
                    :delay-duration="600"
                >
                    <button
                        type="button"
                        class="swatch"
                        :class="{ 'is-active': swatch === activeColorSwatch }"
                        :style="{ backgroundColor: swatch }"
                        :aria-label="swatch"
                        :aria-pressed="swatch === activeColorSwatch"
                        @click="handleColorInput(swatch)"
                    />
                </AppTooltip>
            </div>

            <div v-if="activeWidthControl" class="style-row style-row-width flex flex-col">
                <span class="style-label">
                    {{ activeWidthControl.label }} {{ activeWidthValue }}
                </span>
                <div class="style-width-control">
                    <UButton
                        type="button"
                        class="style-step-button"
                        icon="i-ph-minus"
                        variant="ghost"
                        color="neutral"
                        size="sm"
                        square
                        :aria-label="t('annotations.decreaseWidth')"
                        @click="nudgeWidth(-activeWidthControl.step)"
                    />
                    <USlider
                        class="style-range"
                        color="neutral"
                        size="xs"
                        :ui="widthSliderUi"
                        :aria-label="activeWidthControl.label"
                        :min="activeWidthControl.min"
                        :max="activeWidthControl.max"
                        :step="activeWidthControl.step"
                        :model-value="activeWidthValue"
                        @update:model-value="handleWidthInput"
                    />
                    <UButton
                        type="button"
                        class="style-step-button"
                        icon="i-ph-plus"
                        variant="ghost"
                        color="neutral"
                        size="sm"
                        square
                        :aria-label="t('annotations.increaseWidth')"
                        @click="nudgeWidth(activeWidthControl.step)"
                    />
                </div>
            </div>

            <div v-if="tool === 'draw'" class="draw-style-row flex flex-col">
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
        </template>

        <div v-else class="annotation-style-editor-idle" role="status" aria-live="polite">
            <UIcon name="i-ph-sliders-horizontal" class="annotation-style-editor-idle-icon" />
            <span class="annotation-style-editor-idle-label">{{ t('annotations.styleDescription') }}</span>
        </div>
    </div>
</template>

<script setup lang="ts">
import type {
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdfColors';
import { ANNOTATION_PROPERTY_RANGES } from '@app/constants/annotationDefaults';
import { isAuthoringAnnotationTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isAuthoringAnnotationTool';
import { isShapeTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isShapeTool';
import type { ITextBoxEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

type TDrawStyle = 'pen' | 'pencil' | 'marker';

interface IWidthControl {
    key: 'inkThickness' | 'shapeStrokeWidth' | 'textSize';
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
    selectedTextBox?: Pick<ITextBoxEntity, 'fontSize' | 'color'> | null;
}

const { t } = useTypedI18n();

const {
    settings,
    tool,
    selectedTextBox = null,
} = defineProps<IProps>();

const emit = defineEmits<{
    'set-tool': [tool: TAnnotationTool];
    'color-selected': [];
    'update-setting': [payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }];
}>();

const colorSwatches = ANNOTATION_COLOR_SWATCHES;
const hasStyleControls = computed(() => isAuthoringAnnotationTool(tool));
const widthSliderUi = {
    track: 'style-range-track',
    range: 'style-range-fill',
    thumb: 'style-range-thumb',
};

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

function updateSetting<K extends keyof IAnnotationSettings>(key: K, value: IAnnotationSettings[K]) {
    emit('update-setting', {
        key,
        value,
    });
}

const activeWidthControl = computed<IWidthControl | null>(() => {
    if (tool === 'draw') {
        return {
            key: 'inkThickness',
            ...ANNOTATION_PROPERTY_RANGES.inkThickness,
            label: t('annotations.drawThickness'),
        };
    }

    if (isShapeTool(tool)) {
        return {
            key: 'shapeStrokeWidth',
            ...ANNOTATION_PROPERTY_RANGES.shapeStrokeWidth,
            label: t('annotations.stroke'),
        };
    }

    if (tool === 'text') {
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
    if (tool === 'text' && selectedTextBox) {
        return selectedTextBox.fontSize;
    }
    return settings[activeWidthControl.value.key];
});

const activeColorSwatch = computed(() => {
    if (tool === 'draw') {
        return settings.inkColor;
    }

    if (tool === 'underline') {
        return settings.underlineColor;
    }

    if (tool === 'text') {
        return selectedTextBox?.color ?? settings.textColor;
    }

    if (tool === 'note') {
        return settings.textColor;
    }

    if (tool === 'strikethrough') {
        return settings.strikethroughColor;
    }

    if (tool === 'squiggly') {
        return settings.squigglyColor;
    }

    if (isShapeTool(tool)) {
        return settings.shapeColor;
    }

    return settings.highlightColor;
});

function normalizeColorValue(color: string | null | undefined) {
    return color?.trim().toLowerCase() ?? '';
}

const displayColorSwatches = computed(() => {
    const active = activeColorSwatch.value;
    if (!active) {
        return colorSwatches;
    }

    const normalizedActive = normalizeColorValue(active);
    const hasMatchingPreset = colorSwatches.some(swatch => normalizeColorValue(swatch) === normalizedActive);
    return hasMatchingPreset ? colorSwatches : [
        active,
        ...colorSwatches,
    ];
});

const activeDrawStyle = computed(() => {
    const thickness = settings.inkThickness;
    const opacity = settings.inkOpacity;

    if (thickness >= 5 || opacity <= 0.45) {
        return 'marker';
    }

    if (thickness <= 1.5 || opacity < 0.75) {
        return 'pencil';
    }

    return 'pen';
});

function handleColorInput(color: string) {
    if (tool === 'draw') {
        updateSetting('inkColor', color);
        emit('color-selected');
        return;
    }

    if (tool === 'underline') {
        updateSetting('underlineColor', color);
        emit('color-selected');
        return;
    }

    if (tool === 'text') {
        updateSetting('textColor', color);
        emit('color-selected');
        return;
    }

    if (tool === 'note') {
        updateSetting('textColor', color);
        emit('color-selected');
        return;
    }

    if (tool === 'strikethrough') {
        updateSetting('strikethroughColor', color);
        emit('color-selected');
        return;
    }

    if (tool === 'squiggly') {
        updateSetting('squigglyColor', color);
        emit('color-selected');
        return;
    }

    if (isShapeTool(tool)) {
        updateSetting('shapeColor', color);
        emit('color-selected');
        return;
    }

    updateSetting('highlightColor', color);
    emit('color-selected');
}

function sliderNumericValue(value: number | number[] | undefined) {
    return Array.isArray(value) ? value[0] ?? 0 : value ?? 0;
}

function handleWidthInput(width: number | number[] | undefined) {
    const control = activeWidthControl.value;
    if (!control) {
        return;
    }

    updateSetting(control.key, sliderNumericValue(width));
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
.annotation-style-editor {
    min-height: 0;
}

.annotation-style-editor.is-idle {
    justify-content: center;
}

.annotation-style-editor-idle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--ui-text-muted);
}

.annotation-style-editor-idle-icon {
    font-size: var(--app-text-size-ui);
}

.annotation-style-editor-idle-label {
    font-size: var(--app-text-size-meta);
    line-height: 1.25;
}

.style-row {
    gap: 0.35rem;
}

.style-label {
    font-size: var(--app-text-size-secondary);
    color: var(--ui-text-muted);
}

.swatch-row {
    display: flex;
    flex-wrap: nowrap;
    gap: 0.3rem;
}

.swatch {
    border: 1px solid color-mix(in oklab, var(--app-pdf-color-swatch-border) 45%, transparent);
    border-radius: 0.3rem;
    flex: 0 0 var(--app-annotation-color-control-size);
    width: var(--app-annotation-color-control-size);
    height: var(--app-annotation-color-control-size);
    padding: 0;
    cursor: pointer;
}

.swatch.is-active {
    border-color: var(--app-sidebar-bg);
    box-shadow:
        0 0 0 1px var(--app-sidebar-bg),
        0 0 0 3px var(--ui-text);
}

@media (width <= 360px) {
    .swatch-row {
        flex-wrap: wrap;
    }
}

.style-range {
    flex: 1;
    min-width: 0;
}

.style-range :deep(.style-range-track) {
    height: var(--app-range-track-height);
    border-radius: var(--app-space-3xs);
    background: var(--ui-border);
}

.style-range :deep(.style-range-fill) {
    background: var(--ui-text);
}

.style-range :deep(.style-range-thumb) {
    width: var(--app-annotation-color-swatch-size);
    height: var(--app-annotation-color-swatch-size);
    border: 2px solid var(--app-sidebar-bg);
    background: var(--ui-text);
    box-shadow: none;
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
    color: var(--ui-text);
    width: var(--app-annotation-action-size);
    height: var(--app-annotation-action-size);
    padding: 0;
    cursor: pointer;
}

.style-step-button:hover {
    background: var(--app-sidebar-control-hover-bg);
    border-color: var(--app-control-active-hover-border);
}

.draw-style-row {
    gap: 0.35rem;
}

.draw-style-list {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.35rem;
}

.draw-style-button {
    border: 1px solid transparent;
    border-radius: 0.45rem;
    background: transparent;
    color: var(--ui-text-muted);
    min-height: var(--app-annotation-input-min-height);
    font-size: var(--app-text-size-meta);
    font-weight: 600;
    cursor: pointer;
}

.draw-style-button.is-active {
    border-color: var(--app-control-active-border);
    color: var(--ui-text);
    background: var(--app-control-active-bg);
}

.draw-style-button:hover {
    background: var(--app-sidebar-control-hover-bg);
    color: var(--ui-text);
}

</style>
