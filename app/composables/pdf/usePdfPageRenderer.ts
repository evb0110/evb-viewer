import { Mutex } from 'es-toolkit';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IL10n } from 'pdfjs-dist/types/web/interfaces';
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
} from '@app/types/pdf';
import { chunk } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import type { usePdfDocument } from '@app/composables/pdf/usePdfDocument';
import { usePdfCanvasRenderer } from '@app/composables/pdf/usePdfCanvasRenderer';
import { usePdfTextLayerRenderer } from '@app/composables/pdf/usePdfTextLayerRenderer';
import { usePdfAnnotationLayerRenderer } from '@app/composables/pdf/usePdfAnnotationLayerRenderer';
import { CONCURRENT_RENDERS } from '@app/constants/pdf-layout';
import {
    isRenderingCancelledError,
    captureScrollSnapshot,
    restoreScrollFromSnapshot,
    formatRenderError,
} from '@app/composables/pdf/pdfPageRenderPipeline';
import {
    getPageContainer,
    setupPagePlaceholderSizes,
    type IPageRange,
} from '@app/composables/pdf/pdfPageBufferManager';
import { BrowserLogger } from '@app/utils/browser-logger';

export {
    isRenderingCancelledError, captureScrollSnapshot, restoreScrollFromSnapshot, formatRenderError,
} from '@app/composables/pdf/pdfPageRenderPipeline';
export {
    getPageContainer, setupPagePlaceholderSizes, computeVisibleRange, type IPageRange,
} from '@app/composables/pdf/pdfPageBufferManager';

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
    annotationL10n?: MaybeRefOrGetter<IL10n | null>;

    searchPageMatches?: MaybeRefOrGetter<Map<number, IPdfPageMatches>>;
    currentSearchMatch?: MaybeRefOrGetter<IPdfSearchMatch | null>;

    workingCopyPath?: MaybeRefOrGetter<string | null>;
}

export const usePdfPageRenderer = (options: IUsePdfPageRendererOptions) => {
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

    const outputScale = options.outputScale
        ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

    const canvasRenderer = usePdfCanvasRenderer({ outputScale });
    const textLayerRenderer = usePdfTextLayerRenderer({
        searchPageMatches,
        currentSearchMatch,
        workingCopyPath,
        effectiveScale: options.effectiveScale,
    });
    const annotationLayerRenderer = usePdfAnnotationLayerRenderer({
        numPages,
        currentPage: options.currentPage,
        pdfDocument,
        showAnnotations,
        annotationUiManager: options.annotationUiManager ?? null,
        annotationL10n: options.annotationL10n ?? null,
        scrollToPage: options.scrollToPage,
    });

    const renderMutex = new Mutex();
    let renderVersion = 0;

    const renderedPages = new Set<number>();
    const renderingPages = new Map<number, number>();
    const pageCanvases = new Map<number, HTMLCanvasElement>();
    const textLayerCleanupFns = new Map<number, () => void>();

    const pendingScrollToMatchPageIndex = ref<number | null>(null);
    const RENDERED_CONTAINER_CLASS = 'page_container--rendered';
    const SCROLL_TARGET_CONTAINER_CLASS = 'page_container--scroll-target';
    let activeScrollTargetPageIndex: number | null = null;
    let scrollToMatchRequestId = 0;

    function bumpRenderVersion() {
        renderVersion += 1;
        return renderVersion;
    }

    function logNonCriticalStageError(
        pageNumber: number,
        stage: string,
        error: unknown,
    ) {
        BrowserLogger.error('pdf-renderer', `Failed to render ${stage} for page ${pageNumber}`, error);
    }

    function scheduleRenderForSinglePage(
        pageNumber: number,
        optionsOverride: {
            preserveRenderedPages?: boolean;
            bufferOverride?: number;
        },
    ) {
        void renderVisiblePages(
            {
                start: pageNumber,
                end: pageNumber,
            },
            optionsOverride,
        ).catch((error) => {
            BrowserLogger.error('pdf-renderer', `Failed to schedule follow-up render for page ${pageNumber}`, error);
        });
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
            canvasRenderer.cleanupCanvas(canvas);
            pageCanvases.delete(pageNumber);
        }

        renderedPages.delete(pageNumber);
        renderingPages.delete(pageNumber);

        annotationLayerRenderer.cleanupEditorLayer(pageNumber);

        if (containerRoot) {
            const container = containerRoot.querySelector<HTMLElement>(
                `.page_container[data-page="${pageNumber}"]`,
            );
            container?.classList.remove(RENDERED_CONTAINER_CLASS);
            const skeleton = container?.querySelector<HTMLElement>('.pdf-page-skeleton');
            const canvasHost = container?.querySelector<HTMLDivElement>('.page_canvas');
            const textLayerDiv = container?.querySelector<HTMLDivElement>('.text-layer');
            const annotationLayerDiv = container?.querySelector<HTMLElement>('.annotation-layer');
            const annotationEditorLayerDiv = container?.querySelector<HTMLElement>('.annotation-editor-layer');

            if (canvasHost) {
                canvasHost.innerHTML = '';
            }

            if (skeleton) {
                skeleton.style.display = '';
            }

            if (textLayerDiv) {
                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
            }

            if (annotationLayerDiv) {
                annotationLayerDiv.innerHTML = '';
            }

            if (annotationEditorLayerDiv) {
                annotationEditorLayerDiv.innerHTML = '';
            }

            if (container) {
                textLayerRenderer.clearOcrDebug(container);
            }
        }

        try {
            evictPage(pageNumber);
        } catch (error) {
            BrowserLogger.error('pdf-renderer', 'Failed to evict cached PDF page', error);
        }
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
        setupPagePlaceholderSizes(containerRoot, baseWidth, baseHeight, scale);
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

                        const renderResult = await canvasRenderer.renderCanvas(pdfPage, scale);
                        if (!renderResult) {
                            return;
                        }

                        if (renderVersion !== version) {
                            canvasRenderer.cleanupCanvas(renderResult.canvas);
                            return;
                        }

                        const {
                            canvas,
                            viewport,
                            scaleX,
                            scaleY,
                            rawDims,
                            userUnit,
                            totalScaleFactor,
                        } = renderResult;

                        canvasRenderer.applyContainerDimensions(container, viewport, scale, userUnit, totalScaleFactor);
                        canvasRenderer.mountCanvas(canvasHost, canvas, container, RENDERED_CONTAINER_CLASS);
                        pageCanvases.set(pageNumber, canvas);

                        const textLayerDiv = container.querySelector<HTMLDivElement>('.text-layer');
                        if (textLayerDiv) {
                            cleanupTextLayer(pageNumber);
                            let isTextLayerRendered = false;

                            try {
                                await textLayerRenderer.renderTextLayer(
                                    pdfPage,
                                    textLayerDiv,
                                    viewport,
                                    scale,
                                    userUnit,
                                    totalScaleFactor,
                                );
                                isTextLayerRendered = true;
                            } catch (textLayerError) {
                                logNonCriticalStageError(pageNumber, 'text layer', textLayerError);
                                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
                            }

                            if (renderVersion !== version) {
                                if (renderingPages.get(pageNumber) === version) {
                                    cleanupPage(pageNumber);
                                }
                                return;
                            }

                            if (isTextLayerRendered) {
                                try {
                                    const cleanup = textLayerRenderer.setupTextLayerInteraction(textLayerDiv);
                                    if (typeof cleanup === 'function') {
                                        textLayerCleanupFns.set(pageNumber, cleanup);
                                    }
                                } catch (textLayerInteractionError) {
                                    logNonCriticalStageError(pageNumber, 'text layer interaction', textLayerInteractionError);
                                }

                                try {
                                    textLayerRenderer.applyPageSearchHighlights(
                                        container,
                                        textLayerDiv,
                                        pageNumber,
                                        canvas,
                                        {
                                            userUnit,
                                            totalScaleFactor,
                                            viewportWidth: viewport.width,
                                            viewportHeight: viewport.height,
                                            rawPageWidth: rawDims.pageWidth,
                                            rawPageHeight: rawDims.pageHeight,
                                            canvasPixelWidth: canvas.width,
                                            canvasPixelHeight: canvas.height,
                                            renderScaleX: scaleX,
                                            renderScaleY: scaleY,
                                        },
                                    );
                                } catch (searchHighlightError) {
                                    logNonCriticalStageError(pageNumber, 'search highlights', searchHighlightError);
                                }

                                if (pendingScrollToMatchPageIndex.value === pageNumber - 1) {
                                    try {
                                        scrollToCurrentMatch();
                                    } catch (scrollToMatchError) {
                                        logNonCriticalStageError(pageNumber, 'scroll to current match', scrollToMatchError);
                                    }
                                }
                            }
                        }

                        const annotationLayerDiv = container.querySelector<HTMLElement>('.annotation-layer');
                        let annotationLayerInstance = null;
                        if (annotationLayerDiv && toValue(showAnnotations)) {
                            if (renderVersion !== version) {
                                if (renderingPages.get(pageNumber) === version) {
                                    cleanupPage(pageNumber);
                                }
                                return;
                            }

                            try {
                                annotationLayerInstance = await annotationLayerRenderer.renderAnnotationLayer(
                                    pdfPage,
                                    annotationLayerDiv,
                                    viewport,
                                    pageNumber,
                                );
                            } catch (annotationError) {
                                logNonCriticalStageError(pageNumber, 'annotation layer', annotationError);
                            }

                            if (renderVersion !== version) {
                                if (renderingPages.get(pageNumber) === version) {
                                    cleanupPage(pageNumber);
                                }
                                return;
                            }
                        }

                        const annotationEditorLayerDiv = container.querySelector<HTMLElement>('.annotation-editor-layer');
                        if (annotationEditorLayerDiv && toValue(options.annotationUiManager)) {
                            try {
                                annotationLayerRenderer.renderAnnotationEditorLayer(
                                    container,
                                    annotationEditorLayerDiv,
                                    textLayerDiv,
                                    viewport,
                                    pageNumber,
                                    annotationLayerInstance,
                                );
                            } catch (annotationEditorError) {
                                logNonCriticalStageError(pageNumber, 'annotation editor layer', annotationEditorError);
                            }
                        }

                        if (textLayerRenderer.isOcrDebugEnabled()) {
                            const wcPath = toValue(workingCopyPath);
                            if (wcPath) {
                                void textLayerRenderer.renderOcrDebugBoxes(
                                    container,
                                    pageNumber,
                                    wcPath,
                                    viewport,
                                    rawDims.pageWidth,
                                    rawDims.pageHeight,
                                ).catch((ocrDebugError) => {
                                    logNonCriticalStageError(pageNumber, 'OCR debug overlays', ocrDebugError);
                                });
                            }
                        }

                        if (renderVersion === version) {
                            renderedPages.add(pageNumber);
                        }
                    } catch (error) {
                        if (isRenderingCancelledError(error)) {
                            if (renderVersion === version) {
                                setTimeout(() => {
                                    if (renderVersion !== version) {
                                        return;
                                    }
                                    scheduleRenderForSinglePage(pageNumber, {
                                        preserveRenderedPages: true,
                                        bufferOverride: 0,
                                    });
                                }, 0);
                            }
                            return;
                        }

                        BrowserLogger.error('pdf-renderer', formatRenderError(error, pageNumber));
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
        const snapshot = captureScrollSnapshot(options.container.value);

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
                restoreScrollFromSnapshot(options.container.value, snapshot);
            }

            if (renderVersion !== version) {
                return;
            }

            const visibleRange = getVisibleRange();
            await renderVisiblePages(visibleRange);
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
            canvasRenderer.cleanupCanvas(canvas);
        }

        pageCanvases.clear();
        renderedPages.clear();
        renderingPages.clear();
        textLayerCleanupFns.clear();
        annotationLayerRenderer.clearAllLayers();

        pendingScrollToMatchPageIndex.value = null;
        setScrollTargetPage(null);

        try {
            cleanupPageCache();
        } catch (error) {
            BrowserLogger.error('pdf-renderer', 'Failed to clean up PDF page cache', error);
        }
    }

    function applySearchHighlights() {
        const containerRoot = options.container.value;
        if (!containerRoot) {
            return;
        }
        try {
            textLayerRenderer.applyAllSearchHighlights(containerRoot);
        } catch (error) {
            BrowserLogger.error('pdf-renderer', 'Failed to apply search highlights', error);
        }
    }

    function scrollToCurrentMatch(behavior: ScrollBehavior = 'auto') {
        const containerRoot = options.container.value;
        if (!containerRoot) {
            return false;
        }

        let result = false;
        try {
            result = textLayerRenderer.scrollToCurrentMatch(containerRoot, behavior);
        } catch (error) {
            BrowserLogger.error('pdf-renderer', 'Failed to scroll to current match', error);
            return false;
        }
        if (result) {
            pendingScrollToMatchPageIndex.value = null;
        }
        return result;
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
                ?? textLayerRenderer.getCurrentMatchRanges(textLayerDiv).at(0)?.getBoundingClientRect()
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

            scheduleRenderForSinglePage(matchPageIndex + 1, {
                preserveRenderedPages: true,
                bufferOverride: 0,
            });

            if (attempts >= maxAttempts) {
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

    function invalidatePages(pages: number[]) {
        bumpRenderVersion();
        for (const pageNumber of pages) {
            cleanupPage(pageNumber);
        }
    }

    return {
        setupPagePlaceholders,
        renderVisiblePages,
        reRenderAllVisiblePages,
        cleanupAllPages,
        invalidatePages,
        applySearchHighlights,
        isPageRendered: (pageNumber: number) => renderedPages.has(pageNumber),
    };
};
