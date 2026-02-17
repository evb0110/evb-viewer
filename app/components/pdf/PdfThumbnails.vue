<template>
  <div
    ref="containerRef"
    class="pdf-thumbnails app-scrollbar"
    :class="{
      'is-reorder-dragging': isDragging,
      'is-external-drag': isExternalDragOver,
    }"
    @scroll.passive="handleContainerScroll"
    @dragenter="handleExternalDragEnter"
    @dragover="handleExternalDragOver"
    @dragleave="handleExternalDragLeave"
    @drop="handleExternalDrop"
  >
    <div class="pdf-thumbnails-virtual-wrapper" :style="virtualWrapperStyle">
      <div
        v-for="page in virtualPages"
        :key="page"
        class="pdf-thumbnail pdf-thumbnail--virtual"
        :class="{
          'is-active': page === currentPage,
          'is-selected': isSelected(page),
          'is-dragged': isDragging && draggedPages.includes(page),
          'is-drop-before': dropInsertIndex === page - 1,
          'is-drop-after': page === totalPages && dropInsertIndex === totalPages,
        }"
        :data-page="page"
        :style="getThumbnailStyle(page)"
        @mousedown="handleDragMouseDown($event, page)"
        @click="handleThumbnailClick($event, page)"
        @contextmenu.prevent="handleThumbnailContextMenu($event, page)"
      >
        <canvas class="pdf-thumbnail-canvas" />
        <span class="pdf-thumbnail-number">{{ getPageIndicator(page) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    ref,
    toRef,
    watch,
} from 'vue';
import {
    useDebounceFn,
    useResizeObserver,
} from '@vueuse/core';
import type {
    PDFDocumentProxy,
    RenderTask,
} from 'pdfjs-dist';
import { isPdfDocumentUsable } from '@app/utils/pdf-document-guard';
import { BrowserLogger } from '@app/utils/browser-logger';
import { formatPageIndicator } from '@app/utils/pdf-page-labels';
import { THUMBNAIL_WIDTH } from '@app/constants/pdf-layout';
import { useMultiSelection } from '@app/composables/useMultiSelection';
import { usePageDragDrop } from '@app/composables/pdf/usePageDragDrop';
import { runGuardedTask } from '@app/utils/async-guard';

interface IProps {
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    totalPages: number;
    pageLabels?: string[] | null;
    selectedPages?: number[];
    invalidationRequest?: {
        id: number;
        pages: number[];
    } | null;
}

const THUMBNAIL_GAP = 8;
const DEFAULT_THUMBNAIL_ITEM_HEIGHT = 220;
const VIRTUAL_OVERSCAN = 8;
const THUMBNAIL_RENDER_CONCURRENCY = 3;
const IMMEDIATE_RENDER_RADIUS = 2;
const PREFETCH_RENDER_RADIUS = 8;

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'go-to-page', page: number): void;
    (e: 'update:selected-pages', pages: number[]): void;
    (
        e: 'page-context-menu',
        payload: {
            clientX: number;
            clientY: number;
            pages: number[];
        },
    ): void;
    (e: 'reorder', newOrder: number[]): void;
    (
        e: 'file-drop',
        payload: {
            afterPage: number;
            filePaths: string[];
        },
    ): void;
}>();

const containerRef = ref<HTMLElement | null>(null);
const renderedPages = new Set<number>();
const renderingPages = new Set<number>();
const renderTasks = new Map<number, RenderTask>();
let renderRunId = 0;
let pendingInvalidation: number[] | null = null;
let reloadTransition = false;

const scrollTop = ref(0);
const viewportHeight = ref(0);
const thumbnailItemHeight = ref(DEFAULT_THUMBNAIL_ITEM_HEIGHT);

const multiSelection = useMultiSelection<number>();
const selectedPagesSet = computed(() => new Set(props.selectedPages ?? []));

const itemPitch = computed(() =>
    Math.max(1, thumbnailItemHeight.value + THUMBNAIL_GAP),
);

const visibleStartIndex = computed(() => {
    if (props.totalPages <= 0) {
        return 0;
    }
    return Math.max(
        0,
        Math.floor(scrollTop.value / itemPitch.value) - VIRTUAL_OVERSCAN,
    );
});

const visibleEndIndex = computed(() => {
    if (props.totalPages <= 0) {
        return -1;
    }
    const viewportBottom = scrollTop.value + Math.max(viewportHeight.value, itemPitch.value);
    return Math.min(
        props.totalPages - 1,
        Math.ceil(viewportBottom / itemPitch.value) + VIRTUAL_OVERSCAN,
    );
});

const virtualPages = computed(() => {
    if (props.totalPages <= 0 || visibleEndIndex.value < visibleStartIndex.value) {
        return [] as number[];
    }

    const pages: number[] = [];
    for (let index = visibleStartIndex.value; index <= visibleEndIndex.value; index += 1) {
        pages.push(index + 1);
    }
    return pages;
});

const virtualWrapperStyle = computed(() => {
    if (props.totalPages <= 0) {
        return {height: '0px'};
    }
    const totalHeight = props.totalPages * itemPitch.value - THUMBNAIL_GAP;
    return {height: `${Math.max(0, totalHeight)}px`};
});

function getThumbnailStyle(page: number) {
    return {transform: `translateY(${(page - 1) * itemPitch.value}px)`};
}

const {
    isDragging,
    isExternalDragOver,
    draggedPages,
    dropInsertIndex,
    handleMouseDown: handleDragMouseDown,
    consumeClickSkip,
    handleDragEnter: handleExternalDragEnter,
    handleDragOver: handleExternalDragOver,
    handleDragLeave: handleExternalDragLeave,
    handleDrop: handleExternalDrop,
} = usePageDragDrop({
    containerRef,
    totalPages: toRef(props, 'totalPages'),
    selectedPages: computed(() => props.selectedPages ?? []),
    resolveDropIndex: (clientY, container) => {
        const rect = container.getBoundingClientRect();
        const offsetY = clientY - rect.top + container.scrollTop;
        const index = Math.floor(offsetY / itemPitch.value);
        return Math.max(0, Math.min(props.totalPages, index));
    },
    onReorder: (newOrder) => emit('reorder', newOrder),
    onExternalFileDrop: (afterPage, filePaths) =>
        emit('file-drop', {
            afterPage,
            filePaths,
        }),
});

function normalizeSelectedPages(pages: number[]) {
    const unique = new Set<number>();
    for (const page of pages) {
        if (Number.isInteger(page) && page >= 1 && page <= props.totalPages) {
            unique.add(page);
        }
    }
    return Array.from(unique).sort((left, right) => left - right);
}

function arePageListsEqual(left: number[], right: number[]) {
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}

function isSelected(page: number) {
    return selectedPagesSet.value.has(page);
}

function handleThumbnailClick(event: MouseEvent, page: number) {
    if (consumeClickSkip()) {
        return;
    }

    const allPages = Array.from({ length: props.totalPages }, (_, i) => i + 1);
    multiSelection.toggle(page, allPages, {
        shift: event.shiftKey,
        meta: event.metaKey || event.ctrlKey,
    });
    const normalized = normalizeSelectedPages(
        Array.from(multiSelection.selected.value),
    );
    emit('update:selected-pages', normalized);
    emit('go-to-page', page);
}

function handleThumbnailContextMenu(event: MouseEvent, page: number) {
    if (!isSelected(page)) {
        multiSelection.selected.value = new Set([page]);
        multiSelection.anchor.value = page;
        emit('update:selected-pages', [page]);
    }
    const pages = normalizeSelectedPages(
        Array.from(multiSelection.selected.value),
    );
    emit('page-context-menu', {
        clientX: event.clientX,
        clientY: event.clientY,
        pages,
    });
}

function getCanvas(pageNum: number): HTMLCanvasElement | null {
    if (!containerRef.value) {
        return null;
    }
    const thumbnail = containerRef.value.querySelector<HTMLElement>(
        `.pdf-thumbnail[data-page="${pageNum}"]`,
    );
    return thumbnail?.querySelector('canvas') ?? null;
}

function getPageIndicator(page: number) {
    return formatPageIndicator(page, props.pageLabels ?? null);
}

function updateViewportMetrics() {
    const container = containerRef.value;
    if (!container) {
        return;
    }
    scrollTop.value = container.scrollTop;
    viewportHeight.value = container.clientHeight;
}

const measureThumbnailHeight = useDebounceFn(() => {
    const container = containerRef.value;
    if (!container) {
        return;
    }

    const item = container.querySelector<HTMLElement>('.pdf-thumbnail');
    if (!item) {
        return;
    }

    const measuredHeight = Math.max(1, Math.ceil(item.getBoundingClientRect().height));
    if (Math.abs(measuredHeight - thumbnailItemHeight.value) < 1) {
        return;
    }

    thumbnailItemHeight.value = measuredHeight;
}, 16);

function handleContainerScroll() {
    updateViewportMetrics();
    scheduleVisibleThumbnailRender();
}

watch(
    () => props.selectedPages,
    (pages) => {
        const normalized = normalizeSelectedPages(pages ?? []);
        if (!arePageListsEqual(normalized, pages ?? [])) {
            emit('update:selected-pages', normalized);
            return;
        }

        multiSelection.selected.value = new Set(normalized);

        if (normalized.length === 0) {
            multiSelection.anchor.value = null;
            return;
        }

        if (
            multiSelection.anchor.value === null ||
            !normalized.includes(multiSelection.anchor.value)
        ) {
            multiSelection.anchor.value = normalized[normalized.length - 1] ?? null;
        }
    },
    {
        immediate: true,
        deep: true,
    },
);

function cancelAllRenders() {
    for (const task of renderTasks.values()) {
        try {
            task.cancel();
        } catch {
            // Ignore cancellation errors
        }
    }
    renderTasks.clear();
    renderingPages.clear();
}

async function renderThumbnail(
    pdfDocument: PDFDocumentProxy,
    pageNum: number,
    runId: number,
) {
    if (runId !== renderRunId) {
        return;
    }

    if (!isPdfDocumentUsable(pdfDocument)) {
        return;
    }

    if (renderedPages.has(pageNum) || renderingPages.has(pageNum)) {
        return;
    }

    const canvas = getCanvas(pageNum);
    if (!canvas) {
        return;
    }

    renderingPages.add(pageNum);

    try {
        const page = await pdfDocument.getPage(pageNum);
        if (runId !== renderRunId || !isPdfDocumentUsable(pdfDocument)) {
            return;
        }
        const viewport = page.getViewport({ scale: 1 });
        const scale = THUMBNAIL_WIDTH / viewport.width;
        const scaledViewport = page.getViewport({ scale });

        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;

        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }

        const task = page.render({
            canvasContext: context,
            viewport: scaledViewport,
            canvas,
        });
        renderTasks.set(pageNum, task);
        await task.promise;
        renderTasks.delete(pageNum);

        renderedPages.add(pageNum);
        measureThumbnailHeight();
    } catch (error) {
        renderTasks.delete(pageNum);
        if (
            error instanceof Error
            && error.name === 'RenderingCancelledException'
        ) {
            return;
        }
        if (runId !== renderRunId || !isPdfDocumentUsable(pdfDocument)) {
            return;
        }
        BrowserLogger.error(
            'pdf-thumbnails',
            `Failed to render thumbnail for page ${pageNum}`,
            error,
        );
    } finally {
        renderingPages.delete(pageNum);
    }
}

function buildRenderQueue(totalPages: number) {
    const queue: number[] = [];
    const seen = new Set<number>();

    const push = (page: number) => {
        if (
            page < 1
            || page > totalPages
            || seen.has(page)
            || renderedPages.has(page)
            || renderingPages.has(page)
        ) {
            return;
        }

        seen.add(page);
        queue.push(page);
    };

    const pushRange = (start: number, end: number) => {
        for (let page = start; page <= end; page += 1) {
            push(page);
        }
    };

    push(props.currentPage);
    pushRange(
        Math.max(1, props.currentPage - IMMEDIATE_RENDER_RADIUS),
        Math.min(totalPages, props.currentPage + IMMEDIATE_RENDER_RADIUS),
    );

    const visiblePagesNow = virtualPages.value;
    if (visiblePagesNow.length > 0) {
        const firstVisible = visiblePagesNow[0]!;
        const lastVisible = visiblePagesNow[visiblePagesNow.length - 1]!;
        pushRange(
            Math.max(1, firstVisible - IMMEDIATE_RENDER_RADIUS),
            Math.min(totalPages, lastVisible + IMMEDIATE_RENDER_RADIUS),
        );
    }

    pushRange(
        Math.max(1, props.currentPage - PREFETCH_RENDER_RADIUS),
        Math.min(totalPages, props.currentPage + PREFETCH_RENDER_RADIUS),
    );

    return queue;
}

async function renderThumbnailQueue(
    pdfDocument: PDFDocumentProxy,
    pages: number[],
    runId: number,
) {
    if (pages.length === 0) {
        return;
    }

    const queue = [...pages];

    const workers = Array.from({length: Math.min(THUMBNAIL_RENDER_CONCURRENCY, queue.length)}, async () => {
        while (queue.length > 0) {
            if (runId !== renderRunId || !isPdfDocumentUsable(pdfDocument)) {
                return;
            }
            const pageNum = queue.shift();
            if (pageNum === undefined) {
                return;
            }
            await renderThumbnail(pdfDocument, pageNum, runId);
        }
    });

    await Promise.all(workers);
}

const scheduleVisibleThumbnailRender = useDebounceFn(() => {
    const doc = props.pdfDocument;
    const totalPages = props.totalPages;

    if (!doc || totalPages <= 0) {
        return;
    }

    const runId = renderRunId;
    const pages = buildRenderQueue(totalPages);

    runGuardedTask(() => renderThumbnailQueue(doc, pages, runId), {
        scope: 'pdf-thumbnails',
        message: 'Failed to render virtual thumbnail list',
    });
}, 20);

function clearRenderedState() {
    renderedPages.clear();
    renderingPages.clear();
    renderTasks.clear();
}

watch(
    [
        () => props.pdfDocument,
        () => props.totalPages,
    ],
    ([
        doc,
        total,
    ], [oldDoc]) => {
        cancelAllRenders();
        renderRunId += 1;

        if (!doc || total <= 0) {
            if (total <= 0) {
                clearRenderedState();
                reloadTransition = false;
            } else {
                reloadTransition = true;
            }
            return;
        }

        if (doc !== oldDoc) {
            if (reloadTransition && pendingInvalidation) {
                reloadTransition = false;
                for (const page of pendingInvalidation) {
                    renderedPages.delete(page);
                    renderingPages.delete(page);
                }
                pendingInvalidation = null;
            } else {
                reloadTransition = false;
                pendingInvalidation = null;
                clearRenderedState();
            }
        }

        nextTick(() => {
            updateViewportMetrics();
            scheduleVisibleThumbnailRender();
            measureThumbnailHeight();
        });
    },
    { immediate: true },
);

watch(
    () =>
        [
            props.currentPage,
            visibleStartIndex.value,
            visibleEndIndex.value,
        ] as const,
    () => {
        scheduleVisibleThumbnailRender();
    },
);

function invalidatePages(pages: number[]) {
    pendingInvalidation = pages;
    for (const page of pages) {
        renderedPages.delete(page);

        const task = renderTasks.get(page);
        if (task) {
            try {
                task.cancel();
            } catch {
                // Ignore cancellation errors
            }
            renderTasks.delete(page);
        }

        renderingPages.delete(page);
    }

    scheduleVisibleThumbnailRender();
}

watch(
    () => props.invalidationRequest?.id,
    () => {
        const pages = props.invalidationRequest?.pages;
        if (!pages || pages.length === 0) {
            return;
        }
        invalidatePages([...pages]);
    },
);

watch(
    containerRef,
    () => {
        updateViewportMetrics();
    },
    { immediate: true },
);

watch(virtualPages, async () => {
    await nextTick();
    measureThumbnailHeight();
});

useResizeObserver(containerRef, () => {
    updateViewportMetrics();
    scheduleVisibleThumbnailRender();
    measureThumbnailHeight();
});

onBeforeUnmount(() => {
    cancelAllRenders();
    renderRunId += 1;
    clearRenderedState();
});
</script>

<style scoped>
.pdf-thumbnails {
  position: relative;
  height: 100%;
  overflow: auto;
  padding: 8px;
}

.pdf-thumbnails-virtual-wrapper {
  position: relative;
}

.pdf-thumbnail {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
  transition:
    background-color 0.15s,
    border-color 0.15s;
}

.pdf-thumbnail--virtual {
  position: absolute;
  left: 0;
  right: 0;
}

.pdf-thumbnail:hover {
  background: var(--ui-bg-muted);
}

.pdf-thumbnail.is-active {
  background: var(--ui-bg-accented);
}

.pdf-thumbnail.is-selected {
  border-color: var(--ui-primary);
  background: var(--ui-bg-elevated);
}

.pdf-thumbnail-canvas {
  max-width: 100%;
  border: 1px solid var(--ui-border);
  border-radius: 2px;
  box-shadow:
    0 1px 4px rgb(0 0 0 / 0.1),
    0 0 1px rgb(0 0 0 / 0.06);
  transition: box-shadow 0.15s ease;
}

.pdf-thumbnail.is-active .pdf-thumbnail-canvas {
  box-shadow:
    0 2px 8px rgb(0 0 0 / 0.14),
    0 0 1px rgb(0 0 0 / 0.08);
}

.pdf-thumbnail-number {
  font-size: 12px;
  color: var(--ui-text-muted);
}

.pdf-thumbnail.is-active .pdf-thumbnail-number {
  color: var(--ui-primary);
  font-weight: 600;
}

.pdf-thumbnail.is-selected .pdf-thumbnail-number {
  color: var(--ui-primary);
}

.pdf-thumbnail.is-dragged {
  opacity: 0.35;
}

.pdf-thumbnail.is-drop-before::before {
  content: "";
  position: absolute;
  top: -5px;
  left: 8px;
  right: 8px;
  height: 2px;
  background: var(--ui-primary);
  border-radius: 1px;
}

.pdf-thumbnail.is-drop-after::after {
  content: "";
  position: absolute;
  bottom: -5px;
  left: 8px;
  right: 8px;
  height: 2px;
  background: var(--ui-primary);
  border-radius: 1px;
}

.pdf-thumbnails.is-reorder-dragging .pdf-thumbnail {
  cursor: grabbing;
}

.pdf-thumbnails.is-external-drag {
  outline: 2px dashed var(--ui-primary);
  outline-offset: -2px;
  border-radius: 4px;
}
</style>
