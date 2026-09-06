/* eslint-disable max-lines */
import type {
    IPdfPage,
    IPdfTextContent,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { MaybeRefOrGetter } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { clamp } from 'es-toolkit/math';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import type { IOcrWord } from '@contracts/shared';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { buildOcrWordKey } from '@contracts/ocrText';
import { usePdfSearchHighlight } from '@app/modules/pdf-viewer/runtime/composables/usePdfSearchHighlight';
import { useTextLayerSelection } from '@app/modules/pdf-viewer/runtime/composables/useTextLayerSelection';
import { usePdfWordBoxes } from '@app/modules/pdf-viewer/runtime/composables/usePdfWordBoxes';
import { useOcrTextContent } from '@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent';
import type {
    IHighlightDebugGuard,
    IHighlightDebugInfo,
    IHighlightDebugRects,
    IPageHighlightSignatureState,
    TPageMatchEntry,
    TTextLayerTextContentSource,
} from '@app/modules/pdf-viewer/runtime/composables/pdf/pdfTextLayerRendererTypes';
import { getPageContainer } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/getPageContainer';
import { transformWordBox } from '@app/modules/pdf-viewer/engine/ocr/pdf-word-box-geometry/transformWordBox';
import {
    getHighlightMode,
    isHighlightDebugEnabled as isHighlightDebugEnabledFromStorage,
    isHighlightDebugVerboseEnabled as isHighlightDebugVerboseEnabledFromStorage,
} from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightCss';
import {
    clearTextLayerIndexCache,
    clearTextLayerTextMapping,
    registerTextLayerTextMapping,
} from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';
import { BrowserLogger } from '@app/utils/browserLogger';
import { measureDevPerf } from '@app/utils/devPerf';
import { logPdfNav } from '@app/utils/logPdfNav';
import { guardAsync } from '@app/utils/asyncGuard';
import {
    createPdfjsTextLayer,
    type IPdfTextLayer,
} from '@app/services/pdfjs/pdfViewerFacade';
import {
    applyPdfViewportWrite,
    type IPdfViewportWritePort,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';
import { PDF_PAGE_SCALE_CSS_VARS } from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';
const HIGHLIGHT_REFRESH_BUDGET_MS = 8;
const HIGHLIGHT_REFRESH_MAX_PAGES_PER_SLICE = 4;
interface IRenderedTextLayer {
    textLayer: IPdfTextLayer;
    pdfPage: IPdfPage;
    workingCopyPath: string | null;
    documentRevisionToken: TDocumentRevisionToken | null;
}

const renderedTextLayers = new WeakMap<HTMLElement, IRenderedTextLayer>();

const createAbortError = () => new DOMException('Text layer rendering was cancelled', 'AbortError');

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

export const usePdfTextLayerRenderer = (deps: {
    searchPageMatches: MaybeRefOrGetter<Map<number, IPdfPageMatches>>;
    currentSearchMatch: MaybeRefOrGetter<IPdfSearchMatch | null>;
    workingCopyPath: MaybeRefOrGetter<string | null>;
    documentRevisionToken: MaybeRefOrGetter<TDocumentRevisionToken | null>;
    effectiveScale: MaybeRefOrGetter<number>;
    viewportWritePort: IPdfViewportWritePort;
}) => {
    const { setupTextLayer } = useTextLayerSelection();
    const {
        clearHighlights,
        highlightPage,
        getCurrentMatchRanges,
    } = usePdfSearchHighlight();
    const {
        renderPageWordBoxes,
        clearWordBoxes,
        isOcrDebugEnabled,
        clearOcrDebugBoxes,
        renderOcrDebugBoxes,
    } = usePdfWordBoxes();
    const {
        getOcrTextContent,
        hasPageOcrData,
    } = useOcrTextContent();

    let lastHighlightDebugKey: string | null = null;
    const pageHighlightState: IPageHighlightSignatureState = {
        signatureByPage: new Map<number, string>(),
        pendingRoot: null,
        rafId: 0,
        continuationRafId: 0,
        refreshVersion: 0,
    };

    tryOnScopeDispose(() => {
        if (pageHighlightState.rafId !== 0 && typeof window !== 'undefined') {
            window.cancelAnimationFrame(pageHighlightState.rafId);
            pageHighlightState.rafId = 0;
        }
        if (pageHighlightState.continuationRafId !== 0 && typeof window !== 'undefined') {
            window.cancelAnimationFrame(pageHighlightState.continuationRafId);
            pageHighlightState.continuationRafId = 0;
        }
        pageHighlightState.pendingRoot = null;
        pageHighlightState.signatureByPage.clear();
    });

    function collectWordsFromPageMatches(pageMatchData: IPdfPageMatches) {
        const wordsByKey = new Map<string, NonNullable<NonNullable<IPdfPageMatches['matches'][number]['words']>[number]>>();

        pageMatchData.matches.forEach((match) => {
            match.words?.forEach((word) => {
                wordsByKey.set(buildOcrWordKey(word), word);
            });
        });

        return Array.from(wordsByKey.values());
    }

    function isSamePageMatchEntry(
        match: TPageMatchEntry,
        matchIndex: number,
        currentMatchValue: IPdfSearchMatch,
    ) {
        return matchIndex === currentMatchValue.pageMatchIndex
            || match.matchIndex === currentMatchValue.matchIndex
            || (
                match.start === currentMatchValue.startOffset
                && match.end === currentMatchValue.endOffset
            );
    }

    function resolveCurrentMatchWords(
        pageMatchData: IPdfPageMatches | null,
        currentMatchValue: IPdfSearchMatch | null,
        pageIndex: number,
    ): IOcrWord[] {
        if (!currentMatchValue || currentMatchValue.pageIndex !== pageIndex) {
            return [];
        }

        if (Array.isArray(currentMatchValue.words) && currentMatchValue.words.length > 0) {
            return currentMatchValue.words;
        }

        const currentPageMatch = pageMatchData?.matches.find((match, index) => (
            isSamePageMatchEntry(match, index, currentMatchValue)
        ));

        return currentPageMatch?.words ?? [];
    }

    function hasRenderableGeometryMatch(match: TPageMatchEntry): match is TPageMatchEntry & {
        pageHeight: number;
        pageWidth: number;
        words: IOcrWord[];
    } {
        return Array.isArray(match.words)
            && match.words.length > 0
            && typeof match.pageWidth === 'number'
            && Number.isFinite(match.pageWidth)
            && match.pageWidth > 0
            && typeof match.pageHeight === 'number'
            && Number.isFinite(match.pageHeight)
            && match.pageHeight > 0;
    }

    function hasRenderableCurrentMatchGeometry(
        currentMatchValue: IPdfSearchMatch | null,
        pageIndex: number,
    ): currentMatchValue is IPdfSearchMatch & {
        pageWidth: number;
        pageHeight: number;
        words: IOcrWord[];
    } {
        return Boolean(
            currentMatchValue
            && currentMatchValue.pageIndex === pageIndex
            && Array.isArray(currentMatchValue.words)
            && currentMatchValue.words.length > 0
            && typeof currentMatchValue.pageWidth === 'number'
            && Number.isFinite(currentMatchValue.pageWidth)
            && currentMatchValue.pageWidth > 0
            && typeof currentMatchValue.pageHeight === 'number'
            && Number.isFinite(currentMatchValue.pageHeight)
            && currentMatchValue.pageHeight > 0,
        );
    }

    function computeWordsGeometryHash(words: IOcrWord[] | undefined) {
        return words?.reduce((hash, word) => {
            let nextHash = hash;
            nextHash = Math.imul(nextHash ^ Math.round(word.x * 100), 16777619);
            nextHash = Math.imul(nextHash ^ Math.round(word.y * 100), 16777619);
            nextHash = Math.imul(nextHash ^ Math.round(word.width * 100), 16777619);
            nextHash = Math.imul(nextHash ^ Math.round(word.height * 100), 16777619);
            return nextHash >>> 0;
        }, 2166136261) ?? 0;
    }

    function buildCurrentMatchSignature(currentMatchValue: IPdfSearchMatch) {
        return [
            'current',
            currentMatchValue.matchIndex,
            currentMatchValue.pageMatchIndex ?? -1,
            currentMatchValue.startOffset,
            currentMatchValue.endOffset,
            currentMatchValue.words?.length ?? 0,
            computeWordsGeometryHash(currentMatchValue.words),
        ].join(':');
    }

    function isCurrentMatchForPage(
        currentMatchValue: IPdfSearchMatch | null,
        pageIndex: number | undefined,
    ): currentMatchValue is IPdfSearchMatch {
        return Boolean(currentMatchValue && currentMatchValue.pageIndex === pageIndex);
    }

    function buildPageHighlightSignature(
        pageMatchData: IPdfPageMatches | null,
        currentMatchValue: IPdfSearchMatch | null,
    ) {
        if (!pageMatchData || pageMatchData.matches.length === 0) {
            return isCurrentMatchForPage(currentMatchValue, pageMatchData?.pageIndex)
                ? `empty|current=${currentMatchValue.matchIndex}:${currentMatchValue.pageMatchIndex ?? -1}`
                : 'empty';
        }

        const parts: string[] = [pageMatchData.signatureToken ?? `${pageMatchData.pageIndex}:${pageMatchData.matches.length}`];

        if (isCurrentMatchForPage(currentMatchValue, pageMatchData.pageIndex)) {
            parts.push(buildCurrentMatchSignature(currentMatchValue));
        }

        return parts.join('|');
    }

    function renderWordBoxesForPageMatch(
        container: HTMLElement,
        pageMatchData: IPdfPageMatches | null,
        currentMatchValue: IPdfSearchMatch | null,
        pageIndex: number,
    ) {
        clearWordBoxes(container);

        if (!pageMatchData || pageMatchData.matches.length === 0) {
            return;
        }

        const geometryMatch = pageMatchData.matches.find(hasRenderableGeometryMatch);
        const currentGeometryMatch = hasRenderableCurrentMatchGeometry(currentMatchValue, pageIndex)
            ? currentMatchValue
            : null;
        const geometrySource = geometryMatch ?? currentGeometryMatch;
        if (!geometrySource) {
            logPdfNav(
                `[PDF-NAV] renderWordBoxesForPageMatch: page=${pageIndex + 1} no geometry source`
                + ` pageMatches=${pageMatchData.matches.length}`
                + ` pageWordMatches=${pageMatchData.matches.filter(match => Array.isArray(match.words) && match.words.length > 0).length}`
                + ` currentWords=${currentMatchValue?.words?.length ?? 0}`
                + ` currentPage=${currentMatchValue?.pageIndex ?? 'null'}`,
            );
            return;
        }

        const wordsByKey = new Map(collectWordsFromPageMatches(pageMatchData).map(word => [
            buildOcrWordKey(word),
            word,
        ]));
        currentGeometryMatch?.words.forEach((word) => {
            wordsByKey.set(buildOcrWordKey(word), word);
        });
        const allWords = Array.from(wordsByKey.values());
        const currentMatchWords = new Set<string>();
        resolveCurrentMatchWords(pageMatchData, currentMatchValue, pageIndex).forEach((word) => {
            currentMatchWords.add(buildOcrWordKey(word));
        });

        logPdfNav(
            `[PDF-NAV] renderWordBoxesForPageMatch: page=${pageIndex + 1}`
            + ` words=${allWords.length}`
            + ` currentWords=${currentMatchWords.size}`
            + ` source=${geometryMatch ? 'page' : 'current'}`
            + ` pageSize=${geometrySource.pageWidth.toFixed(2)}x${geometrySource.pageHeight.toFixed(2)}`,
        );

        renderPageWordBoxes(
            container,
            allWords,
            geometrySource.pageWidth,
            geometrySource.pageHeight,
            currentMatchWords.size > 0 ? currentMatchWords : undefined,
            geometrySource.rotation ?? 0,
        );
    }

    function hasPageMatchWordBoxes(pageMatchData: IPdfPageMatches | null) {
        return Boolean(pageMatchData?.matches.some(hasRenderableGeometryMatch));
    }

    function hasSearchGeometryForPage(
        pageMatchData: IPdfPageMatches | null,
        currentMatchValue: IPdfSearchMatch | null,
        pageIndex: number,
    ) {
        return hasPageMatchWordBoxes(pageMatchData)
            || hasRenderableCurrentMatchGeometry(currentMatchValue, pageIndex);
    }

    function hasRenderedSearchGeometry(
        container: HTMLElement,
        currentMatchValue: IPdfSearchMatch | null,
        pageIndex: number,
    ) {
        if (!container.querySelector('.pdf-word-box')) {
            return false;
        }

        if (currentMatchValue?.pageIndex === pageIndex) {
            return Boolean(container.querySelector('.pdf-word-box--current'));
        }

        return true;
    }

    function hasUsablePdfTextContent(textContent: IPdfTextContent | null) {
        return Boolean(textContent?.items.some(item => (
            'str' in item
            && String(item.str ?? '').trim().length > 0
        )));
    }

    async function getPdfjsTextContent(pdfPage: IPdfPage) {
        return pdfPage.getTextContent({
            includeMarkedContent: true,
            disableNormalization: true,
        });
    }

    async function getPdfjsTextContentSource(pdfPage: IPdfPage): Promise<TTextLayerTextContentSource> {
        if (typeof pdfPage.streamTextContent === 'function') {
            return pdfPage.streamTextContent({
                includeMarkedContent: true,
                disableNormalization: true,
            });
        }

        return getPdfjsTextContent(pdfPage);
    }

    function getCurrentTime() {
        return typeof performance !== 'undefined'
            ? performance.now()
            : Date.now();
    }

    function runPendingHighlightRefresh(
        flushSearchHighlightRefresh: (root: HTMLElement | null, refreshVersion: number) => void,
    ) {
        const pendingRoot = pageHighlightState.pendingRoot;
        pageHighlightState.pendingRoot = null;
        if (pendingRoot) {
            flushSearchHighlightRefresh(pendingRoot, pageHighlightState.refreshVersion);
        }
    }

    function shouldPauseHighlightRefreshSlice(processedPages: number, sliceStartedAt: number) {
        const elapsed = getCurrentTime() - sliceStartedAt;
        return processedPages >= HIGHLIGHT_REFRESH_MAX_PAGES_PER_SLICE
            || elapsed >= HIGHLIGHT_REFRESH_BUDGET_MS;
    }

    function pageHasSearchMatches(pageMatchData: IPdfPageMatches | null) {
        return Boolean(pageMatchData && pageMatchData.matches.length > 0);
    }

    function isTextLayerRendering(textLayerDiv: HTMLElement) {
        return textLayerDiv.dataset?.pdfTextLayerRendering === 'true';
    }

    function isTextLayerMarkedReady(textLayerDiv: HTMLElement) {
        return textLayerDiv.dataset?.pdfTextLayerReady === 'true';
    }

    function hasSearchableTextLayerContent(textLayerDiv: HTMLElement) {
        const textLength = (textLayerDiv.textContent ?? '').trim().length;
        return textLength > 0 && Boolean(textLayerDiv.querySelector?.('span'));
    }

    function shouldWaitForSearchTextLayer(
        textLayerDiv: HTMLElement,
        pageMatchData: IPdfPageMatches | null,
    ) {
        if (!pageHasSearchMatches(pageMatchData)) {
            return false;
        }

        if (isTextLayerRendering(textLayerDiv)) {
            return true;
        }

        if (isTextLayerMarkedReady(textLayerDiv)) {
            return false;
        }

        return !hasSearchableTextLayerContent(textLayerDiv);
    }

    function deferSearchHighlightsUntilTextLayerReady(
        pageNumber: number,
        textLayerDiv: HTMLElement,
        pageMatchData: IPdfPageMatches | null,
    ) {
        if (!shouldWaitForSearchTextLayer(textLayerDiv, pageMatchData)) {
            return false;
        }

        pageHighlightState.signatureByPage.delete(pageNumber);
        clearTextLayerIndexCache(textLayerDiv);
        return true;
    }

    function refreshSearchHighlightsForPage(
        container: HTMLElement,
        mountedPageNumber: number,
        pageMatchData: IPdfPageMatches | null,
        currentMatchValue: IPdfSearchMatch | null,
    ) {
        const pageIndex = mountedPageNumber - 1;
        const textLayerDiv = container.querySelector<HTMLElement>('.text-layer');
        if (!textLayerDiv) {
            pageHighlightState.signatureByPage.delete(mountedPageNumber);
            return;
        }

        const hasGeometryHighlights = hasSearchGeometryForPage(
            pageMatchData,
            currentMatchValue,
            pageIndex,
        );
        if (!hasGeometryHighlights && deferSearchHighlightsUntilTextLayerReady(
            mountedPageNumber,
            textLayerDiv,
            pageMatchData,
        )) {
            return;
        }

        const signature = buildPageHighlightSignature(pageMatchData, currentMatchValue);
        const previousSignature = pageHighlightState.signatureByPage.get(mountedPageNumber);
        if (
            previousSignature === signature
            && (!hasGeometryHighlights || hasRenderedSearchGeometry(container, currentMatchValue, pageIndex))
        ) {
            return;
        }

        const canvas = container.querySelector<HTMLCanvasElement>('canvas') ?? null;
        try {
            if (hasGeometryHighlights) {
                clearHighlights(textLayerDiv);
                renderWordBoxesForPageMatch(container, pageMatchData, currentMatchValue, pageIndex);
            } else if (pageMatchData && pageMatchData.matches.length > 0) {
                highlightPage(
                    textLayerDiv,
                    pageMatchData,
                    currentMatchValue,
                );
                clearWordBoxes(container);
            } else {
                clearHighlights(textLayerDiv);
                clearWordBoxes(container);
            }

            if (canvas) {
                maybeLogHighlightDebug(pageIndex + 1, pageMatchData, canvas, textLayerDiv);
            }
        } catch (error) {
            BrowserLogger.warn('pdf-text-layer', 'Failed to refresh search highlights', {
                pageNumber: mountedPageNumber,
                error,
            });
        }

        pageHighlightState.signatureByPage.set(mountedPageNumber, signature);
    }

    function scheduleSearchHighlightRefresh(containerRoot: HTMLElement) {
        const scheduleContinuation = (callback: () => void) => {
            if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
                callback();
                return;
            }

            pageHighlightState.continuationRafId = window.requestAnimationFrame(() => {
                pageHighlightState.continuationRafId = 0;
                callback();
            });
        };

        const flushSearchHighlightRefresh = (
            root: HTMLElement | null,
            refreshVersion: number,
        ) => {
            if (!root || ('isConnected' in root && root.isConnected === false)) {
                return;
            }

            const pageContainers = Array.from(root.querySelectorAll<HTMLElement>('.page_container'));
            const searchMatchesValue = toValue(deps.searchPageMatches);
            const currentMatchValue = toValue(deps.currentSearchMatch);
            let nextIndex = 0;

            const processSlice = () => {
                if (refreshVersion !== pageHighlightState.refreshVersion) {
                    runPendingHighlightRefresh(flushSearchHighlightRefresh);
                    return;
                }

                const sliceStartedAt = getCurrentTime();

                measureDevPerf('pdf:highlight-refresh-slice', () => {
                    let processedPages = 0;

                    while (nextIndex < pageContainers.length) {
                        const container = pageContainers[nextIndex]!;
                        nextIndex += 1;
                        processedPages += 1;

                        const mountedPageNumber = Number.parseInt(container.dataset.page ?? '', 10);
                        if (!Number.isFinite(mountedPageNumber) || mountedPageNumber < 1) {
                            continue;
                        }

                        const pageIndex = mountedPageNumber - 1;
                        const pageMatchData = searchMatchesValue?.get(pageIndex) ?? null;
                        refreshSearchHighlightsForPage(
                            container,
                            mountedPageNumber,
                            pageMatchData,
                            currentMatchValue,
                        );

                        if (shouldPauseHighlightRefreshSlice(processedPages, sliceStartedAt)) {
                            break;
                        }
                    }
                }, {
                    thresholdMs: 8,
                    details: {
                        mountedPages: pageContainers.length,
                        remainingPages: Math.max(0, pageContainers.length - nextIndex),
                    },
                });

                if (nextIndex < pageContainers.length) {
                    scheduleContinuation(processSlice);
                    return;
                }

                if (pageHighlightState.pendingRoot && pageHighlightState.pendingRoot !== root) {
                    runPendingHighlightRefresh(flushSearchHighlightRefresh);
                }
            };

            processSlice();
        };

        pageHighlightState.pendingRoot = containerRoot;
        pageHighlightState.refreshVersion += 1;

        if (pageHighlightState.continuationRafId !== 0) {
            return;
        }

        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
            const root = pageHighlightState.pendingRoot;
            pageHighlightState.pendingRoot = null;
            flushSearchHighlightRefresh(root, pageHighlightState.refreshVersion);
            return;
        }

        if (pageHighlightState.rafId !== 0) {
            return;
        }

        pageHighlightState.rafId = window.requestAnimationFrame(() => {
            pageHighlightState.rafId = 0;

            const root = pageHighlightState.pendingRoot;
            pageHighlightState.pendingRoot = null;
            flushSearchHighlightRefresh(root, pageHighlightState.refreshVersion);
        });
    }

    function isHighlightDebugEnabled() {
        return isHighlightDebugEnabledFromStorage();
    }

    function isHighlightDebugVerboseEnabled() {
        return isHighlightDebugVerboseEnabledFromStorage();
    }

    function getHighlightDebugGuard(
        pageNumber: number,
        pageMatchData: IPdfPageMatches | null,
    ): IHighlightDebugGuard | null {
        if (!isHighlightDebugEnabled()) {
            return null;
        }

        const current = toValue(deps.currentSearchMatch);
        if (!current || current.pageIndex !== pageNumber - 1) {
            return null;
        }

        const query = pageMatchData?.searchQuery ?? '';
        const scale = toValue(deps.effectiveScale);
        const key = `${current.pageIndex}:${current.matchIndex}:${query}:${scale}`;
        if (key === lastHighlightDebugKey) {
            return null;
        }
        lastHighlightDebugKey = key;

        return {
            current,
            query,
            scale,
        };
    }

    function formatHighlightDebugRect(rect: DOMRect) {
        return `${rect.left.toFixed(2)},${rect.top.toFixed(2)} ${rect.width.toFixed(2)}x${rect.height.toFixed(2)}`;
    }

    function getCurrentSpanDebugInfo(currentMark: HTMLElement | null) {
        if (!isHighlightDebugVerboseEnabled() || typeof window === 'undefined') {
            return '';
        }

        const span = currentMark?.closest('span');
        if (!span) {
            return '';
        }

        const spanStyle = window.getComputedStyle(span);
        const scaleX = spanStyle.getPropertyValue('--scale-x').trim();
        const fontHeight = spanStyle.getPropertyValue('--font-height').trim();
        return [
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

    function collectHighlightDebugRects(
        canvas: HTMLCanvasElement,
        textLayerDiv: HTMLElement,
    ): IHighlightDebugRects {
        const canvasRect = canvas.getBoundingClientRect();
        const textRect = textLayerDiv.getBoundingClientRect();
        const pageContainer = textLayerDiv.closest<HTMLElement>('.page_container');
        const containerRect = pageContainer?.getBoundingClientRect() ?? null;
        const canvasHostRect = pageContainer?.querySelector<HTMLElement>('.page_canvas')?.getBoundingClientRect() ?? null;
        const computedTotalScaleFactor = typeof window !== 'undefined'
            ? window.getComputedStyle(textLayerDiv).getPropertyValue(PDF_PAGE_SCALE_CSS_VARS.totalScaleFactor).trim()
            : '';

        const currentRange = getCurrentMatchRanges(textLayerDiv).at(0) ?? null;
        const currentRangeRect = currentRange?.getBoundingClientRect() ?? null;
        const currentMark = textLayerDiv.querySelector<HTMLElement>('.pdf-search-highlight--current');
        const currentMarkRect = currentMark?.getBoundingClientRect() ?? null;
        const highlightRect = currentRangeRect ?? currentMarkRect;
        const currentSpanInfo = getCurrentSpanDebugInfo(currentMark);

        return {
            canvasRect,
            textRect,
            containerRect,
            canvasHostRect,
            highlightRect,
            computedTotalScaleFactor,
            currentSpanInfo,
        };
    }

    function formatHighlightDebugInfo(
        debugInfo: IHighlightDebugInfo | undefined,
        computedTotalScaleFactor: string,
    ) {
        if (!debugInfo) {
            return [
                '',
                '',
                '',
                '',
            ];
        }

        return [
            `viewport=${debugInfo.viewportWidth.toFixed(2)}x${debugInfo.viewportHeight.toFixed(2)}`,
            `raw=${debugInfo.rawPageWidth.toFixed(2)}x${debugInfo.rawPageHeight.toFixed(2)} userUnit=${debugInfo.userUnit}`,
            `totalScale=${debugInfo.totalScaleFactor.toFixed(10)} cssVarTotal=${JSON.stringify(computedTotalScaleFactor)}`,
            `canvasPx=${debugInfo.canvasPixelWidth}x${debugInfo.canvasPixelHeight} renderScale=${debugInfo.renderScaleX.toFixed(6)}x${debugInfo.renderScaleY.toFixed(6)}`,
        ];
    }

    function buildHighlightDebugMessage(
        pageNumber: number,
        guard: IHighlightDebugGuard,
        rects: IHighlightDebugRects,
        debugInfo?: IHighlightDebugInfo,
    ) {
        const dx = rects.textRect.left - rects.canvasRect.left;
        const dy = rects.textRect.top - rects.canvasRect.top;
        const dw = rects.textRect.width - rects.canvasRect.width;
        const dh = rects.textRect.height - rects.canvasRect.height;
        const [
            viewportInfo,
            rawInfo,
            totalScaleInfo,
            canvasPixelInfo,
        ] = formatHighlightDebugInfo(debugInfo, rects.computedTotalScaleFactor);

        return [
            `page=${pageNumber}`,
            `matchIndex=${guard.current.matchIndex}`,
            `scale=${guard.scale}`,
            `query=${JSON.stringify(guard.query)}`,
            viewportInfo,
            rawInfo,
            totalScaleInfo,
            canvasPixelInfo,
            rects.containerRect ? `container=${formatHighlightDebugRect(rects.containerRect)}` : '',
            rects.canvasHostRect ? `canvasHost=${formatHighlightDebugRect(rects.canvasHostRect)}` : '',
            `canvas=${formatHighlightDebugRect(rects.canvasRect)}`,
            `textLayer=${formatHighlightDebugRect(rects.textRect)}`,
            `delta=${dx.toFixed(2)},${dy.toFixed(2)} ${dw.toFixed(2)}x${dh.toFixed(2)}`,
            rects.highlightRect ? `currentHighlight=${formatHighlightDebugRect(rects.highlightRect)}` : 'currentHighlight=null',
            rects.currentSpanInfo,
        ].join(' ');
    }

    function maybeLogHighlightDebug(
        pageNumber: number,
        pageMatchData: IPdfPageMatches | null,
        canvas: HTMLCanvasElement,
        textLayerDiv: HTMLElement,
        debugInfo?: IHighlightDebugInfo,
    ) {
        const guard = getHighlightDebugGuard(pageNumber, pageMatchData);
        if (!guard) {
            return;
        }

        BrowserLogger.debug(
            'PDF-HIGHLIGHT',
            buildHighlightDebugMessage(
                pageNumber,
                guard,
                collectHighlightDebugRects(canvas, textLayerDiv),
                debugInfo,
            ),
        );
    }

    async function renderTextLayer(
        pdfPage: IPdfPage,
        textLayerDiv: HTMLElement,
        viewport: ReturnType<IPdfPage['getViewport']>,
        _scale: number,
        _userUnit: number,
        _totalScaleFactor: number,
        signal?: AbortSignal,
        onBeforeRebuild?: () => void,
    ) {
        throwIfAborted(signal);

        const currentWorkingCopyPath = toValue(deps.workingCopyPath);
        const currentDocumentRevisionToken = toValue(deps.documentRevisionToken);

        const rendered = renderedTextLayers.get(textLayerDiv);
        if (
            rendered
            && rendered.pdfPage === pdfPage
            && rendered.workingCopyPath === currentWorkingCopyPath
            && rendered.documentRevisionToken === currentDocumentRevisionToken
        ) {
            rendered.textLayer.update({ viewport });
            return;
        }

        onBeforeRebuild?.();
        renderedTextLayers.delete(textLayerDiv);
        textLayerDiv.dataset.pdfTextLayerRendering = 'true';
        textLayerDiv.dataset.pdfTextLayerReady = 'false';
        clearHighlights(textLayerDiv);
        clearTextLayerTextMapping(textLayerDiv);
        textLayerDiv.innerHTML = '';
        // Mutable page scale belongs to the page shell. Layer-local copies can
        // outlive their render request and corrupt geometry after a fit change.
        textLayerDiv.style.removeProperty(PDF_PAGE_SCALE_CSS_VARS.scaleFactor);
        textLayerDiv.style.removeProperty(PDF_PAGE_SCALE_CSS_VARS.userUnit);
        textLayerDiv.style.removeProperty(PDF_PAGE_SCALE_CSS_VARS.totalScaleFactor);

        let textContentSource: TTextLayerTextContentSource | null = null;
        let hasOcrFallbackForPage = false;

        if (currentWorkingCopyPath && currentDocumentRevisionToken) {
            try {
                hasOcrFallbackForPage = await hasPageOcrData(
                    currentWorkingCopyPath,
                    currentDocumentRevisionToken,
                    pdfPage.pageNumber,
                );
                throwIfAborted(signal);
            } catch (ocrAvailabilityError) {
                if (signal?.aborted) {
                    throw ocrAvailabilityError;
                }
                BrowserLogger.warn('pdf-text-layer', 'OCR availability check failed', ocrAvailabilityError);
            }
        }

        if (hasOcrFallbackForPage) {
            const pdfjsTextContent = await getPdfjsTextContent(pdfPage);
            throwIfAborted(signal);

            if (hasUsablePdfTextContent(pdfjsTextContent)) {
                textContentSource = pdfjsTextContent;
            } else if (currentWorkingCopyPath && currentDocumentRevisionToken) {
                try {
                    const ocrTextContent = await getOcrTextContent(
                        currentWorkingCopyPath,
                        currentDocumentRevisionToken,
                        pdfPage.pageNumber,
                        viewport,
                    );
                    throwIfAborted(signal);
                    if (ocrTextContent) {
                        textContentSource = ocrTextContent;
                    }
                } catch (ocrError) {
                    if (signal?.aborted) {
                        throw ocrError;
                    }
                    BrowserLogger.warn('pdf-text-layer', 'OCR text content failed', ocrError);
                }
            }
        }

        textContentSource ??= await getPdfjsTextContentSource(pdfPage);
        throwIfAborted(signal);

        const textLayer = createPdfjsTextLayer({
            textContentSource,
            container: textLayerDiv,
            viewport,
        });
        const abortTextLayer = () => {
            textLayer.cancel();
        };
        signal?.addEventListener('abort', abortTextLayer, { once: true });
        try {
            await textLayer.render();
        } finally {
            signal?.removeEventListener('abort', abortTextLayer);
        }
        throwIfAborted(signal);
        registerTextLayerTextMapping(textLayerDiv, {
            textDivs: textLayer.textDivs,
            textContentItemsStr: textLayer.textContentItemsStr,
        });
        renderedTextLayers.set(textLayerDiv, {
            textLayer,
            pdfPage,
            workingCopyPath: currentWorkingCopyPath,
            documentRevisionToken: currentDocumentRevisionToken,
        });
        textLayerDiv.style.width = '';
        textLayerDiv.style.height = '';
        textLayerDiv.dataset.pdfTextLayerReady = 'true';
        delete textLayerDiv.dataset.pdfTextLayerRendering;
    }

    function setupTextLayerInteraction(textLayerDiv: HTMLElement) {
        return setupTextLayer(textLayerDiv);
    }

    function applyPageSearchHighlights(
        container: HTMLElement,
        textLayerDiv: HTMLElement,
        pageNumber: number,
        canvas: HTMLCanvasElement | null,
        debugInfo?: IHighlightDebugInfo,
    ) {
        const pageIndex = pageNumber - 1;
        const searchMatches = toValue(deps.searchPageMatches);
        const currentMatch = toValue(deps.currentSearchMatch) ?? null;
        if (!searchMatches || searchMatches.size === 0) {
            clearHighlights(textLayerDiv);
            clearWordBoxes(container);
            pageHighlightState.signatureByPage.set(pageNumber, buildPageHighlightSignature(null, currentMatch));
            return;
        }

        const pageMatchData = searchMatches.get(pageIndex) ?? null;
        if (!pageMatchData || pageMatchData.matches.length === 0) {
            clearHighlights(textLayerDiv);
            clearWordBoxes(container);
            pageHighlightState.signatureByPage.set(pageNumber, buildPageHighlightSignature(pageMatchData, currentMatch));
            return;
        }

        const hasGeometryHighlights = hasSearchGeometryForPage(
            pageMatchData,
            currentMatch,
            pageIndex,
        );
        if (!hasGeometryHighlights && deferSearchHighlightsUntilTextLayerReady(
            pageNumber,
            textLayerDiv,
            pageMatchData,
        )) {
            return;
        }

        const signature = buildPageHighlightSignature(pageMatchData, currentMatch);
        if (hasGeometryHighlights) {
            clearHighlights(textLayerDiv);
            renderWordBoxesForPageMatch(container, pageMatchData, currentMatch, pageIndex);
            if (canvas) {
                maybeLogHighlightDebug(pageNumber, pageMatchData, canvas, textLayerDiv, debugInfo);
            }
            pageHighlightState.signatureByPage.set(pageNumber, signature);
            return;
        }

        const highlightResult = highlightPage(
            textLayerDiv,
            pageMatchData,
            currentMatch,
        );
        if (canvas) {
            maybeLogHighlightDebug(pageNumber, pageMatchData, canvas, textLayerDiv, debugInfo);
        }

        const isCssHighlightMode = getHighlightMode() === 'css';
        const hasInTextHighlights = isCssHighlightMode
            || highlightResult.elements.length > 0
            || highlightResult.currentMatchRanges.length > 0;

        if (!hasInTextHighlights && pageMatchData && pageMatchData.matches.length > 0) {
            renderWordBoxesForPageMatch(container, pageMatchData, currentMatch, pageIndex);
        } else {
            clearWordBoxes(container);
        }

        pageHighlightState.signatureByPage.set(pageNumber, signature);
    }

    function applyAllSearchHighlights(containerRoot: HTMLElement) {
        scheduleSearchHighlightRefresh(containerRoot);
    }

    function scrollToCurrentMatch(containerRoot: HTMLElement) {
        function clampScrollTopToTargetPage(
            desiredTop: number,
            targetPageContainer: HTMLElement,
        ) {
            const computedStyle = typeof window !== 'undefined'
                ? window.getComputedStyle(containerRoot)
                : null;
            const paddingTop = Number.parseFloat(computedStyle?.paddingTop ?? '0') || 0;
            const paddingBottom = Number.parseFloat(computedStyle?.paddingBottom ?? '0') || 0;

            const minTop = Math.max(0, targetPageContainer.offsetTop - paddingTop);
            const pageBottom = targetPageContainer.offsetTop + targetPageContainer.offsetHeight + paddingBottom;
            const maxTop = Math.max(minTop, pageBottom - containerRoot.clientHeight);
            const clampedTop = clamp(desiredTop, minTop, maxTop);

            return {
                clampedTop,
                minTop,
                maxTop,
                paddingTop,
                paddingBottom,
            };
        }

        function scrollMatchRectIntoView(
            rect: DOMRect,
            targetPageContainer: HTMLElement,
            source: 'range' | 'mark',
        ) {
            const containerRect = containerRoot.getBoundingClientRect();
            const scrollTop = Number.isFinite(containerRoot.scrollTop) ? containerRoot.scrollTop : 0;
            const scrollLeft = Number.isFinite(containerRoot.scrollLeft) ? containerRoot.scrollLeft : 0;
            const clientWidth = Number.isFinite(containerRoot.clientWidth) && containerRoot.clientWidth > 0
                ? containerRoot.clientWidth
                : containerRect.width;
            const scrollWidth = Number.isFinite(containerRoot.scrollWidth) && containerRoot.scrollWidth > 0
                ? containerRoot.scrollWidth
                : clientWidth;
            const elementTop = rect.top - containerRect.top + scrollTop;
            const elementLeft = rect.left - containerRect.left + scrollLeft;
            const desiredTop = elementTop - containerRoot.clientHeight / 2 + rect.height / 2;
            const desiredLeft = elementLeft - clientWidth / 2 + rect.width / 2;
            const {
                clampedTop,
                minTop,
                maxTop,
                paddingTop,
                paddingBottom,
            } = clampScrollTopToTargetPage(desiredTop, targetPageContainer);
            const maxLeft = Math.max(0, scrollWidth - clientWidth);
            const clampedLeft = clamp(desiredLeft, 0, maxLeft);

            logPdfNav(
                `[PDF-NAV] scrollToCurrentMatch (${source}): scrollTop=${scrollTop.toFixed(1)}`
                + ` scrollLeft=${scrollLeft.toFixed(1)}`
                + ` rect.top=${rect.top.toFixed(1)} containerRect.top=${containerRect.top.toFixed(1)}`
                + ` rect.left=${rect.left.toFixed(1)} containerRect.left=${containerRect.left.toFixed(1)}`
                + ` elementTop=${elementTop.toFixed(1)} desiredTop=${desiredTop.toFixed(1)}`
                + ` clampedTop=${clampedTop.toFixed(1)} pageMin=${minTop.toFixed(1)}`
                + ` pageMax=${maxTop.toFixed(1)} padTop=${paddingTop.toFixed(1)}`
                + ` padBottom=${paddingBottom.toFixed(1)}`
                + ` elementLeft=${elementLeft.toFixed(1)} desiredLeft=${desiredLeft.toFixed(1)}`
                + ` clampedLeft=${clampedLeft.toFixed(1)} maxLeft=${maxLeft.toFixed(1)}`,
            );

            applyPdfViewportWrite(deps.viewportWritePort, containerRoot, {
                intentId: 'search-match-arrival',
                reason: 'search-match-arrival',
                top: clampedTop,
                left: clampedLeft,
            });
        }

        function getCurrentGeometryMatchRect(
            targetContainer: HTMLElement,
            pageMatchData: IPdfPageMatches | null,
            currentMatchValue: IPdfSearchMatch,
            pageIndex: number,
        ) {
            const currentWords = resolveCurrentMatchWords(pageMatchData, currentMatchValue, pageIndex);
            if (currentWords.length === 0) {
                return null;
            }

            const canvas = targetContainer.querySelector<HTMLCanvasElement>('canvas');
            if (!canvas) {
                return null;
            }

            const geometryMatch = pageMatchData?.matches.find((match, index) => (
                hasRenderableGeometryMatch(match)
                && isSamePageMatchEntry(match, index, currentMatchValue)
            )) ?? pageMatchData?.matches.find(hasRenderableGeometryMatch);
            const pageWidth = currentMatchValue.pageWidth ?? geometryMatch?.pageWidth;
            const pageHeight = currentMatchValue.pageHeight ?? geometryMatch?.pageHeight;
            if (!pageWidth || !pageHeight) {
                return null;
            }

            const canvasRect = canvas.getBoundingClientRect();
            const renderedPageWidth = canvas.offsetWidth || canvasRect.width;
            const renderedPageHeight = canvas.offsetHeight || canvasRect.height;
            const boxes = currentWords
                .map(word => transformWordBox(
                    word,
                    pageWidth,
                    pageHeight,
                    renderedPageWidth,
                    renderedPageHeight,
                    currentMatchValue.rotation ?? geometryMatch?.rotation ?? 0,
                ))
                .filter(box => box.width > 0 || box.height > 0);

            if (boxes.length === 0) {
                return null;
            }

            const left = Math.min(...boxes.map(box => box.x));
            const top = Math.min(...boxes.map(box => box.y));
            const right = Math.max(...boxes.map(box => box.x + box.width));
            const bottom = Math.max(...boxes.map(box => box.y + box.height));

            return new DOMRect(
                canvasRect.left + left,
                canvasRect.top + top,
                Math.max(0, right - left),
                Math.max(0, bottom - top),
            );
        }
        const currentMatchValue = toValue(deps.currentSearchMatch);
        if (!currentMatchValue) {
            logPdfNav('[PDF-NAV] scrollToCurrentMatch: no current search match');
            return false;
        }
        const pageIndex = currentMatchValue.pageIndex;
        const targetContainer = getPageContainer(containerRoot, pageIndex);
        if (!targetContainer) {
            const mountedPages = Array.from(
                containerRoot.querySelectorAll<HTMLElement>('.page_container'),
            )
                .map(page => page.dataset.page ?? '?')
                .slice(0, 20)
                .join(',');
            logPdfNav(
                `[PDF-NAV] scrollToCurrentMatch: target page=${pageIndex + 1} not mounted`
                + ` mountedPages=[${mountedPages}]`,
            );
            return false;
        }
        const textLayerDiv = targetContainer.querySelector<HTMLElement>('.text-layer');
        if (!textLayerDiv) {
            logPdfNav(
                `[PDF-NAV] scrollToCurrentMatch: page=${pageIndex + 1} has no text-layer`,
            );
            return false;
        }
        const pageMatchData = toValue(deps.searchPageMatches)?.get(pageIndex) ?? null;
        refreshSearchHighlightsForPage(
            targetContainer,
            pageIndex + 1,
            pageMatchData,
            currentMatchValue,
        );

        const currentWordBox = targetContainer.querySelector<HTMLElement>('.pdf-word-box--current');
        if (currentWordBox) {
            const wordBoxRect = currentWordBox.getBoundingClientRect();
            if (wordBoxRect.width > 0 || wordBoxRect.height > 0) {
                scrollMatchRectIntoView(wordBoxRect, targetContainer, 'mark');
                return true;
            }
        }

        const geometryRect = getCurrentGeometryMatchRect(
            targetContainer,
            pageMatchData,
            currentMatchValue,
            pageIndex,
        );
        if (geometryRect && (geometryRect.width > 0 || geometryRect.height > 0)) {
            scrollMatchRectIntoView(geometryRect, targetContainer, 'mark');
            return true;
        }

        const currentHighlight = textLayerDiv.querySelector<HTMLElement>('.pdf-search-highlight--current');
        if (!currentHighlight) {
            const currentRanges = getCurrentMatchRanges(textLayerDiv);
            const range = currentRanges.at(0) ?? null;
            if (!range) {
                logPdfNav(
                    `[PDF-NAV] scrollToCurrentMatch: page=${pageIndex + 1} no current highlight and no ranges`,
                );
                return false;
            }

            const rect = range.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) {
                logPdfNav(
                    `[PDF-NAV] scrollToCurrentMatch: page=${pageIndex + 1} range rect empty`,
                );
                return false;
            }

            scrollMatchRectIntoView(rect, targetContainer, 'range');
            return true;
        }

        const highlightRect = currentHighlight.getBoundingClientRect();
        if (highlightRect.width === 0 && highlightRect.height === 0) {
            logPdfNav(
                `[PDF-NAV] scrollToCurrentMatch: page=${pageIndex + 1} current highlight rect empty`,
            );
            return false;
        }

        scrollMatchRectIntoView(highlightRect, targetContainer, 'mark');
        return true;
    }

    function cleanupTextLayerDom(textLayerDiv: HTMLElement) {
        renderedTextLayers.delete(textLayerDiv);
        clearHighlights(textLayerDiv);
        textLayerDiv.innerHTML = '';
        clearTextLayerTextMapping(textLayerDiv);
        delete textLayerDiv.dataset.pdfTextLayerRendering;
        delete textLayerDiv.dataset.pdfTextLayerReady;

        const pageContainer = textLayerDiv.closest<HTMLElement>('.page_container');
        const pageNumber = Number.parseInt(pageContainer?.dataset.page ?? '', 10);
        if (Number.isFinite(pageNumber) && pageNumber > 0) {
            pageHighlightState.signatureByPage.delete(pageNumber);
        }
    }

    function clearOcrDebug(container: HTMLElement) {
        clearOcrDebugBoxes(container);
    }

    function scheduleRenderOcrDebugBoxes(
        container: HTMLElement,
        pageNumber: number,
        wcPath: string,
        documentRevisionToken: TDocumentRevisionToken,
        viewport: ReturnType<IPdfPage['getViewport']>,
        rawPageWidth: number,
        rawPageHeight: number,
    ) {
        guardAsync(
            renderOcrDebugBoxes(
                container,
                pageNumber,
                wcPath,
                documentRevisionToken,
                viewport,
                rawPageWidth,
                rawPageHeight,
            ),
            {
                category: 'background-diagnostic',
                scope: 'pdf-renderer',
                message: `Failed to render OCR debug overlays for page ${pageNumber}`,
            },
        );
    }

    function scheduleOcrDebugForPage(
        pageNumber: number,
        context: {
            container: HTMLElement;
            renderResult: {
                viewport: ReturnType<IPdfPage['getViewport']>;
                rawDims: {
                    pageWidth: number;
                    pageHeight: number;
                };
            };
        },
    ) {
        if (!isOcrDebugEnabled()) {
            return;
        }

        const wcPath = toValue(deps.workingCopyPath);
        const documentRevisionToken = toValue(deps.documentRevisionToken);
        if (!wcPath || !documentRevisionToken) {
            return;
        }

        const {
            viewport,
            rawDims,
        } = context.renderResult;
        scheduleRenderOcrDebugBoxes(
            context.container,
            pageNumber,
            wcPath,
            documentRevisionToken,
            viewport,
            rawDims.pageWidth,
            rawDims.pageHeight,
        );
    }

    return {
        renderTextLayer,
        setupTextLayerInteraction,
        applyPageSearchHighlights,
        applyAllSearchHighlights,
        scrollToCurrentMatch,
        cleanupTextLayerDom,
        clearOcrDebug,
        isOcrDebugEnabled,
        renderOcrDebugBoxes,
        scheduleRenderOcrDebugBoxes,
        scheduleOcrDebugForPage,
        getCurrentMatchRanges,
    };
};
