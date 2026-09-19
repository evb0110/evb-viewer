<template>
    <div
        ref="noteWindowRef"
        class="note-window"
        :class="{'is-pane-sized': isPaneSizedPresentation}"
        :style="windowStyle"
        :data-annotation-id="annotationId"
        :data-page-number="pageNumber"
        :data-user-placement="userPlacementSequence"
        @mousedown="focusNote"
        @focusin="focusNote"
    >
        <header
            class="note-window__title"
            @mousedown.prevent="startDrag"
        >
            <div class="note-window__title-main">
                <strong class="note-window__summary">{{ title }}</strong>
                <span class="note-window__meta">{{ authorText }}</span>
            </div>
            <div class="note-window__title-side">
                <div class="note-window__actions">
                    <button
                        type="button"
                        class="note-window__delete"
                        :aria-label="t('noteWindow.deleteNote')"
                        @click.stop="deleteNote"
                        @dblclick.stop.prevent
                    >
                        <UIcon name="i-ph-trash" class="size-3.5" />
                    </button>
                    <button
                        type="button"
                        class="note-window__close"
                        :aria-label="t('noteWindow.minimizeNote')"
                        @click="minimizeNote"
                    >
                        <UIcon name="i-ph-minus" class="size-3.5" />
                    </button>
                </div>
                <span class="note-window__date">{{ timestampText }}</span>
            </div>
        </header>

        <textarea
            ref="noteInputRef"
            class="note-window__textarea app-scrollbar app-scroll-region--balanced"
            :value="text"
            :maxlength="PDF_NATIVE_MUTATION_LIMITS.noteTextLength"
            rows="8"
            :placeholder="t('noteWindow.writeNote')"
            @keydown.esc.stop.prevent="minimizeNote"
            @input="updateText"
            @change="updateText"
            @blur="updateText"
        ></textarea>

        <p v-if="saving" class="note-window__status" role="status" aria-live="polite">{{ t('noteWindow.saving') }}</p>
        <p v-if="error" class="note-window__error" role="alert" aria-live="assertive">{{ error }}</p>
    </div>
</template>

<script setup lang="ts">
import type { TPageNumber } from '@contracts/pageNumbers';


import {
    useEventListener,
    useResizeObserver,
} from '@vueuse/core';
import type { IAnnotationNotePosition } from '@app/types/annotationNoteWindow';
import { NOTE_WINDOW } from '@app/constants/pdfLayout';
import type { IAnnotationNoteWindowBounds } from '@app/modules/pdf-viewer/engine/annotation-note-window-bounds/annotationNoteWindowBounds';
import { clampAnnotationNoteWindowPosition } from '@app/modules/pdf-viewer/engine/annotation-note-window-bounds/clampAnnotationNoteWindowPosition';
import { clampAnnotationNoteWindowSize } from '@app/modules/pdf-viewer/engine/annotation-note-window-bounds/clampAnnotationNoteWindowSize';
import {
    captureAnnotationNoteWindowPageAnchor,
    resolveAnnotationNoteWindowClipPath,
    resolveAnnotationNoteWindowPagePosition,
    type IAnnotationNoteWindowPageAnchor,
} from '@app/modules/pdf-viewer/engine/annotation-note-window-bounds/annotationNoteWindowPageAnchor';
import { createRafCoalescedCallback } from '@app/utils/createRafCoalescedCallback';
import { PDF_NATIVE_MUTATION_LIMITS } from '@contracts/nativePdfMutations';

interface IProps {
    annotationId: string;
    pageNumber: TPageNumber;
    author: string | null;
    color?: string | null;
    createdAt: number | null;
    modifiedAt: number | null;
    text: string;
    saving?: boolean;
    error?: string | null;
    position?: IAnnotationNotePosition | null;
    zIndex?: number;
    boundsRoot?: HTMLElement | null;
}

const {
    annotationId,
    pageNumber,
    author,
    color = null,
    createdAt,
    modifiedAt,
    text,
    saving = false,
    error = null,
    position = null,
    zIndex = NOTE_WINDOW.DEFAULT_Z_INDEX,
    boundsRoot = null,
} = defineProps<IProps>();

const emit = defineEmits<{
    'update:text': [value: string];
    'update:position': [value: IAnnotationNotePosition];
    minimize: [focusDocument: Document | null];
    delete: [];
    focus: [];
}>();

const { t } = useTypedI18n();

const NOTE_WINDOW_INITIAL_OFFSET_X = 14;
const NOTE_WINDOW_INITIAL_OFFSET_Y = 72;

const noteInputRef = ref<HTMLTextAreaElement | null>(null);
const noteWindowRef = ref<HTMLElement | null>(null);
const offsetX = ref(NOTE_WINDOW_INITIAL_OFFSET_X);
const offsetY = ref(NOTE_WINDOW_INITIAL_OFFSET_Y);
const width = ref(NOTE_WINDOW.DEFAULT_WIDTH);
const height = ref(NOTE_WINDOW.DEFAULT_HEIGHT);
const dragStartX = ref(0);
const dragStartY = ref(0);
const frameStartX = ref(0);
const frameStartY = ref(0);
const isDragging = ref(false);
// Published on the element because a drag deliberately suspends page
// following, so a window the reader is moving breaks the anchor delta on
// purpose. An observer that compares two moments needs to tell that apart from
// a window that failed to follow its page; the counter changes for as long as
// the reader is placing the window.
const userPlacementSequence = ref(0);
let initialFocusRepairFrame: number | null = null;
const dragWindowTarget = shallowRef<Window | undefined>();
const pageElement = shallowRef<HTMLElement | null>(null);
const clipPath = ref<string | undefined>();
let pageAnchor: IAnnotationNoteWindowPageAnchor | null = null;
let isScrolledOut = false;

function focusNote() {
    emit('focus');
}

function deleteNote() {
    emit('delete');
}

function minimizeNote() {
    const root = noteWindowRef.value;
    const focusDocument = root?.contains(root.ownerDocument.activeElement) ? root.ownerDocument : null;
    emit('minimize', focusDocument);
}

function updateText(event: Event) {
    emit('update:text', (event.target as HTMLTextAreaElement).value);
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

const title = computed(() => t('noteWindow.popUpNote', { page: pageNumber }));
const authorText = computed(() => {
    const commentAuthor = author?.trim();
    if (commentAuthor) {
        return commentAuthor;
    }
    return t('noteWindow.unknownAuthor');
});
const timestampText = computed(() => {
    const timestamp = modifiedAt ?? createdAt;
    if (!timestamp) {
        return t('noteWindow.noDate');
    }
    return timeFormatter.format(new Date(timestamp));
});

const windowStyle = computed(() => ({
    '--annotation-note-color': color ?? 'var(--ui-warning)',
    left: `${offsetX.value}px`,
    top: `${offsetY.value}px`,
    width: `${width.value}px`,
    height: `${height.value}px`,
    minWidth: `${Math.min(NOTE_WINDOW.MIN_WIDTH, width.value)}px`,
    minHeight: `${Math.min(NOTE_WINDOW.MIN_HEIGHT, height.value)}px`,
    zIndex: String(zIndex),
    clipPath: clipPath.value,
}));
const isPaneSizedPresentation = computed(() => (
    width.value < NOTE_WINDOW.MIN_WIDTH
    || height.value < NOTE_WINDOW.MIN_HEIGHT
));
const boundsRootElement = computed(() => boundsRoot ?? null);
const documentElement = computed(() => (
    typeof document !== 'undefined'
        ? document.documentElement
        : null
));

async function focusTextInput() {
    await nextTick();
    await nextTick();
    const input = noteInputRef.value;
    if (!input) {
        return;
    }
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
}

function clearInitialFocusRepair() {
    if (initialFocusRepairFrame !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(initialFocusRepairFrame);
    }
    initialFocusRepairFrame = null;
}

function scheduleInitialFocusRepair() {
    if (typeof window === 'undefined') {
        return;
    }
    clearInitialFocusRepair();
    initialFocusRepairFrame = window.requestAnimationFrame(() => {
        initialFocusRepairFrame = null;
        const activeElement = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        // A single post-mount repair covers focus dropped to the document
        // body during PDF.js DOM churn. Any explicit Tab/click target wins.
        if (!activeElement || activeElement === document.body) {
            void focusTextInput();
        }
    });
}

function syncPosition(position: IAnnotationNotePosition | null) {
    const previous = {
        x: offsetX.value,
        y: offsetY.value,
        width: width.value,
        height: height.value,
    };
    const nextSize = clampSize(
        position?.width ?? width.value,
        position?.height ?? height.value,
    );
    width.value = nextSize.width;
    height.value = nextSize.height;

    placeClamped(
        position?.x ?? offsetX.value,
        position?.y ?? offsetY.value,
        nextSize.width,
        nextSize.height,
    );
    return (
        previous.x !== offsetX.value
        || previous.y !== offsetY.value
        || previous.width !== width.value
        || previous.height !== height.value
    );
}

function emitPositionUpdate() {
    emit('update:position', {
        x: offsetX.value,
        y: offsetY.value,
        width: width.value,
        height: height.value,
    });
}

function getCurrentPosition(): IAnnotationNotePosition {
    return {
        x: offsetX.value,
        y: offsetY.value,
        width: width.value,
        height: height.value,
    };
}

function positionChanged(previous: IAnnotationNotePosition) {
    return previous.x !== offsetX.value
        || previous.y !== offsetY.value
        || previous.width !== width.value
        || previous.height !== height.value;
}

function clampSize(nextWidth: number, nextHeight: number) {
    return clampAnnotationNoteWindowSize(nextWidth, nextHeight, getWindowBounds());
}

function getWindowBounds(): IAnnotationNoteWindowBounds | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const rootRect = boundsRoot?.getBoundingClientRect();
    if (rootRect && rootRect.width > 0 && rootRect.height > 0) {
        return {
            left: rootRect.left,
            top: rootRect.top,
            right: rootRect.right,
            bottom: rootRect.bottom,
            width: rootRect.width,
            height: rootRect.height,
        };
    }

    return {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        width: window.innerWidth,
        height: window.innerHeight,
    };
}

function clampPosition(x: number, y: number, nextWidth: number, nextHeight: number) {
    return clampAnnotationNoteWindowPosition(x, y, nextWidth, nextHeight, getWindowBounds());
}

function resolvePageRect() {
    const current = pageElement.value;
    if (!current?.isConnected || current.dataset.page !== String(pageNumber)) {
        pageElement.value = boundsRoot?.querySelector<HTMLElement>(
            `.page_container[data-page="${String(pageNumber)}"]`,
        ) ?? null;
    }
    const rect = pageElement.value?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

function refreshClipPath() {
    const rootRect = boundsRoot?.getBoundingClientRect();
    clipPath.value = rootRect && rootRect.width > 0 && rootRect.height > 0
        ? resolveAnnotationNoteWindowClipPath(offsetX.value, offsetY.value, width.value, height.value, rootRect)
        : undefined;
}

// Every user-driven placement lands inside the viewer and becomes the spot the
// window keeps on its page.
function placeClamped(x: number, y: number, nextWidth: number, nextHeight: number) {
    const clamped = clampPosition(x, y, nextWidth, nextHeight);
    offsetX.value = clamped.x;
    offsetY.value = clamped.y;
    isScrolledOut = false;
    const pageRect = resolvePageRect();
    pageAnchor = pageRect ? captureAnnotationNoteWindowPageAnchor(clamped.x, clamped.y, pageRect) : null;
    refreshClipPath();
}

// Scroll and zoom move the page, and the window goes with it, unclamped. The
// stored position stays where the user left it, so restoring a note reopens it in view.
function followPage() {
    if (isDragging.value) {
        return;
    }
    const pageRect = pageAnchor ? resolvePageRect() : null;
    if (!pageAnchor || !pageRect) {
        return;
    }
    const next = resolveAnnotationNoteWindowPagePosition(pageAnchor, pageRect);
    const clamped = clampPosition(next.x, next.y, width.value, height.value);
    isScrolledOut = clamped.x !== next.x || clamped.y !== next.y;
    offsetX.value = next.x;
    offsetY.value = next.y;
    refreshClipPath();
}

function handlePointerMove(event: MouseEvent) {
    if (!isDragging.value) {
        return;
    }

    const nextX = frameStartX.value + (event.clientX - dragStartX.value);
    const nextY = frameStartY.value + (event.clientY - dragStartY.value);
    userPlacementSequence.value += 1;
    placeClamped(nextX, nextY, width.value, height.value);
    emitPositionUpdate();
}

const noteDragMove = createRafCoalescedCallback(handlePointerMove);

function stopDrag(event?: MouseEvent) {
    if (!isDragging.value) {
        return;
    }

    if (event) {
        noteDragMove.flush(event);
    } else {
        noteDragMove.flushPending();
    }
    isDragging.value = false;
    dragWindowTarget.value = undefined;
    emitPositionUpdate();
}

function startDrag(event: MouseEvent) {
    emit('focus');
    userPlacementSequence.value += 1;
    isDragging.value = true;
    dragStartX.value = event.clientX;
    dragStartY.value = event.clientY;
    frameStartX.value = offsetX.value;
    frameStartY.value = offsetY.value;

    isDragging.value = true;
    if (typeof window === 'undefined') {
        return;
    }
    dragWindowTarget.value = window;
}

function handleViewportResize() {
    const previous = getCurrentPosition();
    const clampedSize = clampSize(width.value, height.value);
    width.value = clampedSize.width;
    height.value = clampedSize.height;
    if (isScrolledOut) {
        followPage();
        return;
    }
    placeClamped(offsetX.value, offsetY.value, clampedSize.width, clampedSize.height);
    if (positionChanged(previous)) {
        emitPositionUpdate();
    }
}

function measureObservedWindowSize(entry: ResizeObserverEntry) {
    const target = entry.target instanceof HTMLElement
        ? entry.target
        : null;
    if (!target) {
        return {
            width: entry.contentRect.width,
            height: entry.contentRect.height,
        };
    }
    // Use border-box dimensions so we don't progressively shrink by border/padding
    // when syncing browser resize handles back into reactive state.
    return {
        width: target.offsetWidth,
        height: target.offsetHeight,
    };
}

useEventListener(
    typeof window !== 'undefined' ? window : undefined,
    'resize',
    handleViewportResize,
);
useEventListener(dragWindowTarget, 'mousemove', noteDragMove.schedule);
useEventListener(dragWindowTarget, 'mouseup', stopDrag);
useEventListener(boundsRootElement, 'scroll', followPage, { passive: true });
useResizeObserver(pageElement, followPage);

useResizeObserver(noteWindowRef, (entries) => {
    const entry = entries[0];
    if (!entry || isDragging.value) {
        return;
    }
    const measuredSize = measureObservedWindowSize(entry);
    const nextSize = clampSize(measuredSize.width, measuredSize.height);
    if (nextSize.width === width.value && nextSize.height === height.value) {
        return;
    }
    const previous = getCurrentPosition();
    width.value = nextSize.width;
    height.value = nextSize.height;
    if (isScrolledOut) {
        refreshClipPath();
        return;
    }
    placeClamped(offsetX.value, offsetY.value, nextSize.width, nextSize.height);
    if (positionChanged(previous)) {
        emitPositionUpdate();
    }
}, { box: 'border-box' });

useResizeObserver(boundsRootElement, () => {
    handleViewportResize();
});

useResizeObserver(documentElement, () => {
    handleViewportResize();
});

onMounted(() => {
    if (syncPosition(position)) {
        emitPositionUpdate();
    }
    void focusTextInput();
    scheduleInitialFocusRepair();
});

onBeforeUnmount(() => {
    clearInitialFocusRepair();
    stopDrag();
});

watch(
    () => position,
    (nextPosition) => {
        if (isDragging.value) {
            return;
        }
        if (syncPosition(nextPosition)) {
            emitPositionUpdate();
        }
    },
);

watch(
    () => annotationId,
    () => {
        if (syncPosition(position)) {
            emitPositionUpdate();
        }
        void focusTextInput();
        scheduleInitialFocusRepair();
    },
);

watch(
    () => boundsRoot,
    () => {
        handleViewportResize();
    },
);
</script>

<style scoped>
.note-window {
    --note-bg: var(--app-pdf-note-bg);
    --note-border: color-mix(in srgb, var(--annotation-note-color) 62%, var(--ui-border));
    --note-title-bg: color-mix(in srgb, var(--annotation-note-color) 18%, var(--ui-bg));
    --note-title-border: color-mix(in srgb, var(--annotation-note-color) 42%, var(--ui-border));
    --note-text: var(--app-pdf-note-text);
    --note-text-heading: var(--app-pdf-note-text-heading);
    --note-text-secondary: var(--app-pdf-note-text-secondary);
    --note-text-dim: var(--app-pdf-note-text-dim);
    --note-text-status: var(--app-pdf-note-text-status);
    --note-btn-border: var(--app-pdf-note-button-border);
    --note-btn-bg: var(--app-pdf-note-button-bg);
    --note-btn-color: var(--app-pdf-note-button-fg);
    --note-delete-border: var(--app-pdf-note-delete-border);
    --note-delete-bg: var(--app-pdf-note-delete-bg);
    --note-delete-color: var(--app-pdf-note-delete-fg);
    --note-shadow: var(--app-pdf-note-shadow);

    position: fixed;
    z-index: auto;
    min-width: 0;
    min-height: 0;
    border: 1px solid var(--note-border);
    background: var(--note-bg);
    box-shadow: var(--note-shadow);
    display: grid;
    grid-template-rows: auto 1fr auto auto;
    resize: both;
    overflow: hidden;
}

.note-window.is-pane-sized {
    resize: none;
    border-radius: var(--app-radius-lg);
}

.note-window.is-pane-sized .note-window__title {
    flex-wrap: wrap;
}

.note-window__title {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--app-pdf-note-title-gap);
    border-bottom: 1px solid var(--note-title-border);
    padding: var(--app-pdf-note-title-padding);
    cursor: move;
    user-select: none;
    background: var(--note-title-bg);
}

.note-window__title-main {
    min-width: 0;
    display: grid;
    gap: var(--app-pdf-note-title-main-gap);
}

.note-window__summary {
    font-size: var(--app-pdf-note-summary-font-size);
    color: var(--note-text-heading);
    line-height: 1.25;
}

.note-window__meta {
    font-size: var(--app-pdf-note-meta-font-size);
    color: var(--note-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.note-window__title-side {
    display: grid;
    justify-items: end;
    gap: var(--app-pdf-note-title-side-gap);
}

.note-window__actions {
    display: inline-flex;
    align-items: center;
    gap: var(--app-pdf-note-actions-gap);
}

.note-window__date {
    font-size: var(--app-pdf-note-date-font-size);
    color: var(--note-text-dim);
    white-space: nowrap;
}

.note-window__close {
    border: 1px solid var(--note-btn-border);
    background: var(--note-btn-bg);
    color: var(--note-btn-color);
    width: var(--app-pdf-note-action-size);
    height: var(--app-pdf-note-action-size);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.note-window__delete {
    border: 1px solid var(--note-delete-border);
    background: var(--note-delete-bg);
    color: var(--note-delete-color);
    width: var(--app-pdf-note-action-size);
    height: var(--app-pdf-note-action-size);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.note-window__textarea {
    width: 100%;
    min-height: 100%;
    border: none;
    background: transparent;
    color: var(--note-text);
    line-height: 1.45;
    font-size: var(--app-pdf-note-textarea-font-size);
    resize: none;
    outline: none;
    padding: var(--app-pdf-note-textarea-padding);
}

.note-window__status {
    margin: 0;
    font-size: var(--app-pdf-note-status-font-size);
    color: var(--note-text-status);
    padding: var(--app-pdf-note-status-padding);
}

.note-window__error {
    margin: 0;
    font-size: var(--app-pdf-note-error-font-size);
    color: var(--note-delete-color);
    padding: var(--app-pdf-note-error-padding);
}
</style>
