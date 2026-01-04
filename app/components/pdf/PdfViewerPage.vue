<template>
    <div
        class="page_container"
        :data-page="page"
    >
        <div class="page_canvas"></div>
        <div class="text-layer"></div>
        <div class="annotation-layer"></div>
        <PdfPageSkeleton
            v-if="showSkeleton"
            :padding="skeletonPadding"
            :content-height="contentHeight"
        />
    </div>
</template>

<script setup lang="ts">
import PdfPageSkeleton from './PdfPageSkeleton.vue';
import type { TContentInsets } from '../../types/pdf';

interface IPdfViewerPageProps {
    page: number;
    showSkeleton: boolean;
    skeletonPadding: TContentInsets | null;
    contentHeight: number | null;
}

defineProps<IPdfViewerPageProps>();
</script>
