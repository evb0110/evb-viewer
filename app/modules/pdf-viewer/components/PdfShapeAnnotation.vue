<template>
    <g
        class="pdf-annotation-editor-entity pdf-annotation-editor-shape"
        :class="{'is-selected': selected}"
        :data-annotation-id="entity.identity.id"
        :data-pdf-annotation-id="entity.identity.pdfRef"
        data-annotation-kind="shape"
        :style="shapeStyle"
    >
        <g
            v-for="pass in renderPasses"
            :key="pass"
            :data-annotation-hit-target="pass === 'hit' ? '' : undefined"
            :data-annotation-visual="pass === 'visual' ? '' : undefined"
            :class="`pdf-annotation-editor-shape__${pass}`"
        >
            <line
                v-if="entity.tool === 'line' || entity.tool === 'arrow'"
                :x1="line.x1" :y1="line.y1" :x2="line.x2" :y2="line.y2"
            />
            <ellipse
                v-else-if="entity.tool === 'circle'"
                :cx="entity.rect.left + entity.rect.width / 2"
                :cy="entity.rect.top + entity.rect.height / 2"
                :rx="Math.abs(entity.rect.width / 2)"
                :ry="Math.abs(entity.rect.height / 2)"
            />
            <template v-else-if="entity.tool === 'draw'">
                <component
                    :is="entity.pdfSubtype === 'Polygon' ? 'polygon' : 'polyline'"
                    v-for="(stroke, index) in drawableStrokePointSets"
                    :key="index"
                    :points="formatPoints(stroke)"
                />
            </template>
            <rect v-else :x="entity.rect.left" :y="entity.rect.top" :width="entity.rect.width" :height="entity.rect.height" />
            <template v-if="pass === 'visual'">
                <component
                    :is="head.closed ? 'polygon' : 'polyline'"
                    v-for="(head, index) in arrowHeads"
                    :key="`head-${index}`"
                    class="pdf-annotation-editor-shape__arrowhead"
                    :class="{'is-open': !head.closed}"
                    :points="head.points"
                />
            </template>
        </g>
    </g>
</template>

<script setup lang="ts">
import type { IShapeEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { toPdfScaledCssLength } from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';
import type { IAnnotationPageDimensions } from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';

const props = defineProps<{
    entity: IShapeEntity;
    selected: boolean;
    pageSize?: IAnnotationPageDimensions
}>();
const renderPasses = [
    'hit',
    'visual',
] as const;
const strokePointSets = computed(() => props.entity.strokes?.length ? props.entity.strokes : props.entity.points ? [props.entity.points] : []);
const drawableStrokePointSets = computed(() => strokePointSets.value.filter(points => points.length > 1));
const linePoints = computed(() => props.entity.points?.length ? props.entity.points : props.entity.strokes?.[0] ?? []);
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
const arrowHeads = computed(() => {
    if (props.entity.tool !== 'line' && props.entity.tool !== 'arrow') {
        return [];
    }
    const page = props.pageSize ?? {
        width: 612,
        height: 792,
    };
    const endpoints = [
        {
            x: line.value.x1 * page.width,
            y: line.value.y1 * page.height,
        },
        {
            x: line.value.x2 * page.width,
            y: line.value.y2 * page.height,
        },
    ] as const;
    const styles = [
        props.entity.lineStartStyle ?? 'none',
        props.entity.lineEndStyle ?? (props.entity.tool === 'arrow' ? 'closedArrow' : 'none'),
    ];
    return styles.flatMap((style, index) => {
        if (style === 'none') {
            return [];
        }
        const tip = endpoints[index === 0 ? 0 : 1];
        const other = endpoints[index === 0 ? 1 : 0];
        const length = Math.hypot(tip.x - other.x, tip.y - other.y);
        if (!length) {
            return [];
        }
        const headLength = Math.min(length * 0.4, Math.max(6, props.entity.strokeWidth * 10));
        const halfWidth = headLength * 0.35;
        const ux = (tip.x - other.x) / length;
        const uy = (tip.y - other.y) / length;
        return [{
            closed: style === 'closedArrow',
            points: formatPoints([
                {
                    x: tip.x - ux * headLength - uy * halfWidth,
                    y: tip.y - uy * headLength + ux * halfWidth,
                },
                tip,
                {
                    x: tip.x - ux * headLength + uy * halfWidth,
                    y: tip.y - uy * headLength - ux * halfWidth,
                },
            ].map(point => ({
                x: point.x / page.width,
                y: point.y / page.height,
            }))),
        }];
    });
});
const shapeStyle = computed(() => ({
    '--annotation-stroke': props.entity.strokeColor,
    '--annotation-fill': props.entity.fill ?? 'none',
    '--annotation-opacity': String(props.entity.opacity),
    '--annotation-stroke-width': toPdfScaledCssLength(props.entity.strokeWidth),
    '--annotation-hit-width': `max(14px, ${toPdfScaledCssLength(props.entity.strokeWidth, 10)})`,
}));
</script>
