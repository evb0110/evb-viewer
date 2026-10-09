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
        <div
            v-if="openingPageShell && openingPageVisual !== 'fresh'"
            class="document-viewer-chassis__opening-layer"
        >
            <section
                :id="openingPageShell.id"
                :ref="setOpeningPageElement"
                class="document-viewer-chassis__opening-page"
                :style="openingPageShell.style"
                :data-page-number="openingPageShell.pageNumber"
                :data-document-page-number="openingPageShell.pageNumber"
                :data-document-opening-shell-id="openingPageShell.id"
                :data-open-surface-generation="openingPageShell.generation"
                :data-open-surface-frame-owner="openingPageShell.ownerId"
                :data-page-source-visual="openingPageVisual"
                data-testid="document-page-source-page"
            >
                <DocumentPageSkeleton :content-height="openingPageShell.height" />
            </section>
        </div>
        <slot />
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import DocumentPageSkeleton from '@app/components/document-viewer/DocumentPageSkeleton.vue';
import {
    resolveDocumentWheelInteraction,
    type IDocumentWheelInteraction,
} from '@app/modules/document-viewer/input/documentWheelInteraction';
import type { IDocumentOpeningPageShell } from '@app/modules/document-viewer/runtime/documentOpeningPageFrame';
import type { TDocumentOpeningPageVisual } from '@app/modules/document-viewer/runtime/documentViewerRuntime';

const {
    openingPageShell,
    openingPageVisual,
    setOpeningPage,
    setViewport,
    viewportId = undefined,
} = defineProps<{
    openingPageShell: IDocumentOpeningPageShell | null;
    openingPageVisual: TDocumentOpeningPageVisual;
    setOpeningPage: (element: HTMLElement | null) => void;
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

function setOpeningPageElement(element: Element | ComponentPublicInstance | null) {
    setOpeningPage(element instanceof HTMLElement ? element : null);
}

function handleWheel(event: WheelEvent) {
    const viewport = viewportElement.value;
    if (!viewport) {
        return;
    }
    emit('wheel', resolveDocumentWheelInteraction(event, viewport));
}
</script>

<style scoped>
.document-viewer-chassis__opening-page {
    position: absolute;

    /* This is the sole visible owner until the joined canvas/viewport commit.
       Keep the mounted live page track underneath so it can render without
       occluding the shell before the atomic ready handoff. */
    z-index: var(--app-workspace-transition-overlay-z-index);
    overflow: hidden;
    pointer-events: none;
    background: var(--app-document-page-bg);
    border-radius: var(--app-document-page-radius);
    box-shadow: var(--app-document-page-shadow);
}

.document-viewer-chassis__opening-layer {
    position: sticky;
    top: 0;
    left: 0;
    z-index: var(--app-workspace-transition-overlay-z-index);
    width: 100%;
    height: 0;
    overflow: visible;
    pointer-events: none;
}
</style>
