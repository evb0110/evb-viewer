import { Mutex } from 'es-toolkit';
import {
    AnnotationLayer,
    AnnotationEditorLayer,
    DrawLayer,
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
import { BrowserLogger } from '@app/utils/browser-logger';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    IScrollSnapshot,
} from '@app/types/pdf';
import { chunk } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import { usePdfSearchHighlight } from '@app/composables/usePdfSearchHighlight';
import { useTextLayerSelection } from '@app/composables/useTextLayerSelection';
import { usePdfWordBoxes } from '@app/composables/usePdfWordBoxes';
import { useOcrTextContent } from '@app/composables/pdf/useOcrTextContent';
import type { usePdfDocument } from '@app/composables/pdf/usePdfDocument';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';

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

    annotationUiManager?: MaybeRefOrGetter<AnnotationEditorUIManager | null>;
    annotationL10n?: MaybeRefOrGetter<unknown>;

    searchPageMatches?: MaybeRefOrGetter<Map<number, IPdfPageMatches>>;
    currentSearchMatch?: MaybeRefOrGetter<IPdfSearchMatch | null>;

    /**
     * Path to the working copy of the PDF file.
     * Used to look up OCR index data for OCR-derived text layers.
     */
    workingCopyPath?: MaybeRefOrGetter<string | null>;
}

const CONCURRENT_RENDERS = 3;

export const usePdfPageRenderer = (options: IUsePdfPageRendererOptions) => {
    const { setupTextLayer } = useTextLayerSelection();
    const {
        clearHighlights,
        highlightPage,
        scrollToHighlight,
        getCurrentMatchRanges,
    } = usePdfSearchHighlight();
    const {
        renderPageWordBoxes,
        clearWordBoxes,
        isOcrDebugEnabled,
        clearOcrDebugBoxes,
        renderOcrDebugBoxes,
    } = usePdfWordBoxes();
    const { getOcrTextContent } = useOcrTextContent();

    const {
        pdfDocument,
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
    const workingCopyPath = options.workingCopyPath ?? null;

    const renderMutex = new Mutex();
    let renderVersion = 0;

    const renderedPages = new Set<number>();
    const renderingPages = new Map<number, number>();
    const pageCanvases = new Map<number, HTMLCanvasElement>();
    const textLayerCleanupFns = new Map<number, () => void>();
    const annotationEditorLayers = new Map<number, AnnotationEditorLayer>();
    const drawLayers = new Map<number, DrawLayer>();

    const pendingScrollToMatchPageIndex = ref<number | null>(null);
    const RENDERED_CONTAINER_CLASS = 'page_container--rendered';
    const SCROLL_TARGET_CONTAINER_CLASS = 'page_container--scroll-target';
    let activeScrollTargetPageIndex: number | null = null;
    let scrollToMatchRequestId = 0;

    const outputScale = options.outputScale
        ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

    let lastHighlightDebugKey: string | null = null;

    function isHighlightDebugEnabled() {
        if (typeof window === 'undefined') {
            return false;
        }

        try {
            return window.localStorage?.getItem('pdfHighlightDebug') === '1';
        } catch {
            return false;
        }
    }

    function isHighlightDebugVerboseEnabled() {
        if (typeof window === 'undefined') {
            return false;
        }

        try {
            return window.localStorage?.getItem('pdfHighlightDebugVerbose') === '1';
        } catch {
            return false;
        }
    }

    function maybeLogHighlightDebug(
        pageNumber: number,
        pageMatchData: IPdfPageMatches | null,
        canvas: HTMLCanvasElement,
        textLayerDiv: HTMLElement,
        debugInfo?: {
            userUnit: number;
            totalScaleFactor: number;
            viewportWidth: number;
            viewportHeight: number;
            rawPageWidth: number;
            rawPageHeight: number;
            canvasPixelWidth: number;
            canvasPixelHeight: number;
            renderScaleX: number;
            renderScaleY: number;
        },
    ) {
        if (!isHighlightDebugEnabled()) {
            return;
        }

        const current = toValue(currentSearchMatch);
        if (!current || current.pageIndex !== pageNumber - 1) {
            return;
        }

        const query = pageMatchData?.searchQuery ?? '';
        const key = `${current.pageIndex}:${current.matchIndex}:${query}:${toValue(options.effectiveScale)}`;
        if (key === lastHighlightDebugKey) {
            return;
        }
        lastHighlightDebugKey = key;

        const canvasRect = canvas.getBoundingClientRect();
        const textRect = textLayerDiv.getBoundingClientRect();
        const pageContainer = textLayerDiv.closest<HTMLElement>('.page_container');
        const containerRect = pageContainer?.getBoundingClientRect() ?? null;
        const canvasHostRect = pageContainer?.querySelector<HTMLElement>('.page_canvas')?.getBoundingClientRect() ?? null;
        const computedTotalScaleFactor = typeof window !== 'undefined'
            ? window.getComputedStyle(textLayerDiv).getPropertyValue('--total-scale-factor').trim()
            : '';

        const currentRange = getCurrentMatchRanges(textLayerDiv).at(0) ?? null;
        const currentRangeRect = currentRange?.getBoundingClientRect() ?? null;
        const currentMark = textLayerDiv.querySelector<HTMLElement>('.pdf-search-highlight--current');
        const currentMarkRect = currentMark?.getBoundingClientRect() ?? null;
        const highlightRect = currentRangeRect ?? currentMarkRect;

        const verbose = isHighlightDebugVerboseEnabled();
        let currentSpanInfo = '';
        if (verbose && typeof window !== 'undefined') {
            const span = currentMark?.closest('span');
            if (span) {
                const spanStyle = window.getComputedStyle(span);
                const scaleX = spanStyle.getPropertyValue('--scale-x').trim();
                const fontHeight = spanStyle.getPropertyValue('--font-height').trim();
                currentSpanInfo = [
                    `spanFont=${JSON.stringify(spanStyle.font)}`,
                    `spanFamily=${JSON.stringify(spanStyle.fontFamily)}`,
                    `spanWeight=${spanStyle.fontWeight}`,
                    `spanSize=${spanStyle.fontSize}`,
                    `spanTransform=${JSON.stringify(spanStyle.transform)}`,
                    `spanScaleX=${JSON.stringify(scaleX)}`,
                    `spanFontHeightVar=${JSON.stringify(fontHeight)}`,
                    `spanText=${JSON.stringify(span.textContent?.slice(0, 60) ?? '')}`,
                ].join(' ');
            }
        }

        const scale = toValue(options.effectiveScale);
        const dx = textRect.left - canvasRect.left;
        const dy = textRect.top - canvasRect.top;
        const dw = textRect.width - canvasRect.width;
        const dh = textRect.height - canvasRect.height;

        const fmtRect = (rect: DOMRect) =>
            `${rect.left.toFixed(2)},${rect.top.toFixed(2)} ${rect.width.toFixed(2)}x${rect.height.toFixed(2)}`;

        const msg = [
            `page=${pageNumber}`,
            `matchIndex=${current.matchIndex}`,
            `scale=${scale}`,
            `query=${JSON.stringify(query)}`,
            debugInfo
                ? `viewport=${debugInfo.viewportWidth.toFixed(2)}x${debugInfo.viewportHeight.toFixed(2)}`
                : '',
            debugInfo
                ? `raw=${debugInfo.rawPageWidth.toFixed(2)}x${debugInfo.rawPageHeight.toFixed(2)} userUnit=${debugInfo.userUnit}`
                : '',
            debugInfo
                ? `totalScale=${debugInfo.totalScaleFactor.toFixed(10)} cssVarTotal=${JSON.stringify(computedTotalScaleFactor)}`
                : '',
            debugInfo
                ? `canvasPx=${debugInfo.canvasPixelWidth}x${debugInfo.canvasPixelHeight} renderScale=${debugInfo.renderScaleX.toFixed(6)}x${debugInfo.renderScaleY.toFixed(6)}`
                : '',
            containerRect ? `container=${fmtRect(containerRect)}` : '',
            canvasHostRect ? `canvasHost=${fmtRect(canvasHostRect)}` : '',
            `canvas=${fmtRect(canvasRect)}`,
            `textLayer=${fmtRect(textRect)}`,
            `delta=${dx.toFixed(2)},${dy.toFixed(2)} ${dw.toFixed(2)}x${dh.toFixed(2)}`,
            highlightRect ? `currentHighlight=${fmtRect(highlightRect)}` : 'currentHighlight=null',
            currentSpanInfo,
        ].join(' ');

        BrowserLogger.debug('PDF-HIGHLIGHT', msg);
    }

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
            container?.classList.remove(RENDERED_CONTAINER_CLASS);
            const skeleton = container?.querySelector<HTMLElement>('.pdf-page-skeleton');
            const canvasHost = container?.querySelector<HTMLDivElement>('.page_canvas');
            const textLayerDiv = container?.querySelector<HTMLElement>('.text-layer');
            const annotationLayerDiv = container?.querySelector<HTMLElement>('.annotation-layer');
            const annotationEditorLayerDiv = container?.querySelector<HTMLElement>('.annotation-editor-layer');

            if (canvasHost) {
                canvasHost.innerHTML = '';
            }

            if (skeleton) {
                skeleton.style.display = '';
            }

            if (textLayerDiv) {
                clearHighlights(textLayerDiv);
                textLayerDiv.innerHTML = '';
            }

            if (annotationLayerDiv) {
                annotationLayerDiv.innerHTML = '';
            }

            if (annotationEditorLayerDiv) {
                annotationEditorLayerDiv.innerHTML = '';
            }

            // Clear OCR debug boxes if they exist
            if (container) {
                clearOcrDebugBoxes(container);
            }
        }

        const editorLayer = annotationEditorLayers.get(pageNumber);
        if (editorLayer) {
            editorLayer.destroy();
            annotationEditorLayers.delete(pageNumber);
        }

        const drawLayer = drawLayers.get(pageNumber);
        if (drawLayer) {
            drawLayer.destroy();
            drawLayers.delete(pageNumber);
        }

        try {
            evictPage(pageNumber);
        } catch (error) {
            console.error('Failed to evict cached PDF page:', error);
        }
    }

    function getPageContainer(containerRoot: HTMLElement, pageIndex: number) {
        const pageNumber = pageIndex + 1;
        return containerRoot.querySelector<HTMLElement>(`.page_container[data-page="${pageNumber}"]`)
            ?? containerRoot.querySelectorAll<HTMLElement>('.page_container')[pageIndex]
            ?? null;
    }

    function setScrollTargetPage(pageIndex: number | null) {
        const containerRoot = options.container.value;
        if (!containerRoot) {
            activeScrollTargetPageIndex = pageIndex;
            return;
        }

        const previous = activeScrollTargetPageIndex;
        if (previous !== null && previous !== pageIndex) {
            getPageContainer(containerRoot, previous)?.classList.remove(SCROLL_TARGET_CONTAINER_CLASS);
        }

        if (pageIndex !== null) {
            getPageContainer(containerRoot, pageIndex)?.classList.add(SCROLL_TARGET_CONTAINER_CLASS);
        } else if (previous !== null) {
            getPageContainer(containerRoot, previous)?.classList.remove(SCROLL_TARGET_CONTAINER_CLASS);
        }

        activeScrollTargetPageIndex = pageIndex;
    }

    function setupPagePlaceholders() {
        const containerRoot = options.container.value;
        const baseWidth = toValue(basePageWidth);
        const baseHeight = toValue(basePageHeight);
        if (!containerRoot || !baseWidth || !baseHeight) {
            return;
        }

        const scale = toValue(options.effectiveScale);
        const width = baseWidth * scale;
        const height = baseHeight * scale;

        const containers = containerRoot.querySelectorAll<HTMLDivElement>('.page_container');
        containers.forEach((container) => {
            container.style.width = `${width}px`;
            container.style.height = `${height}px`;
        });
    }

    async function renderVisiblePages(
        visibleRange: IPageRange,
        renderOptions?: {
            preserveRenderedPages?: boolean;
            bufferOverride?: number;
        },
    ) {
        const containerRoot = options.container.value;

        if (!containerRoot || numPages.value === 0) {
            return;
        }

        const version = renderVersion;
        const buffer = renderOptions?.bufferOverride ?? toValue(bufferPages);

        const renderStart = Math.max(1, visibleRange.start - buffer);
        const renderEnd = Math.min(numPages.value, visibleRange.end + buffer);

        const pagesToKeep = new Set(range(renderStart, renderEnd + 1));

        if (!renderOptions?.preserveRenderedPages) {
            for (const pageNum of renderedPages) {
                if (!pagesToKeep.has(pageNum)) {
                    cleanupPage(pageNum);
                }
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
                        const userUnit = (viewport as unknown as { userUnit?: number }).userUnit ?? 1;
                        const totalScaleFactor = scale * userUnit;
                        const rawDims = viewport.rawDims as unknown as {
                            pageWidth: number;
                            pageHeight: number;
                        };

                        // Keep the page container sized to the exact viewport dimensions (avoids
                        // sub-pixel drift between canvas and text layer when `scale` produces
                        // fractional page sizes).
                        container.style.width = `${viewport.width}px`;
                        container.style.height = `${viewport.height}px`;
                        container.style.setProperty('--scale-factor', String(scale));
                        container.style.setProperty('--user-unit', String(userUnit));
                        container.style.setProperty('--total-scale-factor', String(totalScaleFactor));

                        const canvas = document.createElement('canvas');
                        const context = canvas.getContext('2d');
                        if (!context) {
                            return;
                        }

                        const cssWidth = viewport.width;
                        const cssHeight = viewport.height;
                        const pixelWidth = Math.max(1, Math.round(cssWidth * outputScale));
                        const pixelHeight = Math.max(1, Math.round(cssHeight * outputScale));

                        canvas.width = pixelWidth;
                        canvas.height = pixelHeight;
                        canvas.style.width = `${cssWidth}px`;
                        canvas.style.height = `${cssHeight}px`;
                        canvas.style.display = 'block';
                        canvas.style.margin = '0';

                        const sx = pixelWidth / cssWidth;
                        const sy = pixelHeight / cssHeight;

                        const transform = sx !== 1 || sy !== 1
                            ? [
                                sx,
                                0,
                                0,
                                sy,
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
                        container.classList.add(RENDERED_CONTAINER_CLASS);

                        const skeleton = container.querySelector<HTMLElement>('.pdf-page-skeleton');
                        if (skeleton) {
                            skeleton.style.display = 'none';
                        }

                        const textLayerDiv = container.querySelector<HTMLElement>('.text-layer');
                        if (textLayerDiv) {
                            cleanupTextLayer(pageNumber);
                            textLayerDiv.innerHTML = '';
                            textLayerDiv.style.setProperty('--scale-factor', String(scale));
                            textLayerDiv.style.setProperty('--user-unit', String(userUnit));
                            textLayerDiv.style.setProperty('--total-scale-factor', String(totalScaleFactor));

                            // Try OCR-derived text content first (if OCR index exists)
                            const currentWorkingCopyPath = toValue(workingCopyPath);
                            let textContent = null;

                            if (currentWorkingCopyPath) {
                                try {
                                    const ocrTextContent = await getOcrTextContent(
                                        currentWorkingCopyPath,
                                        pageNumber,
                                        viewport,
                                    );
                                    if (ocrTextContent) {
                                        textContent = ocrTextContent;
                                    }
                                } catch (ocrError) {
                                    // OCR text content failed, will fall back to PDF.js extraction
                                    console.warn('[usePdfPageRenderer] OCR text content failed:', ocrError);
                                }
                            }

                            // Fallback to PDF.js extraction if no OCR content
                            if (!textContent) {
                                textContent = await pdfPage.getTextContent({
                                    includeMarkedContent: true,
                                    disableNormalization: true,
                                });
                            }

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
                            // PDF.js sizes the text layer via `setLayerDimensions` using CSS variables that
                            // aren't always wired up in custom viewers. Rely on our absolute `inset: 0`
                            // layout instead, so the text layer always matches the canvas container.
                            textLayerDiv.style.width = '';
                            textLayerDiv.style.height = '';

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
                                const highlightResult = highlightPage(
                                    textLayerDiv,
                                    pageMatchData,
                                    toValue(currentSearchMatch) ?? null,
                                );
                                maybeLogHighlightDebug(pageNumber, pageMatchData, canvas, textLayerDiv, {
                                    userUnit,
                                    totalScaleFactor,
                                    viewportWidth: viewport.width,
                                    viewportHeight: viewport.height,
                                    rawPageWidth: rawDims.pageWidth,
                                    rawPageHeight: rawDims.pageHeight,
                                    canvasPixelWidth: canvas.width,
                                    canvasPixelHeight: canvas.height,
                                    renderScaleX: sx,
                                    renderScaleY: sy,
                                });

                                const isCssHighlightMode = typeof window !== 'undefined'
                                    ? window.localStorage?.getItem('pdfHighlightMode') === 'css'
                                    : false;
                                const hasInTextHighlights = isCssHighlightMode
                                    || highlightResult.elements.length > 0
                                    || highlightResult.currentMatchRanges.length > 0;

                                // Render word boxes only when we cannot highlight directly in the text layer
                                // (e.g. OCR-indexed PDFs where the PDF has no meaningful text layer).
                                if (!hasInTextHighlights && pageMatchData && pageMatchData.matches.length > 0) {
                                    const firstMatch = pageMatchData.matches.at(0);
                                    const firstMatchWords = firstMatch?.words ?? [];

                                    if (firstMatch && firstMatchWords.length > 0) {
                                        const allWords: { [key: string]: typeof firstMatchWords[0] } = {};
                                        pageMatchData.matches.forEach((match) => {
                                            match.words?.forEach((word) => {
                                                allWords[word.text] = word;
                                            });
                                        });

                                        const currentMatch = toValue(currentSearchMatch);
                                        const currentMatchWords = new Set<string>();
                                        if (currentMatch && currentMatch.pageIndex === pageIndex && currentMatch.words) {
                                            currentMatch.words.forEach((word) => {
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
                                    } else {
                                        clearWordBoxes(container);
                                    }
                                } else {
                                    clearWordBoxes(container);
                                }
                            }

                            if (pendingScrollToMatchPageIndex.value === pageIndex) {
                                scrollToCurrentMatch();
                            }
                        }

                        const annotationLayerDiv = container.querySelector<HTMLElement>('.annotation-layer');
                        let annotationLayerInstance: AnnotationLayer | null = null;
                        if (annotationLayerDiv && toValue(showAnnotations)) {
                            annotationLayerDiv.innerHTML = '';

                            const annotations = await pdfPage.getAnnotations();
                            const annotationStorage = pdfDocument.value?.annotationStorage;
                            const annotationUiManager = toValue(options.annotationUiManager) ?? null;

                            if (renderVersion !== version) {
                                if (renderingPages.get(pageNumber) === version) {
                                    cleanupPage(pageNumber);
                                }
                                return;
                            }

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

                            annotationLayerInstance = new AnnotationLayer({
                                div: annotationLayerDiv as HTMLDivElement,
                                page: pdfPage,
                                viewport,
                                accessibilityManager: null,
                                annotationCanvasMap: null,
                                annotationEditorUIManager: annotationUiManager,
                                structTreeLayer: null,
                                commentManager: null,
                                linkService: simpleLinkService,
                                annotationStorage,
                            });

                            await annotationLayerInstance.render({
                                annotations,
                                viewport,
                                div: annotationLayerDiv as HTMLDivElement,
                                page: pdfPage,
                                linkService: simpleLinkService,
                                renderForms: false,
                                annotationStorage,
                            });
                        }

                        const annotationEditorLayerDiv = container.querySelector<HTMLElement>('.annotation-editor-layer');
                        const annotationUiManager = toValue(options.annotationUiManager) ?? null;
                        if (annotationEditorLayerDiv && annotationUiManager) {
                            const editorViewport = viewport.clone({ dontFlip: true });
                            const editorLayer = annotationEditorLayers.get(pageNumber);
                            const drawLayer = drawLayers.get(pageNumber) ?? new DrawLayer({ pageIndex: pageNumber - 1 });
                            const textLayerShim = textLayerDiv
                                ? ({ div: textLayerDiv } as any)
                                : undefined;

                            const canvasHost = container.querySelector<HTMLDivElement>('.page_canvas');
                            if (canvasHost) {
                                drawLayer.setParent(canvasHost);
                            }
                            drawLayers.set(pageNumber, drawLayer);

                            if (!editorLayer) {
                                annotationEditorLayerDiv.innerHTML = '';
                                annotationEditorLayerDiv.dir = annotationUiManager.direction;
                            }

                            const l10n = toValue(options.annotationL10n) ?? null;
                            const activeLayer = editorLayer ?? new AnnotationEditorLayer({
                                mode: {},
                                uiManager: annotationUiManager,
                                div: annotationEditorLayerDiv as HTMLDivElement,
                                structTreeLayer: null,
                                enabled: true,
                                accessibilityManager: undefined,
                                pageIndex: pageNumber - 1,
                                l10n: l10n as any,
                                viewport: editorViewport,
                                annotationLayer: annotationLayerInstance ?? undefined,
                                textLayer: textLayerShim,
                                drawLayer,
                            });

                            if (!editorLayer) {
                                annotationEditorLayers.set(pageNumber, activeLayer);
                            }

                            if (editorLayer) {
                                editorLayer.update({ viewport: editorViewport });
                            } else {
                                activeLayer.render({ viewport: editorViewport });
                            }

                            annotationEditorLayerDiv.hidden = activeLayer.isInvisible;
                            activeLayer.pause(false);
                        }

                        // Render OCR debug boxes if debug mode is enabled
                        if (isOcrDebugEnabled()) {
                            const wcPath = toValue(workingCopyPath);
                            if (wcPath) {
                                void renderOcrDebugBoxes(
                                    container,
                                    pageNumber,
                                    wcPath,
                                    viewport,
                                    rawDims.pageWidth,
                                    rawDims.pageHeight,
                                );
                            }
                        }

                        if (renderVersion === version) {
                            renderedPages.add(pageNumber);
                        }
                    } catch (error) {
                        const message = error instanceof Error
                            ? error.message
                            : typeof error === 'string'
                                ? error
                                : (() => {
                                    try {
                                        return JSON.stringify(error);
                                    } catch {
                                        return String(error);
                                    }
                                })();

                        const stack = error instanceof Error ? error.stack ?? '' : '';
                        const text = stack
                            ? `Failed to render PDF page: ${pageNumber} ${message}\n${stack}`
                            : `Failed to render PDF page: ${pageNumber} ${message}`;

                        console.error(text);
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
        annotationEditorLayers.clear();
        drawLayers.clear();

        pendingScrollToMatchPageIndex.value = null;
        setScrollTargetPage(null);

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
                const firstMatch = pageMatches.matches.at(0);
                const firstMatchWords = firstMatch?.words ?? [];
                if (firstMatch && firstMatchWords.length > 0) {
                    // Collect all unique words from all matches on this page
                    const allWords: { [key: string]: typeof firstMatchWords[0] } = {};
                    pageMatches.matches.forEach((match) => {
                        match.words?.forEach((word) => {
                            allWords[word.text] = word;
                        });
                    });

                    // Determine which words are in the current match
                    const currentMatchWords = new Set<string>();
                    if (currentMatchValue && currentMatchValue.pageIndex === pageIndex && currentMatchValue.words) {
                        currentMatchValue.words.forEach((word) => {
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
                } else {
                    clearWordBoxes(container);
                }
            } else {
                clearWordBoxes(container);
            }
        });
    }

    function scrollToCurrentMatch(behavior: ScrollBehavior = 'auto') {
        const containerRoot = options.container.value;
        const currentMatchValue = toValue(currentSearchMatch);
        if (!containerRoot || !currentMatchValue) {
            return false;
        }

        const pageIndex = currentMatchValue.pageIndex;
        const targetContainer = getPageContainer(containerRoot, pageIndex);

        if (!targetContainer) {
            return false;
        }

        const textLayerDiv = targetContainer.querySelector<HTMLElement>('.text-layer');
        if (!textLayerDiv) {
            return false;
        }

        const currentHighlight = textLayerDiv.querySelector<HTMLElement>('.pdf-search-highlight--current');
        if (!currentHighlight) {
            const currentRanges = getCurrentMatchRanges(textLayerDiv);
            const range = currentRanges.at(0) ?? null;
            if (!range) {
                return false;
            }

            const rect = range.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) {
                return false;
            }

            const containerRect = containerRoot.getBoundingClientRect();
            const elementTop = rect.top - containerRect.top + containerRoot.scrollTop;
            const elementCenter = elementTop - containerRoot.clientHeight / 2 + rect.height / 2;

            pendingScrollToMatchPageIndex.value = null;
            containerRoot.scrollTo({
                top: Math.max(0, elementCenter),
                behavior,
            });

            return true;
        }

        const highlightRect = currentHighlight.getBoundingClientRect();
        if (highlightRect.width === 0 && highlightRect.height === 0) {
            return false;
        }

        pendingScrollToMatchPageIndex.value = null;
        scrollToHighlight(currentHighlight, containerRoot, behavior);
        return true;
    }

    function scheduleScrollCorrection(requestId: number) {
        if (typeof window === 'undefined') {
            return;
        }

        const correctIfNeeded = () => {
            if (requestId !== scrollToMatchRequestId) {
                return;
            }

            const containerRoot = options.container.value;
            const currentMatchValue = toValue(currentSearchMatch);
            if (!containerRoot || !currentMatchValue) {
                return;
            }

            const targetContainer = getPageContainer(containerRoot, currentMatchValue.pageIndex);
            if (!targetContainer) {
                return;
            }

            const textLayerDiv = targetContainer.querySelector<HTMLElement>('.text-layer');
            if (!textLayerDiv) {
                return;
            }

            const currentHighlight = textLayerDiv.querySelector<HTMLElement>('.pdf-search-highlight--current');
            const rect = currentHighlight?.getBoundingClientRect()
                ?? getCurrentMatchRanges(textLayerDiv).at(0)?.getBoundingClientRect()
                ?? null;

            if (!rect || (rect.width === 0 && rect.height === 0)) {
                return;
            }

            const containerRect = containerRoot.getBoundingClientRect();
            const centerDelta = (rect.top + rect.height / 2) - (containerRect.top + containerRect.height / 2);
            const isVisible = rect.bottom > containerRect.top + 16 && rect.top < containerRect.bottom - 16;
            const isCentered = Math.abs(centerDelta) < 8;
            if (isVisible && isCentered) {
                return;
            }

            void scrollToCurrentMatch();
        };

        requestAnimationFrame(() => {
            correctIfNeeded();
            requestAnimationFrame(() => {
                correctIfNeeded();
            });
        });
        setTimeout(correctIfNeeded, 120);
        setTimeout(correctIfNeeded, 350);
        setTimeout(correctIfNeeded, 800);
    }

    function requestScrollToMatch(matchPageIndex: number | null) {
        const requestId = ++scrollToMatchRequestId;

        if (matchPageIndex === null) {
            return;
        }

        if (typeof window === 'undefined') {
            return;
        }

        const maxAttempts = 8;
        let attempts = 0;

        const tryScroll = () => {
            if (requestId !== scrollToMatchRequestId) {
                return;
            }

            const didScroll = scrollToCurrentMatch();
            if (didScroll) {
                scheduleScrollCorrection(requestId);
                return;
            }

            attempts += 1;

            void renderVisiblePages(
                {
                    start: matchPageIndex + 1,
                    end: matchPageIndex + 1,
                },
                {
                    preserveRenderedPages: true,
                    bufferOverride: 0,
                },
            );

            if (attempts >= maxAttempts) {
                // Fallback: bring the page into view to ensure layout is measurable, then try again.
                options.scrollToPage?.(matchPageIndex + 1);
                requestAnimationFrame(() => {
                    if (requestId !== scrollToMatchRequestId) {
                        return;
                    }
                    void nextTick(() => {
                        void scrollToCurrentMatch();
                    });
                });
                return;
            }

            requestAnimationFrame(tryScroll);
        };

        nextTick(() => {
            tryScroll();
        });
    }

    watch(
        () => [
            isLoading.value,
            toValue(searchPageMatches),
            toValue(currentSearchMatch),
        ] as const,
        () => {
            if (isLoading.value) {
                return;
            }

            const currentMatchValue = toValue(currentSearchMatch);
            const matchPageIndex = currentMatchValue
                ? currentMatchValue.pageIndex
                : null;

            pendingScrollToMatchPageIndex.value = matchPageIndex;
            setScrollTargetPage(matchPageIndex);

            applySearchHighlights();

            nextTick(() => {
                if (matchPageIndex === null) {
                    return;
                }

                requestScrollToMatch(matchPageIndex);
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
        isPageRendered: (pageNumber: number) => renderedPages.has(pageNumber),
    };
};
