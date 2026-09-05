<template>
    <g
        class="pdf-annotation-editor-entity pdf-annotation-editor-shape"
        :class="{'is-selected': selected}"
        :data-annotation-id="entity.identity.id"
        :data-pdf-annotation-id="entity.identity.pdfRef"
        data-annotation-kind="shape"
        :style="shapeStyle"
        aria-label="Shape annotation"
    >
        <template v-if="entity.tool === 'line' || entity.tool === 'arrow'">
            <line
                :x1="line.x1"
                :y1="line.y1"
                :x2="line.x2"
                :y2="line.y2"
            />
            <polygon
                v-if="entity.tool === 'arrow' && arrowHeadPoints"
                class="pdf-annotation-editor-shape__arrowhead"
                :points="arrowHeadPoints"
            />
        </template>
            <ellipse
            v-else-if="entity.tool === 'circle'"
            :cx="entity.rect.left + entity.rect.width / 2"
            :cy="entity.rect.top + entity.rect.height / 2"
            :rx="Math.abs(entity.rect.width / 2)"
                :ry="Math.abs(entity.rect.height / 2)"
        />
        <template v-else-if="entity.tool === 'draw'">
            <polyline
                v-for="(stroke, index) in drawableStrokePointSets"
                :key="`${entity.identity.id}-stroke-${index}`"
                :points="formatPoints(stroke)"
            />
        </template>
        <rect
            v-else
            :x="entity.rect.left"
            :y="entity.rect.top"
            :width="entity.rect.width"
            :height="entity.rect.height"
        />
    </g>
</template>

<script setup lang="ts">
import type { IShapeEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { toPdfScaledCssLength } from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';

const props = defineProps<{
    entity: IShapeEntity;
    selected: boolean;
}>();

const strokePointSets = computed(() => {
    if (props.entity.strokes && props.entity.strokes.length > 0) {
        return props.entity.strokes;
    }
    return props.entity.points ? [props.entity.points] : [];
});
const drawableStrokePointSets = computed(() => strokePointSets.value.filter(points => points.length > 1));
const linePoints = computed(() => (
    props.entity.points && props.entity.points.length > 0
        ? props.entity.points
        : props.entity.strokes?.[0] ?? []
));

function formatPoints(points: ReadonlyArray<{
    x: number;
    y: number
}>) {
    return points.map(point => `${point.x},${point.y}`).join(' ');
}

const line = computed(() => {
    const first = linePoints.value[0];
    const last = linePoints.value.at(-1);
    return {
        x1: first?.x ?? props.entity.rect.left,
        y1: first?.y ?? props.entity.rect.top,
        x2: last?.x ?? props.entity.rect.left + props.entity.rect.width,
        y2: last?.y ?? props.entity.rect.top + props.entity.rect.height,
    };
});

const arrowHeadPoints = computed(() => {
    if (props.entity.tool !== 'arrow') {
        return null;
    }
    const dx = line.value.x2 - line.value.x1;
    const dy = line.value.y2 - line.value.y1;
    const length = Math.hypot(dx, dy);
    if (length <= 0) {
        return null;
    }
    const headLength = Math.min(length * 0.25, 0.04);
    const headHalfWidth = headLength * 0.45;
    const unitX = dx / length;
    const unitY = dy / length;
    const baseX = line.value.x2 - unitX * headLength;
    const baseY = line.value.y2 - unitY * headLength;
    const perpendicularX = -unitY * headHalfWidth;
    const perpendicularY = unitX * headHalfWidth;
    return formatPoints([
        {
            x: line.value.x2,
            y: line.value.y2,
        },
        {
            x: baseX + perpendicularX,
            y: baseY + perpendicularY,
        },
        {
            x: baseX - perpendicularX,
            y: baseY - perpendicularY,
        },
    ]);
});

const shapeStyle = computed(() => ({
    '--annotation-stroke': props.entity.strokeColor,
    '--annotation-fill': props.entity.fill ?? 'transparent',
    '--annotation-opacity': String(props.entity.opacity),
    '--annotation-stroke-width': toPdfScaledCssLength(props.entity.strokeWidth),
}));
</script>
