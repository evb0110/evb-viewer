<template>
    <div ref="containerRef" class="page-thumbnails">
        <div
            v-for="(page, index) in pages"
            :key="page"
            class="page-thumbnail"
            :class="{
                'is-selected': currentPage === index,
                'is-complete': pageStatuses[page] === 'complete',
                'is-error': pageStatuses[page] === 'error',
                'is-processing': pageStatuses[page] === 'processing',
            }"
            role="button"
            tabindex="0"
            :aria-label="`Page ${page}`"
            :aria-selected="currentPage === index"
            @click="handleSelect(index)"
            @keydown.enter="handleSelect(index)"
            @keydown.space.prevent="handleSelect(index)"
        >
            <div class="thumbnail-image">
                <canvas
                    ref="canvasRefs"
                    class="thumbnail-canvas"
                    :data-page="page"
                />
                <div v-if="!thumbnailRendered[page]" class="thumbnail-placeholder">
                    <UIcon name="i-lucide-file" class="size-6 text-muted" />
                </div>
            </div>

            <div class="thumbnail-footer">
                <span class="thumbnail-number">{{ page }}</span>
                <span v-if="pageStatuses[page] !== 'pending'" class="thumbnail-status">
                    <UIcon
                        v-if="pageStatuses[page] === 'complete'"
                        name="i-lucide-check"
                        class="size-3 status-complete"
                    />
                    <UIcon
                        v-else-if="pageStatuses[page] === 'error'"
                        name="i-lucide-circle-alert"
                        class="size-3 status-error"
                    />
                    <UIcon
                        v-else-if="pageStatuses[page] === 'processing'"
                        name="i-lucide-loader-circle"
                        class="size-3 status-processing animate-spin"
                    />
                </span>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    ref,
    watch,
    nextTick,
    onMounted,
} from 'vue';
import type { TPageStatus } from '@app/types/page-processing';

interface IProps {
    pages: number[];
    currentPage: number;
    pageStatuses: Record<number, TPageStatus>;
    thumbnailUrls?: Record<number, string>;
}

const {
    pages,
    currentPage,
    pageStatuses,
    thumbnailUrls = {},
} = defineProps<IProps>();

const emit = defineEmits<{(e: 'select', pageIndex: number): void;}>();

const containerRef = ref<HTMLElement | null>(null);
const canvasRefs = ref<HTMLCanvasElement[]>([]);
const thumbnailRendered = ref<Record<number, boolean>>({});

function handleSelect(pageIndex: number) {
    emit('select', pageIndex);
    scrollToPage(pageIndex);
}

function scrollToPage(pageIndex: number) {
    if (!containerRef.value) {
        return;
    }

    const thumbnail = containerRef.value.querySelector(
        `.page-thumbnail:nth-child(${pageIndex + 1})`,
    ) as HTMLElement | null;

    if (thumbnail) {
        thumbnail.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
        });
    }
}

async function renderThumbnail(page: number, url: string) {
    await nextTick();

    const canvas = containerRef.value?.querySelector(
        `canvas[data-page="${page}"]`,
    ) as HTMLCanvasElement | null;

    if (!canvas) {
        return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return;
    }

    const img = new Image();
    img.onload = () => {
        const maxWidth = 100;
        const scale = maxWidth / img.width;
        canvas.width = maxWidth;
        canvas.height = img.height * scale;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        thumbnailRendered.value[page] = true;
    };
    img.src = url;
}

watch(
    () => thumbnailUrls,
    (urls) => {
        for (const [
            pageStr,
            url,
        ] of Object.entries(urls)) {
            const page = parseInt(pageStr, 10);
            if (url && !thumbnailRendered.value[page]) {
                void renderThumbnail(page, url);
            }
        }
    },
    {
        deep: true,
        immediate: true,
    },
);

watch(
    () => currentPage,
    (newPage) => {
        scrollToPage(newPage);
    },
);

onMounted(() => {
    scrollToPage(currentPage);
});
</script>

<style scoped>
.page-thumbnails {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 8px;
}

.page-thumbnail {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.15s;
    outline: none;
}

.page-thumbnail:hover {
    background-color: var(--ui-bg-muted);
}

.page-thumbnail:focus-visible {
    outline: 2px solid var(--ui-primary);
    outline-offset: 2px;
}

.page-thumbnail.is-selected {
    background-color: var(--ui-bg-accented);
}

.thumbnail-number {
    font-size: 0.6875rem;
    color: var(--ui-text-muted);
}

.page-thumbnail.is-selected .thumbnail-number {
    color: var(--ui-primary);
    font-weight: 600;
}

.thumbnail-image {
    position: relative;
    width: 100%;
    aspect-ratio: 0.707;
    background-color: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    overflow: hidden;
}

.page-thumbnail.is-selected .thumbnail-image {
    border-color: var(--ui-primary);
}

.thumbnail-canvas {
    width: 100%;
    height: 100%;
    object-fit: contain;
}

.thumbnail-placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--ui-bg-muted);
}

.text-muted {
    color: var(--ui-text-muted);
}

.thumbnail-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
}

.thumbnail-status {
    display: flex;
    align-items: center;
}

.status-complete {
    color: var(--ui-success);
}

.status-error {
    color: var(--ui-error);
}

.status-processing {
    color: var(--ui-primary);
}

.animate-spin {
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from {
        transform: rotate(0deg);
    }

    to {
        transform: rotate(360deg);
    }
}
</style>
