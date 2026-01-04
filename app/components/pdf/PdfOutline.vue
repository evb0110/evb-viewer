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
                :key="item.id || index"
                :item="item"
                :pdf-document="pdfDocument"
                :active-item-id="activeItemId"
                @go-to-page="$emit('goToPage', $event)"
                @activate="activeItemId = $event"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    ref,
    watch,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';

interface IRefProxy {
    num: number;
    gen: number;
}

interface IOutlineItemRaw {
    title: string;
    dest: string | unknown[] | null;
    items?: IOutlineItemRaw[];
}

interface IOutlineItem extends Omit<IOutlineItemRaw, 'items'> {
    id: string;
    pageIndex: number | null;
    items?: IOutlineItem[];
}

interface IPdfOutlineProps {
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
}

const props = defineProps<IPdfOutlineProps>();

defineEmits<{(e: 'goToPage', page: number): void;}>();

const outline = ref<IOutlineItem[] | null>(null);
const isLoading = ref(false);
const activeItemId = ref<string | null>(null);

function isRefProxy(value: unknown): value is IRefProxy {
    return (
        typeof value === 'object' &&
        value !== null &&
        'num' in value &&
        'gen' in value &&
        typeof (value as IRefProxy).num === 'number' &&
        typeof (value as IRefProxy).gen === 'number'
    );
}

async function resolvePageIndex(
    pdfDocument: PDFDocumentProxy,
    dest: IOutlineItemRaw['dest'],
    destinationCache: Map<string, unknown[] | null>,
    refIndexCache: Map<string, number | null>,
): Promise<number | null> {
    if (!dest) {
        return null;
    }

    let destinationArray: unknown[] | null = null;

    if (typeof dest === 'string') {
        if (destinationCache.has(dest)) {
            destinationArray = destinationCache.get(dest) ?? null;
        } else {
            try {
                destinationArray = await pdfDocument.getDestination(dest);
            } catch {
                destinationArray = null;
            }
            destinationCache.set(dest, destinationArray);
        }
    } else if (Array.isArray(dest)) {
        destinationArray = dest;
    }

    if (!destinationArray || destinationArray.length === 0) {
        return null;
    }

    const pageRef = destinationArray[0];

    if (typeof pageRef === 'number' && Number.isFinite(pageRef)) {
        const maybeIndex = Math.trunc(pageRef);
        if (maybeIndex >= 0 && maybeIndex < pdfDocument.numPages) {
            return maybeIndex;
        }
        if (maybeIndex > 0 && maybeIndex <= pdfDocument.numPages) {
            return maybeIndex - 1;
        }
        return null;
    }

    if (!isRefProxy(pageRef)) {
        return null;
    }

    const refKey = `${pageRef.num}:${pageRef.gen}`;
    if (refIndexCache.has(refKey)) {
        return refIndexCache.get(refKey) ?? null;
    }

    try {
        const pageIndex = await pdfDocument.getPageIndex(pageRef);
        refIndexCache.set(refKey, pageIndex);
        return pageIndex;
    } catch {
        refIndexCache.set(refKey, null);
        return null;
    }
}

async function buildResolvedOutline(
    items: IOutlineItemRaw[],
    pdfDocument: PDFDocumentProxy,
    parentId: string,
    destinationCache: Map<string, unknown[] | null>,
    refIndexCache: Map<string, number | null>,
): Promise<IOutlineItem[]> {
    return Promise.all(
        items.map(async (item, index) => {
            const id = parentId ? `${parentId}.${index}` : String(index);
            const pageIndex = await resolvePageIndex(
                pdfDocument,
                item.dest,
                destinationCache,
                refIndexCache,
            );
            const children = item.items?.length
                ? await buildResolvedOutline(
                    item.items,
                    pdfDocument,
                    id,
                    destinationCache,
                    refIndexCache,
                )
                : undefined;

            return {
                title: item.title,
                dest: item.dest,
                id,
                pageIndex,
                items: children,
            };
        }),
    );
}

const flatOutline = computed(() => {
    const flattened: IOutlineItem[] = [];

    function visit(items?: IOutlineItem[]) {
        if (!items?.length) {
            return;
        }
        for (const item of items) {
            flattened.push(item);
            visit(item.items);
        }
    }

    visit(outline.value ?? undefined);
    return flattened;
});

function updateActiveItemFromCurrentPage() {
    const pageIndex = Math.max(0, (props.currentPage || 1) - 1);
    let active: IOutlineItem | null = null;

    for (const item of flatOutline.value) {
        if (typeof item.pageIndex === 'number' && item.pageIndex <= pageIndex) {
            active = item;
        }
    }

    activeItemId.value = active?.id ?? null;
}

async function loadOutline() {
    if (!props.pdfDocument) {
        outline.value = null;
        return;
    }

    isLoading.value = true;
    try {
        const result = await props.pdfDocument.getOutline();
        const rawOutline = (result ?? []) as IOutlineItemRaw[];
        const destinationCache = new Map<string, unknown[] | null>();
        const refIndexCache = new Map<string, number | null>();

        outline.value = await buildResolvedOutline(
            rawOutline,
            props.pdfDocument,
            '',
            destinationCache,
            refIndexCache,
        );
        updateActiveItemFromCurrentPage();
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

watch(
    () => [
        props.currentPage,
        outline.value,
    ] as const,
    () => updateActiveItemFromCurrentPage(),
    { deep: true },
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
    user-select: none;
}
</style>
