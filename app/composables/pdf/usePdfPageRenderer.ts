import { Mutex } from 'es-toolkit';
import {
    AnnotationLayer,
    TextLayer,
} from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { IPDFLinkService } from 'pdfjs-dist/types/web/interfaces';
import {
    nextTick,
    ref,
    watch,
    type Ref,
} from 'vue';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    TScrollSnapshot,
} from '../../types/pdf';

type TPageRange = {
    start: number;
    end: number;
};

type TUsePdfPageRendererOptions = {
    container: Ref<HTMLElement | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    bufferPages: Ref<number>;
    effectiveScale: Ref<number>;
    basePageWidth: Ref<number | null>;
    basePageHeight: Ref<number | null>;
    showAnnotations: Ref<boolean>;
    isLoading: Ref<boolean>;
    outputScale?: number;

    getPage: (pageNumber: number) => Promise<PDFPageProxy>;
    evictPage: (pageNumber: number) => void;
    cleanupPageCache: () => void;

    onGoToPage: (pageNumber: number) => void;
    setupTextLayer: (textLayerDiv: HTMLElement) => void | (() => void);

    searchPageMatches: Ref<Map<number, IPdfPageMatches> | undefined>;
    currentSearchMatch: Ref<IPdfSearchMatch | null>;
    clearHighlights: (container: HTMLElement) => void;
    highlightPage: (
        textLayerDiv: HTMLElement,
        pageMatches: IPdfPageMatches | null,
        currentMatch: IPdfSearchMatch | null,
    ) => void;
    scrollToHighlight: (element: HTMLElement, container: HTMLElement) => void;
};

const CONCURRENT_RENDERS = 3;

export const usePdfPageRenderer = (options: TUsePdfPageRendererOptions) => {
    const renderMutex = new Mutex();
    let renderVersion = 0;

    const renderedPages = new Set<number>();
    const renderingPages = new Map<number, number>();
    const pageCanvases = new Map<number, HTMLCanvasElement>();
    const textLayerCleanupFns = new Map<number, () => void>();

    const pendingScrollToMatchPageIndex = ref<number | null>(null);

    const outputScale = options.outputScale
        ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

    function bumpRenderVersion() {
        renderVersion += 1;
        return renderVersion;
    }

    function captureScrollSnapshot(): TScrollSnapshot | null {
        const container = options.container.value;
        if (!container) {
            return null;
        }

        const {
            scrollWidth,
            scrollHeight,
        } = container;

        if (!scrollWidth || !scrollHeight) {
            return null;
        }

        return {
            width: scrollWidth,
            height: scrollHeight,
            centerX: container.scrollLeft + container.clientWidth / 2,
            centerY: container.scrollTop + container.clientHeight / 2,
        };
    }

    function restoreScrollFromSnapshot(snapshot: TScrollSnapshot | null) {
        if (!snapshot) {
            return;
        }

        const container = options.container.value;
        if (!container) {
            return;
        }

        const newWidth = container.scrollWidth;
        const newHeight = container.scrollHeight;

        if (!newWidth || !newHeight || !snapshot.width || !snapshot.height) {
            return;
        }

        const targetLeft = (snapshot.centerX / snapshot.width) * newWidth - container.clientWidth / 2;
        const targetTop = (snapshot.centerY / snapshot.height) * newHeight - container.clientHeight / 2;

        container.scrollLeft = Math.max(0, targetLeft);
        container.scrollTop = Math.max(0, targetTop);
    }

    function cleanupCanvas(canvas: HTMLCanvasElement) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
    }

    function cleanupTextLayer(pageNumber: number) {
        const cleanup = textLayerCleanupFns.get(pageNumber);
        if (cleanup) {
            cleanup();
            textLayerCleanupFns.delete(pageNumber);
        }
    }

    function cleanupPage(pageNumber: number) {
        const containerRoot = options.container.value;

        cleanupTextLayer(pageNumber);

        const canvas = pageCanvases.get(pageNumber);
        if (canvas) {
            cleanupCanvas(canvas);
            pageCanvases.delete(pageNumber);
        }

        renderedPages.delete(pageNumber);
        renderingPages.delete(pageNumber);

        if (containerRoot) {
            const container = containerRoot.querySelector<HTMLElement>(
                `.page_container[data-page="${pageNumber}"]`,
            );
            const skeleton = container?.querySelector<HTMLElement>('.pdf-page-skeleton');
            const canvasHost = container?.querySelector<HTMLDivElement>('.page_canvas');
            const textLayerDiv = container?.querySelector<HTMLElement>('.text-layer');
            const annotationLayerDiv = container?.querySelector<HTMLElement>('.annotation-layer');

            if (canvasHost) {
                canvasHost.innerHTML = '';
            }

            if (skeleton) {
                skeleton.style.display = '';
            }

            if (textLayerDiv) {
                textLayerDiv.innerHTML = '';
            }

            if (annotationLayerDiv) {
                annotationLayerDiv.innerHTML = '';
            }
        }

        try {
            options.evictPage(pageNumber);
        } catch (error) {
            console.error('Failed to evict cached PDF page:', error);
        }
    }

    function setupPagePlaceholders() {
        const containerRoot = options.container.value;
        if (
            !containerRoot
            || !options.basePageWidth.value
            || !options.basePageHeight.value
        ) {
            return;
        }

        const scale = options.effectiveScale.value;
        const width = Math.floor(options.basePageWidth.value * scale);
        const height = Math.floor(options.basePageHeight.value * scale);

        const containers = containerRoot.querySelectorAll<HTMLDivElement>('.page_container');
        containers.forEach((container) => {
            container.style.width = `${width}px`;
            container.style.height = `${height}px`;
        });
    }

    async function renderVisiblePages(visibleRange: TPageRange) {
        const getPage = options.getPage;
        const containerRoot = options.container.value;

        if (!containerRoot || !getPage || options.numPages.value === 0) {
            return;
        }

        const version = renderVersion;
        const buffer = options.bufferPages.value;

        const renderStart = Math.max(1, visibleRange.start - buffer);
        const renderEnd = Math.min(options.numPages.value, visibleRange.end + buffer);

        const pagesToKeep = new Set<number>();
        for (let i = renderStart; i <= renderEnd; i++) {
            pagesToKeep.add(i);
        }

        for (const pageNum of renderedPages) {
            if (!pagesToKeep.has(pageNum)) {
                cleanupPage(pageNum);
            }
        }

        const pagesToRenderNow: number[] = [];
        for (let i = renderStart; i <= renderEnd; i++) {
            if (!renderedPages.has(i)) {
                pagesToRenderNow.push(i);
            }
        }

        if (pagesToRenderNow.length === 0) {
            return;
        }

        const scale = options.effectiveScale.value;
        const containers = containerRoot.querySelectorAll<HTMLDivElement>('.page_container');

        for (let i = 0; i < pagesToRenderNow.length; i += CONCURRENT_RENDERS) {
            const batch = pagesToRenderNow.slice(i, i + CONCURRENT_RENDERS);

            await Promise.all(
                batch.map(async (pageNumber) => {
                    if (renderVersion !== version) {
                        return;
                    }

                    if (renderedPages.has(pageNumber)) {
                        return;
                    }

                    const alreadyRenderingVersion = renderingPages.get(pageNumber);
                    if (alreadyRenderingVersion === version) {
                        return;
                    }

                    renderingPages.set(pageNumber, version);

                    try {
                        const containerIndex = pageNumber - 1;
                        const container = containers[containerIndex];
                        if (!container) {
                            return;
                        }

                        const canvasHost = container.querySelector<HTMLDivElement>('.page_canvas');
                        if (!canvasHost) {
                            return;
                        }

                        const pdfPage = await getPage(pageNumber);
                        if (renderVersion !== version) {
                            return;
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

                        const transform = outputScale !== 1
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

                        await pdfPage.render(renderContext).promise;

                        if (renderVersion !== version) {
                            cleanupCanvas(canvas);
                            return;
                        }

                        canvasHost.innerHTML = '';
                        canvasHost.appendChild(canvas);
                        pageCanvases.set(pageNumber, canvas);

                        const skeleton = container.querySelector<HTMLElement>('.pdf-page-skeleton');
                        if (skeleton) {
                            skeleton.style.display = 'none';
                        }

                        const textLayerDiv = container.querySelector<HTMLElement>('.text-layer');
                        if (textLayerDiv) {
                            cleanupTextLayer(pageNumber);
                            textLayerDiv.innerHTML = '';
                            textLayerDiv.style.setProperty('--scale-factor', String(scale));
                            textLayerDiv.style.setProperty('--total-scale-factor', String(scale));

                            const textContent = await pdfPage.getTextContent({
                                includeMarkedContent: true,
                                disableNormalization: true,
                            });

                            if (renderVersion !== version) {
                                if (renderingPages.get(pageNumber) === version) {
                                    cleanupPage(pageNumber);
                                }
                                return;
                            }

                            const textLayer = new TextLayer({
                                textContentSource: textContent,
                                container: textLayerDiv,
                                viewport,
                            });
                            await textLayer.render();

                            if (renderVersion !== version) {
                                if (renderingPages.get(pageNumber) === version) {
                                    cleanupPage(pageNumber);
                                }
                                return;
                            }

                            const cleanup = options.setupTextLayer(textLayerDiv);
                            if (typeof cleanup === 'function') {
                                textLayerCleanupFns.set(pageNumber, cleanup);
                            }

                            const pageIndex = pageNumber - 1;

                            if (options.searchPageMatches.value && options.searchPageMatches.value.size > 0) {
                                const pageMatchData = options.searchPageMatches.value.get(pageIndex) ?? null;
                                options.highlightPage(
                                    textLayerDiv,
                                    pageMatchData,
                                    options.currentSearchMatch.value ?? null,
                                );
                            }

                            if (pendingScrollToMatchPageIndex.value === pageIndex) {
                                scrollToCurrentMatch();
                            }
                        }

                        const annotationLayerDiv = container.querySelector<HTMLElement>('.annotation-layer');
                        if (annotationLayerDiv && options.showAnnotations.value) {
                            annotationLayerDiv.innerHTML = '';

                            const annotations = await pdfPage.getAnnotations();

                            if (renderVersion !== version) {
                                if (renderingPages.get(pageNumber) === version) {
                                    cleanupPage(pageNumber);
                                }
                                return;
                            }

                            if (annotations.length > 0) {
                                const simpleLinkService = {
                                    pagesCount: options.numPages.value,
                                    page: options.currentPage.value,
                                    rotation: 0,
                                    isInPresentationMode: false,
                                    externalLinkEnabled: true,
                                    goToDestination: async () => {},
                                    goToPage: (page: number) => options.onGoToPage(page),
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

                        if (renderVersion === version) {
                            renderedPages.add(pageNumber);
                        }
                    } catch (error) {
                        console.error('Failed to render PDF page:', pageNumber, error);
                        if (renderingPages.get(pageNumber) === version) {
                            cleanupPage(pageNumber);
                        }
                    } finally {
                        if (renderingPages.get(pageNumber) === version) {
                            renderingPages.delete(pageNumber);
                        }
                    }
                }),
            );
        }
    }

    async function reRenderAllVisiblePages(getVisibleRange: () => TPageRange) {
        const version = bumpRenderVersion();
        const snapshot = captureScrollSnapshot();

        await renderMutex.acquire();

        try {
            if (renderVersion !== version) {
                return;
            }

            const pagesToCleanup = new Set<number>();
            renderedPages.forEach((page) => pagesToCleanup.add(page));
            renderingPages.forEach((_, page) => pagesToCleanup.add(page));
            pageCanvases.forEach((_, page) => pagesToCleanup.add(page));
            textLayerCleanupFns.forEach((_, page) => pagesToCleanup.add(page));

            pagesToCleanup.forEach((page) => cleanupPage(page));

            setupPagePlaceholders();

            if (renderVersion === version) {
                restoreScrollFromSnapshot(snapshot);
            }

            if (renderVersion !== version) {
                return;
            }

            const range = getVisibleRange();
            await renderVisiblePages(range);
        } finally {
            renderMutex.release();
        }
    }

    function cleanupAllPages() {
        bumpRenderVersion();

        const pagesToCleanup = new Set<number>();
        renderedPages.forEach((page) => pagesToCleanup.add(page));
        renderingPages.forEach((_, page) => pagesToCleanup.add(page));
        pageCanvases.forEach((_, page) => pagesToCleanup.add(page));
        textLayerCleanupFns.forEach((_, page) => pagesToCleanup.add(page));

        pagesToCleanup.forEach((page) => cleanupPage(page));

        for (const [
            , canvas,
        ] of pageCanvases) {
            cleanupCanvas(canvas);
        }

        pageCanvases.clear();
        renderedPages.clear();
        renderingPages.clear();
        textLayerCleanupFns.clear();

        pendingScrollToMatchPageIndex.value = null;

        try {
            options.cleanupPageCache();
        } catch (error) {
            console.error('Failed to clean up PDF page cache:', error);
        }
    }

    function applySearchHighlights() {
        const containerRoot = options.container.value;
        if (!containerRoot) {
            return;
        }

        const pageContainers = containerRoot.querySelectorAll<HTMLElement>('.page_container');

        pageContainers.forEach((container, index) => {
            const pageIndex = index;
            const textLayerDiv = container.querySelector<HTMLElement>('.text-layer');

            if (!textLayerDiv) {
                return;
            }

            if (!options.searchPageMatches.value || options.searchPageMatches.value.size === 0) {
                options.clearHighlights(textLayerDiv);
                return;
            }

            const pageMatches = options.searchPageMatches.value.get(pageIndex) ?? null;
            options.highlightPage(textLayerDiv, pageMatches, options.currentSearchMatch.value ?? null);
        });
    }

    function scrollToCurrentMatch() {
        const containerRoot = options.container.value;
        if (!containerRoot || !options.currentSearchMatch.value) {
            return false;
        }

        const pageIndex = options.currentSearchMatch.value.pageIndex;
        const pageContainers = containerRoot.querySelectorAll<HTMLElement>('.page_container');
        const targetContainer = pageContainers[pageIndex];

        if (!targetContainer) {
            return false;
        }

        const textLayerDiv = targetContainer.querySelector<HTMLElement>('.text-layer');
        if (!textLayerDiv) {
            return false;
        }

        const currentHighlight = textLayerDiv.querySelector<HTMLElement>('.pdf-search-highlight--current');
        if (!currentHighlight) {
            return false;
        }

        pendingScrollToMatchPageIndex.value = null;
        options.scrollToHighlight(currentHighlight, containerRoot);
        return true;
    }

    watch(
        () => [
            options.searchPageMatches.value,
            options.currentSearchMatch.value,
        ] as const,
        () => {
            if (options.isLoading.value) {
                return;
            }

            pendingScrollToMatchPageIndex.value = options.currentSearchMatch.value
                ? options.currentSearchMatch.value.pageIndex
                : null;

            applySearchHighlights();

            nextTick(() => {
                scrollToCurrentMatch();
            });
        },
        { deep: true },
    );

    return {
        setupPagePlaceholders,
        renderVisiblePages,
        reRenderAllVisiblePages,
        cleanupAllPages,
        applySearchHighlights,
        scrollToCurrentMatch,
        bumpRenderVersion,
    };
};
