<template>
    <div
        ref="editor"
        class="zone-editor-overlay"
        :style="frameStyle"
        tabindex="0"
        :aria-label="t('scanCleanup.zones.editorLabel')"
        @keydown.delete.stop.prevent="deleteSelectedZone"
        @keydown.esc.stop.prevent="cancelDrag"
        @pointermove="updateDrag"
        @pointerup="finishDrag"
        @pointercancel="cancelDrag"
        @lostpointercapture="cancelDrag"
    >
        <svg
            class="zone-editor-polygons"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            @pointerdown.stop="startDrawing"
        >
            <polygon
                v-for="zone in renderedZones"
                :key="`${zone.selection.kind}-${zone.selection.index}`"
                class="zone-editor-polygon"
                :class="[
                    `is-${zone.selection.kind}`,
                    {'is-selected': isSelected(zone.selection)},
                ]"
                :points="polygonPoints(zone.polygon)"
                vector-effect="non-scaling-stroke"
                @pointerdown.stop="startMoving($event, zone.selection, zone.polygon)"
            />
            <polygon
                v-if="draft?.kind === 'drawing' && draft.polygon"
                class="zone-editor-polygon is-draft"
                :class="`is-${zoneKind}`"
                :points="polygonPoints(draft.polygon)"
                vector-effect="non-scaling-stroke"
            />
        </svg>

        <template v-if="selectedBounds">
            <button
                v-for="handle in handles"
                :key="handle"
                type="button"
                class="zone-editor-handle"
                :class="`is-${handle}`"
                :style="handleStyle(handle)"
                :aria-label="t('scanCleanup.zones.resizeHandle', {
                    direction: t(`scanCleanup.zones.corners.${handle}`),
                })"
                @pointerdown.stop="startResizing($event, handle)"
            />
            <UButton
                class="zone-editor-delete"
                type="button"
                color="error"
                variant="solid"
                size="xs"
                square
                icon="i-ph-trash"
                :style="deleteStyle"
                :aria-label="t('scanCleanup.zones.delete')"
                @pointerdown.stop
                @click.stop="deleteSelectedZone"
            />
        </template>
    </div>
</template>

<script setup lang="ts">
import type {
    IScanCleanupManualZones,
    IScanCleanupNormalizedZonePolygon,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {CSSProperties} from 'vue';
import {
    cloneScanCleanupZonePolygon,
    createScanCleanupRectangleZone,
    moveScanCleanupZonePolygon,
    previewPxToNormalizedZonePoint,
    resizeScanCleanupZonePolygon,
    resolveScanCleanupZoneBounds,
    type IScanCleanupZonePreviewFrame,
    type IScanCleanupZoneSelection,
    type TScanCleanupZoneCorner,
    type TScanCleanupZoneKind,
} from '@app/modules/scan-cleanup/geometry/zoneGeometry';

interface IDrawingZoneDrag {
    kind: 'drawing';
    pointerId: number;
    polygon: IScanCleanupNormalizedZonePolygon | null;
    start: ReturnType<typeof previewPxToNormalizedZonePoint>;
}

interface IMovingZoneDrag {
    kind: 'moving';
    original: IScanCleanupNormalizedZonePolygon;
    pointerId: number;
    polygon: IScanCleanupNormalizedZonePolygon;
    selection: IScanCleanupZoneSelection;
    start: ReturnType<typeof previewPxToNormalizedZonePoint>;
}

interface IResizingZoneDrag {
    corner: TScanCleanupZoneCorner;
    kind: 'resizing';
    original: IScanCleanupNormalizedZonePolygon;
    pointerId: number;
    polygon: IScanCleanupNormalizedZonePolygon;
    selection: IScanCleanupZoneSelection;
}

interface IRenderedZone {
    polygon: IScanCleanupNormalizedZonePolygon;
    selection: IScanCleanupZoneSelection;
}

type TZoneDrag = IDrawingZoneDrag | IMovingZoneDrag | IResizingZoneDrag;

const props = defineProps<{
    frame: IScanCleanupZonePreviewFrame;
    manualZones?: IScanCleanupManualZones | undefined;
    rotationDegrees: TScanCleanupPageRotation;
    selected: IScanCleanupZoneSelection | null;
    zoneKind: TScanCleanupZoneKind;
}>();
const emit = defineEmits<{
    'update:manualZones': [value: IScanCleanupManualZones];
    'update:selected': [value: IScanCleanupZoneSelection | null];
}>();
const {t} = useTypedI18n();
const editor = ref<HTMLElement | null>(null);
const draft = shallowRef<TZoneDrag | null>(null);
const handles: readonly TScanCleanupZoneCorner[] = [
    'nw',
    'ne',
    'se',
    'sw',
];
const frameStyle = computed<CSSProperties>(() => ({
    height: `${props.frame.height}px`,
    left: `${props.frame.left}px`,
    top: `${props.frame.top}px`,
    width: `${props.frame.width}px`,
}));
const zones = computed<IScanCleanupManualZones>(() => props.manualZones ?? {
    picture: [],
    fill: [],
});
const renderedZones = computed<IRenderedZone[]>(() => {
    const picture = zones.value.picture.map((zone, index): IRenderedZone => ({
        polygon: draftPolygon({
            kind: 'picture',
            index,
        }) ?? zone.polygon,
        selection: {
            kind: 'picture',
            index,
        },
    }));
    const fill = zones.value.fill.map((polygon, index): IRenderedZone => ({
        polygon: draftPolygon({
            kind: 'fill',
            index,
        }) ?? polygon,
        selection: {
            kind: 'fill',
            index,
        },
    }));
    return [
        ...picture,
        ...fill,
    ];
});
const selectedPolygon = computed(() => {
    if (!props.selected) {
        return null;
    }
    return renderedZones.value.find(zone => isSelected(zone.selection))?.polygon ?? null;
});
const selectedBounds = computed(() => selectedPolygon.value
    ? resolveScanCleanupZoneBounds(selectedPolygon.value)
    : null);
const deleteStyle = computed<CSSProperties>(() => selectedBounds.value ? {
    left: `${selectedBounds.value.right * 100}%`,
    top: `${selectedBounds.value.top * 100}%`,
} : {});

function sameSelection(left: IScanCleanupZoneSelection, right: IScanCleanupZoneSelection) {
    return left.kind === right.kind && left.index === right.index;
}

function isSelected(selection: IScanCleanupZoneSelection) {
    return props.selected !== null && sameSelection(selection, props.selected);
}

function draftPolygon(selection: IScanCleanupZoneSelection) {
    const current = draft.value;
    if (!current || current.kind === 'drawing' || !sameSelection(current.selection, selection)) {
        return null;
    }
    return current.polygon;
}

function polygonPoints(polygon: IScanCleanupNormalizedZonePolygon) {
    return polygon.points
        .map(point => `${point.xNormalized},${point.yNormalized}`)
        .join(' ');
}

function pointFromEvent(event: PointerEvent) {
    const rect = editor.value?.getBoundingClientRect();
    return previewPxToNormalizedZonePoint({
        xPx: event.clientX,
        yPx: event.clientY,
    }, rect ? {
        height: rect.height,
        left: rect.left,
        top: rect.top,
        width: rect.width,
    } : props.frame);
}

function capturePointer(event: PointerEvent) {
    if (event.button !== 0 || !editor.value) {
        return false;
    }
    editor.value.focus();
    editor.value.setPointerCapture(event.pointerId);
    return true;
}

function startDrawing(event: PointerEvent) {
    if (!capturePointer(event)) {
        return;
    }
    const start = pointFromEvent(event);
    emit('update:selected', null);
    draft.value = {
        kind: 'drawing',
        pointerId: event.pointerId,
        polygon: null,
        start,
    };
}

function startMoving(
    event: PointerEvent,
    selection: IScanCleanupZoneSelection,
    polygon: IScanCleanupNormalizedZonePolygon,
) {
    if (!capturePointer(event)) {
        return;
    }
    emit('update:selected', selection);
    draft.value = {
        kind: 'moving',
        original: cloneScanCleanupZonePolygon(polygon),
        pointerId: event.pointerId,
        polygon: cloneScanCleanupZonePolygon(polygon),
        selection,
        start: pointFromEvent(event),
    };
}

function startResizing(event: PointerEvent, corner: TScanCleanupZoneCorner) {
    if (!props.selected || !selectedPolygon.value || !capturePointer(event)) {
        return;
    }
    draft.value = {
        corner,
        kind: 'resizing',
        original: cloneScanCleanupZonePolygon(selectedPolygon.value),
        pointerId: event.pointerId,
        polygon: cloneScanCleanupZonePolygon(selectedPolygon.value),
        selection: props.selected,
    };
}

function updateDrag(event: PointerEvent) {
    const current = draft.value;
    if (!current || current.pointerId !== event.pointerId) {
        return;
    }
    const point = pointFromEvent(event);
    if (current.kind === 'drawing') {
        current.polygon = createScanCleanupRectangleZone(
            current.start,
            point,
            props.rotationDegrees,
            0,
        );
    } else if (current.kind === 'moving') {
        current.polygon = moveScanCleanupZonePolygon(
            current.original,
            point.xNormalized - current.start.xNormalized,
            point.yNormalized - current.start.yNormalized,
        );
    } else {
        current.polygon = resizeScanCleanupZonePolygon(current.original, current.corner, point);
    }
    draft.value = {...current};
}

function cloneZones() {
    return {
        picture: zones.value.picture.map(zone => ({
            layer: zone.layer,
            polygon: cloneScanCleanupZonePolygon(zone.polygon),
        })),
        fill: zones.value.fill.map(cloneScanCleanupZonePolygon),
    };
}

function replaceZone(
    next: IScanCleanupManualZones,
    selection: IScanCleanupZoneSelection,
    polygon: IScanCleanupNormalizedZonePolygon,
) {
    if (selection.kind === 'picture') {
        const current = next.picture[selection.index];
        if (current) {
            next.picture[selection.index] = {
                ...current,
                polygon,
            };
        }
    } else if (next.fill[selection.index]) {
        next.fill[selection.index] = polygon;
    }
}

function samePolygon(
    left: IScanCleanupNormalizedZonePolygon,
    right: IScanCleanupNormalizedZonePolygon,
) {
    return left.rotationDegrees === right.rotationDegrees
        && left.points.length === right.points.length
        && left.points.every((point, index) => {
            const other = right.points[index];
            if (!other) {
                return false;
            }
            return point.xNormalized === other.xNormalized
                && point.yNormalized === other.yNormalized;
        });
}

function finishDrag(event: PointerEvent) {
    const current = draft.value;
    if (!current || current.pointerId !== event.pointerId) {
        return;
    }
    if (current.kind === 'drawing') {
        const polygon = createScanCleanupRectangleZone(
            current.start,
            pointFromEvent(event),
            props.rotationDegrees,
        );
        if (polygon) {
            const next = cloneZones();
            const selection: IScanCleanupZoneSelection = props.zoneKind === 'picture'
                ? {
                    kind: 'picture',
                    index: next.picture.length,
                }
                : {
                    kind: 'fill',
                    index: next.fill.length,
                };
            if (selection.kind === 'picture') {
                next.picture.push({
                    layer: 'painter2',
                    polygon,
                });
            } else {
                next.fill.push(polygon);
            }
            emit('update:manualZones', next);
            emit('update:selected', selection);
        }
    } else if (!samePolygon(current.original, current.polygon)) {
        const next = cloneZones();
        replaceZone(next, current.selection, current.polygon);
        emit('update:manualZones', next);
    }
    releasePointer(current.pointerId);
    draft.value = null;
}

function releasePointer(pointerId: number) {
    if (editor.value?.hasPointerCapture(pointerId)) {
        editor.value.releasePointerCapture(pointerId);
    }
}

function cancelDrag() {
    if (draft.value) {
        releasePointer(draft.value.pointerId);
    }
    draft.value = null;
}

function deleteSelectedZone() {
    if (!props.selected) {
        return;
    }
    const next = cloneZones();
    if (props.selected.kind === 'picture') {
        next.picture.splice(props.selected.index, 1);
    } else {
        next.fill.splice(props.selected.index, 1);
    }
    emit('update:manualZones', next);
    emit('update:selected', null);
}

function handleStyle(corner: TScanCleanupZoneCorner): CSSProperties {
    const bounds = selectedBounds.value;
    if (!bounds) {
        return {};
    }
    return {
        left: `${corner.includes('w') ? bounds.left * 100 : bounds.right * 100}%`,
        top: `${corner.includes('n') ? bounds.top * 100 : bounds.bottom * 100}%`,
    };
}

watch(() => props.rotationDegrees, () => {
    cancelDrag();
    emit('update:selected', null);
});
</script>

<style scoped>
.zone-editor-overlay {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    box-sizing: border-box;
    overflow: visible;
    outline: none;
    pointer-events: auto;
    touch-action: none;
}

.zone-editor-overlay:focus-visible {
    outline: var(--app-hairline-height) solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.zone-editor-polygons {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
    cursor: crosshair;
}

.zone-editor-polygon {
    stroke-width: var(--app-scan-zone-stroke-width);
    cursor: move;
    pointer-events: all;
}

.zone-editor-polygon.is-picture {
    fill: color-mix(
        in srgb,
        var(--app-scan-zone-picture-color) var(--app-scan-zone-overlay-opacity),
        transparent
    );
    stroke: var(--app-scan-zone-picture-color);
}

.zone-editor-polygon.is-fill {
    fill: color-mix(
        in srgb,
        var(--app-scan-zone-fill-color) var(--app-scan-zone-overlay-opacity),
        transparent
    );
    stroke: var(--app-scan-zone-fill-color);
}

.zone-editor-polygon.is-selected,
.zone-editor-polygon.is-draft {
    stroke-width: var(--app-scan-zone-active-stroke-width);
}

.zone-editor-polygon.is-draft {
    stroke-dasharray: var(--app-scan-zone-dash-array);
    pointer-events: none;
}

.zone-editor-handle {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    width: var(--app-scan-zone-handle-size);
    height: var(--app-scan-zone-handle-size);
    border: var(--app-hairline-height) solid var(--ui-primary);
    border-radius: var(--app-radius-xs);
    background: var(--ui-bg);
    box-shadow: var(--shadow-sm);
    pointer-events: auto;
    touch-action: none;
    transform: translate(-50%, -50%);
}

.zone-editor-handle.is-nw,
.zone-editor-handle.is-se {
    cursor: nwse-resize;
}

.zone-editor-handle.is-ne,
.zone-editor-handle.is-sw {
    cursor: nesw-resize;
}

.zone-editor-delete {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    pointer-events: auto;
    transform: translate(
        calc(-100% - var(--app-space-sm)),
        calc(-100% - var(--app-space-sm))
    );
}
</style>
