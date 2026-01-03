<template>
    <div class="pdf-outline">
        <div
            v-if="isLoading"
            class="pdf-outline-loading"
        >
            <UIcon
                name="i-lucide-loader-circle"
                class="animate-spin"
            />
            <span>Loading outline...</span>
        </div>
        <div
            v-else-if="!outline || outline.length === 0"
            class="pdf-outline-empty"
        >
            <UIcon name="i-lucide-list" />
            <span>No outline available</span>
        </div>
        <div
            v-else
            class="pdf-outline-tree"
        >
            <PdfOutlineItem
                v-for="(item, index) in outline"
                :key="index"
                :item="item"
                :pdf-document="pdfDocument"
                @go-to-page="$emit('goToPage', $event)"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    ref,
    watch,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';

interface IOutlineItem {
    title: string;
    dest: string | unknown[] | null;
    items?: IOutlineItem[];
}

interface IPdfOutlineProps {pdfDocument: PDFDocumentProxy | null;}

const props = defineProps<IPdfOutlineProps>();

defineEmits<{(e: 'goToPage', page: number): void;}>();

const outline = ref<IOutlineItem[] | null>(null);
const isLoading = ref(false);

async function loadOutline() {
    if (!props.pdfDocument) {
        outline.value = null;
        return;
    }

    isLoading.value = true;
    try {
        const result = await props.pdfDocument.getOutline();
        outline.value = result as IOutlineItem[] | null;
    } catch (error) {
        console.error('Failed to load outline:', error);
        outline.value = null;
    } finally {
        isLoading.value = false;
    }
}

watch(
    () => props.pdfDocument,
    () => loadOutline(),
    { immediate: true },
);
</script>

<style scoped>
.pdf-outline {
    padding: 8px;
}

.pdf-outline-loading,
.pdf-outline-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    color: var(--ui-text-muted);
    text-align: center;
}

.pdf-outline-tree {
    display: flex;
    flex-direction: column;
}
</style>
