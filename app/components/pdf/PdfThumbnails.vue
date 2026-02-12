<template>
    <div
        ref="containerRef"
        class="pdf-thumbnails"
        :class="{
            'is-reorder-dragging': isDragging,
            'is-external-drag': isExternalDragOver,
        }"
        @dragenter="handleExternalDragEnter"
        @dragover="handleExternalDragOver"
        @dragleave="handleExternalDragLeave"
        @drop="handleExternalDrop"
    >
        <div
            v-for="page in totalPages"
            :key="page"
            class="pdf-thumbnail"
            :class="{
                'is-active': page === currentPage,
                'is-selected': isSelected(page),
                'is-dragged': isDragging && draggedPages.includes(page),
                'is-drop-before': dropInsertIndex === page - 1,
                'is-drop-after': page === totalPages && dropInsertIndex === totalPages,
            }"
            :data-page="page"
            @mousedown="handleDragMouseDown($event, page)"
            @click="handleThumbnailClick($event, page)"
            @contextmenu.prevent="handleThumbnailContextMenu($event, page)"
        >
            <canvas class="pdf-thumbnail-canvas" />
            <span class="pdf-thumbnail-number">{{ getPageIndicator(page) }}</span>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    watch,
    nextTick,
    onBeforeUnmount,
} from 'vue';
import type {
    PDFDocumentProxy,
    RenderTask,
} from 'pdfjs-dist';
import { isPdfDocumentUsable } from '@app/utils/pdf-document-guard';
import { formatPageIndicator } from '@app/utils/pdf-page-labels';
import { THUMBNAIL_WIDTH } from '@app/constants/pdf-layout';
import { useMultiSelection } from '@app/composables/useMultiSelection';
import { usePageDragDrop } from '@app/composables/pdf/usePageDragDrop';

interface IProps {
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    totalPages: number;
    pageLabels?: string[] | null;
    selectedPages?: number[];
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'go-to-page', page: number): void;
    (e: 'update:selected-pages', pages: number[]): void;
    (e: 'page-context-menu', payload: {
        clientX: number;
        clientY: number;
        pages: number[]
    }): void;
    (e: 'reorder', newOrder: number[]): void;
    (e: 'file-drop', payload: {
        afterPage: number;
        filePath: string 
    }): void;
}>();

const containerRef = ref<HTMLElement | null>(null);
const renderedPages = new Set<number>();
const renderingPages = new Set<number>();
const renderTasks = new Map<number, RenderTask>();
let renderRunId = 0;
let pendingInvalidation: number[] | null = null;

const multiSelection = useMultiSelection<number>();

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
    onReorder: (newOrder) => emit('reorder', newOrder),
    onExternalFileDrop: (afterPage, filePath) => emit('file-drop', {
        afterPage,
        filePath, 
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
    return (props.selectedPages ?? []).includes(page);
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
    const normalized = normalizeSelectedPages(Array.from(multiSelection.selected.value));
    emit('update:selected-pages', normalized);
    emit('go-to-page', page);
}

function handleThumbnailContextMenu(event: MouseEvent, page: number) {
    if (!isSelected(page)) {
        multiSelection.selected.value = new Set([page]);
        multiSelection.anchor.value = page;
        emit('update:selected-pages', [page]);
    }
    const pages = normalizeSelectedPages(Array.from(multiSelection.selected.value));
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
    const thumbnail = containerRef.value.querySelector(`[data-page="${pageNum}"]`);
    return thumbnail?.querySelector('canvas') ?? null;
}

function getPageIndicator(page: number) {
    return formatPageIndicator(page, props.pageLabels ?? null);
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

        if (multiSelection.anchor.value === null || !normalized.includes(multiSelection.anchor.value)) {
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
    } catch (error) {
        renderTasks.delete(pageNum);
        if (error instanceof Error && error.name === 'RenderingCancelledException') {
            return;
        }
        if (runId !== renderRunId || !isPdfDocumentUsable(pdfDocument)) {
            return;
        }
        console.error(`Failed to render thumbnail for page ${pageNum}:`, error);
    } finally {
        renderingPages.delete(pageNum);
    }
}

async function renderAllThumbnails(
    pdfDocument: PDFDocumentProxy,
    totalPages: number,
    runId: number,
) {
    // Wait for DOM to be fully ready FIRST (v-for needs to render)
    await nextTick();

    if (runId !== renderRunId) {
        return;
    }

    if (!containerRef.value || totalPages === 0) {
        return;
    }

    for (let i = 1; i <= totalPages; i++) {
        if (runId !== renderRunId || !isPdfDocumentUsable(pdfDocument)) {
            return;
        }
        await renderThumbnail(pdfDocument, i, runId);
    }
}

function clearRenderedState() {
    renderedPages.clear();
    renderingPages.clear();
    renderTasks.clear();
}

// Single watcher for both props to avoid race conditions
// When totalPages and pdfDocument change together (they're linked via computed),
// separate watchers can miss the update due to timing
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
        const runId = renderRunId;

        if (!doc || total <= 0) {
            clearRenderedState();
            return;
        }

        if (doc !== oldDoc) {
            const pagesToInvalidate = pendingInvalidation;
            pendingInvalidation = null;

            if (pagesToInvalidate && pagesToInvalidate.length > 0) {
                for (const page of pagesToInvalidate) {
                    renderedPages.delete(page);
                    renderingPages.delete(page);
                    const task = renderTasks.get(page);
                    if (task) {
                        try { task.cancel(); } catch { /* */ }
                        renderTasks.delete(page);
                    }
                }
            } else {
                clearRenderedState();
            }
        }

        void renderAllThumbnails(doc, total, runId);
    },
    { immediate: true }, // Run on mount with current values
);

function invalidatePages(pages: number[]) {
    pendingInvalidation = pages;
}

defineExpose({ invalidatePages });

onBeforeUnmount(() => {
    cancelAllRenders();
    renderRunId += 1;
    clearRenderedState();
});
</script>

<style scoped>
.pdf-thumbnails {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
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
    transition: background-color 0.15s, border-color 0.15s;
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
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.1), 0 0 1px rgb(0 0 0 / 0.06);
    transition: box-shadow 0.15s ease;
}

.pdf-thumbnail.is-active .pdf-thumbnail-canvas {
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.14), 0 0 1px rgb(0 0 0 / 0.08);
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
    content: '';
    position: absolute;
    top: -5px;
    left: 8px;
    right: 8px;
    height: 2px;
    background: var(--ui-primary);
    border-radius: 1px;
}

.pdf-thumbnail.is-drop-after::after {
    content: '';
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
