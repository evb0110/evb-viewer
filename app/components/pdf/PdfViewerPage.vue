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
            :padding="scaledSkeletonPadding"
            :content-height="scaledPageHeight"
        />
    </div>
</template>

<script setup lang="ts">
import PdfPageSkeleton from 'app/components/pdf/PdfPageSkeleton.vue';
import { usePdfSkeletonContext } from 'app/composables/pdf/usePdfSkeletonInsets';

interface IProps {
    page: number;
    showSkeleton: boolean;
}

defineProps<IProps>();

const {
    scaledSkeletonPadding, scaledPageHeight,
} = usePdfSkeletonContext();
</script>
