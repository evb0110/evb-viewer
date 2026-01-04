import { Mutex } from 'es-toolkit';
import {
    AnnotationLayer,
    TextLayer,
} from 'pdfjs-dist';
import type { IPDFLinkService } from 'pdfjs-dist/types/web/interfaces';
import {
    nextTick,
    ref,
    toValue,
    watch,
    type MaybeRefOrGetter,
    type Ref,
} from 'vue';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    IScrollSnapshot,
} from 'app/types/pdf';
import { chunk } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import { usePdfSearchHighlight } from 'app/composables/usePdfSearchHighlight';
import { useTextLayerSelection } from 'app/composables/useTextLayerSelection';
import type { usePdfDocument } from 'app/composables/pdf/usePdfDocument';

interface IPageRange {
    start: number;
    end: number;
}

interface IUsePdfPageRendererOptions {
    container: Ref<HTMLElement | null>;
    document: ReturnType<typeof usePdfDocument>;
    currentPage: Ref<number>;
    effectiveScale: MaybeRefOrGetter<number>;

    bufferPages?: MaybeRefOrGetter<number>;
    showAnnotations?: MaybeRefOrGetter<boolean>;
    scrollToPage?: (pageNumber: number) => void;
    outputScale?: number;

    searchPageMatches?: MaybeRefOrGetter<Map<number, IPdfPageMatches>>;
    currentSearchMatch?: MaybeRefOrGetter<IPdfSearchMatch | null>;
}

const CONCURRENT_RENDERS = 3;

export const usePdfPageRenderer = (options: IUsePdfPageRendererOptions) => {
    const { setupTextLayer } = useTextLayerSelection();
    const {
        clearHighlights,
        highlightPage,
        scrollToHighlight,
    } = usePdfSearchHighlight();

    const {
        numPages,
        basePageWidth,
        basePageHeight,
        isLoading,
        getPage,
        evictPage,
        cleanupPageCache,
    } = options.document;

    const bufferPages = options.bufferPages ?? 2;
    const showAnnotations = options.showAnnotations ?? true;
    const searchPageMatches = options.searchPageMatches ?? new Map<number, IPdfPageMatches>();
    const currentSearchMatch = options.currentSearchMatch ?? null;

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

    function captureScrollSnapshot(): IScrollSnapshot | null {
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

    function restoreScrollFromSnapshot(snapshot: IScrollSnapshot | null) {
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
            evictPage(pageNumber);
        } catch (error) {
            console.error('Failed to evict cached PDF page:', error);
        }
    }

    function setupPagePlaceholders() {
        const containerRoot = options.container.value;
        const baseWidth = toValue(basePageWidth);
        const baseHeight = toValue(basePageHeight);
        if (!containerRoot || !baseWidth || !baseHeight) {
            return;
        }

        const scale = toValue(options.effectiveScale);
        const width = Math.floor(baseWidth * scale);
        const height = Math.floor(baseHeight * scale);

        const containers = containerRoot.querySelectorAll<HTMLDivElement>('.page_container');
        containers.forEach((container) => {
            container.style.width = `${width}px`;
            container.style.height = `${height}px`;
        });
    }

    async function renderVisiblePages(visibleRange: IPageRange) {
        const containerRoot = options.container.value;

        if (!containerRoot || numPages.value === 0) {
            return;
        }

        const version = renderVersion;
        const buffer = toValue(bufferPages);

        const renderStart = Math.max(1, visibleRange.start - buffer);
        const renderEnd = Math.min(numPages.value, visibleRange.end + buffer);

        const pagesToKeep = new Set(range(renderStart, renderEnd + 1));

        for (const pageNum of renderedPages) {
            if (!pagesToKeep.has(pageNum)) {
                cleanupPage(pageNum);
            }
        }

        const pagesToRenderNow = range(renderStart, renderEnd + 1).filter(
            i => !renderedPages.has(i),
        );

        if (pagesToRenderNow.length === 0) {
            return;
        }

        const scale = toValue(options.effectiveScale);
        const containers = containerRoot.querySelectorAll<HTMLDivElement>('.page_container');

        for (const batch of chunk(pagesToRenderNow, CONCURRENT_RENDERS)) {
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

                            const cleanup = setupTextLayer(textLayerDiv);
                            if (typeof cleanup === 'function') {
                                textLayerCleanupFns.set(pageNumber, cleanup);
                            }

                            const pageIndex = pageNumber - 1;

                            const searchMatches = toValue(searchPageMatches);
                            if (searchMatches && searchMatches.size > 0) {
                                const pageMatchData = searchMatches.get(pageIndex) ?? null;
                                highlightPage(
                                    textLayerDiv,
                                    pageMatchData,
                                    toValue(currentSearchMatch) ?? null,
                                );
                            }

                            if (pendingScrollToMatchPageIndex.value === pageIndex) {
                                scrollToCurrentMatch();
                            }
                        }

                        const annotationLayerDiv = container.querySelector<HTMLElement>('.annotation-layer');
                        if (annotationLayerDiv && toValue(showAnnotations)) {
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
                                    pagesCount: numPages.value,
                                    page: options.currentPage.value,
                                    rotation: 0,
                                    isInPresentationMode: false,
                                    externalLinkEnabled: true,
                                    goToDestination: async () => {},
                                    goToPage: (page: number) => options.scrollToPage?.(page),
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

    async function reRenderAllVisiblePages(getVisibleRange: () => IPageRange) {
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
            cleanupPageCache();
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

        const searchMatchesValue = toValue(searchPageMatches);
        const currentMatchValue = toValue(currentSearchMatch);

        pageContainers.forEach((container, index) => {
            const pageIndex = index;
            const textLayerDiv = container.querySelector<HTMLElement>('.text-layer');

            if (!textLayerDiv) {
                return;
            }

            if (!searchMatchesValue || searchMatchesValue.size === 0) {
                clearHighlights(textLayerDiv);
                return;
            }

            const pageMatches = searchMatchesValue.get(pageIndex) ?? null;
            highlightPage(textLayerDiv, pageMatches, currentMatchValue ?? null);
        });
    }

    function scrollToCurrentMatch() {
        const containerRoot = options.container.value;
        const currentMatchValue = toValue(currentSearchMatch);
        if (!containerRoot || !currentMatchValue) {
            return false;
        }

        const pageIndex = currentMatchValue.pageIndex;
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
        scrollToHighlight(currentHighlight, containerRoot);
        return true;
    }

    watch(
        () => [
            toValue(searchPageMatches),
            toValue(currentSearchMatch),
        ] as const,
        () => {
            if (isLoading.value) {
                return;
            }

            const currentMatchValue = toValue(currentSearchMatch);
            pendingScrollToMatchPageIndex.value = currentMatchValue
                ? currentMatchValue.pageIndex
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
    };
};
