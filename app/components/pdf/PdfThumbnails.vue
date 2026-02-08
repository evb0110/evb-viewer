<template>
    <div
        ref="containerRef"
        class="pdf-thumbnails"
    >
        <div
            v-for="page in totalPages"
            :key="page"
            class="pdf-thumbnail"
            :class="{ 'is-active': page === currentPage }"
            :data-page="page"
            @click="$emit('goToPage', page)"
        >
            <canvas class="pdf-thumbnail-canvas" />
            <span class="pdf-thumbnail-number">{{ page }}</span>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    ref,
    watch,
    nextTick,
    onBeforeUnmount,
} from 'vue';
import type {
    PDFDocumentProxy,
    RenderTask,
} from 'pdfjs-dist';
import { isPdfDocumentUsable } from '@app/utils/pdf-document-guard';

interface IProps {
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    totalPages: number;
}

const props = defineProps<IProps>();

defineEmits<{(e: 'goToPage', page: number): void;}>();

const containerRef = ref<HTMLElement | null>(null);
const renderedPages = new Set<number>();
const renderingPages = new Set<number>();
const renderTasks = new Map<number, RenderTask>();
const THUMBNAIL_WIDTH = 150;
let renderRunId = 0;

function getCanvas(pageNum: number): HTMLCanvasElement | null {
    if (!containerRef.value) {
        return null;
    }
    const thumbnail = containerRef.value.querySelector(`[data-page="${pageNum}"]`);
    return thumbnail?.querySelector('canvas') ?? null;
}

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

        // Only clear if document changed (not just page count)
        if (doc !== oldDoc) {
            clearRenderedState();
        }

        void renderAllThumbnails(doc, total, runId);
    },
    { immediate: true }, // Run on mount with current values
);

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
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 4px;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.15s;
}

.pdf-thumbnail:hover {
    background: var(--ui-bg-muted);
}

.pdf-thumbnail.is-active {
    background: var(--ui-bg-accented);
}

.pdf-thumbnail-canvas {
    max-width: 100%;
    border: 1px solid var(--ui-border);
    border-radius: 2px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.pdf-thumbnail-number {
    font-size: 12px;
    color: var(--ui-text-muted);
}

.pdf-thumbnail.is-active .pdf-thumbnail-number {
    color: var(--ui-primary);
    font-weight: 600;
}
</style>
