<template>
    <div class="pdf-outline-item">
        <div
            class="pdf-outline-item-row"
            @click="handleClick"
        >
            <button
                v-if="hasChildren"
                class="pdf-outline-item-toggle"
                @click.stop="isExpanded = !isExpanded"
            >
                <UIcon
                    :name="isExpanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                    class="size-4"
                />
            </button>
            <span
                v-else
                class="pdf-outline-item-spacer"
            />
            <span class="pdf-outline-item-title">{{ item.title }}</span>
        </div>
        <div
            v-if="hasChildren && isExpanded"
            class="pdf-outline-item-children"
        >
            <PdfOutlineItem
                v-for="(child, index) in item.items"
                :key="index"
                :item="child"
                :pdf-document="pdfDocument"
                @go-to-page="$emit('goToPage', $event)"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    ref,
    computed,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';

interface IRefProxy {
    num: number;
    gen: number;
}

interface IOutlineItem {
    title: string;
    dest: string | unknown[] | null;
    items?: IOutlineItem[];
}

interface IPdfOutlineItemProps {
    item: IOutlineItem;
    pdfDocument: PDFDocumentProxy | null;
}

const props = defineProps<IPdfOutlineItemProps>();

const emit = defineEmits<{(e: 'goToPage', page: number): void;}>();

const isExpanded = ref(false);

const hasChildren = computed(() => {
    return props.item.items && props.item.items.length > 0;
});

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

async function handleClick() {
    if (!props.pdfDocument || !props.item.dest) {
        return;
    }

    try {
        let dest: unknown[] | null = null;

        if (typeof props.item.dest === 'string') {
            dest = await props.pdfDocument.getDestination(props.item.dest);
        } else if (Array.isArray(props.item.dest)) {
            dest = props.item.dest;
        }

        if (!dest || dest.length === 0) {
            return;
        }

        const pageRef = dest[0];
        if (!isRefProxy(pageRef)) {
            return;
        }

        const pageIndex = await props.pdfDocument.getPageIndex(pageRef);
        emit('goToPage', pageIndex + 1);
    } catch (error) {
        console.error('Failed to navigate to outline destination:', error);
    }
}
</script>

<style scoped>
.pdf-outline-item-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.15s;
}

.pdf-outline-item-row:hover {
    background: var(--ui-bg-muted);
}

.pdf-outline-item-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    background: none;
    color: var(--ui-text-muted);
    cursor: pointer;
    border-radius: 2px;
}

.pdf-outline-item-toggle:hover {
    background: var(--ui-bg-elevated);
}

.pdf-outline-item-spacer {
    width: 20px;
}

.pdf-outline-item-title {
    flex: 1;
    font-size: 13px;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.pdf-outline-item-children {
    padding-left: 16px;
}
</style>
