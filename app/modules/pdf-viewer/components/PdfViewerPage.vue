<template>
    <div
        ref="pageContainer"
        class="page_container"
        role="group"
        :aria-label="t('pageOps.pageTarget', {page})"
        :aria-busy="showSkeleton && !rendered && !renderFailed ? 'true' : undefined"
        :class="{
            'page_container--spread-single': spreadSingle,
            'page_container--buffered': buffered,
            'page_container--rendered': rendered,
        }"
        :data-page="page"
        :data-document-page-number="page"
        :data-page-visual="pageVisualState"
        :style="[
            placeholderStyle ?? undefined,
            pageScaleStyle,
        ]"
        @click="handlePageClick"
    >
        <div class="page_canvas">
            <div
                class="page_canvas__render-layer canvasWrapper"
                :class="{'document-page-visual--committed': rendered}"
            ></div>
            <DocumentPageSkeleton
                v-if="showPageSkeleton && !rendered && !renderFailed"
                :padding="pageSkeletonPadding"
                :content-height="pageSkeletonContentHeight"
            />
            <div
                v-else-if="renderFailed"
                class="pdf-page-render-error"
                role="alert"
            >
                {{ renderErrorLabel }}
            </div>
        </div>
        <div class="text-layer textLayer"></div>
        <div class="annotation-layer annotationLayer"></div>
        <PdfAnnotationEditorLayer :page-index="page - 1" />
        <PdfImagePlacementOverlay
            :placement="placedImage"
            :busy="placedImageBusy"
            @update-rect="emit('update-placed-image-rect', $event)"
            @finalize="emit('finalize-placed-image')"
            @cancel="emit('cancel-placed-image')"
        />
    </div>
</template>

<script setup lang="ts">

import DocumentPageSkeleton from '@app/components/document-viewer/DocumentPageSkeleton.vue';
import PdfAnnotationEditorLayer from '@app/modules/pdf-viewer/components/PdfAnnotationEditorLayer.vue';
import PdfImagePlacementOverlay from '@app/modules/pdf-viewer/components/PdfImagePlacementOverlay.vue';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { shouldClearPdfPageSelection } from '@app/modules/pdf-viewer/engine/annotations/shouldClearPdfPageSelection';
import { usePdfSkeletonContext } from '@app/modules/pdf-viewer/runtime/skeleton/usePdfSkeletonInsets';
import type {
    IPdfImagePlacementDraft,
    IPdfImagePlacementRectUpdate,
} from '@app/types/pdfImagePlacement';
import {
    buildPdfPageScaleStyle,
    type IPdfPageScale,
} from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';
import { annotationEditorSurfaceKey } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';

interface IProps {
    page: number;
    showSkeleton: boolean;
    renderFailed?: boolean;
    renderErrorLabel?: string;
    spreadSingle?: boolean;
    buffered?: boolean;
    rendered?: boolean;
    pageScale: IPdfPageScale | null;
    placeholderStyle?: Record<string, string> | null;
    placedImage?: IPdfImagePlacementDraft | null;
    placedImageBusy?: boolean;
}

const {
    page,
    showSkeleton,
    renderFailed = false,
    renderErrorLabel = '',
    spreadSingle = false,
    buffered = false,
    rendered = false,
    pageScale,
    placeholderStyle = null,
    placedImage = null,
    placedImageBusy = false,
} = defineProps<IProps>();
const { t } = useTypedI18n();
const emit = defineEmits<{
    'page-container-mounted': [page: number];
    'page-container-unmounted': [page: number];
    'update-placed-image-rect': [payload: IPdfImagePlacementRectUpdate];
    'finalize-placed-image': [];
    'cancel-placed-image': [];
}>();
const pageContainer = ref<HTMLElement | null>(null);
const pageScaleStyle = computed(() => pageScale ? buildPdfPageScaleStyle(pageScale) : undefined);

const {
    scaledSkeletonPadding,
    scaledPageHeight,
} = usePdfSkeletonContext();
const fallbackSkeletonPadding = Object.freeze({
    top: 56,
    right: 56,
    bottom: 56,
    left: 56,
});
const pageSkeletonPadding = computed(() => scaledSkeletonPadding.value ?? fallbackSkeletonPadding);
const pageSkeletonContentHeight = computed(() => scaledPageHeight.value ?? 760);

const showPageSkeleton = computed(() => showSkeleton);
const pageVisualState = computed(() => rendered ? 'ready' : 'none');
const annotationEditorSurface = inject(annotationEditorSurfaceKey, null);

function handlePageClick(event: MouseEvent) {
    const target = event.target;
    if (!shouldClearPdfPageSelection(target)) {
        return;
    }
    annotationEditorSurface?.clearSelection();
}

onMounted(() => {
    emit('page-container-mounted', page);
});

onBeforeUnmount(() => {
    clearPdfSelectionForLayerTeardown({ target: pageContainer.value });
    emit('page-container-unmounted', page);
});
</script>
