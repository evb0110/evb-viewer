<template>
    <div
        :id="chassisAuthority ? undefined : 'pdf-viewer'"
        :ref="setViewerContainerElement"
        class="pdf-viewer-page-track"
        :class="chassisAuthority ? viewerClass : ['pdfViewer app-scrollbar app-scroll-region--balanced', viewerClass]"
        :style="containerStyle"
        data-pdf-page-track
        v-bind="viewportAttributes"
    >
        <template
            v-for="item in renderedVirtualItems"
            :key="item.key"
        >
            <div
                v-if="item.kind === 'spacer'"
                class="pdf-viewer-virtual-spacer"
                :style="item.style"
            />
            <div
                v-else-if="item.kind === 'row'"
                class="pdf-viewer-page-row"
                :class="{'pdf-viewer-page-row--buffered': item.buffered}"
            >
                <PdfViewerPage
                    v-for="pageItem in item.pages"
                    :key="pageItem.key"
                    v-bind="pageItem.pageProps"
                    v-on="pageListeners"
                />
            </div>
            <PdfViewerPage
                v-else
                v-bind="item.pageProps"
                v-on="pageListeners"
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
import type {ComponentPublicInstance, StyleValue} from 'vue';
import {requirePageNumber, type TPageNumber} from '@contracts/pageNumbers';
import PdfViewerPage from '@app/modules/pdf-viewer/components/PdfViewerPage.vue';
import {
    flattenPdfVirtualPageSegments,
    groupPdfVirtualPageItems,
} from '@app/modules/pdf-viewer/runtime/composables/flattenPdfVirtualPageSegments';
import {
    injectDocumentViewerRuntime,
    isDocumentOpenEmptySurfaceTransition,
    resolveDocumentWheelInteraction,
    type IDocumentViewportFlingBackdrop,
    type IDocumentWheelInteraction,
} from '@app/modules/document-viewer/public';
import type {IPdfImagePlacementDraft, IPdfImagePlacementRectUpdate} from '@app/types/pdfImagePlacement';
import type {IPdfVirtualPageSegment} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';
import type {IPdfPageScale} from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';

interface IProps {
    setViewerContainer: (element: HTMLElement | null) => void;
    viewerClass: Record<string, boolean>;
    containerStyle: StyleValue;
    virtualPageSegments: IPdfVirtualPageSegment[];
    initialPageShell?: boolean;
    initialPageShellPage?: TPageNumber;
    openingPageFramePage?: TPageNumber | null;
    openingPageFrameStyle?: Record<string, string> | null;
    shouldShowSkeleton: (page: TPageNumber) => boolean;
    isPageRenderFailed: (page: TPageNumber) => boolean;
    pageRenderErrorLabel: string;
    isSpreadSingle: (page: TPageNumber) => boolean;
    isBufferedPage: (page: TPageNumber) => boolean;
    /** The page is painted and, when the viewport needs it, its text is readable. */
    isPageRendered: (page: TPageNumber) => boolean;
    pageRaster: (page: TPageNumber) => 'current' | 'stale' | null;
    getPageScale: (page: TPageNumber) => IPdfPageScale | null;
    getPagePlaceholderStyle: (page: TPageNumber) => Record<string, string> | null;
    bottomVirtualSpacerStyle?: Record<string, string> | null;
    flingBackdrop?: IDocumentViewportFlingBackdrop | null;
    pendingImagePlacement?: IPdfImagePlacementDraft | null;
    isPendingImagePlacementFinalizing?: boolean;
}

const {
    setViewerContainer,
    viewerClass,
    containerStyle,
    virtualPageSegments,
    initialPageShell = false,
    initialPageShellPage = requirePageNumber(1),
    openingPageFramePage = null,
    openingPageFrameStyle = null,
    shouldShowSkeleton,
    isPageRenderFailed,
    pageRenderErrorLabel,
    isSpreadSingle,
    isBufferedPage,
    isPageRendered,
    pageRaster,
    getPageScale,
    getPagePlaceholderStyle,
    bottomVirtualSpacerStyle = null,
    flingBackdrop = null,
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
    'page-container-mounted': [page: TPageNumber];
    'page-container-unmounted': [page: TPageNumber];
    'update-placed-image-rect': [payload: IPdfImagePlacementRectUpdate];
    'finalize-placed-image': [];
    'cancel-placed-image': [];
}>();

const chassisAuthority = injectDocumentViewerRuntime();
let releaseViewportFeature: (() => void) | null = null;

interface IPdfViewerPageBindings {
    page: TPageNumber;
    shouldShowSkeleton: (page: TPageNumber) => boolean;
    deferSkeleton: boolean;
    paintMode: 'normal' | 'hidden' | 'shell-owned';
    isPageRenderFailed: (page: TPageNumber) => boolean;
    renderErrorLabel: string;
    spreadSingle: boolean;
    buffered: boolean;
    isPageRendered: (page: TPageNumber) => boolean;
    pageRaster: (page: TPageNumber) => 'current' | 'stale' | null;
    getPageScale: (page: TPageNumber) => IPdfPageScale | null;
    getPagePlaceholderStyle: (page: TPageNumber) => Record<string, string> | null;
    openingPageFrameStyle: Record<string, string> | null;
    placedImage: IPdfImagePlacementDraft | null;
    placedImageBusy: boolean;
}

type TRenderedVirtualItem =
    | {
          kind: 'spacer';
          key: string;
          style: Record<string, string>;
      }
    | {
          kind: 'row';
          key: string;
          buffered: boolean;
          pages: Array<{
              key: string;
              pageProps: IPdfViewerPageBindings;
          }>;
      }
    | {
          kind: 'page';
          key: string;
          pageProps: IPdfViewerPageBindings;
      };

const standaloneListeners = chassisAuthority
    ? {}
    : {
          onScrollPassive: (event: Event) => emit('scroll', event),
          onWheel: handleStandaloneWheel,
          onMousedown: (event: MouseEvent) => emit('mousedown', event),
          onMousemove: (event: MouseEvent) => emit('mousemove', event),
          onMouseup: (event: MouseEvent) => emit('mouseup', event),
          onMouseleave: () => emit('mouseleave'),
          onClick: (event: MouseEvent) => emit('click', event),
          onDblclick: (event: MouseEvent) => emit('dblclick', event),
          onContextmenu: (event: MouseEvent) => emit('contextmenu', event),
          onSelectstart: (event: Event) => emit('selectstart', event),
      };

const pageListeners = {
    'page-container-mounted': (page: TPageNumber) => emit('page-container-mounted', page),
    'page-container-unmounted': (page: TPageNumber) => emit('page-container-unmounted', page),
    'update-placed-image-rect': (payload: IPdfImagePlacementRectUpdate) => emit('update-placed-image-rect', payload),
    'finalize-placed-image': () => emit('finalize-placed-image'),
    'cancel-placed-image': () => emit('cancel-placed-image'),
};

const virtualPageItems = computed(() => {
    return flattenPdfVirtualPageSegments(virtualPageSegments, {
        initialPageShell,
        initialPageShellPage,
    });
});

// The presentation modes an observer has to read back off the rendered page
// track. They are derived from the same class map that styles the viewer, so
// the view model stays the single owner of the state itself.
const viewportAttributes = computed(() => ({
    'data-pdf-continuous-scroll': viewerClass['pdfViewer--single-page'] === true ? 'false' : 'true',
    'data-pdf-view-mode':
        viewerClass['pdfViewer--mode-facing'] === true
            ? 'facing'
            : viewerClass['pdfViewer--mode-facing-first-single'] === true
              ? 'facing-first-single'
              : 'single',
    'data-pdf-zoom-mode':
        viewerClass['pdfViewer--fit-width'] === true
            ? 'fit-width'
            : viewerClass['pdfViewer--fit-height'] === true
              ? 'fit-height'
              : 'custom',
    ...standaloneListeners,
}));

const groupedVirtualPageItems = computed(() =>
    groupPdfVirtualPageItems(virtualPageItems.value, {
        isFacingMode: viewerClass['pdfViewer--mode-facing'] === true || viewerClass['pdfViewer--mode-facing-first-single'] === true,
        isSpreadSingle,
    }),
);

// The navigation ticket owns the reveal for every destination-visible page,
// including neighbours still painting after the target canvas commits.
const deferPageSkeleton = computed(() => {
    const visual = chassisAuthority?.openSurface.viewportSession.value.visual;
    return chassisAuthority?.navigationTicket.value !== null && visual?.kind === 'page' && visual.deferSkeleton === true;
});

const pagePaintMode = computed<'normal' | 'hidden' | 'shell-owned'>(() => {
    const snapshot = chassisAuthority?.openSurface.snapshot.value;
    if (!snapshot) {
        return 'normal';
    }
    if (isDocumentOpenEmptySurfaceTransition(snapshot) && snapshot.presentation === 'idle') {
        return 'hidden';
    }
    return snapshot.presentation === 'page-shell' ? 'shell-owned' : 'normal';
});

function buildPageProps(page: TPageNumber): IPdfViewerPageBindings {
    return {
        page,
        shouldShowSkeleton,
        deferSkeleton: deferPageSkeleton.value,
        paintMode: pagePaintMode.value,
        isPageRenderFailed,
        renderErrorLabel: pageRenderErrorLabel,
        spreadSingle: isSpreadSingle(page),
        buffered: isBufferedPage(page),
        isPageRendered,
        pageRaster,
        getPageScale,
        getPagePlaceholderStyle,
        openingPageFrameStyle: page === openingPageFramePage ? openingPageFrameStyle : null,
        placedImage: pendingImagePlacement?.pageNumber === page ? pendingImagePlacement : null,
        placedImageBusy: isPendingImagePlacementFinalizing,
    };
}

const renderedVirtualItems = computed<TRenderedVirtualItem[]>(() =>
    groupedVirtualPageItems.value.map((item) => {
        if (item.kind === 'spacer') {
            return item;
        }
        if (item.kind === 'row') {
            const pages = item.pages.map((pageItem) => ({
                key: pageItem.key,
                pageProps: buildPageProps(pageItem.page),
            }));
            return {
                kind: 'row',
                key: item.key,
                buffered: pages.every((entry) => entry.pageProps.buffered),
                pages,
            };
        }
        return {
            kind: 'page',
            key: item.key,
            pageProps: buildPageProps(item.page),
        };
    }),
);

function setViewerContainerElement(element: Element | ComponentPublicInstance | null) {
    setViewerContainer(chassisAuthority?.viewportElement.value ?? (element instanceof HTMLElement ? element : null));
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
        getClass: () => ['document-viewer-viewport pdfViewer app-scrollbar', viewerClass],
        // The chassis owns scrolling only. Page spacing and viewer-specific
        // inherited variables belong to the physical page track above.
        getStyle: () => ({}),
        getFlingBackdrop: () => flingBackdrop,
        events: {
            scroll: (event) => emit('scroll', event as Event),
            mousedown: (event) => emit('mousedown', event as MouseEvent),
            mousemove: (event) => emit('mousemove', event as MouseEvent),
            mouseup: (event) => emit('mouseup', event as MouseEvent),
            mouseleave: () => emit('mouseleave'),
            click: (event) => emit('click', event as MouseEvent),
            dblclick: (event) => emit('dblclick', event as MouseEvent),
            contextmenu: (event) => emit('contextmenu', event as MouseEvent),
            selectstart: (event) => emit('selectstart', event as Event),
        },
        wheel: (interaction) => emit('wheel', interaction),
    });
});

onBeforeUnmount(() => releaseViewportFeature?.());
</script>
