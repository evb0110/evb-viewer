<template>
    <div class="annotation-style-editor flex flex-col gap-2" :class="{ 'is-idle': !hasStyleControls && selectedAnnotations.length === 0 }">
        <template v-if="selectedAnnotations.length > 0">
            <div v-if="selectionHasColor" class="swatch-row">
                <button
                    v-for="swatch in selectionColorSwatches" :key="swatch" type="button" class="swatch"
                    :class="{ 'is-active': swatch === selectionColor }" :style="{ backgroundColor: swatch }"
                    :aria-label="swatch" :aria-pressed="swatch === selectionColor"
                    @click="emit('update-properties', {color: swatch})" />
            </div>
            <label v-if="selectionWidthProperty" class="style-row">
                <span class="style-label">{{ selectionWidthProperty === 'fontSize' ? t('annotations.textSize') : t('annotations.stroke') }}</span>
                <input
                    type="number" class="annotation-property-number" :aria-label="selectionWidthProperty === 'fontSize' ? t('annotations.textSize') : t('annotations.stroke')"
                    :min="selectionWidthProperty === 'fontSize' ? 8 : 0.5" :max="selectionWidthProperty === 'fontSize' ? 72 : 24" step="0.5"
                    :value="selectionWidthDisplay" :placeholder="t('annotations.mixedValues')"
                    @change="updateSelectedWidth($event)" />
            </label>
            <p v-if="selectionWidthProperty === 'fontSize'" class="text-xs text-muted">
                {{ t('annotations.textResizeHint') }}
            </p>
            <label v-if="selectionHasOpacity" class="style-row">
                <span class="style-label">{{ t('annotations.opacity') }}</span>
                <input
                    type="number" class="annotation-property-number" :aria-label="t('annotations.opacity')" min="0" max="100" step="5"
                    :value="selectionOpacity" :placeholder="t('annotations.mixedValues')"
                    @change="updateSelectedNumber('opacity', $event, 0, 100, 100)" />
            </label>
            <div v-if="selectionHasFill" class="style-row">
                <span class="style-label">{{ t('annotations.fillColor') }}</span>
                <input
                    type="color" :aria-label="t('annotations.fillColor')" :value="selectionFill ?? '#ffffff'"
                    @change="emit('update-properties', {fill: inputValue($event)})" />
                <button type="button" @click="emit('update-properties', {fill: null})">{{ t('annotations.noFill') }}</button>
            </div>
            <div v-if="selectionHasRotation && canRotate" class="style-row">
                <span class="style-label">{{ t('annotations.rotation') }}</span>
                <div class="style-rotation-control">
                    <AppTooltip :text="t('annotations.rotateCounterclockwise', {degrees: 90})">
                        <UButton
                            type="button" class="style-step-button" icon="i-ph-arrow-counter-clockwise"
                            variant="ghost" color="neutral" size="sm" square
                            data-annotation-rotate="ccw"
                            :aria-label="t('annotations.rotateCounterclockwise', {degrees: 90})"
                            :disabled="!canRotate?.(-90)"
                            @click="emit('update-properties', {rotationDelta: -90})" />
                    </AppTooltip>
                    <output class="style-rotation-value" data-annotation-rotation-value :aria-label="t('annotations.rotation')" aria-live="polite">
                        {{ selectionRotation === null ? t('annotations.mixedValues') : `${Math.round(selectionRotation * 100) / 100}°` }}
                    </output>
                    <AppTooltip :text="t('annotations.rotateClockwise', {degrees: 90})">
                        <UButton
                            type="button" class="style-step-button" icon="i-ph-arrow-clockwise"
                            variant="ghost" color="neutral" size="sm" square
                            data-annotation-rotate="cw"
                            :aria-label="t('annotations.rotateClockwise', {degrees: 90})"
                            :disabled="!canRotate?.(90)"
                            @click="emit('update-properties', {rotationDelta: 90})" />
                    </AppTooltip>
                </div>
            </div>
        </template>
        <template v-else-if="hasStyleControls">
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

            <label v-if="opacitySettingKey" class="style-row">
                <span class="style-label">{{ t('annotations.opacity') }}</span>
                <input
                    type="range" min="0" max="100" step="5" :aria-label="t('annotations.opacity')"
                    :value="Number(settings[opacitySettingKey]) * 100" @input="updateDefaultOpacity($event)" />
            </label>
            <div v-if="isShapeTool(tool) && tool !== 'draw'" class="style-row">
                <span class="style-label">{{ t('annotations.fillColor') }}</span>
                <input
                    type="color" :aria-label="t('annotations.fillColor')" :value="settings.shapeFillColor === 'transparent' ? '#ffffff' : settings.shapeFillColor"
                    @input="updateSetting('shapeFillColor', inputValue($event))" />
                <button type="button" @click="updateSetting('shapeFillColor', 'transparent')">{{ t('annotations.noFill') }}</button>
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
    IAnnotationPropertyUpdate,
    TAnnotationTool,
} from '@app/types/annotations';
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdfColors';
import { ANNOTATION_PROPERTY_RANGES } from '@app/constants/annotationDefaults';
import { isAuthoringAnnotationTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isAuthoringAnnotationTool';
import { isShapeTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isShapeTool';
import type {
    ITextBoxEntity,
    AnnotationEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

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
    selectedAnnotations?: readonly AnnotationEntity[];
    canRotate?: ((delta: -90 | 90) => boolean) | undefined;
}

const { t } = useTypedI18n();

const {
    settings,
    tool,
    selectedTextBox = null,
    selectedAnnotations = [],
    canRotate = undefined,
} = defineProps<IProps>();

const emit = defineEmits<{
    'color-selected': [];
    'update-properties': [updates: IAnnotationPropertyUpdate];
    'update-setting': [payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }];
}>();

function inputValue(event: Event) {
    return (event.target as HTMLInputElement).value;
}

function commonSelectionValue<T>(read: (entity: AnnotationEntity) => T): T | null {
    const values = selectedAnnotations.map(read);
    return values.length > 0 && values.every(value => value === values[0]) ? values[0]! : null;
}
const selectionHasColor = computed(() => selectedAnnotations.every(entity => entity.kind !== 'placed-image'));
const selectionColor = computed(() => commonSelectionValue(entity => entity.kind === 'shape' ? entity.strokeColor : entity.kind === 'placed-image' ? null : entity.color));
const selectionColorSwatches = computed(() => {
    const color = selectionColor.value;
    return color && !colorSwatches.some(swatch => swatch.toLowerCase() === color.toLowerCase()) ? [
        color,
        ...colorSwatches,
    ] : colorSwatches;
});
const selectionWidthProperty = computed(() => selectedAnnotations.every(entity => entity.kind === 'text-box') ? 'fontSize'
    : selectedAnnotations.every(entity => entity.kind === 'shape') ? 'strokeWidth' : null);
const selectionWidth = computed(() => commonSelectionValue(entity => entity.kind === 'text-box' ? entity.fontSize : entity.kind === 'shape' ? entity.strokeWidth : null));
const selectionWidthDisplay = computed(() => selectionWidth.value === null ? '' : String(Math.round(selectionWidth.value * 100) / 100));
const selectionHasOpacity = computed(() => selectedAnnotations.every(entity => entity.kind === 'shape' || entity.kind === 'text-markup'));
const selectionOpacity = computed(() => commonSelectionValue(entity => entity.kind === 'shape' || entity.kind === 'text-markup' ? Math.round((entity.opacity ?? 1) * 100) : null));
const selectionHasFill = computed(() => selectedAnnotations.every(entity => entity.kind === 'shape'));
const selectionFill = computed(() => commonSelectionValue(entity => entity.kind === 'shape' ? entity.fill : null));
const selectionHasRotation = computed(() => selectedAnnotations.every(entity => entity.kind === 'text-box' || entity.kind === 'placed-image'));
const selectionRotation = computed(() => commonSelectionValue(entity => entity.kind === 'text-box' || entity.kind === 'placed-image' ? entity.rotation : null));

function updateSelectedNumber(key: 'fontSize' | 'strokeWidth' | 'opacity', event: Event, min: number, max: number, divisor = 1) {
    if (inputValue(event).trim() === '') {
        return;
    }
    const value = Number(inputValue(event));
    if (!Number.isFinite(value)) {
        return;
    }
    const bounded = Math.max(min, Math.min(max, value)) / divisor;
    emit('update-properties', {[key]: bounded});
}
async function updateSelectedWidth(event: Event) {
    if (selectionWidthProperty.value === 'fontSize') updateSelectedNumber('fontSize', event, 8, 72);
    if (selectionWidthProperty.value === 'strokeWidth') updateSelectedNumber('strokeWidth', event, 0.5, 24);
    await nextTick();
    const input = event.target;
    if (input instanceof HTMLInputElement) input.value = selectionWidthDisplay.value;
}
const opacitySettingKey = computed(() => {
    switch (tool) {
        case 'draw': return 'inkOpacity';
        case 'highlight': return 'highlightOpacity';
        case 'underline': return 'underlineOpacity';
        case 'strikethrough': return 'strikethroughOpacity';
        case 'squiggly': return 'squigglyOpacity';
        case 'rectangle': case 'circle': case 'line': case 'arrow': return 'shapeOpacity';
        case 'text': case 'stamp': case 'select': case 'none': case 'note': return null;
    }
});
function updateDefaultOpacity(event: Event) {
    const key = opacitySettingKey.value;
    if (key) updateSetting(key, Number(inputValue(event)) / 100);
}

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
        return settings.noteColor ?? '#f59e0b';
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
        updateSetting('noteColor', color);
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

    updateSetting('inkThickness', preset.thickness);
    updateSetting('inkOpacity', preset.opacity);
}
</script>

<style scoped>
.annotation-property-number {
    width: var(--app-annotation-property-input-width);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-md);
    background: var(--ui-bg);
    color: var(--ui-text);
}

.annotation-style-editor {
    min-height: 0;
}

.annotation-style-editor.is-idle {
    justify-content: center;
}

.annotation-style-editor-idle {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    color: var(--ui-text-muted);
}

.annotation-style-editor-idle-icon {
    flex: none;
    font-size: var(--app-text-size-ui);
}

.annotation-style-editor-idle-label {
    font-size: var(--app-text-size-meta);
    line-height: 1.25;
}

.style-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.35rem;
}

.style-row-width {
    align-items: stretch;
    min-width: 0;
}

.style-rotation-control {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-sm);
}

.style-rotation-value {
    min-width: var(--app-pdf-annotation-properties-value-min-width);
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-size: var(--app-text-size-secondary);
}

.style-label {
    font-size: var(--app-text-size-secondary);
    color: var(--ui-text-muted);
}

.swatch-row {
    display: flex;
    flex-wrap: wrap;
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
    width: 100%;
    min-width: 0;
    align-items: center;
    gap: 0.45rem;
}

.style-step-button {
    flex: 0 0 var(--app-annotation-action-size);
    border: 1px solid var(--ui-border);
    border-radius: 0.4rem;
    background: var(--ui-bg);
    color: var(--ui-text);
    width: var(--app-annotation-action-size);
    height: var(--app-annotation-action-size);
    padding: 0;
    justify-content: center;
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
