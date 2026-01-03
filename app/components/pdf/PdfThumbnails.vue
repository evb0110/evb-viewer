<template>
    <div class="pdf-thumbnails">
        <div
            v-for="page in totalPages"
            :key="page"
            class="pdf-thumbnail"
            :class="{ 'is-active': page === currentPage }"
            @click="$emit('goToPage', page)"
        >
            <canvas
                ref="canvasRefs"
                class="pdf-thumbnail-canvas"
            />
            <span class="pdf-thumbnail-number">{{ page }}</span>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    ref,
    watch,
    onMounted,
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

const canvasRefs = ref<HTMLCanvasElement[]>([]);
const renderedPages = ref(new Set<number>());
const THUMBNAIL_WIDTH = 150;

async function renderThumbnail(pageNum: number) {
    if (!props.pdfDocument || renderedPages.value.has(pageNum)) {
        return;
    }

    const canvas = canvasRefs.value[pageNum - 1];
    if (!canvas) {
        return;
    }

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

        renderedPages.value.add(pageNum);
    } catch (error) {
        console.error(`Failed to render thumbnail for page ${pageNum}:`, error);
    }
}

async function renderVisibleThumbnails() {
    if (!props.pdfDocument) {
        return;
    }

    for (let i = 1; i <= props.totalPages; i++) {
        await renderThumbnail(i);
    }
}

watch(
    () => props.pdfDocument,
    async (doc) => {
        if (doc) {
            renderedPages.value.clear();
            await nextTick();
            renderVisibleThumbnails();
        }
    },
    { immediate: true },
);

onMounted(() => {
    if (props.pdfDocument) {
        renderVisibleThumbnails();
    }
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
