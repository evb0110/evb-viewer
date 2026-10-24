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
import { useEventListener } from '@vueuse/core';
import {
    resolveDocumentPinchZoomDeltaPx,
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

/*
 * A two-finger pinch zooms the document, not the page: the page forbids the
 * browser's own pinch zoom (touch-action in the app shell), and each move of
 * the pinch reaches the viewer as the zoom interaction a trackpad pinch makes,
 * anchored between the fingers. Moving both fingers scrolls the document.
 *
 * Zooming re-renders the page under the fingers, and touch events stay with
 * the element each finger first touched: once that element is replaced they
 * reach neither the viewport nor the window, only the element itself. The
 * pinch therefore listens on the fingers' own targets while it lasts, so
 * ordinary scrolling keeps passive listeners.
 */
interface ITouchPinch {
    span: number;
    x: number;
    y: number;
}

let pinch: ITouchPinch | null = null;
let stopFollowingPinch: (() => void) | null = null;

function readTouchPinch(event: TouchEvent): ITouchPinch | null {
    const first = event.touches.item(0);
    const second = event.touches.item(1);
    if (event.touches.length !== 2 || !first || !second) {
        return null;
    }
    return {
        span: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
        x: (first.clientX + second.clientX) / 2,
        y: (first.clientY + second.clientY) / 2,
    };
}

function endTouchPinch() {
    pinch = null;
    stopFollowingPinch?.();
    stopFollowingPinch = null;
}

function moveTouchPinch(event: TouchEvent) {
    const viewport = viewportElement.value;
    const next = readTouchPinch(event);
    if (!viewport || !next || !pinch) {
        endTouchPinch();
        return;
    }
    // Each finger's target receives the same move; act on it once.
    if (next.span === pinch.span && next.x === pinch.x && next.y === pinch.y) {
        return;
    }
    // A second finger added during a one-finger scroll arrives as moves the
    // browser already scrolls with and will not let us cancel; scrolling them
    // again would double the speed.
    if (event.cancelable) {
        event.preventDefault();
        viewport.scrollBy(pinch.x - next.x, pinch.y - next.y);
    }
    const deltaPx = resolveDocumentPinchZoomDeltaPx(pinch.span, next.span);
    pinch = next;
    emit('wheel', {
        deltaPx,
        intent: 'zoom',
        event: {
            cancelable: event.cancelable,
            clientX: next.x,
            clientY: next.y,
            defaultPrevented: event.defaultPrevented,
            deltaX: 0,
            deltaY: deltaPx,
            timeStamp: event.timeStamp,
            preventDefault: () => event.preventDefault(),
        },
    });
}

function startTouchPinch(event: TouchEvent) {
    const start = readTouchPinch(event);
    if (!start) {
        return;
    }
    endTouchPinch();
    pinch = start;
    const targets = new Set(Array.from(event.touches, touch => touch.target));
    const stops = [...targets].flatMap(target => [
        useEventListener(target, 'touchmove', moveTouchPinch, {passive: false}),
        useEventListener(target, [
            'touchend',
            'touchcancel',
        ], (touchEvent: TouchEvent) => {
            if (touchEvent.touches.length < 2) {
                endTouchPinch();
            }
        }),
    ]);
    stopFollowingPinch = () => stops.forEach(stop => stop());
}

useEventListener(viewportElement, 'touchstart', startTouchPinch, {passive: true});
onBeforeUnmount(endTouchPinch);
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
