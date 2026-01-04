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
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';

interface IPdfThumbnailsProps {
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    totalPages: number;
}

const props = defineProps<IPdfThumbnailsProps>();

defineEmits<{(e: 'goToPage', page: number): void;}>();

const containerRef = ref<HTMLElement | null>(null);
const renderedPages = new Set<number>();
const renderingPages = new Set<number>();
const THUMBNAIL_WIDTH = 150;

function getCanvas(pageNum: number): HTMLCanvasElement | null {
    if (!containerRef.value) {
        return null;
    }
    const thumbnail = containerRef.value.querySelector(`[data-page="${pageNum}"]`);
    return thumbnail?.querySelector('canvas') ?? null;
}

async function renderThumbnail(pageNum: number) {
    if (!props.pdfDocument) {
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
        const page = await props.pdfDocument.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const scale = THUMBNAIL_WIDTH / viewport.width;
        const scaledViewport = page.getViewport({ scale });

        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;

        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }

        await page.render({
            canvasContext: context,
            viewport: scaledViewport,
            canvas,
        }).promise;

        renderedPages.add(pageNum);
    } catch (error) {
        if (error instanceof Error && error.name === 'RenderingCancelledException') {
            return;
        }
        console.error(`Failed to render thumbnail for page ${pageNum}:`, error);
    } finally {
        renderingPages.delete(pageNum);
    }
}

async function renderAllThumbnails() {
    // Wait for DOM to be fully ready FIRST (v-for needs to render)
    await nextTick();

    if (!props.pdfDocument || !containerRef.value || props.totalPages === 0) {
        return;
    }

    for (let i = 1; i <= props.totalPages; i++) {
        await renderThumbnail(i);
    }
}

function clearRenderedState() {
    renderedPages.clear();
    renderingPages.clear();
}

// Single watcher for both props to avoid race conditions
// When totalPages and pdfDocument change together (they're linked via computed),
// separate watchers can miss the update due to timing
watch(
    [() => props.pdfDocument, () => props.totalPages],
    ([doc, total], [oldDoc]) => {
        if (doc && total > 0) {
            // Only clear if document changed (not just page count)
            if (doc !== oldDoc) {
                clearRenderedState();
            }
            void renderAllThumbnails();
        }
    },
    { immediate: true }, // Run on mount with current values
);
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
