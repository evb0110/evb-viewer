<template>
    <div
        :id="chassisAuthority ? undefined : 'pdf-viewer'"
        :ref="setViewerContainerElement"
        class="pdf-viewer-page-track"
        :class="chassisAuthority ? viewerClass : ['pdfViewer app-scrollbar app-scroll-region--balanced', viewerClass]"
        :style="containerStyle"
        data-pdf-page-track
        @scroll.passive="!chassisAuthority && emit('scroll', $event)"
        @wheel="!chassisAuthority && handleStandaloneWheel($event)"
        @mousedown="!chassisAuthority && emit('mousedown', $event)"
        @mousemove="!chassisAuthority && emit('mousemove', $event)"
        @mouseup="!chassisAuthority && emit('mouseup', $event)"
        @mouseleave="!chassisAuthority && emit('mouseleave')"
        @click="!chassisAuthority && emit('click', $event)"
        @dblclick="!chassisAuthority && emit('dblclick', $event)"
        @contextmenu="!chassisAuthority && emit('contextmenu', $event)"
        @selectstart="!chassisAuthority && emit('selectstart', $event)"
    >
        <template v-for="item in virtualPageItems" :key="item.key">
            <div
                v-if="item.kind === 'spacer'"
                class="pdf-viewer-virtual-spacer"
                :style="item.style"
            />
            <PdfViewerPage
                v-else
                :page="item.page"
                :show-skeleton="shouldRenderPageSkeleton(item.page)"
                :render-failed="isPageRenderFailed(item.page)"
                :render-error-label="pageRenderErrorLabel"
                :spread-single="isSpreadSingle(item.page)"
                :buffered="isBufferedPage(item.page)"
                :rendered="isRenderedPage(item.page)"
                :page-scale="getPageScale(item.page)"
                :placeholder-style="getEffectivePagePlaceholderStyle(item.page)"
                :placed-image="pendingImagePlacement?.pageNumber === item.page ? pendingImagePlacement : null"
                :placed-image-busy="isPendingImagePlacementFinalizing"
                @page-container-mounted="emit('page-container-mounted', $event)"
                @page-container-unmounted="emit('page-container-unmounted', $event)"
                @update-placed-image-rect="emit('update-placed-image-rect', $event)"
                @finalize-placed-image="emit('finalize-placed-image')"
                @cancel-placed-image="emit('cancel-placed-image')"
            />
        </template>
        <div
            v-if="bottomVirtualSpacerStyle"
            class="pdf-viewer-virtual-spacer"
            :style="bottomVirtualSpacerStyle"
        />
    </div>
</template>

<script setup lang="ts">
import type {
    ComponentPublicInstance,
    StyleValue,
} from 'vue';
import PdfViewerPage from '@app/modules/pdf-viewer/components/PdfViewerPage.vue';
import { flattenPdfVirtualPageSegments } from '@app/modules/pdf-viewer/runtime/composables/flattenPdfVirtualPageSegments';
import { injectDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import type {
    IPdfImagePlacementDraft,
    IPdfImagePlacementRectUpdate,
} from '@app/types/pdfImagePlacement';
import type { IPdfVirtualPageSegment } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';
import type { IPdfPageScale } from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';
import {
    resolveDocumentWheelInteraction,
    type IDocumentWheelInteraction,
} from '@app/utils/document-viewer/input/documentWheelInteraction';

interface IProps {
    setViewerContainer: (element: HTMLElement | null) => void;
    viewerClass: Record<string, boolean>;
    containerStyle: StyleValue;
    virtualPageSegments: IPdfVirtualPageSegment[];
    initialPageShell?: boolean;
    initialPageShellPage?: number;
    openingPageFramePage?: number | null;
    openingPageFrameStyle?: Record<string, string> | null;
    shouldShowSkeleton: (page: number) => boolean;
    isPageRenderFailed: (page: number) => boolean;
    pageRenderErrorLabel: string;
    isSpreadSingle: (page: number) => boolean;
    isBufferedPage: (page: number) => boolean;
    isRenderedPage: (page: number) => boolean;
    getPageScale: (page: number) => IPdfPageScale | null;
    getPagePlaceholderStyle: (page: number) => Record<string, string> | null;
    bottomVirtualSpacerStyle?: Record<string, string> | null;
    pendingImagePlacement?: IPdfImagePlacementDraft | null;
    isPendingImagePlacementFinalizing?: boolean;
}

const {
    setViewerContainer,
    viewerClass,
    containerStyle,
    virtualPageSegments,
    initialPageShell = false,
    initialPageShellPage = 1,
    openingPageFramePage = null,
    openingPageFrameStyle = null,
    shouldShowSkeleton,
    isPageRenderFailed,
    pageRenderErrorLabel,
    isSpreadSingle,
    isBufferedPage,
    isRenderedPage,
    getPageScale,
    getPagePlaceholderStyle,
    bottomVirtualSpacerStyle = null,
    pendingImagePlacement = null,
    isPendingImagePlacementFinalizing = false,
} = defineProps<IProps>();

const emit = defineEmits<{
    scroll: [event: Event];
    wheel: [interaction: IDocumentWheelInteraction];
    mousedown: [event: MouseEvent];
    mousemove: [event: MouseEvent];
    mouseup: [event: MouseEvent];
    mouseleave: [];
    click: [event: MouseEvent];
    dblclick: [event: MouseEvent];
    contextmenu: [event: MouseEvent];
    selectstart: [event: Event];
    'page-container-mounted': [page: number];
    'page-container-unmounted': [page: number];
    'update-placed-image-rect': [payload: IPdfImagePlacementRectUpdate];
    'finalize-placed-image': [];
    'cancel-placed-image': [];
}>();

const chassisAuthority = injectDocumentViewerChassisAuthority();
let releaseViewportFeature: (() => void) | null = null;

const virtualPageItems = computed(() => {
    return flattenPdfVirtualPageSegments(virtualPageSegments, {
        initialPageShell,
        initialPageShellPage,
    });
});

function shouldRenderPageSkeleton(page: number) {
    // The viewport-session projection is the only presentation authority.
    // An opening shell remains a frame during the debounce window; it does not
    // independently force a skeleton before the session delay elapses.
    return shouldShowSkeleton(page);
}

function getEffectivePagePlaceholderStyle(page: number) {
    return page === openingPageFramePage && openingPageFrameStyle
        ? openingPageFrameStyle
        : getPagePlaceholderStyle(page);
}

function setViewerContainerElement(element: Element | ComponentPublicInstance | null) {
    setViewerContainer(chassisAuthority?.viewportElement.value
        ?? (element instanceof HTMLElement ? element : null));
}

function handleStandaloneWheel(event: WheelEvent) {
    const container = event.currentTarget;
    if (!(container instanceof HTMLElement)) {
        return;
    }
    emit('wheel', resolveDocumentWheelInteraction(event, container));
}

onMounted(() => {
    if (!chassisAuthority) {
        return;
    }
    setViewerContainer(chassisAuthority.viewportElement.value);
    releaseViewportFeature = chassisAuthority.bindViewportFeature({
        getClass: () => [
            'document-viewer-viewport pdfViewer app-scrollbar',
            viewerClass,
        ],
        // The chassis owns scrolling only. Page spacing and viewer-specific
        // inherited variables belong to the physical page track above.
        getStyle: () => ({}),
        events: {
            scroll: event => emit('scroll', event as Event),
            mousedown: event => emit('mousedown', event as MouseEvent),
            mousemove: event => emit('mousemove', event as MouseEvent),
            mouseup: event => emit('mouseup', event as MouseEvent),
            mouseleave: () => emit('mouseleave'),
            click: event => emit('click', event as MouseEvent),
            dblclick: event => emit('dblclick', event as MouseEvent),
            contextmenu: event => emit('contextmenu', event as MouseEvent),
            selectstart: event => emit('selectstart', event as Event),
        },
        wheel: interaction => emit('wheel', interaction),
    });
});

onBeforeUnmount(() => releaseViewportFeature?.());

</script>
