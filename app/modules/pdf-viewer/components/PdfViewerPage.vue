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
            'page_container--paint-hidden': paintMode === 'hidden',
        }"
        :data-page="page"
        :data-document-page-number="page"
        :data-page-visual="raster === null ? 'none' : 'ready'"
        :data-page-raster="raster ?? undefined"
        :style="[placeholderStyle ?? undefined, pageScaleStyle]"
        @click="handlePageClick"
    >
        <div
            class="page_canvas"
            :class="{'page_canvas--shell-owned': paintMode === 'shell-owned'}"
        >
            <div
                class="page_canvas__render-layer canvasWrapper"
                :class="{'document-page-visual--committed': raster !== null}"
            ></div>
            <div class="page_canvas__detail-layer"></div>
            <DocumentPageSkeleton
                v-if="showSkeleton && raster === null && !renderFailed"
                :deferred="deferSkeleton"
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
import {clearPdfSelectionForLayerTeardown} from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import {shouldClearPdfPageSelection} from '@app/modules/pdf-viewer/engine/annotations/shouldClearPdfPageSelection';
import {usePdfSkeletonContext} from '@app/modules/pdf-viewer/runtime/skeleton/usePdfSkeletonInsets';
import type {IPdfImagePlacementDraft, IPdfImagePlacementRectUpdate} from '@app/types/pdfImagePlacement';
import type {TPageNumber} from '@contracts/pageNumbers';
import {buildPdfPageScaleStyle, type IPdfPageScale} from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';
import {annotationEditorSurfaceKey} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';

interface IProps {
    page: TPageNumber;
    shouldShowSkeleton: (page: TPageNumber) => boolean;
    deferSkeleton?: boolean;
    paintMode?: 'normal' | 'hidden' | 'shell-owned';
    isPageRenderFailed: (page: TPageNumber) => boolean;
    renderErrorLabel?: string;
    spreadSingle?: boolean;
    buffered?: boolean;
    /** Painted and, when the viewport needs it, readable; a skeleton never covers a raster. */
    isPageRendered: (page: TPageNumber) => boolean;
    /** A committed raster, at the current scale or stretched from an older one. */
    pageRaster: (page: TPageNumber) => 'current' | 'stale' | null;
    getPageScale: (page: TPageNumber) => IPdfPageScale | null;
    getPagePlaceholderStyle: (page: TPageNumber) => Record<string, string> | null;
    openingPageFrameStyle?: Record<string, string> | null;
    placedImage?: IPdfImagePlacementDraft | null;
    placedImageBusy?: boolean;
}

const {
    page,
    shouldShowSkeleton,
    deferSkeleton = false,
    paintMode = 'normal',
    isPageRenderFailed,
    renderErrorLabel = '',
    spreadSingle = false,
    buffered = false,
    isPageRendered,
    pageRaster,
    getPageScale,
    getPagePlaceholderStyle,
    openingPageFrameStyle = null,
    placedImage = null,
    placedImageBusy = false,
} = defineProps<IProps>();
const {t} = useTypedI18n();
const emit = defineEmits<{
    'page-container-mounted': [page: TPageNumber];
    'page-container-unmounted': [page: TPageNumber];
    'update-placed-image-rect': [payload: IPdfImagePlacementRectUpdate];
    'finalize-placed-image': [];
    'cancel-placed-image': [];
}>();
const pageContainer = ref<HTMLElement | null>(null);
const showSkeleton = computed(() => shouldShowSkeleton(page));
const renderFailed = computed(() => isPageRenderFailed(page));
const rendered = computed(() => isPageRendered(page));
const raster = computed(() => pageRaster(page));
const placeholderStyle = computed(() => openingPageFrameStyle ?? getPagePlaceholderStyle(page));
const pageScaleStyle = computed(() => {
    const resolved = getPageScale(page);
    return resolved ? buildPdfPageScaleStyle(resolved) : undefined;
});

const {scaledSkeletonPadding, scaledPageHeight} = usePdfSkeletonContext();
const fallbackSkeletonPadding = Object.freeze({
    top: 56,
    right: 56,
    bottom: 56,
    left: 56,
});
const pageSkeletonPadding = computed(() => scaledSkeletonPadding.value ?? fallbackSkeletonPadding);
const pageSkeletonContentHeight = computed(() => scaledPageHeight.value ?? 760);

const annotationEditorSurface = inject(annotationEditorSurfaceKey, null);

function handlePageClick(event: MouseEvent) {
    if (shouldClearPdfPageSelection(event.target)) {
        annotationEditorSurface?.clearSelection();
    }
}

onMounted(() => {
    emit('page-container-mounted', page);
});

onBeforeUnmount(() => {
    clearPdfSelectionForLayerTeardown({target: pageContainer.value});
    emit('page-container-unmounted', page);
});
</script>

<style scoped>
/* Until an open knows its page shape the viewer shows only its background
   (behavior contract T5). The renderer may already have laid its pages out
   underneath at a scale it has not fitted, at the page it has not reached. */
.page_container--paint-hidden {
    visibility: hidden;
}

/* The opening shell is the sole visible page-frame owner until commit. The
   renderer still mounts underneath so it can prepare pixels, but its matching
   shadow must not composite through the opening shell's translucent shadow. */
.page_canvas--shell-owned {
    box-shadow: none;
}
</style>
