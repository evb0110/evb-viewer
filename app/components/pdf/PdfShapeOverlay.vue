<template>
    <svg
        v-if="isActive || shapes.length > 0 || drawingShape"
        ref="svgRef"
        class="pdf-shape-overlay"
        :viewBox="`0 0 1 1`"
        preserveAspectRatio="none"
        @pointerdown.prevent="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointerleave="handlePointerUp"
    >
        <g
            v-for="shape in shapes"
            :key="shape.id"
            :class="{ 'is-selected': shape.id === selectedShapeId }"
            @pointerdown.stop.prevent="handleShapeClick(shape.id)"
            @contextmenu.stop.prevent="handleShapeContextMenu(shape.id, $event)"
        >
            <rect
                v-if="shape.type === 'rectangle'"
                :x="shape.x"
                :y="shape.y"
                :width="shape.width"
                :height="shape.height"
                :stroke="shape.color"
                :fill="shape.fillColor ?? 'none'"
                :opacity="shape.opacity"
                :stroke-width="strokeWidthNorm(shape.strokeWidth)"
                vector-effect="non-scaling-stroke"
            />
            <ellipse
                v-if="shape.type === 'circle'"
                :cx="shape.x + shape.width / 2"
                :cy="shape.y + shape.height / 2"
                :rx="shape.width / 2"
                :ry="shape.height / 2"
                :stroke="shape.color"
                :fill="shape.fillColor ?? 'none'"
                :opacity="shape.opacity"
                :stroke-width="strokeWidthNorm(shape.strokeWidth)"
                vector-effect="non-scaling-stroke"
            />
            <line
                v-if="shape.type === 'line'"
                :x1="shape.x"
                :y1="shape.y"
                :x2="shape.x2 ?? shape.x"
                :y2="shape.y2 ?? shape.y"
                :stroke="shape.color"
                :opacity="shape.opacity"
                :stroke-width="strokeWidthNorm(shape.strokeWidth)"
                vector-effect="non-scaling-stroke"
            />
            <line
                v-if="shape.type === 'arrow'"
                :x1="shape.x"
                :y1="shape.y"
                :x2="shape.x2 ?? shape.x"
                :y2="shape.y2 ?? shape.y"
                :stroke="shape.color"
                :opacity="shape.opacity"
                :stroke-width="strokeWidthNorm(shape.strokeWidth)"
                vector-effect="non-scaling-stroke"
            />
            <polygon
                v-if="shape.type === 'arrow' && shape.lineEndStyle !== 'openArrow'"
                :points="arrowHeadPoints(shape)"
                :fill="shape.color"
                :opacity="shape.opacity"
            />
            <polyline
                v-if="shape.type === 'arrow' && shape.lineEndStyle === 'openArrow'"
                :points="arrowHeadPoints(shape)"
                fill="none"
                :stroke="shape.color"
                :opacity="shape.opacity"
                :stroke-width="strokeWidthNorm(shape.strokeWidth)"
                vector-effect="non-scaling-stroke"
            />
        </g>

        <g v-if="drawingShape" class="is-drawing">
            <rect
                v-if="drawingShape.type === 'rectangle'"
                :x="drawingShape.x"
                :y="drawingShape.y"
                :width="drawingShape.width"
                :height="drawingShape.height"
                :stroke="drawingShape.color"
                :fill="drawingShape.fillColor ?? 'none'"
                :opacity="drawingShape.opacity"
                :stroke-width="strokeWidthNorm(drawingShape.strokeWidth)"
                stroke-dasharray="0.01 0.005"
                vector-effect="non-scaling-stroke"
            />
            <ellipse
                v-if="drawingShape.type === 'circle'"
                :cx="drawingShape.x + drawingShape.width / 2"
                :cy="drawingShape.y + drawingShape.height / 2"
                :rx="drawingShape.width / 2"
                :ry="drawingShape.height / 2"
                :stroke="drawingShape.color"
                :fill="drawingShape.fillColor ?? 'none'"
                :opacity="drawingShape.opacity"
                :stroke-width="strokeWidthNorm(drawingShape.strokeWidth)"
                stroke-dasharray="0.01 0.005"
                vector-effect="non-scaling-stroke"
            />
            <line
                v-if="drawingShape.type === 'line'"
                :x1="drawingShape.x"
                :y1="drawingShape.y"
                :x2="drawingShape.x2 ?? drawingShape.x"
                :y2="drawingShape.y2 ?? drawingShape.y"
                :stroke="drawingShape.color"
                :opacity="drawingShape.opacity"
                :stroke-width="strokeWidthNorm(drawingShape.strokeWidth)"
                stroke-dasharray="0.01 0.005"
                vector-effect="non-scaling-stroke"
            />
            <line
                v-if="drawingShape.type === 'arrow'"
                :x1="drawingShape.x"
                :y1="drawingShape.y"
                :x2="drawingShape.x2 ?? drawingShape.x"
                :y2="drawingShape.y2 ?? drawingShape.y"
                :stroke="drawingShape.color"
                :opacity="drawingShape.opacity"
                :stroke-width="strokeWidthNorm(drawingShape.strokeWidth)"
                stroke-dasharray="0.01 0.005"
                vector-effect="non-scaling-stroke"
            />
            <polygon
                v-if="drawingShape.type === 'arrow' && drawingShape.lineEndStyle !== 'openArrow'"
                :points="arrowHeadPoints(drawingShape)"
                :fill="drawingShape.color"
                :opacity="drawingShape.opacity"
            />
            <polyline
                v-if="drawingShape.type === 'arrow' && drawingShape.lineEndStyle === 'openArrow'"
                :points="arrowHeadPoints(drawingShape)"
                fill="none"
                :stroke="drawingShape.color"
                :opacity="drawingShape.opacity"
                :stroke-width="strokeWidthNorm(drawingShape.strokeWidth)"
                vector-effect="non-scaling-stroke"
            />
        </g>

        <rect
            v-if="selectedShapeId && selectedShapeBounds"
            class="selection-outline"
            :x="selectedShapeBounds.x - 0.003"
            :y="selectedShapeBounds.y - 0.003"
            :width="selectedShapeBounds.width + 0.006"
            :height="selectedShapeBounds.height + 0.006"
            fill="none"
            stroke="#2563eb"
            stroke-width="1"
            stroke-dasharray="4 2"
            vector-effect="non-scaling-stroke"
        />
    </svg>
</template>

<script setup lang="ts">
import {
    ref,
    computed,
} from 'vue';
import { useResizeObserver } from '@vueuse/core';
import type {
    IShapeAnnotation,
    TShapeType,
    IAnnotationSettings,
} from '@app/types/annotations';

interface IProps {
    pageIndex: number;
    shapes: IShapeAnnotation[];
    drawingShape: IShapeAnnotation | null;
    selectedShapeId: string | null;
    isActive: boolean;
    tool: TShapeType | null;
    settings: IAnnotationSettings;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'start-drawing', payload: {
        x: number;
        y: number 
    }): void;
    (e: 'continue-drawing', payload: {
        x: number;
        y: number 
    }): void;
    (e: 'finish-drawing'): void;
    (e: 'select-shape', id: string | null): void;
    (e: 'shape-contextmenu', payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }): void;
}>();

const svgRef = ref<SVGSVGElement | null>(null);
const svgWidth = ref(1);
const svgHeight = ref(1);

useResizeObserver(svgRef, (entries) => {
    const entry = entries[0];
    if (entry) {
        svgWidth.value = entry.contentRect.width || 1;
        svgHeight.value = entry.contentRect.height || 1;
    }
});

function strokeWidthNorm(px: number) {
    return px;
}

function arrowHeadPoints(shape: IShapeAnnotation) {
    const x1 = shape.x;
    const y1 = shape.y;
    const x2 = shape.x2 ?? shape.x;
    const y2 = shape.y2 ?? shape.y;
    const w = svgWidth.value;
    const h = svgHeight.value;

    const dxPx = (x2 - x1) * w;
    const dyPx = (y2 - y1) * h;
    const angle = Math.atan2(dyPx, dxPx);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    const headLength = 10 * shape.strokeWidth;
    const headHalfWidth = 3.5 * shape.strokeWidth;

    const baseCenterNX = x2 - (headLength * cosA) / w;
    const baseCenterNY = y2 - (headLength * sinA) / h;

    const perpNX = (-sinA * headHalfWidth) / w;
    const perpNY = (cosA * headHalfWidth) / h;

    const leftX = baseCenterNX + perpNX;
    const leftY = baseCenterNY + perpNY;
    const rightX = baseCenterNX - perpNX;
    const rightY = baseCenterNY - perpNY;

    return `${x2},${y2} ${leftX},${leftY} ${rightX},${rightY}`;
}

function getNormalizedCoords(event: PointerEvent) {
    const svg = (event.currentTarget as SVGSVGElement) ?? (event.target as Element)?.closest('svg');
    if (!svg) {
        return null;
    }
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    return {
        x,
        y, 
    };
}

const selectedShapeBounds = computed(() => {
    if (!props.selectedShapeId) {
        return null;
    }
    const shape = props.shapes.find(s => s.id === props.selectedShapeId);
    if (!shape) {
        return null;
    }
    if (shape.type === 'line' || shape.type === 'arrow') {
        const x1 = shape.x;
        const y1 = shape.y;
        const x2 = shape.x2 ?? shape.x;
        const y2 = shape.y2 ?? shape.y;
        const minX = Math.min(x1, x2);
        const minY = Math.min(y1, y2);
        return {
            x: minX,
            y: minY,
            width: Math.max(0.01, Math.abs(x2 - x1)),
            height: Math.max(0.01, Math.abs(y2 - y1)),
        };
    }
    return {
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
    };
});

let pointerDrawing = false;

function handlePointerDown(event: PointerEvent) {
    if (!props.isActive || !props.tool) {
        emit('select-shape', null);
        return;
    }
    const coords = getNormalizedCoords(event);
    if (!coords) {
        return;
    }
    pointerDrawing = true;
    (event.currentTarget as Element)?.setPointerCapture(event.pointerId);
    emit('start-drawing', coords);
}

function handlePointerMove(event: PointerEvent) {
    if (!pointerDrawing) {
        return;
    }
    const coords = getNormalizedCoords(event);
    if (!coords) {
        return;
    }
    emit('continue-drawing', coords);
}

function handlePointerUp() {
    if (!pointerDrawing) {
        return;
    }
    pointerDrawing = false;
    emit('finish-drawing');
}

function handleShapeClick(id: string) {
    if (props.isActive && props.tool) {
        return;
    }
    emit('select-shape', id);
}

function handleShapeContextMenu(id: string, event: MouseEvent) {
    emit('select-shape', id);
    emit('shape-contextmenu', {
        shapeId: id,
        clientX: event.clientX,
        clientY: event.clientY,
    });
}
</script>

<style scoped>
.pdf-shape-overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 6;
    pointer-events: none;
}

.pdf-shape-overlay[viewBox] {
    pointer-events: auto;
}

.is-selected {
    cursor: move;
}

.is-drawing {
    pointer-events: none;
}

.selection-outline {
    pointer-events: none;
}
</style>
