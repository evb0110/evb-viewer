<template>
    <g
        class="pdf-annotation-editor-entity pdf-annotation-editor-text-markup"
        :class="{'is-selected': selected}"
        :data-annotation-id="entity.identity.id"
        data-annotation-kind="text-markup"
        :data-markup-subtype="entity.subtype"
        :style="markupStyle"
    >
        <template v-for="(quad, index) in entity.quadPoints" :key="`${entity.identity.id}-${index}`">
            <rect data-annotation-hit-target :x="quad.left" :y="quad.top" :width="quad.width" :height="quad.height" />
            <path v-if="entity.subtype === 'Squiggly'" data-annotation-visual :d="squiggleFor(quad)" />
            <line v-else-if="entity.subtype !== 'Highlight'" data-annotation-visual v-bind="lineFor(quad)" />
        </template>
        <path v-if="entity.subtype === 'Highlight' && highlightPath" data-annotation-visual :d="highlightPath" />
        <template v-if="entity.subtype === 'Highlight' && selected">
            <defs>
                <mask :id="highlightOutlineMaskId" maskUnits="userSpaceOnUse" x="-1" y="-1" width="3" height="3">
                    <rect x="-1" y="-1" width="3" height="3" fill="white" />
                    <path :d="ownHighlightPath" fill="black" />
                </mask>
            </defs>
            <path
                class="pdf-annotation-editor-highlight-outline"
                :d="ownHighlightPath"
                :mask="`url(#${highlightOutlineMaskId})`"
            />
        </template>
    </g>
</template>

<script setup lang="ts">
import type { ITextMarkupEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { IAnnotationPageDimensions } from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import { toPdfScaledCssLength } from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';
const props = defineProps<{
    entity: ITextMarkupEntity;
    selected: boolean;
    pageSize?: IAnnotationPageDimensions;
    pageRotation?: number;
    highlightPaintQuads?: readonly IAnnotationMarkerRect[] | undefined;
}>();
// One nonzero-winding fill applies transparency once, including where text
// line boxes overlap. Hit targets still belong to each original annotation.
function highlightPathFor(quads: readonly IAnnotationMarkerRect[]) {
    return quads.map(quad => `M${quad.left} ${quad.top}h${quad.width}v${quad.height}h${-quad.width}z`).join(' ');
}
const highlightPath = computed(() => highlightPathFor(props.highlightPaintQuads ?? props.entity.quadPoints));
const ownHighlightPath = computed(() => highlightPathFor(props.entity.quadPoints));
const highlightOutlineMaskId = useId();
function lineFor(quad: IAnnotationMarkerRect) {
    const fraction = props.entity.subtype === 'StrikeOut' ? 0.5 : 0.94;
    switch (props.pageRotation ?? 0) {
        case 90: return {
            x1: quad.left + quad.width * (1 - fraction),
            y1: quad.top,
            x2: quad.left + quad.width * (1 - fraction),
            y2: quad.top + quad.height,
        };
        case 180: return {
            x1: quad.left,
            y1: quad.top + quad.height * (1 - fraction),
            x2: quad.left + quad.width,
            y2: quad.top + quad.height * (1 - fraction),
        };
        case 270: return {
            x1: quad.left + quad.width * fraction,
            y1: quad.top,
            x2: quad.left + quad.width * fraction,
            y2: quad.top + quad.height,
        };
        default: return {
            x1: quad.left,
            y1: quad.top + quad.height * fraction,
            x2: quad.left + quad.width,
            y2: quad.top + quad.height * fraction,
        };
    }
}
function squiggleFor(quad: IAnnotationMarkerRect) {
    const line = lineFor(quad);
    const page = props.pageSize ?? {
        width: 612,
        height: 792,
    };
    const dx = (line.x2 - line.x1) * page.width;
    const dy = (line.y2 - line.y1) * page.height;
    const length = Math.hypot(dx, dy);
    if (!length) {
        return '';
    }
    const steps = Math.max(2, Math.ceil(length / 2));
    return Array.from({length: steps + 1}, (_, index) => {
        const fraction = index / steps;
        const offset = index === 0 || index === steps ? 0 : index % 2 ? 0.8 : -0.8;
        const x = line.x1 + (dx * fraction - dy / length * offset) / page.width;
        const y = line.y1 + (dy * fraction + dx / length * offset) / page.height;
        return `${index ? 'L' : 'M'}${x} ${y}`;
    }).join(' ');
}

const markupStyle = computed(() => ({
    '--annotation-color': props.entity.color ?? 'var(--app-pdf-highlight-bg)',
    '--annotation-opacity': String(props.entity.opacity ?? 0.45),
    '--annotation-markup-stroke-width': toPdfScaledCssLength(1),
}));
</script>
