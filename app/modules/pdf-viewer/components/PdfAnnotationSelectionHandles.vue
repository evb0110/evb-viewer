<template>
    <div
        v-if="rect"
        class="pdf-annotation-selection-handles"
        :style="handlesStyle"
        aria-hidden="true"
    >
        <span
            v-for="handle in handles"
            :key="handle"
            class="pdf-annotation-selection-handle"
            :class="`pdf-annotation-selection-handle--${handle}`"
            :data-pdf-annotation-resize-handle="handle"
            @pointerdown.stop.prevent="handlePointerDown(handle, $event)"
        ></span>
    </div>
</template>

<script setup lang="ts">
import type { AnnotationEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { TAnnotationResizeHandle } from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';

const props = defineProps<{
    entity: AnnotationEntity | null;
    displayRect?: IAnnotationMarkerRect | undefined;
}>();
const emit = defineEmits<{'resize-start': [handle: TAnnotationResizeHandle, event: PointerEvent];}>();

function normalizeSelectionRect(value: IAnnotationMarkerRect): IAnnotationMarkerRect {
    const right = value.left + value.width;
    const bottom = value.top + value.height;
    return {
        left: Math.min(value.left, right),
        top: Math.min(value.top, bottom),
        width: Math.abs(value.width),
        height: Math.abs(value.height),
    };
}

const handles = [
    'nw',
    'n',
    'ne',
    'e',
    'se',
    's',
    'sw',
    'w',
] as const;

const rect = computed(() => {
    const entity = props.entity;
    if (!entity) {
        return null;
    }
    return entity.kind === 'shape' || entity.kind === 'text-box' || entity.kind === 'placed-image'
        ? normalizeSelectionRect(props.displayRect ?? entity.rect)
        : null;
});

const handlesStyle = computed(() => rect.value ? {
    left: `${rect.value.left * 100}%`,
    top: `${rect.value.top * 100}%`,
    width: `${rect.value.width * 100}%`,
    height: `${rect.value.height * 100}%`,
} : undefined);

function handlePointerDown(handle: TAnnotationResizeHandle, event: PointerEvent) {
    if (props.entity?.kind === 'text-box' || props.entity?.kind === 'placed-image') {
        emit('resize-start', handle, event);
    }
}
</script>
