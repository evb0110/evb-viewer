import type {
    IPdfPage,
    IPdfTextContent,
    IPdfViewport,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    pageNumberToPageIndex,
    requirePageNumber,
    type TPageIndex,
    type TPageNumber,
} from '@contracts/pageNumbers';
import type { TDocumentRef } from '@contracts/documentRef';
import type { MaybeRefOrGetter } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
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
    IPageHighlightSignatureState,
    TPageMatchEntry,
    TTextLayerTextContentSource,
} from '@app/modules/pdf-viewer/runtime/composables/pdf/pdfTextLayerRendererTypes';
import { getHighlightMode } from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightCss';
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
    createPdfjsStructTreeLayer,
    createPdfjsTextLayer,
    type IPdfStructTreeLayer,
    type IPdfTextLayer,
} from '@app/services/pdfjs/pdfViewerFacade';
import { PDF_PAGE_SCALE_CSS_VARS } from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';
const HIGHLIGHT_REFRESH_BUDGET_MS = 8;
const HIGHLIGHT_REFRESH_MAX_PAGES_PER_SLICE = 4;
/** What a text-layer element holds; `textLayer` is set once its spans are complete. */
interface IRenderedTextLayer {
    textLayer: IPdfTextLayer | null;
    structTreeDom: HTMLElement | null;
    pdfPage: IPdfPage;
    viewport: IPdfViewport;
    workingCopyPath: TDocumentRef | null;
    documentRevisionToken: TDocumentRevisionToken | null;
}

// One record per text-layer element. A rebuild replaces the record, so an
// older render of the same element knows it no longer owns it.
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
    workingCopyPath: MaybeRefOrGetter<TDocumentRef | null>;
    documentRevisionToken: MaybeRefOrGetter<TDocumentRevisionToken | null>;
}) => {
    const { setupTextLayer, teardownTextLayer } = useTextLayerSelection();
    const {
        clearHighlights,
        highlightPage,
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
        pageIndex: TPageIndex,
    ): readonly IOcrWord[] {
        if (!currentMatchValue || currentMatchValue.pageIndex !== pageIndex) {
            return [];
        }

        if (currentMatchValue.words && currentMatchValue.words.length > 0) {
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
        words: readonly IOcrWord[];
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
        pageIndex: TPageIndex,
    ): currentMatchValue is IPdfSearchMatch & {
        pageWidth: number;
        pageHeight: number;
        words: readonly IOcrWord[];
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

    function computeWordsGeometryHash(words: readonly IOcrWord[] | undefined) {
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
        pageIndex: TPageIndex | undefined,
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
        pageIndex: TPageIndex,
        viewport?: IPdfViewport,
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
            viewport,
        );
    }

    function hasPageMatchWordBoxes(pageMatchData: IPdfPageMatches | null) {
        return Boolean(pageMatchData?.matches.some(hasRenderableGeometryMatch));
    }

    function hasSearchGeometryForPage(
        pageMatchData: IPdfPageMatches | null,
        currentMatchValue: IPdfSearchMatch | null,
        pageIndex: TPageIndex,
    ) {
        return hasPageMatchWordBoxes(pageMatchData)
            || hasRenderableCurrentMatchGeometry(currentMatchValue, pageIndex);
    }

    function hasRenderedSearchGeometry(
        container: HTMLElement,
        currentMatchValue: IPdfSearchMatch | null,
        pageIndex: TPageIndex,
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

    function exposeMarkedContentNames(structure: HTMLElement, textLayerDiv: HTMLElement) {
        for (const element of structure.querySelectorAll<HTMLElement>('[aria-owns]')) {
            const ownedIds = element.getAttribute('aria-owns')?.split(/\s+/u).filter(Boolean) ?? [];
            const text = ownedIds
                .map(id => textLayerDiv.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.textContent ?? '')
                .join(' ')
                .replace(/\s+/gu, ' ')
                .trim();
            if (text && !element.hasAttribute('aria-label')) {
                element.setAttribute('aria-label', text);
            }
        }
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

    // The page resource marks a text layer ready once its page accepted it.
    function isTextLayerReady(textLayerDiv: HTMLElement) {
        return textLayerDiv.dataset?.pdfTextLayerReady === 'true';
    }

    function deferSearchHighlightsUntilTextLayerReady(
        pageNumber: number,
        textLayerDiv: HTMLElement,
        pageMatchData: IPdfPageMatches | null,
    ) {
        if (!pageHasSearchMatches(pageMatchData) || isTextLayerReady(textLayerDiv)) {
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
        currentMatchPresentationReady: boolean,
    ) {
        const pageIndex = pageNumberToPageIndex(requirePageNumber(mountedPageNumber));
        const textLayerDiv = container.querySelector<HTMLElement>('.text-layer');
        if (!textLayerDiv) {
            pageHighlightState.signatureByPage.delete(mountedPageNumber);
            return;
        }

        // A search navigation changes the current mark before the target page's
        // text layer has committed. Keep the outgoing current mark until the
        // target can paint its replacement. Clearing it here exposes a stale
        // page with no visible match during the real compositor handoff.
        const targetPageNumber = currentMatchValue
            ? currentMatchValue.pageIndex + 1
            : null;
        if (
            !currentMatchPresentationReady
            && targetPageNumber !== null
            && mountedPageNumber !== targetPageNumber
            && container.querySelector('.pdf-search-highlight--current')
        ) {
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

        const signature = buildPageHighlightSignature(pageMatchData, hasGeometryHighlights ? currentMatchValue : null);
        const previousSignature = pageHighlightState.signatureByPage.get(mountedPageNumber);
        if (
            previousSignature === signature
            && (!hasGeometryHighlights || hasRenderedSearchGeometry(container, currentMatchValue, pageIndex))
        ) {
            if (!hasGeometryHighlights) highlightPage(textLayerDiv, pageMatchData, currentMatchValue);
            return;
        }

        try {
            if (hasGeometryHighlights) {
                clearHighlights(textLayerDiv);
                renderWordBoxesForPageMatch(
                    container,
                    pageMatchData,
                    currentMatchValue,
                    pageIndex,
                    renderedTextLayers.get(textLayerDiv)?.viewport,
                );
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
            const currentMatchPresentationReady = currentMatchValue === null
                || Array.from(root.querySelectorAll<HTMLElement>('.page_container')).some(pageContainer => {
                    if (pageContainer.dataset.page !== String(currentMatchValue.pageIndex + 1)) {
                        return false;
                    }
                    const textLayerDiv = pageContainer.querySelector<HTMLElement>('.text-layer');
                    return textLayerDiv !== null && isTextLayerReady(textLayerDiv);
                });
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

                        const pageIndex = pageNumberToPageIndex(requirePageNumber(mountedPageNumber));
                        const pageMatchData = searchMatchesValue?.get(pageIndex) ?? null;
                        refreshSearchHighlightsForPage(
                            container,
                            mountedPageNumber,
                            pageMatchData,
                            currentMatchValue,
                            currentMatchPresentationReady,
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

    function canReuseTextLayer(pdfPage: IPdfPage, textLayerDiv: HTMLElement) {
        const rendered = renderedTextLayers.get(textLayerDiv);
        return Boolean(rendered?.textLayer
            && rendered.pdfPage === pdfPage
            && rendered.workingCopyPath === toValue(deps.workingCopyPath)
            && rendered.documentRevisionToken === toValue(deps.documentRevisionToken));
    }

    /**
     * Renders the page's text into `textLayerDiv`. A scale or rotation step
     * updates the mounted spans in place, so selections survive it; a content
     * change rebuilds them. A rebuild that fails or is cancelled clears what it
     * started, unless a newer render took the element over.
     */
    async function renderTextLayer(
        pdfPage: IPdfPage,
        textLayerDiv: HTMLElement,
        viewport: ReturnType<IPdfPage['getViewport']>,
        signal?: AbortSignal,
    ) {
        throwIfAborted(signal);

        const rendered = renderedTextLayers.get(textLayerDiv);
        if (rendered?.textLayer && canReuseTextLayer(pdfPage, textLayerDiv)) {
            rendered.textLayer.update({ viewport });
            rendered.viewport = viewport;
            return;
        }

        cleanupTextLayerDom(textLayerDiv);
        const record: IRenderedTextLayer = {
            textLayer: null,
            structTreeDom: null,
            pdfPage,
            viewport,
            workingCopyPath: toValue(deps.workingCopyPath),
            documentRevisionToken: toValue(deps.documentRevisionToken),
        };
        renderedTextLayers.set(textLayerDiv, record);
        textLayerDiv.closest<HTMLElement>('.page_container')
            ?.querySelector<HTMLElement>('.structTree')
            ?.remove();
        // Mutable page scale belongs to the page shell. Layer-local copies can
        // outlive their render request and corrupt geometry after a fit change.
        textLayerDiv.style.removeProperty(PDF_PAGE_SCALE_CSS_VARS.scaleFactor);
        textLayerDiv.style.removeProperty(PDF_PAGE_SCALE_CSS_VARS.userUnit);
        textLayerDiv.style.removeProperty(PDF_PAGE_SCALE_CSS_VARS.totalScaleFactor);
        try {
            await buildTextLayer(record, textLayerDiv, signal);
        } catch (error) {
            if (renderedTextLayers.get(textLayerDiv) === record) cleanupTextLayerDom(textLayerDiv);
            throw error;
        }
    }

    async function resolveTextContentSource(record: IRenderedTextLayer, signal?: AbortSignal): Promise<TTextLayerTextContentSource> {
        const {pdfPage, viewport, workingCopyPath, documentRevisionToken} = record;
        const pageNumber = requirePageNumber(pdfPage.pageNumber);
        if (!workingCopyPath || !documentRevisionToken) return getPdfjsTextContentSource(pdfPage);
        let hasOcrFallbackForPage = false;
        try {
            hasOcrFallbackForPage = await hasPageOcrData(workingCopyPath, documentRevisionToken, pageNumber);
            throwIfAborted(signal);
        } catch (ocrAvailabilityError) {
            if (signal?.aborted) {
                throw ocrAvailabilityError;
            }
            BrowserLogger.warn('pdf-text-layer', 'OCR availability check failed', ocrAvailabilityError);
        }
        if (!hasOcrFallbackForPage) return getPdfjsTextContentSource(pdfPage);
        // Native PDF text wins; OCR text stands in only for a page without any.
        const pdfjsTextContent = await getPdfjsTextContent(pdfPage);
        throwIfAborted(signal);
        if (hasUsablePdfTextContent(pdfjsTextContent)) return pdfjsTextContent;
        try {
            const ocrTextContent = await getOcrTextContent(workingCopyPath, documentRevisionToken, pageNumber, viewport);
            throwIfAborted(signal);
            if (ocrTextContent) return ocrTextContent;
        } catch (ocrError) {
            if (signal?.aborted) {
                throw ocrError;
            }
            BrowserLogger.warn('pdf-text-layer', 'OCR text content failed', ocrError);
        }
        return getPdfjsTextContentSource(pdfPage);
    }

    async function buildTextLayer(record: IRenderedTextLayer, textLayerDiv: HTMLElement, signal?: AbortSignal) {
        const {pdfPage, viewport} = record;
        const textContentSource = await resolveTextContentSource(record, signal);
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

        let structTreeLayer: IPdfStructTreeLayer | undefined;
        let structTreeDom: HTMLElement | null = null;
        if (typeof pdfPage.getStructTree === 'function') {
            try {
                structTreeLayer = await createPdfjsStructTreeLayer({
                    page: pdfPage,
                    rawDims: viewport.rawDims,
                });
                const renderedStructure = await structTreeLayer.render();
                structTreeDom = typeof HTMLElement !== 'undefined' && renderedStructure instanceof HTMLElement
                    ? renderedStructure
                    : null;
            } catch (structureError) {
                if (!signal?.aborted) {
                    BrowserLogger.warn('pdf-text-layer', 'PDF structure tree unavailable', structureError);
                }
                structTreeDom = null;
            }
        }

        // A render that waited on optional structure past a cleanup or a newer
        // render of this element publishes nothing.
        if (renderedTextLayers.get(textLayerDiv) !== record) {
            throw createAbortError();
        }
        throwIfAborted(signal);
        if (structTreeLayer && structTreeDom) {
            structTreeLayer.updateTextLayer();
            exposeMarkedContentNames(structTreeDom, textLayerDiv);
            const structureHost = textLayerDiv.closest<HTMLElement>('.page_container')
                ?.querySelector<HTMLElement>('.page_canvas__render-layer, .page_canvas');
            structureHost?.append(structTreeDom);
        }

        registerTextLayerTextMapping(textLayerDiv, {
            textDivs: textLayer.textDivs,
            textContentItemsStr: textLayer.textContentItemsStr,
        });
        record.structTreeDom = structTreeDom;
        record.textLayer = textLayer;
        setupTextLayer(textLayerDiv);
    }

    function applyPageSearchHighlights(
        container: HTMLElement,
        textLayerDiv: HTMLElement,
        pageNumber: number,
        viewport?: IPdfViewport,
    ) {
        const pageIndex = pageNumberToPageIndex(requirePageNumber(pageNumber));
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

        const signature = buildPageHighlightSignature(pageMatchData, hasGeometryHighlights ? currentMatch : null);
        if (hasGeometryHighlights) {
            clearHighlights(textLayerDiv);
            renderWordBoxesForPageMatch(container, pageMatchData, currentMatch, pageIndex, viewport);
            pageHighlightState.signatureByPage.set(pageNumber, signature);
            return;
        }

        const highlightResult = highlightPage(
            textLayerDiv,
            pageMatchData,
            currentMatch,
        );

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

    /** The one teardown of a text-layer element: selection, spans, structure and mapping. */
    function cleanupTextLayerDom(textLayerDiv: HTMLElement) {
        teardownTextLayer(textLayerDiv);
        const rendered = renderedTextLayers.get(textLayerDiv);
        rendered?.structTreeDom?.remove();
        renderedTextLayers.delete(textLayerDiv);
        clearHighlights(textLayerDiv);
        textLayerDiv.innerHTML = '';
        clearTextLayerTextMapping(textLayerDiv);

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
        pageNumber: TPageNumber,
        wcPath: TDocumentRef,
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
        pageNumber: TPageNumber,
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
        canReuseTextLayer,
        renderTextLayer,
        applyPageSearchHighlights,
        applyAllSearchHighlights,
        cleanupTextLayerDom,
        clearOcrDebug,
        isOcrDebugEnabled,
        renderOcrDebugBoxes,
        scheduleRenderOcrDebugBoxes,
        scheduleOcrDebugForPage,
    };
};
