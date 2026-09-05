<template>
    <div
        v-if="placement"
        ref="frameRef"
        class="pdf-image-placement"
        :style="frameStyle"
        @mousedown.stop.prevent
        @mouseup.stop
        @click.stop
        @dblclick.stop
        @contextmenu.prevent.stop
    >
        <div class="pdf-image-placement__transform" :style="transformStyle">
            <img
                class="pdf-image-placement__preview"
                :src="placement.previewUrl"
                :alt="placement.fileName"
                draggable="false"
            >
            <button
                type="button"
                class="pdf-image-placement__surface"
                :disabled="busy"
                :aria-label="t('annotations.imageLabel')"
                @mousedown.stop.prevent
                @pointerdown.stop.prevent="handleMovePointerDown"
            />
            <div class="pdf-image-placement__resizers">
                <button
                    v-for="handle in resizeHandles"
                    :key="handle"
                    type="button"
                    class="pdf-image-placement__resizer"
                    :class="`pdf-image-placement__resizer--${handle}`"
                    :style="getResizeHandleStyle(handle)"
                    :disabled="busy"
                    :aria-label="t('annotations.imageLabel')"
                    @mousedown.stop.prevent
                    @pointerdown.stop.prevent="handleResizePointerDown(handle, $event)"
                />
                <button
                    type="button"
                    class="pdf-image-placement__rotate-handle"
                    :disabled="busy"
                    :aria-label="t('annotations.imageLabel')"
                    @mousedown.stop.prevent
                    @pointerdown.stop.prevent="handleRotatePointerDown"
                />
            </div>
        </div>
        <div class="pdf-image-placement__controls">
            <button
                type="button"
                class="pdf-image-placement__action pdf-image-placement__action--secondary"
                :disabled="busy"
                @mousedown.stop.prevent
                @click.stop="cancelPlacement"
            >
                {{ t('annotations.cancelImagePlacement') }}
            </button>
            <button
                type="button"
                class="pdf-image-placement__action pdf-image-placement__action--primary"
                :disabled="busy"
                @mousedown.stop.prevent
                @click.stop="finalizePlacement"
            >
                {{ t('annotations.embedImageToPage') }}
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { clamp } from 'es-toolkit/math';
import { useEventListener } from '@vueuse/core';
import type {
    IPdfImagePlacementDraft,
    IPdfImagePlacementRectUpdate,
} from '@app/types/pdfImagePlacement';
import { getImagePlacementResizeCursorStyle } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/getImagePlacementResizeCursorStyle';
import { getImagePlacementResizeHandleViewportPosition } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/getImagePlacementResizeHandleViewportPosition';
import { getImagePlacementRotateHandleViewportPosition } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/getImagePlacementRotateHandleViewportPosition';
import { moveImagePlacementRect } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/moveImagePlacementRect';
import type {
    IImagePlacementContainerRect,
    IImagePlacementRectPx,
    TImagePlacementResizeHandle,
} from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/pdfImagePlacementSizingTypes';
import { resizeImagePlacementRect } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/resizeImagePlacementRect';
import { rotateImagePlacementRect } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/rotateImagePlacementRect';
import { createRafCoalescedCallback } from '@app/utils/createRafCoalescedCallback';

const {
    placement,
    busy = false,
} = defineProps<{
    placement: IPdfImagePlacementDraft | null;
    busy?: boolean;
}>();

const emit = defineEmits<{
    updateRect: [payload: IPdfImagePlacementRectUpdate];
    finalize: [];
    cancel: [];
}>();

const { t } = useTypedI18n();
const frameRef = ref<HTMLElement | null>(null);
const GLOBAL_CURSOR_ATTRIBUTE = 'data-pdf-image-placement-cursor';
const placementKeyboardTarget = computed(() => (
    placement && !busy && typeof window !== 'undefined'
        ? window
        : null
));
const resizeHandles: TImagePlacementResizeHandle[] = [
    'nw',
    'n',
    'ne',
    'e',
    'se',
    's',
    'sw',
    'w',
];

const frameStyle = computed((): Record<string, string> => {
    if (!placement) {
        return {};
    }

    return {
        left: `${placement.x * 100}%`,
        top: `${placement.y * 100}%`,
        width: `${placement.width * 100}%`,
        height: `${placement.height * 100}%`,
    };
});

const transformStyle = computed((): Record<string, string> => ({ '--pdf-image-placement-rotation': `${placement?.rotationDegrees ?? 0}deg` }));

function getResizeHandleStyle(handle: TImagePlacementResizeHandle) {
    return { cursor: getImagePlacementResizeCursorStyle(handle, placement?.rotationDegrees ?? 0) };
}

interface IActiveInteraction {
    mode: 'move' | 'resize' | 'rotate';
    handle?: TImagePlacementResizeHandle | undefined;
    pointerId: number;
    captureElement: HTMLElement | null;
    originRectPx: IImagePlacementRectPx;
    startClientX: number;
    startClientY: number;
    containerRect: IImagePlacementContainerRect;
    originRotationDegrees: number;
    activeCursor: string;
}

let activeInteraction: IActiveInteraction | null = null;
const interactionWindowTarget = shallowRef<Window | undefined>();

function setGlobalInteractionCursor(cursor: string) {
    const root = document.documentElement;
    root.style.setProperty('--pdf-image-placement-active-cursor', cursor);
    root.setAttribute(GLOBAL_CURSOR_ATTRIBUTE, '');
}

function clearGlobalInteractionCursor() {
    const root = document.documentElement;
    root.style.removeProperty('--pdf-image-placement-active-cursor');
    root.removeAttribute(GLOBAL_CURSOR_ATTRIBUTE);
}

let virtualCursorElement: HTMLElement | null = null;

function createVirtualCursor(cursorSvgDataUri: string) {
    removeVirtualCursor();
    const element = document.createElement('div');
    element.className = 'pdf-image-placement-virtual-cursor';
    element.innerHTML = cursorSvgDataUri;
    document.body.appendChild(element);
    virtualCursorElement = element;
}

function updateVirtualCursorPosition(x: number, y: number) {
    if (!virtualCursorElement) {
        return;
    }
    virtualCursorElement.style.left = `${x}px`;
    virtualCursorElement.style.top = `${y}px`;
}

function removeVirtualCursor() {
    virtualCursorElement?.remove();
    virtualCursorElement = null;
}

const ROTATE_HANDLE_OFFSET_REM = 2.4;

function getRemPx() {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

function resolveCursorThemeColors() {
    const styles = getComputedStyle(document.documentElement);
    // Fallbacks shadow the design tokens --ui-text and --ui-bg for SVG
    // attribute strings (canvas/inline-style requires concrete colors).
    const fill = styles.getPropertyValue('--ui-text').trim() || '#0f172a';
    const outline = styles.getPropertyValue('--ui-bg').trim() || '#ffffff';
    return {
        fill,
        outline,
    };
}

function buildVirtualCursorSvg(mode: IActiveInteraction['mode'], handle?: TImagePlacementResizeHandle) {
    const {
        fill,
        outline,
    } = resolveCursorThemeColors();
    if (mode === 'rotate') {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" fill="${fill}" stroke="${outline}" stroke-width="0.5"/></svg>`;
    }
    if (mode === 'move') {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M13 6v5h5V8l4 4-4 4v-3h-5v5h3l-4 4-4-4h3v-5H6v3l-4-4 4-4v3h5V6H8l4-4 4 4h-3z" fill="${fill}" stroke="${outline}" stroke-width="0.5"/></svg>`;
    }
    const angleDeg = IMAGE_PLACEMENT_HANDLE_ANGLES_FOR_CURSOR[handle ?? 'e'] + (placement?.rotationDegrees ?? 0);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g transform="rotate(${angleDeg} 12 12)"><line x1="6" y1="12" x2="18" y2="12" stroke="${outline}" stroke-width="4" stroke-linecap="round"/><path d="M8.5 9 L5 12 L8.5 15" fill="none" stroke="${outline}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 9 L19 12 L15.5 15" fill="none" stroke="${outline}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><line x1="6" y1="12" x2="18" y2="12" stroke="${fill}" stroke-width="2" stroke-linecap="round"/><path d="M8.5 9 L5 12 L8.5 15" fill="none" stroke="${fill}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 9 L19 12 L15.5 15" fill="none" stroke="${fill}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
}

const IMAGE_PLACEMENT_HANDLE_ANGLES_FOR_CURSOR: Record<TImagePlacementResizeHandle, number> = {
    n: -90,
    ne: -45,
    e: 0,
    se: 45,
    s: 90,
    sw: 135,
    w: 180,
    nw: 225,
};

function getInteractionCursor(
    mode: IActiveInteraction['mode'],
    handle?: TImagePlacementResizeHandle,
) {
    if (mode === 'move' || mode === 'rotate') {
        return 'grabbing';
    }

    if (!handle) {
        return 'move';
    }

    return getImagePlacementResizeCursorStyle(handle, placement?.rotationDegrees ?? 0);
}

function getContainerRect(): IImagePlacementContainerRect | null {
    const pageContainer = frameRef.value?.parentElement;
    if (!pageContainer) {
        return null;
    }
    const rect = pageContainer.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
    };
}

function getOriginRectPx(containerRect: IImagePlacementContainerRect, placement: IPdfImagePlacementDraft): IImagePlacementRectPx {
    return {
        left: placement.x * containerRect.width,
        top: placement.y * containerRect.height,
        width: placement.width * containerRect.width,
        height: placement.height * containerRect.height,
    };
}

function toNormalizedRect(
    containerRect: IImagePlacementContainerRect,
    rectPx: IImagePlacementRectPx,
    rotationDegrees?: number,
): IPdfImagePlacementRectUpdate {
    const update: IPdfImagePlacementRectUpdate = {
        x: clamp(rectPx.left / containerRect.width, 0, 1),
        y: clamp(rectPx.top / containerRect.height, 0, 1),
        width: clamp(rectPx.width / containerRect.width, 0, 1),
        height: clamp(rectPx.height / containerRect.height, 0, 1),
    };
    if (typeof rotationDegrees === 'number' && Number.isFinite(rotationDegrees)) {
        update.rotationDegrees = rotationDegrees;
    }
    return update;
}

function startInteraction(
    mode: IActiveInteraction['mode'],
    event: PointerEvent,
    handle?: TImagePlacementResizeHandle,
) {
    if (!placement || busy) {
        return;
    }

    const containerRect = getContainerRect();
    if (!containerRect) {
        return;
    }

    stopInteraction();

    const captureElement = event.currentTarget instanceof HTMLElement
        ? event.currentTarget
        : null;
    const activeCursor = getInteractionCursor(mode, handle);

    captureElement?.setPointerCapture(event.pointerId);

    activeInteraction = {
        mode,
        ...(handle !== undefined ? { handle } : {}),
        pointerId: event.pointerId,
        captureElement,
        originRectPx: getOriginRectPx(containerRect, placement),
        startClientX: event.clientX,
        startClientY: event.clientY,
        containerRect,
        originRotationDegrees: placement.rotationDegrees,
        activeCursor,
    };
    setGlobalInteractionCursor('none');
    createVirtualCursor(buildVirtualCursorSvg(mode, handle));
    updateVirtualCursorPosition(event.clientX, event.clientY);
    interactionWindowTarget.value = window;
}

function stopInteraction() {
    imagePlacementMove.cancel();
    const interaction = activeInteraction;
    if (
        interaction?.captureElement
        && interaction.captureElement.hasPointerCapture(interaction.pointerId)
    ) {
        interaction.captureElement.releasePointerCapture(interaction.pointerId);
    }

    activeInteraction = null;
    interactionWindowTarget.value = undefined;
    clearGlobalInteractionCursor();
    removeVirtualCursor();
}

function handleMovePointerDown(event: PointerEvent) {
    startInteraction('move', event);
}

function handleResizePointerDown(handle: TImagePlacementResizeHandle, event: PointerEvent) {
    startInteraction('resize', event, handle);
}

function handleRotatePointerDown(event: PointerEvent) {
    startInteraction('rotate', event);
}

function applyMoveInteraction(interaction: IActiveInteraction, event: PointerEvent) {
    const rectPx = moveImagePlacementRect({
        originRectPx: interaction.originRectPx,
        containerRect: interaction.containerRect,
        deltaX: event.clientX - interaction.startClientX,
        deltaY: event.clientY - interaction.startClientY,
        rotationDegrees: interaction.originRotationDegrees,
    });

    updateVirtualCursorPosition(event.clientX, event.clientY);

    emit('updateRect', toNormalizedRect(interaction.containerRect, rectPx));
}

function applyResizeInteraction(interaction: IActiveInteraction, event: PointerEvent) {
    const handle = interaction.handle;
    if (!handle) {
        return;
    }

    const rectPx = resizeImagePlacementRect({
        originRectPx: interaction.originRectPx,
        containerRect: interaction.containerRect,
        handle,
        startClientX: interaction.startClientX,
        startClientY: interaction.startClientY,
        clientX: event.clientX,
        clientY: event.clientY,
        rotationDegrees: interaction.originRotationDegrees,
        shiftKey: event.shiftKey,
    });

    const containerOrigin = {
        x: interaction.containerRect.left,
        y: interaction.containerRect.top,
    };
    const handlePos = getImagePlacementResizeHandleViewportPosition(
        rectPx,
        handle,
        interaction.originRotationDegrees,
        containerOrigin,
    );
    updateVirtualCursorPosition(handlePos.x, handlePos.y);

    emit('updateRect', toNormalizedRect(interaction.containerRect, rectPx));
}

function applyRotateInteraction(interaction: IActiveInteraction, event: PointerEvent) {
    const containerOrigin = {
        x: interaction.containerRect.left,
        y: interaction.containerRect.top,
    };
    const { rotationDegrees } = rotateImagePlacementRect({
        originRectPx: interaction.originRectPx,
        containerOrigin,
        originRotationDegrees: interaction.originRotationDegrees,
        startClientX: interaction.startClientX,
        startClientY: interaction.startClientY,
        clientX: event.clientX,
        clientY: event.clientY,
        shiftKey: event.shiftKey,
    });

    const handlePos = getImagePlacementRotateHandleViewportPosition(
        interaction.originRectPx,
        rotationDegrees,
        containerOrigin,
        ROTATE_HANDLE_OFFSET_REM * getRemPx(),
    );
    updateVirtualCursorPosition(handlePos.x, handlePos.y);

    emit('updateRect', toNormalizedRect(
        interaction.containerRect,
        interaction.originRectPx,
        rotationDegrees,
    ));
}

function handleWindowPointerMove(event: PointerEvent) {
    const interaction = activeInteraction;
    if (!interaction || event.pointerId !== interaction.pointerId) {
        return;
    }

    if (interaction.mode === 'move') {
        applyMoveInteraction(interaction, event);
        return;
    }

    if (interaction.mode === 'rotate') {
        applyRotateInteraction(interaction, event);
        return;
    }

    applyResizeInteraction(interaction, event);
}

const imagePlacementMove = createRafCoalescedCallback(handleWindowPointerMove);

function handleWindowPointerUp(event: PointerEvent) {
    if (!activeInteraction || event.pointerId !== activeInteraction.pointerId) {
        return;
    }
    imagePlacementMove.flush(event);
    stopInteraction();
}

useEventListener(interactionWindowTarget, 'pointermove', imagePlacementMove.schedule);
useEventListener(interactionWindowTarget, 'pointerup', handleWindowPointerUp);
useEventListener(interactionWindowTarget, 'pointercancel', handleWindowPointerUp);

watch(() => [
    placement !== null,
    busy,
] as const, ([
    hasPlacement,
    isBusy,
]) => {
    if (!hasPlacement || isBusy) {
        stopInteraction();
    }
});

function isEditableTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    if (target.isContentEditable) {
        return true;
    }

    return [
        'INPUT',
        'TEXTAREA',
        'SELECT',
    ].includes(target.tagName);
}

function handlePlacementKeydown(event: KeyboardEvent) {
    if (!placement || busy || event.defaultPrevented || isEditableTarget(event.target)) {
        return;
    }

    if (event.key === 'Escape') {
        event.preventDefault();
        stopInteraction();
        emit('cancel');
        return;
    }

    if (
        (event.key === 'Enter' || event.key === 'NumpadEnter')
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
    ) {
        event.preventDefault();
        stopInteraction();
        emit('finalize');
    }
}

useEventListener(placementKeyboardTarget, 'keydown', handlePlacementKeydown);

function cancelPlacement() {
    stopInteraction();
    emit('cancel');
}

function finalizePlacement() {
    stopInteraction();
    emit('finalize');
}

onBeforeUnmount(() => {
    stopInteraction();
    clearGlobalInteractionCursor();
    removeVirtualCursor();
});
</script>

<style scoped>
:global(html[data-pdf-image-placement-cursor]),
:global(html[data-pdf-image-placement-cursor] *) {
    /* stylelint-disable declaration-no-important -- css-important-allow: Image placement locks the pointer cursor across native controls and PDF.js layers. */
    cursor: var(--pdf-image-placement-active-cursor) !important;
    /* stylelint-enable declaration-no-important */
}

:global(.pdf-image-placement-virtual-cursor) {
    position: fixed;
    pointer-events: none;
    z-index: var(--app-z-pdf-image-placement-virtual-cursor);
    width: var(--app-pdf-image-placement-virtual-cursor-size);
    height: var(--app-pdf-image-placement-virtual-cursor-size);
    transform: translate(
        calc(var(--app-pdf-image-placement-virtual-cursor-size) * -0.5),
        calc(var(--app-pdf-image-placement-virtual-cursor-size) * -0.5)
    );
    filter: drop-shadow(0 1px 2px var(--app-image-placement-shadow));
}

.pdf-image-placement {
    --pdf-image-placement-resizer-offset: calc(var(--app-pdf-image-placement-resizer-size) * -0.5);
    --pdf-image-placement-rotate-handle-offset: calc(var(--app-pdf-image-placement-rotate-handle-size) * -0.5);

    position: absolute;
    z-index: var(--app-z-pdf-image-placement);
    touch-action: none;
}

.pdf-image-placement__transform {
    position: absolute;
    inset: 0;
    border-radius: var(--app-radius-xl);
    transform: rotate(var(--pdf-image-placement-rotation, 0deg));
    transform-origin: center;
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--ui-primary) 70%, var(--ui-bg) 30%);
}

.pdf-image-placement__preview {
    width: 100%;
    height: 100%;
    display: block;
    border-radius: inherit;
    object-fit: fill;
    pointer-events: none;
    user-select: none;
}

.pdf-image-placement__surface {
    position: absolute;
    inset: 0;
    border: none;
    border-radius: inherit;
    background: color-mix(in oklab, transparent 82%, var(--ui-primary) 18%);
    cursor: move;
}

.pdf-image-placement__surface:disabled {
    cursor: progress;
}

.pdf-image-placement__resizers {
    position: absolute;
    inset: 0;
    pointer-events: none;
}

.pdf-image-placement__resizer {
    position: absolute;
    width: var(--app-pdf-image-placement-resizer-size);
    height: var(--app-pdf-image-placement-resizer-size);
    border: 1px solid var(--ui-bg);
    border-radius: var(--app-radius-full);
    background: var(--ui-primary);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--ui-bg-inverted) 22%, transparent);
    pointer-events: auto;
}

.pdf-image-placement__resizer::after {
    content: '';
    position: absolute;
    inset: var(--app-pdf-image-placement-resizer-hit-inset);
}

.pdf-image-placement__resizer:disabled {
    cursor: progress;
}

.pdf-image-placement__resizer--nw {
    top: var(--pdf-image-placement-resizer-offset);
    left: var(--pdf-image-placement-resizer-offset);
}

.pdf-image-placement__resizer--n {
    top: var(--pdf-image-placement-resizer-offset);
    left: calc(50% + var(--pdf-image-placement-resizer-offset));
}

.pdf-image-placement__resizer--ne {
    top: var(--pdf-image-placement-resizer-offset);
    right: var(--pdf-image-placement-resizer-offset);
}

.pdf-image-placement__resizer--e {
    top: calc(50% + var(--pdf-image-placement-resizer-offset));
    right: var(--pdf-image-placement-resizer-offset);
}

.pdf-image-placement__resizer--se {
    right: var(--pdf-image-placement-resizer-offset);
    bottom: var(--pdf-image-placement-resizer-offset);
}

.pdf-image-placement__resizer--s {
    bottom: var(--pdf-image-placement-resizer-offset);
    left: calc(50% + var(--pdf-image-placement-resizer-offset));
}

.pdf-image-placement__resizer--sw {
    left: var(--pdf-image-placement-resizer-offset);
    bottom: var(--pdf-image-placement-resizer-offset);
}

.pdf-image-placement__resizer--w {
    top: calc(50% + var(--pdf-image-placement-resizer-offset));
    left: var(--pdf-image-placement-resizer-offset);
}

.pdf-image-placement__rotate-handle {
    position: absolute;
    top: var(--app-pdf-image-placement-rotate-handle-top);
    left: calc(50% + var(--pdf-image-placement-rotate-handle-offset));
    width: var(--app-pdf-image-placement-rotate-handle-size);
    height: var(--app-pdf-image-placement-rotate-handle-size);
    border: 1px solid var(--ui-bg);
    border-radius: var(--app-radius-full);
    background: color-mix(in oklab, var(--ui-bg) 18%, var(--ui-primary) 82%);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--ui-bg-inverted) 22%, transparent);
    cursor: grab;
    pointer-events: auto;
}

.pdf-image-placement__rotate-handle::after {
    content: '';
    position: absolute;
    inset: var(--pdf-image-placement-resizer-offset);
}

.pdf-image-placement__rotate-handle::before {
    content: '';
    position: absolute;
    left: calc(50% - (var(--app-pdf-image-placement-rotate-stem-width) * 0.5));
    top: calc(100% - (var(--app-pdf-image-placement-rotate-stem-width) * 0.5));
    width: var(--app-pdf-image-placement-rotate-stem-width);
    height: var(--app-pdf-image-placement-rotate-stem-height);
    border-radius: var(--app-radius-full);
    background: color-mix(in oklab, var(--ui-primary) 76%, var(--ui-bg) 24%);
}

.pdf-image-placement__rotate-handle:active {
    cursor: grabbing;
}

.pdf-image-placement__rotate-handle:disabled {
    cursor: progress;
}

.pdf-image-placement__controls {
    position: absolute;
    left: 0;
    top: calc(100% + var(--app-pdf-image-placement-controls-offset));
    display: flex;
    gap: var(--app-space-2xl);
    align-items: center;
    padding: var(--app-space-md);
    border: 1px solid var(--app-pdf-context-menu-panel-action-border);
    border-radius: var(--app-radius-full);
    background: color-mix(in oklab, var(--ui-bg) 94%, var(--ui-bg-elevated) 6%);
    box-shadow: var(--app-pdf-context-menu-panel-shadow);
    white-space: nowrap;
}

.pdf-image-placement__action {
    border: 1px solid transparent;
    border-radius: var(--app-radius-full);
    min-height: 0;
    padding: var(--app-pdf-image-placement-action-padding);
    font-size: var(--app-text-size-fine);
    font-weight: var(--app-font-weight-semibold);
    line-height: 1.2;
    transition:
        background-color var(--app-transition-quick),
        border-color var(--app-transition-quick),
        color var(--app-transition-quick);
}

.pdf-image-placement__action--secondary {
    background: color-mix(in oklab, var(--ui-bg-muted) 62%, var(--ui-bg) 38%);
    border-color: var(--app-pdf-context-menu-panel-action-border);
    color: var(--ui-text);
}

.pdf-image-placement__action--primary {
    background: color-mix(in oklab, var(--ui-primary) 18%, var(--ui-bg) 82%);
    border-color: color-mix(in oklab, var(--ui-primary) 48%, var(--ui-border) 52%);
    color: var(--ui-text-highlighted);
}

.pdf-image-placement__action:disabled {
    opacity: var(--app-opacity-muted);
    cursor: progress;
}
</style>
