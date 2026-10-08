<template>
    <div
        v-if="leafNode"
        :ref="bindLeafPaneSlot"
        class="editor-pane-slot"
        :data-editor-pane-slot="leafNode.paneId"
    />

    <div
        v-else-if="splitNode"
        ref="splitContainerRef"
        class="editor-split"
        :class="[
            splitNode.orientation === 'horizontal' ? 'is-horizontal' : 'is-vertical',
            {'is-ultra-compact': splitRatioBounds.ultraCompact},
        ]"
    >
        <div
            v-if="!zenMode || nodeContainsPane(splitNode.first, zenActivePaneId)"
            :id="`editor-split-primary-${splitNode.id}`"
            class="editor-split-pane editor-split-pane-first"
            :style="firstPaneStyle"
        >
            <EditorPanesGrid
                :node="splitNode.first"
                :zen-mode="zenMode"
                :zen-active-pane-id="zenActivePaneId"
                @set-pane-slot="forwardPaneSlot"
                @update-split-ratio="(splitId, ratio) => emit('update-split-ratio', splitId, ratio)"
                @update-layout-resizing="emit('update-layout-resizing', $event)"
            />
        </div>

        <div
            v-if="!zenMode"
            class="editor-sash"
            :class="splitNode.orientation === 'horizontal' ? 'is-vertical-line' : 'is-horizontal-line'"
            role="separator"
            tabindex="0"
            :aria-label="t('menu.resizeEditorPanes')"
            :aria-controls="`editor-split-primary-${splitNode.id}`"
            :aria-valuemin="splitRatioBounds.minRatio * 100"
            :aria-valuemax="splitRatioBounds.maxRatio * 100"
            :aria-valuenow="splitRatio * 100"
            :aria-orientation="splitNode.orientation === 'horizontal' ? 'vertical' : 'horizontal'"
            @pointerdown.prevent="handleSplitResizePointerDown"
            @keydown="handleSplitResizeKeyDown"
            @keyup="clearResizeListeners"
            @blur="clearResizeListeners"
        />

        <div
            v-if="!zenMode || nodeContainsPane(splitNode.second, zenActivePaneId)"
            class="editor-split-pane editor-split-pane-second"
        >
            <EditorPanesGrid
                :node="splitNode.second"
                :zen-mode="zenMode"
                :zen-active-pane-id="zenActivePaneId"
                @set-pane-slot="forwardPaneSlot"
                @update-split-ratio="(splitId, ratio) => emit('update-split-ratio', splitId, ratio)"
                @update-layout-resizing="emit('update-layout-resizing', $event)"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import {
    useEventListener,
    useResizeObserver,
} from '@vueuse/core';
import { clamp } from 'es-toolkit/math';
import type {
    IEditorLayoutSplitNode,
    TEditorLayoutNode,
    TPaneOrientation,
} from '@contracts/editorPanes';
import { createRafCoalescedCallback } from '@app/utils/createRafCoalescedCallback';
import { resolveEditorPaneSplitBounds } from '@app/modules/workspace-shell/layout/resolveEditorPaneSplitBounds';

defineOptions({name: 'EditorPanesGrid'});

const {
    node,
    zenActivePaneId,
    zenMode,
} = defineProps<{
    node: TEditorLayoutNode;
    zenMode: boolean;
    zenActivePaneId: string | null;
}>();

const emit = defineEmits<{
    'set-pane-slot': [paneId: string, element: HTMLElement | null];
    'update-split-ratio': [splitId: string, ratio: number];
    'update-layout-resizing': [value: boolean];
}>();

const {t} = useTypedI18n();

const splitContainerRef = ref<HTMLElement | null>(null);
const splitAxisSize = ref(0);
const leafNode = computed(() => (node.type === 'leaf' ? node : null));
const splitNode = computed<IEditorLayoutSplitNode | null>(() => (node.type === 'split' ? node : null));
const splitRatioBounds = computed(() => resolveEditorPaneSplitBounds(splitAxisSize.value));

useResizeObserver(splitContainerRef, ([entry]) => {
    const split = splitNode.value;
    if (!entry || !split) {
        splitAxisSize.value = 0;
        return;
    }
    splitAxisSize.value = split.orientation === 'horizontal'
        ? entry.contentRect.width
        : entry.contentRect.height;
});

const splitRatio = computed(() => clamp(
    splitNode.value?.ratio ?? 0.5,
    splitRatioBounds.value.minRatio,
    splitRatioBounds.value.maxRatio,
));

const firstPaneStyle = computed(() => {
    if (!splitNode.value) {
        return undefined;
    }
    if (zenMode) {
        return {flexBasis: '100%'};
    }
    return {flexBasis: `${String(splitRatio.value * 100)}%`};
});

function nodeContainsPane(candidate: TEditorLayoutNode, paneId: string | null): boolean {
    if (!paneId) {
        return false;
    }
    if (candidate.type === 'leaf') {
        return candidate.paneId === paneId;
    }
    return nodeContainsPane(candidate.first, paneId) || nodeContainsPane(candidate.second, paneId);
}

let boundLeafPaneId: string | null = null;
function bindLeafPaneSlot(element: Element | ComponentPublicInstance | null) {
    if (element instanceof HTMLElement && leafNode.value) {
        boundLeafPaneId = leafNode.value.paneId;
        emit('set-pane-slot', boundLeafPaneId, element);
        return;
    }
    if (boundLeafPaneId) {
        emit('set-pane-slot', boundLeafPaneId, null);
        boundLeafPaneId = null;
    }
}

function forwardPaneSlot(paneId: string, element: HTMLElement | null) {
    emit('set-pane-slot', paneId, element);
}

let moveListener: ((event: PointerEvent) => void) | null = null;
let upListener: ((event: PointerEvent) => void) | null = null;
let isSplitResizing = false;
const resizeWindowTarget = shallowRef<Window | undefined>();
const coalescedResizeMove = createRafCoalescedCallback((event: PointerEvent) => {
    moveListener?.(event);
});

function clearResizeListeners() {
    coalescedResizeMove.cancel();
    resizeWindowTarget.value = undefined;
    moveListener = null;
    upListener = null;
    if (isSplitResizing) {
        isSplitResizing = false;
        emit('update-layout-resizing', false);
    }
}

function startResize(event: PointerEvent, splitId: string, orientation: TPaneOrientation) {
    const container = splitContainerRef.value;
    if (!container) {
        return;
    }
    const startRect = container.getBoundingClientRect();
    const axisSize = orientation === 'horizontal' ? startRect.width : startRect.height;
    const ratioBounds = resolveEditorPaneSplitBounds(axisSize);
    isSplitResizing = true;
    emit('update-layout-resizing', true);
    moveListener = (nextEvent: PointerEvent) => {
        const raw = orientation === 'horizontal'
            ? (nextEvent.clientX - startRect.left) / startRect.width
            : (nextEvent.clientY - startRect.top) / startRect.height;
        emit('update-split-ratio', splitId, clamp(raw, ratioBounds.minRatio, ratioBounds.maxRatio));
    };
    upListener = clearResizeListeners;
    resizeWindowTarget.value = window;
    const sash = event.currentTarget;
    if (sash instanceof HTMLElement) {
        sash.focus();
        sash.setPointerCapture(event.pointerId);
    }
}

function handleSplitResizePointerDown(event: PointerEvent) {
    const split = splitNode.value;
    if (split) {
        startResize(event, split.id, split.orientation);
    }
}

function handleSplitResizeKeyDown(event: KeyboardEvent) {
    const split = splitNode.value;
    if (!split || event.altKey || event.ctrlKey || event.metaKey) {
        return;
    }
    const decreaseKey = split.orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const increaseKey = split.orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    let ratio: number;
    switch (event.key) {
        case decreaseKey:
            ratio = splitRatio.value - 0.02;
            break;
        case increaseKey:
            ratio = splitRatio.value + 0.02;
            break;
        case 'Home':
            ratio = splitRatioBounds.value.minRatio;
            break;
        case 'End':
            ratio = splitRatioBounds.value.maxRatio;
            break;
        default:
            return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!isSplitResizing) {
        isSplitResizing = true;
        emit('update-layout-resizing', true);
    }
    emit('update-split-ratio', split.id, clamp(
        ratio,
        splitRatioBounds.value.minRatio,
        splitRatioBounds.value.maxRatio,
    ));
}

useEventListener(resizeWindowTarget, 'pointermove', (event: PointerEvent) => {
    coalescedResizeMove.schedule(event);
});
useEventListener(resizeWindowTarget, 'pointerup', (event: PointerEvent) => {
    coalescedResizeMove.flush(event);
    upListener?.(event);
});
useEventListener(resizeWindowTarget, 'pointercancel', (event: PointerEvent) => {
    coalescedResizeMove.flush(event);
    upListener?.(event);
});

onUnmounted(clearResizeListeners);
</script>

<style scoped>
.editor-pane-slot {
    display: flex;
    flex: 1;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
}

.editor-split {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--app-editor-pane-grid-bg);
    box-sizing: border-box;
}

.editor-split.is-horizontal {
    flex-direction: row;
}

.editor-split.is-vertical {
    flex-direction: column;
}

.editor-split-pane {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    box-sizing: border-box;
}

.editor-split-pane > * {
    flex: 1;
    min-width: 0;
    min-height: 0;
}

.editor-split-pane-first {
    flex-grow: 0;
    flex-shrink: 0;
}

.editor-sash {
    flex-shrink: 0;
    background: var(--app-editor-sash-bg);
    transition: background-color 0.12s ease;
}

.editor-sash:hover,
.editor-sash:focus-visible {
    background: var(--app-editor-sash-bg-hover);
}

.editor-sash:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 var(--app-space-3xs) var(--ui-primary);
}

.editor-sash.is-vertical-line {
    width: var(--app-editor-sash-size);
    cursor: col-resize;
}

.editor-sash.is-horizontal-line {
    height: var(--app-editor-sash-size);
    cursor: row-resize;
}
</style>
