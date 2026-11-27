<template>
    <div
        class="pdf-initial-surface-placeholder"
        aria-hidden="true"
        data-evb-initial-visual-placeholder="true"
    >
        <div
            class="pdf-initial-surface-placeholder__page-shell"
            :class="{'pdf-initial-surface-placeholder__page-shell--measured': pageStyle != null}"
            :style="pageStyle ?? undefined"
        >
            <DocumentPageSkeleton :content-height="skeletonContentHeight" />
        </div>
    </div>
</template>

<script setup lang="ts">
import type {StyleValue} from 'vue';
import DocumentPageSkeleton from '@app/components/document-viewer/DocumentPageSkeleton.vue';

defineProps<{pageStyle?: StyleValue | null}>();

const skeletonContentHeight = 760;
</script>

<style scoped>
.pdf-initial-surface-placeholder {
    position: absolute;
    inset: 0;
    z-index: var(--app-pdf-initial-surface-z-index);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    overflow: hidden;
    pointer-events: none;
    background: var(--app-pdf-viewer-bg, var(--app-window-bg));
}

.pdf-initial-surface-placeholder__page-shell {
    position: relative;
    box-sizing: border-box;
    width: calc(100% - 2rem);
    aspect-ratio: 1 / 1.409;
    margin-top: var(--app-initial-surface-offset);
    overflow: hidden;
    border-radius: var(--app-pdf-page-radius);
    background: var(--app-pdf-page-bg);
    box-shadow: var(--app-pdf-page-shadow);
}

.pdf-initial-surface-placeholder__page-shell--measured {
    max-width: 100%;
    margin-inline: auto;
    aspect-ratio: auto;
}
</style>
