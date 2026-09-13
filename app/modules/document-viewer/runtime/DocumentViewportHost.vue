<template>
    <div
        :id="viewportId"
        :ref="setViewportElement"
        data-document-viewer-chassis-viewport
        @scroll.passive="emit('scroll', $event)"
        @wheel="handleWheel"
        @mousedown="emit('mousedown', $event)"
        @mousemove="emit('mousemove', $event)"
        @mouseup="emit('mouseup', $event)"
        @mouseleave="emit('mouseleave')"
        @click="emit('click', $event)"
        @dblclick="emit('dblclick', $event)"
        @contextmenu="emit('contextmenu', $event)"
        @selectstart="emit('selectstart', $event)"
    >
        <slot />
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import {
    resolveDocumentWheelInteraction,
    type IDocumentWheelInteraction,
} from '@app/modules/document-viewer/input/documentWheelInteraction';

const {
    setViewport,
    viewportId = undefined,
} = defineProps<{
    setViewport: (element: HTMLElement | null) => void;
    viewportId?: string | undefined;
}>();

const emit = defineEmits<{
    scroll: [event: Event];
    wheel: [interaction: IDocumentWheelInteraction];
    mousedown: [event: MouseEvent];
    mousemove: [event: MouseEvent];
    mouseup: [event: MouseEvent];
    mouseleave: [];
    click: [event: MouseEvent];
    dblclick: [event: MouseEvent];
    contextmenu: [event: MouseEvent];
    selectstart: [event: Event];
}>();

const viewportElement = shallowRef<HTMLElement | null>(null);

function setViewportElement(element: Element | ComponentPublicInstance | null) {
    viewportElement.value = element instanceof HTMLElement ? element : null;
    setViewport(viewportElement.value);
}

function handleWheel(event: WheelEvent) {
    const viewport = viewportElement.value;
    if (!viewport) {
        return;
    }
    emit('wheel', resolveDocumentWheelInteraction(event, viewport));
}
</script>
