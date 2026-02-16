<template>
    <div
        class="page_container"
        :class="{ 'page_container--spread-single': spreadSingle }"
        :data-page="page"
    >
        <div class="page_canvas canvasWrapper"></div>
        <div class="text-layer textLayer"></div>
        <div class="annotation-layer annotationLayer"></div>
        <div class="annotation-editor-layer annotationEditorLayer"></div>
        <PdfShapeOverlay
            v-if="shapeContext"
            :page-index="page - 1"
            :shapes="pageShapes"
            :drawing-shape="pageDrawingShape"
            :selected-shape-id="shapeContext.selectedShapeId.value"
            :is-active="shapeContext.isShapeToolActive.value"
            :tool="shapeContext.activeShapeTool.value"
            :settings="shapeContext.settings.value"
            @start-drawing="shapeContext.handleStartDrawing(page - 1, $event)"
            @continue-drawing="shapeContext.handleContinueDrawing($event)"
            @finish-drawing="shapeContext.handleFinishDrawing()"
            @select-shape="shapeContext.handleSelectShape($event)"
            @shape-contextmenu="shapeContext.handleShapeContextMenu($event)"
        />
        <PdfPageSkeleton
            v-if="showSkeleton"
            :padding="scaledSkeletonPadding"
            :content-height="scaledPageHeight"
        />
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    inject,
} from 'vue';
import PdfPageSkeleton from '@app/components/pdf/PdfPageSkeleton.vue';
import PdfShapeOverlay from '@app/components/pdf/PdfShapeOverlay.vue';
import { usePdfSkeletonContext } from '@app/composables/pdf/usePdfSkeletonInsets';
import type { IShapeContextProvide } from '@app/composables/pdf/useAnnotationShapes';

interface IProps {
    page: number;
    showSkeleton: boolean;
    spreadSingle?: boolean;
}

const props = defineProps<IProps>();

const {
    scaledSkeletonPadding,
    scaledPageHeight,
} = usePdfSkeletonContext();

const shapeContext = inject<IShapeContextProvide | null>('shapeContext', null);

const pageShapes = computed(() => shapeContext?.getShapesForPage(props.page - 1) ?? []);

const pageDrawingShape = computed(() => {
    const drawing = shapeContext?.drawingShape.value;
    if (!drawing || drawing.pageIndex !== props.page - 1) {
        return null;
    }
    return drawing;
});
</script>
