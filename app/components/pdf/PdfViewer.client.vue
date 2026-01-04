<template>
    <div
        class="pdf-viewer-container"
        :class="{ 'pdf-viewer-container--dark': invertColors }"
    >
        <div v-if="src && isLoading" class="pdf-loader">
            <USkeleton class="pdf-loader__skeleton" />
        </div>
        <div
            id="pdf-viewer"
            ref="viewerContainer"
            class="pdfViewer"
            :class="{
                'is-dragging': isDragging,
                'drag-mode': dragMode,
                'pdfViewer--hidden': src && isLoading,
                'pdfViewer--fit-height': fitMode === 'height',
            }"
            :style="containerStyle"
            @mousedown="startDrag"
            @mousemove="onDrag"
            @mouseup="stopDrag"
            @mouseleave="stopDrag"
        >
            <div
                v-for="page in pagesToRender"
                :key="page"
                ref="pages"
                class="page_container"
                :data-page="page"
            >
                <div class="page_canvas"></div>
                <div class="text-layer"></div>
                <div class="annotation-layer"></div>
                <PdfPageSkeleton
                    v-if="isPageNearVisible(page)"
                    :padding="scaledSkeletonPadding"
                    :content-height="scaledPageHeight"
                />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    ref,
    computed,
    watch,
    nextTick,
    onMounted,
    onUnmounted,
} from 'vue';
import * as pdfjsLib from 'pdfjs-dist';
import {
    TextLayer,
    AnnotationLayer,
} from 'pdfjs-dist';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import type { IPDFLinkService } from 'pdfjs-dist/types/web/interfaces';
import { Mutex } from 'es-toolkit';
import {
    useDebounceFn,
    useResizeObserver,
} from '@vueuse/core';
import PdfPageSkeleton from './PdfPageSkeleton.vue';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '../../types/pdf';

import 'pdfjs-dist/web/pdf_viewer.css';

const { setupTextLayer } = useTextLayerSelection();
const {
    clearHighlights,
    highlightPage,
    scrollToHighlight,
} = usePdfSearchHighlight();

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.min.mjs';

interface IPdfViewerProps {
    src: Blob | null;
    bufferPages?: number;
    zoom?: number;
    dragMode?: boolean;
    fitMode?: 'width' | 'height';
    isResizing?: boolean;
    invertColors?: boolean;
    showAnnotations?: boolean;
    searchPageMatches?: Map<number, IPdfPageMatches>;
    currentSearchMatch?: IPdfSearchMatch | null;
}

const emit = defineEmits<{
    (e: 'update:zoom', value: number): void;
    (e: 'update:currentPage', page: number): void;
    (e: 'update:totalPages', total: number): void;
    (e: 'update:loading', loading: boolean): void;
}>();

const {
    src,
    bufferPages = 2,
    zoom = 1,
    dragMode = false,
    fitMode = 'width',
    isResizing = false,
    invertColors = false,
    showAnnotations = true,
    searchPageMatches = undefined,
    currentSearchMatch = null,
} = defineProps<IPdfViewerProps>();

const numPages = ref<number>(0);
const currentPage = ref<number>(1);
const pagesToRender = ref<number[]>([]);
const visibleRange = ref({
    start: 1,
    end: 1, 
});
const pdfInstance = ref<null | (() => pdfjsLib.PDFDocumentProxy)>(null);
const viewerContainer = ref<HTMLElement | null>(null);
const isDragging = ref(false);
const dragStart = ref({
    x: 0,
    y: 0,
});
const basePageWidth = ref<number | null>(null);
const basePageHeight = ref<number | null>(null);
const fitWidthScale = ref(1);
const lastContainerSize = ref<number | null>(null);
const isLoading = ref(true);

const SKELETON_BUFFER = 3;

function isPageNearVisible(page: number) {
    const start = Math.max(1, visibleRange.value.start - SKELETON_BUFFER);
    const end = Math.min(numPages.value, visibleRange.value.end + SKELETON_BUFFER);
    return page >= start && page <= end;
}

const devicePixelRatio = window.devicePixelRatio || 1;
const BASE_MARGIN = 20;
type TScrollSnapshot = {
    width: number;
    height: number;
    centerX: number;
    centerY: number;
};
const renderMutex = new Mutex();
let renderVersion = 0;
let isLoadingPdf = false;
let pendingScrollToMatchPageIndex: number | null = null;

const renderedPages = new Set<number>();
const renderingPages = new Set<number>();
const pageCanvases = new Map<number, HTMLCanvasElement>();
const pdfPageCache = new Map<number, PDFPageProxy>();

type TContentInsets = {
    top: number;
    right: number;
    bottom: number;
    left: number;
};

type TDestroyablePdf = PDFDocumentProxy & {
    destroy?: () => void;
    cleanup?: () => void;
};

const skeletonContentInsets = ref<TContentInsets | null>(null);

const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

const containerStyle = computed(() => {
    const scale = zoom * fitWidthScale.value;
    const margin = Math.floor(BASE_MARGIN * scale);
    return {
        padding: `${margin}px`,
        gap: `${margin}px`,
    };
});

const scaledSkeletonPadding = computed<TContentInsets | null>(() => {
    if (!basePageWidth.value || !basePageHeight.value) {
        return null;
    }

    const insets =
        skeletonContentInsets.value ??
        buildFallbackInsets(basePageWidth.value, basePageHeight.value);
    const scale = zoom * fitWidthScale.value;

    return {
        top: insets.top * scale,
        right: insets.right * scale,
        bottom: insets.bottom * scale,
        left: insets.left * scale,
    };
});

const scaledPageHeight = computed(() => {
    if (!basePageHeight.value) {
        return null;
    }
    const scale = zoom * fitWidthScale.value;
    return Math.floor(basePageHeight.value * scale);
});

function buildFallbackInsets(width: number, height: number): TContentInsets {
    const horizontal = clamp(width * 0.08, 24, width / 3);
    const vertical = clamp(height * 0.1, 32, height / 3);

    return {
        top: vertical,
        right: horizontal,
        bottom: vertical,
        left: horizontal,
    };
}

function extractInsetsFromTextContent(
    viewport: {
        width: number;
        height: number;
        convertToViewportPoint: (x: number, y: number) => number[];
    },
    textContent: { items: Array<Record<string, unknown>> },
): TContentInsets | null {
    if (!textContent?.items?.length) {
        return null;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const item of textContent.items) {
        if (!item || !Array.isArray(item.transform)) {
            continue;
        }

        const transform = item.transform as number[];
        const originX = transform[4] ?? 0;
        const originY = transform[5] ?? 0;

        const itemWidth =
            typeof item.width === 'number' ? (item.width as number) : 0;
        const itemHeight =
            typeof item.height === 'number'
                ? (item.height as number)
                : Math.abs(transform[3] ?? 0);

        const points = [
            viewport.convertToViewportPoint(originX, originY),
            viewport.convertToViewportPoint(originX + itemWidth, originY),
            viewport.convertToViewportPoint(originX, originY + itemHeight),
            viewport.convertToViewportPoint(
                originX + itemWidth,
                originY + itemHeight,
            ),
        ];

        const xs = points.map((point) => point[0] ?? 0);
        const ys = points.map((point) => point[1] ?? 0);

        const localMinX = Math.min(...xs);
        const localMaxX = Math.max(...xs);
        const localMinY = Math.min(...ys);
        const localMaxY = Math.max(...ys);

        if (
            !Number.isFinite(localMinX) ||
            !Number.isFinite(localMinY) ||
            !Number.isFinite(localMaxX) ||
            !Number.isFinite(localMaxY)
        ) {
            continue;
        }

        minX = Math.min(minX, localMinX);
        minY = Math.min(minY, localMinY);
        maxX = Math.max(maxX, localMaxX);
        maxY = Math.max(maxY, localMaxY);
    }

    if (
        !Number.isFinite(minX) ||
        !Number.isFinite(minY) ||
        !Number.isFinite(maxX) ||
        !Number.isFinite(maxY)
    ) {
        return null;
    }

    const paddingX = Math.min((maxX - minX) * 0.05, 32);
    const paddingY = Math.min((maxY - minY) * 0.05, 32);

    const left = clamp(minX - paddingX, 0, viewport.width);
    const right = clamp(viewport.width - (maxX + paddingX), 0, viewport.width);
    const top = clamp(minY - paddingY, 0, viewport.height);
    const bottom = clamp(
        viewport.height - (maxY + paddingY),
        0,
        viewport.height,
    );

    const contentWidth = viewport.width - left - right;
    const contentHeight = viewport.height - top - bottom;

    if (contentWidth <= 0 || contentHeight <= 0) {
        return null;
    }

    return {
        top,
        right,
        bottom,
        left, 
    };
}

async function computeSkeletonInsets(version: number) {
    if (!pdfInstance.value || !basePageWidth.value || !basePageHeight.value) {
        skeletonContentInsets.value = null;
        return;
    }

    const fallback = buildFallbackInsets(
        basePageWidth.value,
        basePageHeight.value,
    );

    try {
        const firstPage = await pdfInstance.value().getPage(1);
        if (renderVersion !== version) {
            return;
        }

        const viewport = firstPage.getViewport({ scale: 1 });
        const textContent = await firstPage.getTextContent();

        if (renderVersion !== version) {
            return;
        }

        const detectedInsets = extractInsetsFromTextContent(
            viewport,
            textContent,
        );

        skeletonContentInsets.value = detectedInsets
            ? {
                top: Math.max(detectedInsets.top, fallback.top),
                right: Math.max(detectedInsets.right, fallback.right),
                bottom: Math.max(detectedInsets.bottom, fallback.bottom),
                left: Math.max(detectedInsets.left, fallback.left),
            }
            : fallback;
    } catch (error) {
        if (renderVersion !== version) {
            return;
        }
        console.warn(
            'Failed to derive PDF content bounds, using fallback.',
            error,
        );
        skeletonContentInsets.value = fallback;
    }
}

function startDrag(e: MouseEvent) {
    if (!dragMode || !viewerContainer.value) {
        return;
    }
    isDragging.value = true;
    dragStart.value = {
        x: e.clientX,
        y: e.clientY,
    };
    e.preventDefault();
}

function onDrag(e: MouseEvent) {
    if (!dragMode || !isDragging.value || !viewerContainer.value) {
        return;
    }
    const dx = e.clientX - dragStart.value.x;
    const dy = e.clientY - dragStart.value.y;
    viewerContainer.value.scrollLeft -= dx;
    viewerContainer.value.scrollTop -= dy;
    dragStart.value = {
        x: e.clientX,
        y: e.clientY,
    };
}

function stopDrag() {
    if (dragMode) {
        isDragging.value = false;
    }
}

async function loadPdf() {
    if (!src || isLoadingPdf) {
        return;
    }

    isLoadingPdf = true;

    const version = ++renderVersion;
    isLoading.value = true;
    basePageWidth.value = null;
    basePageHeight.value = null;
    fitWidthScale.value = 1;
    lastContainerSize.value = null;
    skeletonContentInsets.value = null;

    cleanupAllPages();

    const loadingTask = pdfjsLib.getDocument({
        url: URL.createObjectURL(src),
        verbosity: pdfjsLib.VerbosityLevel.ERRORS,
        standardFontDataUrl: '/pdf/standard_fonts/',
        cMapUrl: '/pdf/cmaps/',
        cMapPacked: true,
        wasmUrl: '/pdf/wasm/',
        iccUrl: '/pdf/iccs/',
        useSystemFonts: false,
    });

    try {
        const pdfDoc = await loadingTask.promise;
        pdfInstance.value = () => pdfDoc;
        numPages.value = pdfDoc.numPages;
        currentPage.value = 1;
        emit('update:totalPages', pdfDoc.numPages);
        emit('update:currentPage', 1);
        pagesToRender.value = Array.from(
            { length: pdfDoc.numPages },
            (_, i) => i + 1,
        );
        await setBasePageWidth();
        void computeSkeletonInsets(version);
        await nextTick();
        computeFitWidthScale();
        await setupPagePlaceholders();
        updateVisibleRange();
        await renderVisiblePages();
    } catch (error) {
        console.error('Failed to load PDF with custom renderer:', error);
    } finally {
        isLoading.value = false;
        isLoadingPdf = false;
    }
}

async function setBasePageWidth() {
    if (!pdfInstance.value) {
        return;
    }
    const getInstance = pdfInstance.value;
    const firstPage = await getInstance().getPage(1);
    const viewport = firstPage.getViewport({ scale: 1 });
    basePageWidth.value = viewport.width;
    basePageHeight.value = viewport.height;
}

function computeFitWidthScale(): boolean {
    if (
        !viewerContainer.value ||
        !basePageWidth.value ||
        !basePageHeight.value
    ) {
        return false;
    }
    const container = viewerContainer.value;
    const mode = fitMode;
    const rawSize =
        mode === 'height' ? container.clientHeight : container.clientWidth;

    if (rawSize <= 0) {
        return false;
    }

    if (
        lastContainerSize.value !== null &&
        Math.abs(rawSize - lastContainerSize.value) < 1
    ) {
        return false;
    }

    lastContainerSize.value = rawSize;

    const baseDimension =
        mode === 'height'
            ? basePageHeight.value + BASE_MARGIN * 2
            : basePageWidth.value + BASE_MARGIN * 2;

    const newScale = rawSize / baseDimension;

    if (Math.abs(newScale - fitWidthScale.value) < 0.001) {
        return false;
    }

    fitWidthScale.value = newScale;
    return true;
}

function captureScrollSnapshot() {
    if (!viewerContainer.value) {
        return null;
    }

    const container = viewerContainer.value;
    const {
        scrollWidth, scrollHeight, 
    } = container;

    if (!scrollWidth || !scrollHeight) {
        return null;
    }

    return {
        width: scrollWidth,
        height: scrollHeight,
        centerX: container.scrollLeft + container.clientWidth / 2,
        centerY: container.scrollTop + container.clientHeight / 2,
    } as TScrollSnapshot;
}

function restoreScrollFromSnapshot(snapshot: TScrollSnapshot | null) {
    if (!snapshot || !viewerContainer.value) {
        return;
    }

    const container = viewerContainer.value;
    const newWidth = container.scrollWidth;
    const newHeight = container.scrollHeight;

    if (!newWidth || !newHeight || !snapshot.width || !snapshot.height) {
        return;
    }

    const targetLeft =
        (snapshot.centerX / snapshot.width) * newWidth -
        container.clientWidth / 2;
    const targetTop =
        (snapshot.centerY / snapshot.height) * newHeight -
        container.clientHeight / 2;

    container.scrollLeft = Math.max(0, targetLeft);
    container.scrollTop = Math.max(0, targetTop);
}

function cleanupAllPages() {
    for (const [
        , canvas,
    ] of pageCanvases) {
        cleanupCanvas(canvas);
    }
    pageCanvases.clear();
    renderedPages.clear();
    renderingPages.clear();

    for (const [
        , pdfPage,
    ] of pdfPageCache) {
        pdfPage.cleanup();
    }
    pdfPageCache.clear();

    if (pdfInstance.value) {
        try {
            const getDoc = pdfInstance.value;
            const doc = getDoc ? (getDoc() as TDestroyablePdf | null) : null;

            if (doc?.destroy && typeof doc.destroy === 'function') {
                void doc.destroy();
            } else if (doc?.cleanup && typeof doc.cleanup === 'function') {
                doc.cleanup();
            }
        } catch (error) {
            console.error('Failed to clean up PDF document:', error);
        } finally {
            pdfInstance.value = null;
        }
    }
}

function cleanupCanvas(canvas: HTMLCanvasElement) {
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
}

function cleanupPage(pageNumber: number) {
    const container = viewerContainer.value?.querySelector<HTMLElement>(
        `.page_container[data-page="${pageNumber}"]`,
    );
    const skeleton =
        container?.querySelector<HTMLElement>('.pdf-page-skeleton');
    const textLayerDiv = container?.querySelector<HTMLElement>('.text-layer');
    const annotationLayerDiv = container?.querySelector<HTMLElement>('.annotation-layer');

    const canvas = pageCanvases.get(pageNumber);
    if (canvas) {
        cleanupCanvas(canvas);
        pageCanvases.delete(pageNumber);
    }
    renderedPages.delete(pageNumber);

    if (skeleton) {
        skeleton.style.display = '';
    }

    if (textLayerDiv) {
        textLayerDiv.innerHTML = '';
    }

    if (annotationLayerDiv) {
        annotationLayerDiv.innerHTML = '';
    }

    const pdfPage = pdfPageCache.get(pageNumber);
    if (pdfPage) {
        pdfPage.cleanup();
        pdfPageCache.delete(pageNumber);
    }
}

function setupPagePlaceholders() {
    const getInstance = pdfInstance.value;
    if (!getInstance || !basePageWidth.value || !basePageHeight.value) {
        return;
    }

    const scale = zoom * fitWidthScale.value;
    const width = Math.floor(basePageWidth.value * scale);
    const height = Math.floor(basePageHeight.value * scale);

    const containers = document.querySelectorAll('.page_container');
    containers.forEach((container) => {
        const el = container as HTMLDivElement;
        el.style.width = `${width}px`;
        el.style.height = `${height}px`;
    });
}

function getVisiblePageRange(): {
    start: number;
    end: number 
} {
    if (!viewerContainer.value || numPages.value === 0) {
        return {
            start: 1,
            end: 1, 
        };
    }

    const container = viewerContainer.value;
    const containerRect = container.getBoundingClientRect();
    const scrollTop = container.scrollTop;
    const viewportTop = scrollTop;
    const viewportBottom = scrollTop + containerRect.height;

    const pageContainers = container.querySelectorAll('.page_container');
    let firstVisible = 1;
    let lastVisible = 1;
    let foundFirst = false;

    for (let i = 0; i < pageContainers.length; i++) {
        const pageEl = pageContainers[i] as HTMLElement;
        const pageTop = pageEl.offsetTop;
        const pageBottom = pageTop + pageEl.offsetHeight;

        const isVisible = pageBottom > viewportTop && pageTop < viewportBottom;

        if (isVisible) {
            if (!foundFirst) {
                firstVisible = i + 1;
                foundFirst = true;
            }
            lastVisible = i + 1;
        } else if (foundFirst) {
            break;
        }
    }

    return {
        start: firstVisible,
        end: lastVisible, 
    };
}

function getMostVisiblePage(): number {
    if (!viewerContainer.value || numPages.value === 0) {
        return 1;
    }

    const container = viewerContainer.value;
    const containerRect = container.getBoundingClientRect();
    const scrollTop = container.scrollTop;
    const viewportTop = scrollTop;
    const viewportBottom = scrollTop + containerRect.height;

    const pageContainers = container.querySelectorAll('.page_container');
    let mostVisiblePage = 1;
    let maxVisibleArea = 0;

    for (let i = 0; i < pageContainers.length; i++) {
        const pageEl = pageContainers[i] as HTMLElement;
        const pageTop = pageEl.offsetTop;
        const pageBottom = pageTop + pageEl.offsetHeight;

        const visibleTop = Math.max(pageTop, viewportTop);
        const visibleBottom = Math.min(pageBottom, viewportBottom);
        const visibleArea = Math.max(0, visibleBottom - visibleTop);

        if (visibleArea > maxVisibleArea) {
            maxVisibleArea = visibleArea;
            mostVisiblePage = i + 1;
        }

        if (pageTop > viewportBottom) {
            break;
        }
    }

    return mostVisiblePage;
}

function scrollToPage(pageNumber: number) {
    if (!viewerContainer.value || numPages.value === 0) {
        return;
    }

    const targetPage = Math.max(1, Math.min(pageNumber, numPages.value));
    const container = viewerContainer.value;
    const pageContainers = container.querySelectorAll('.page_container');
    const targetEl = pageContainers[targetPage - 1] as HTMLElement | undefined;

    if (targetEl) {
        const scale = zoom * fitWidthScale.value;
        const margin = Math.floor(BASE_MARGIN * scale);
        container.scrollTop = targetEl.offsetTop - margin;
        currentPage.value = targetPage;
        emit('update:currentPage', targetPage);

        queueMicrotask(() => {
            if (!viewerContainer.value || isLoading.value) {
                return;
            }
            updateVisibleRange();
            void renderVisiblePages();
        });
    }
}

async function renderVisiblePages() {
    const getInstance = pdfInstance.value;
    const containerRoot = viewerContainer.value;
    if (!getInstance || !containerRoot) {
        return;
    }

    const {
        start, end,
    } = getVisiblePageRange();
    const buffer = bufferPages;

    const renderStart = Math.max(1, start - buffer);
    const renderEnd = Math.min(numPages.value, end + buffer);

    const pagesToKeep = new Set<number>();
    for (let i = renderStart; i <= renderEnd; i++) {
        pagesToKeep.add(i);
    }

    const pagesToCleanup: number[] = [];
    for (const pageNum of renderedPages) {
        if (!pagesToKeep.has(pageNum)) {
            pagesToCleanup.push(pageNum);
        }
    }
    pagesToCleanup.forEach((pageNum) => cleanupPage(pageNum));

    const pagesToRenderNow: number[] = [];
    for (let i = renderStart; i <= renderEnd; i++) {
        if (!renderedPages.has(i)) {
            pagesToRenderNow.push(i);
        }
    }

    if (pagesToRenderNow.length === 0) {
        return;
    }

    const scale = zoom * fitWidthScale.value;
    const outputScale = devicePixelRatio;
    const containers =
        containerRoot.querySelectorAll<HTMLDivElement>('.page_container');

    const CONCURRENT_RENDERS = 3;

    for (let i = 0; i < pagesToRenderNow.length; i += CONCURRENT_RENDERS) {
        const batch = pagesToRenderNow.slice(i, i + CONCURRENT_RENDERS);

        await Promise.all(
            batch.map(async (pageNumber) => {
                if (renderedPages.has(pageNumber) || renderingPages.has(pageNumber)) {
                    return;
                }

                renderingPages.add(pageNumber);

                try {
                    const containerIndex = pageNumber - 1;
                    const container = containers[containerIndex];
                    if (!container) {
                        return;
                    }

                    const canvasHost =
                        container.querySelector<HTMLDivElement>('.page_canvas');
                    if (!canvasHost) {
                        return;
                    }

                    let pdfPage = pdfPageCache.get(pageNumber);
                    if (!pdfPage) {
                        pdfPage = await getInstance().getPage(pageNumber);
                        pdfPageCache.set(pageNumber, pdfPage);
                    }

                    const viewport = pdfPage.getViewport({ scale });
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');
                    if (!context) {
                        return;
                    }

                    canvas.width = Math.floor(viewport.width * outputScale);
                    canvas.height = Math.floor(viewport.height * outputScale);
                    canvas.style.width = `${viewport.width}px`;
                    canvas.style.height = `${viewport.height}px`;
                    canvas.style.display = 'block';
                    canvas.style.margin = '0';

                    const transform =
                        outputScale !== 1
                            ? [
                                outputScale,
                                0,
                                0,
                                outputScale,
                                0,
                                0,
                            ]
                            : undefined;

                    const renderContext = {
                        canvasContext: context,
                        canvas,
                        transform,
                        viewport,
                    };

                    // Render to off-screen canvas first
                    await pdfPage.render(renderContext).promise;

                    // Only append after render is complete - prevents flash
                    canvasHost.innerHTML = '';
                    canvasHost.appendChild(canvas);

                    // Hide skeleton immediately after canvas is ready
                    const skeleton =
                        container.querySelector<HTMLElement>('.pdf-page-skeleton');
                    if (skeleton) {
                        skeleton.style.display = 'none';
                    }

                    const textLayerDiv =
                        container.querySelector<HTMLElement>('.text-layer');
                    if (textLayerDiv) {
                        textLayerDiv.innerHTML = '';
                        textLayerDiv.style.setProperty('--scale-factor', String(scale));
                        textLayerDiv.style.setProperty('--total-scale-factor', String(scale));
                        const textContent = await pdfPage.getTextContent({
                            includeMarkedContent: true,
                            disableNormalization: true,
                        });
                        const textLayer = new TextLayer({
                            textContentSource: textContent,
                            container: textLayerDiv,
                            viewport,
                        });
                        await textLayer.render();
                        setupTextLayer(textLayerDiv);

                        const pageIndex = pageNumber - 1;

                        if (searchPageMatches && searchPageMatches.size > 0) {
                            const pageMatchData = searchPageMatches.get(pageIndex) ?? null;
                            highlightPage(textLayerDiv, pageMatchData, currentSearchMatch ?? null);
                        }

                        if (pendingScrollToMatchPageIndex === pageIndex) {
                            scrollToCurrentMatch();
                        }
                    }

                    const annotationLayerDiv =
                        container.querySelector<HTMLElement>('.annotation-layer');
                    if (annotationLayerDiv && showAnnotations) {
                        annotationLayerDiv.innerHTML = '';
                        const annotations = await pdfPage.getAnnotations();
                        if (annotations.length > 0) {
                            const simpleLinkService = {
                                pagesCount: numPages.value,
                                page: currentPage.value,
                                rotation: 0,
                                isInPresentationMode: false,
                                externalLinkEnabled: true,
                                goToDestination: async () => {},
                                goToPage: (page: number) => scrollToPage(page),
                                goToXY: () => {},
                                addLinkAttributes: (
                                    link: HTMLAnchorElement,
                                    url: string,
                                    newWindow?: boolean,
                                ) => {
                                    link.href = url;
                                    if (newWindow) {
                                        link.target = '_blank';
                                        link.rel = 'noopener noreferrer';
                                    }
                                },
                                getDestinationHash: () => '#',
                                getAnchorUrl: () => '#',
                                setHash: () => {},
                                executeNamedAction: () => {},
                                executeSetOCGState: () => {},
                            } as unknown as IPDFLinkService;
                            const annotationLayer = new AnnotationLayer({
                                div: annotationLayerDiv as HTMLDivElement,
                                page: pdfPage,
                                viewport,
                                accessibilityManager: null,
                                annotationCanvasMap: null,
                                annotationEditorUIManager: null,
                                structTreeLayer: null,
                                commentManager: null,
                                linkService: simpleLinkService,
                                annotationStorage: null,
                            });
                            await annotationLayer.render({
                                annotations,
                                viewport,
                                div: annotationLayerDiv as HTMLDivElement,
                                page: pdfPage,
                                linkService: simpleLinkService,
                                renderForms: false,
                            });
                        }
                    }

                    renderedPages.add(pageNumber);
                    pageCanvases.set(pageNumber, canvas);
                } finally {
                    renderingPages.delete(pageNumber);
                }
            }),
        );
    }
}

async function reRenderAllVisiblePages() {
    const version = ++renderVersion;
    const snapshot = captureScrollSnapshot();

    await renderMutex.acquire();

    try {
        if (renderVersion !== version) {
            return;
        }

        for (const pageNum of renderedPages) {
            cleanupPage(pageNum);
        }

        await setupPagePlaceholders();

        if (renderVersion === version) {
            restoreScrollFromSnapshot(snapshot);
        }

        await renderVisiblePages();
    } finally {
        renderMutex.release();
    }
}

const debouncedRenderOnScroll = useDebounceFn(() => {
    if (isLoading.value || !pdfInstance.value) {
        return;
    }
    void renderVisiblePages();
}, 100);

function handleScroll() {
    if (isLoading.value) {
        return;
    }
    updateVisibleRange();
    debouncedRenderOnScroll();
    updateCurrentPage();
}

function updateVisibleRange() {
    const range = getVisiblePageRange();
    visibleRange.value = range;
}

function updateCurrentPage() {
    const page = getMostVisiblePage();
    if (page !== currentPage.value) {
        currentPage.value = page;
        emit('update:currentPage', page);
    }
}

const debouncedRenderOnResize = useDebounceFn(() => {
    if (isLoading.value || !pdfInstance.value) {
        return;
    }
    void reRenderAllVisiblePages();
}, 200);

function handleResize() {
    if (isLoading.value || isResizing) {
        return;
    }
    const updated = computeFitWidthScale();
    if (updated && pdfInstance.value) {
        debouncedRenderOnResize();
    }
}

useResizeObserver(viewerContainer, handleResize);

onMounted(() => {
    loadPdf();

    if (viewerContainer.value) {
        viewerContainer.value.addEventListener('scroll', handleScroll, {passive: true});
    }
});

onUnmounted(() => {
    if (viewerContainer.value) {
        viewerContainer.value.removeEventListener('scroll', handleScroll);
    }
    cleanupAllPages();
});

watch(
    () => fitMode,
    async () => {
        const pageToSnapTo = fitMode === 'height' ? getMostVisiblePage() : null;
        const updated = computeFitWidthScale();
        if (updated && pdfInstance.value) {
            await reRenderAllVisiblePages();
            if (pageToSnapTo !== null) {
                await nextTick();
                scrollToPage(pageToSnapTo);
            }
        }
    },
);

watch(
    () => src,
    () => {
        loadPdf();
    },
);

watch(
    () => zoom,
    () => {
        if (pdfInstance.value) {
            void reRenderAllVisiblePages();
        }
    },
);

watch(
    () => isResizing,
    async (value) => {
        if (!value && pdfInstance.value && !isLoading.value) {
            await nextTick();
            await new Promise((r) => setTimeout(r, 20));
            computeFitWidthScale();
            void reRenderAllVisiblePages();
        }
    },
);

const isEffectivelyLoading = computed(() => !!src && isLoading.value);

watch(
    isEffectivelyLoading,
    async (value, oldValue) => {
        if (oldValue === true && value === false) {
            await nextTick();
        }
        emit('update:loading', value);
    },
    { immediate: true },
);

function getPdfDocument() {
    return pdfInstance.value ? pdfInstance.value() : null;
}

async function saveDocument(): Promise<Uint8Array | null> {
    if (!pdfInstance.value) {
        return null;
    }
    const doc = pdfInstance.value();
    return doc.saveDocument();
}

function applySearchHighlights() {
    if (!viewerContainer.value) {
        return;
    }

    const pageContainers = viewerContainer.value.querySelectorAll<HTMLElement>('.page_container');

    pageContainers.forEach((container, index) => {
        const pageIndex = index;
        const textLayerDiv = container.querySelector<HTMLElement>('.text-layer');

        if (!textLayerDiv) {
            return;
        }

        if (!searchPageMatches || searchPageMatches.size === 0) {
            clearHighlights(textLayerDiv);
            return;
        }

        const pageMatches = searchPageMatches.get(pageIndex) ?? null;
        highlightPage(textLayerDiv, pageMatches, currentSearchMatch ?? null);
    });
}

function scrollToCurrentMatch() {
    if (!viewerContainer.value || !currentSearchMatch) {
        return false;
    }

    const pageIndex = currentSearchMatch.pageIndex;
    const pageContainers = viewerContainer.value.querySelectorAll<HTMLElement>('.page_container');
    const targetContainer = pageContainers[pageIndex];

    if (!targetContainer) {
        return false;
    }

    const textLayerDiv = targetContainer.querySelector<HTMLElement>('.text-layer');
    if (!textLayerDiv) {
        return false;
    }

    const currentHighlight = textLayerDiv.querySelector<HTMLElement>('.pdf-search-highlight--current');
    if (currentHighlight) {
        pendingScrollToMatchPageIndex = null;
        scrollToHighlight(currentHighlight, viewerContainer.value);
        return true;
    }

    return false;
}

watch(
    () => [
        searchPageMatches,
        currentSearchMatch,
    ] as const,
    () => {
        if (isLoading.value) {
            return;
        }
        pendingScrollToMatchPageIndex = currentSearchMatch
            ? currentSearchMatch.pageIndex
            : null;
        applySearchHighlights();
        nextTick(() => {
            scrollToCurrentMatch();
        });
    },
    { deep: true },
);

defineExpose({
    scrollToPage,
    getPdfDocument,
    saveDocument,
    applySearchHighlights,
    scrollToCurrentMatch,
});
</script>

<style scoped>
.pdf-viewer-container {
    position: relative;
    height: 100%;
    width: 100%;
}

.pdf-loader {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    justify-content: center;
    align-items: center;
    background: var(--color-surface-muted);
}

.pdf-loader__skeleton {
    width: 64px;
    height: 64px;
    border-radius: 8px;
}

.pdfViewer {
    width: 100%;
    height: 100%;
    overflow: auto;
    background: var(--color-surface-muted);
    display: flex;
    flex-direction: column;
    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);

    &::-webkit-scrollbar {
        width: 0.5rem;
        height: 0.5rem;
    }

    &::-webkit-scrollbar-track {
        background: var(--scrollbar-track);
        border-radius: 0.4rem;
        border: none;
    }

    &::-webkit-scrollbar-thumb {
        background: var(--scrollbar-thumb);
        border-radius: 0.4rem;
        border: none;
    }

    &::-webkit-scrollbar-thumb:hover {
        background: var(--scrollbar-thumb-hover);
    }
}

.pdfViewer--fit-height {
    overflow-x: auto;
}

.pdfViewer--hidden {
    opacity: 0;
    pointer-events: none;
}

.pdfViewer.drag-mode.is-dragging {
    cursor: grabbing;
    user-select: none;
}

.pdfViewer.drag-mode:not(.is-dragging) {
    cursor: grab;
}

.page_container {
    position: relative;
    margin: 0 auto;
    flex-shrink: 0;
    content-visibility: auto;
    contain-intrinsic-size: auto 800px;
}

.page_container canvas {
    background: var(--pdf-page-bg);
    box-shadow: var(--pdf-page-shadow);
    border-radius: 2px;
}

.page_canvas {
    position: relative;
    width: 100%;
    height: 100%;
    z-index: 0;
}

.text-layer {
    position: absolute;
    text-align: initial;
    inset: 0;
    overflow: clip;
    opacity: 1;
    line-height: 1;
    -webkit-text-size-adjust: none;
    -moz-text-size-adjust: none;
    text-size-adjust: none;
    forced-color-adjust: none;
    transform-origin: 0 0;
    caret-color: CanvasText;
    z-index: 0;
    pointer-events: auto;
    user-select: text;

    /* We multiply the font size by --min-font-size, and then scale the text
     * elements by 1/--min-font-size. This allows us to effectively ignore the
     * minimum font size enforced by the browser, so that the text layer <span>s
     * can always match the size of the text in the canvas. */
    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor, 1) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
}

.text-layer :deep(span),
.text-layer :deep(br) {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
}

.text-layer :deep(> span),
.text-layer :deep(.markedContent span) {
    z-index: 1;
    font-size: calc(var(--text-scale-factor) * var(--font-height, 10px));
    transform: rotate(var(--rotate, 0deg)) scaleX(var(--scale-x, 1)) scale(var(--min-font-size-inv));
}

.text-layer :deep(.markedContent) {
    display: contents;
}

.text-layer :deep(br) {
    user-select: none;
}

.text-layer :deep(::selection) {
    background: rgb(0 0 255 / 0.25);
}

.text-layer :deep(br::selection) {
    background: transparent;
}

.text-layer :deep(.pdf-search-highlight) {
    background-color: rgb(255 230 0 / 0.5);
    color: transparent;
    border-radius: 2px;
    padding: 0;
    margin: 0;
}

.text-layer :deep(.pdf-search-highlight--current) {
    background-color: rgb(255 150 0 / 0.7);
    outline: 2px solid rgb(255 100 0 / 0.8);
    outline-offset: 0;
}

.text-layer :deep(.end-of-content) {
    display: block;
    position: absolute;
    inset: 100% 0 0;
    z-index: 0;
    cursor: default;
    user-select: none;
}

.text-layer.selecting :deep(.end-of-content) {
    top: 0;
}

.annotation-layer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    z-index: 2;
    pointer-events: none;
}

.annotation-layer :deep(a) {
    pointer-events: auto;
}

.annotation-layer :deep(section) {
    position: absolute;
}

.annotation-layer :deep(a) {
    display: block;
    position: absolute;
}

.annotation-layer :deep(.linkAnnotation > a) {
    background: rgb(255 255 0 / 0);
    transition: background 150ms ease;
}

.annotation-layer :deep(.linkAnnotation > a:hover) {
    background: rgb(255 255 0 / 0.2);
}

.pdf-viewer-container--dark .text-layer :deep(::selection) {
    background: rgb(255 200 0 / 0.35);
}

.pdf-viewer-container--dark .text-layer :deep(.pdf-search-highlight) {
    background-color: rgb(255 230 0 / 0.6);
}

.pdf-viewer-container--dark .text-layer :deep(.pdf-search-highlight--current) {
    background-color: rgb(255 150 0 / 0.8);
    outline: 2px solid rgb(255 100 0 / 0.9);
}

.pdf-viewer-container--dark .page_container,
.pdf-viewer-container--dark .page_container canvas {
    filter: invert(1) hue-rotate(180deg) saturate(1.05);
}

.pdf-viewer-container--dark .pdfViewer {
    background: var(--color-neutral-900);
}
</style>

<style>
.page {
    margin: 1px auto -3px !important;
    border: 1px dashed transparent !important;
    box-shadow: var(--pdf-page-shadow);
    box-sizing: content-box;
    user-select: none;
}
</style>
