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
import { extractPageTextWithCoordinates } from './usePdfTextCoordinates';
import { BrowserLogger } from 'app/utils/browser-logger';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    IScrollSnapshot,
} from 'app/types/pdf';
import { chunk } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import { usePdfSearchHighlight } from 'app/composables/usePdfSearchHighlight';
import { useTextLayerSelection } from 'app/composables/useTextLayerSelection';
import { usePdfWordBoxes } from 'app/composables/usePdfWordBoxes';
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
        renderPageWordBoxes,
        clearWordBoxes,
    } = usePdfWordBoxes();

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

                                // Render word boxes if we have word data
                                if (pageMatchData && pageMatchData.matches.length > 0) {
                                    const firstMatch = pageMatchData.matches[0];
                                    let wordsToRender = firstMatch.words ?? [];

                                    // If no stored words (non-OCR PDF), extract coordinates from PDF.js
                                    if (!wordsToRender || wordsToRender.length === 0) {
                                        BrowserLogger.debug('PAGE-RENDERER', `Page ${pageIndex + 1}: No stored words, extracting from PDF.js`);
                                        BrowserLogger.debug('PAGE-RENDERER', 'pageMatchData structure:', {
                                            pageIndex: pageMatchData.pageIndex,
                                            searchQuery: pageMatchData.searchQuery,
                                            pageText: pageMatchData.pageText ? `${pageMatchData.pageText.substring(0, 100)}...` : 'UNDEFINED',
                                            matchesCount: pageMatchData.matches.length,
                                            firstMatch: pageMatchData.matches[0],
                                        });

                                        try {
                                            BrowserLogger.debug('PAGE-RENDERER', `Page ${pageIndex + 1}: Calling extractPageTextWithCoordinates`);
                                            const textItems = await extractPageTextWithCoordinates(pdfPage);

                                            BrowserLogger.info('PAGE-RENDERER', `Page ${pageIndex + 1}: Extracted ${textItems.length} text items`);
                                            BrowserLogger.debug('PAGE-RENDERER', `Page ${pageIndex + 1}: First 10 extracted items:`, textItems.slice(0, 10));

                                            if (textItems.length > 0 && pageMatchData.searchQuery) {
                                                // Find text items that contain the search query (case-insensitive)
                                                const searchQueryLower = pageMatchData.searchQuery.toLowerCase();
                                                const matchedItemsByText: { [key: string]: typeof textItems[0] } = {};

                                                BrowserLogger.debug('PAGE-RENDERER', `Page ${pageIndex + 1}: Searching for query="${pageMatchData.searchQuery}" (lowercase="${searchQueryLower}")`);

                                                let matchCount = 0;
                                                textItems.forEach((item, idx) => {
                                                    const itemLower = item.text.toLowerCase();

                                                    // Try direct match first
                                                    let matches = itemLower.includes(searchQueryLower);

                                                    // If no match, try with spaces removed (for spaced-out letters like "r a b i c")
                                                    if (!matches) {
                                                        const itemWithoutSpaces = itemLower.replace(/\s+/g, '');
                                                        matches = itemWithoutSpaces.includes(searchQueryLower);
                                                    }

                                                    if (matches) {
                                                        matchCount++;
                                                        matchedItemsByText[item.text] = item;

                                                        // Log first few matches
                                                        if (matchCount <= 5) {
                                                            BrowserLogger.debug('PAGE-RENDERER', `Page ${pageIndex + 1}: Match ${matchCount}:`, {
                                                                itemText: item.text,
                                                                itemLower,
                                                                itemWithoutSpaces: itemLower.replace(/\s+/g, ''),
                                                                searchQuery: searchQueryLower,
                                                                matchType: itemLower.includes(searchQueryLower) ? 'direct' : 'spaceNormalized',
                                                                itemCoords: { x: item.x, y: item.y, w: item.width, h: item.height },
                                                            });
                                                        }
                                                    }
                                                });

                                                wordsToRender = Object.values(matchedItemsByText);
                                                BrowserLogger.info('PAGE-RENDERER', `Page ${pageIndex + 1}: Query="${pageMatchData.searchQuery}" - Found ${wordsToRender.length}/${textItems.length} matching items`);
                                                BrowserLogger.debug('PAGE-RENDERER', `Page ${pageIndex + 1}: Matched items:`, wordsToRender);
                                            } else {
                                                BrowserLogger.warn('PAGE-RENDERER', `Page ${pageIndex + 1}: textItems empty or no searchQuery`, {
                                                    textItemsLength: textItems.length,
                                                    searchQuery: pageMatchData.searchQuery,
                                                });
                                            }
                                        } catch (err) {
                                            const errMsg = err instanceof Error ? err.message : String(err);
                                            BrowserLogger.error('PAGE-RENDERER', `Page ${pageIndex + 1}: Failed to extract text coordinates`, err);
                                        }
                                    } else {
                                        BrowserLogger.debug('PAGE-RENDERER', `Page ${pageIndex + 1}: Using stored words (OCR), count=${wordsToRender.length}`);
                                    }

                                    if (wordsToRender && wordsToRender.length > 0) {
                                        // Collect all unique words from all matches on this page
                                        const allWords: { [key: string]: typeof wordsToRender[0] } = {};
                                        pageMatchData.matches.forEach(match => {
                                            if (match.words) {
                                                match.words.forEach(word => {
                                                    allWords[word.text] = word;
                                                });
                                            }
                                        });

                                        // Check if we extracted PDF.js words or using stored OCR words
                                        const usedPdfJsExtraction = !firstMatch.words || firstMatch.words.length === 0;

                                        // Also add extracted words if we extracted them
                                        if (usedPdfJsExtraction) {
                                            wordsToRender.forEach(word => {
                                                allWords[word.text] = word;
                                            });
                                        }

                                        // Determine which words are in the current match
                                        const currentMatch = toValue(currentSearchMatch);
                                        const currentMatchWords = new Set<string>();
                                        if (currentMatch && currentMatch.pageIndex === pageIndex && currentMatch.words) {
                                            currentMatch.words.forEach(word => {
                                                currentMatchWords.add(word.text);
                                            });
                                        }

                                        // Use correct dimensions based on word source
                                        let pageWidth = firstMatch.pageWidth;
                                        let pageHeight = firstMatch.pageHeight;

                                        if (usedPdfJsExtraction) {
                                            // For PDF.js extracted items, use actual PDF page dimensions
                                            // pdfPage.view is [x0, y0, x1, y1], so width = x1 - x0, height = y1 - y0
                                            pageWidth = pdfPage.view[2] - pdfPage.view[0];
                                            pageHeight = pdfPage.view[3] - pdfPage.view[1];
                                            BrowserLogger.debug('PAGE-RENDERER', `Page ${pageIndex + 1}: Using PDF.js extraction - dimensions from pdfPage.view: ${pageWidth}x${pageHeight}`);
                                        } else {
                                            BrowserLogger.debug('PAGE-RENDERER', `Page ${pageIndex + 1}: Using OCR words - dimensions from search result: ${pageWidth}x${pageHeight}`);
                                        }

                                        renderPageWordBoxes(
                                            container,
                                            Object.values(allWords),
                                            pageWidth,
                                            pageHeight,
                                            currentMatchWords.size > 0 ? currentMatchWords : undefined,
                                        );
                                    }
                                }
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
                clearWordBoxes(container);
                return;
            }

            const pageMatches = searchMatchesValue.get(pageIndex) ?? null;
            highlightPage(textLayerDiv, pageMatches, currentMatchValue ?? null);

            // Also render word boxes if available
            if (pageMatches && pageMatches.matches.length > 0) {
                const firstMatch = pageMatches.matches[0];
                if (firstMatch.words && firstMatch.words.length > 0) {
                    // Collect all unique words from all matches on this page
                    const allWords: { [key: string]: typeof firstMatch.words[0] } = {};
                    pageMatches.matches.forEach(match => {
                        if (match.words) {
                            match.words.forEach(word => {
                                allWords[word.text] = word;
                            });
                        }
                    });

                    // Determine which words are in the current match
                    const currentMatchWords = new Set<string>();
                    if (currentMatchValue && currentMatchValue.pageIndex === pageIndex && currentMatchValue.words) {
                        currentMatchValue.words.forEach(word => {
                            currentMatchWords.add(word.text);
                        });
                    }

                    renderPageWordBoxes(
                        container,
                        Object.values(allWords),
                        firstMatch.pageWidth,
                        firstMatch.pageHeight,
                        currentMatchWords.size > 0 ? currentMatchWords : undefined,
                    );
                }
            } else {
                clearWordBoxes(container);
            }
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
