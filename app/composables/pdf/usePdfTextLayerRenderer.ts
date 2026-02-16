import { TextLayer } from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import {
    toValue,
    type MaybeRefOrGetter,
} from 'vue';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdf';
import { usePdfSearchHighlight } from '@app/composables/usePdfSearchHighlight';
import { useTextLayerSelection } from '@app/composables/useTextLayerSelection';
import { usePdfWordBoxes } from '@app/composables/usePdfWordBoxes';
import { useOcrTextContent } from '@app/composables/pdf/useOcrTextContent';
import {
    getHighlightMode,
    isHighlightDebugEnabled as isHighlightDebugEnabledFromStorage,
    isHighlightDebugVerboseEnabled as isHighlightDebugVerboseEnabledFromStorage,
} from '@app/composables/pdfSearchHighlightCss';
import { BrowserLogger } from '@app/utils/browser-logger';

interface IHighlightDebugInfo {
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
}

export const usePdfTextLayerRenderer = (deps: {
    searchPageMatches: MaybeRefOrGetter<Map<number, IPdfPageMatches>>;
    currentSearchMatch: MaybeRefOrGetter<IPdfSearchMatch | null>;
    workingCopyPath: MaybeRefOrGetter<string | null>;
    effectiveScale: MaybeRefOrGetter<number>;
}) => {
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

    let lastHighlightDebugKey: string | null = null;

    function buildWordKey(word: {
        text: string;
        x: number;
        y: number;
        width: number;
        height: number;
    }) {
        return `${word.text}|${word.x}|${word.y}|${word.width}|${word.height}`;
    }

    function collectWordsFromPageMatches(pageMatchData: IPdfPageMatches) {
        const wordsByKey = new Map<string, NonNullable<NonNullable<IPdfPageMatches['matches'][number]['words']>[number]>>();

        pageMatchData.matches.forEach((match) => {
            match.words?.forEach((word) => {
                wordsByKey.set(buildWordKey(word), word);
            });
        });

        return Array.from(wordsByKey.values());
    }

    function isHighlightDebugEnabled() {
        return isHighlightDebugEnabledFromStorage();
    }

    function isHighlightDebugVerboseEnabled() {
        return isHighlightDebugVerboseEnabledFromStorage();
    }

    function maybeLogHighlightDebug(
        pageNumber: number,
        pageMatchData: IPdfPageMatches | null,
        canvas: HTMLCanvasElement,
        textLayerDiv: HTMLElement,
        debugInfo?: IHighlightDebugInfo,
    ) {
        if (!isHighlightDebugEnabled()) {
            return;
        }

        const current = toValue(deps.currentSearchMatch);
        if (!current || current.pageIndex !== pageNumber - 1) {
            return;
        }

        const query = pageMatchData?.searchQuery ?? '';
        const key = `${current.pageIndex}:${current.matchIndex}:${query}:${toValue(deps.effectiveScale)}`;
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

        const scale = toValue(deps.effectiveScale);
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

    async function renderTextLayer(
        pdfPage: PDFPageProxy,
        textLayerDiv: HTMLElement,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        scale: number,
        userUnit: number,
        totalScaleFactor: number,
    ) {
        textLayerDiv.innerHTML = '';
        textLayerDiv.style.setProperty('--scale-factor', String(scale));
        textLayerDiv.style.setProperty('--user-unit', String(userUnit));
        textLayerDiv.style.setProperty('--total-scale-factor', String(totalScaleFactor));

        const currentWorkingCopyPath = toValue(deps.workingCopyPath);
        let textContent = null;

        if (currentWorkingCopyPath) {
            try {
                const ocrTextContent = await getOcrTextContent(
                    currentWorkingCopyPath,
                    pdfPage.pageNumber,
                    viewport,
                );
                if (ocrTextContent) {
                    textContent = ocrTextContent;
                }
            } catch (ocrError) {
                BrowserLogger.warn('pdf-text-layer', 'OCR text content failed', ocrError);
            }
        }

        if (!textContent) {
            textContent = await pdfPage.getTextContent({
                includeMarkedContent: true,
                disableNormalization: true,
            });
        }

        const textLayer = new TextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport,
        });
        await textLayer.render();
        textLayerDiv.style.width = '';
        textLayerDiv.style.height = '';
    }

    function setupTextLayerInteraction(textLayerDiv: HTMLElement) {
        return setupTextLayer(textLayerDiv);
    }

    function applyPageSearchHighlights(
        container: HTMLElement,
        textLayerDiv: HTMLElement,
        pageNumber: number,
        canvas: HTMLCanvasElement,
        debugInfo?: IHighlightDebugInfo,
    ) {
        const pageIndex = pageNumber - 1;
        const searchMatches = toValue(deps.searchPageMatches);
        if (!searchMatches || searchMatches.size === 0) {
            return;
        }

        const pageMatchData = searchMatches.get(pageIndex) ?? null;
        const highlightResult = highlightPage(
            textLayerDiv,
            pageMatchData,
            toValue(deps.currentSearchMatch) ?? null,
        );
        maybeLogHighlightDebug(pageNumber, pageMatchData, canvas, textLayerDiv, debugInfo);

        const isCssHighlightMode = getHighlightMode() === 'css';
        const hasInTextHighlights = isCssHighlightMode
            || highlightResult.elements.length > 0
            || highlightResult.currentMatchRanges.length > 0;

        if (!hasInTextHighlights && pageMatchData && pageMatchData.matches.length > 0) {
            const firstMatch = pageMatchData.matches.at(0);
            const firstMatchWords = firstMatch?.words ?? [];

            if (firstMatch && firstMatchWords.length > 0) {
                const allWords = collectWordsFromPageMatches(pageMatchData);

                const currentMatch = toValue(deps.currentSearchMatch);
                const currentMatchWords = new Set<string>();
                if (currentMatch && currentMatch.pageIndex === pageIndex && currentMatch.words) {
                    currentMatch.words.forEach((word) => {
                        currentMatchWords.add(word.text);
                    });
                }

                renderPageWordBoxes(
                    container,
                    allWords,
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

    function applyAllSearchHighlights(containerRoot: HTMLElement) {
        const pageContainers = containerRoot.querySelectorAll<HTMLElement>('.page_container');
        const searchMatchesValue = toValue(deps.searchPageMatches);
        const currentMatchValue = toValue(deps.currentSearchMatch);

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

            if (pageMatches && pageMatches.matches.length > 0) {
                const firstMatch = pageMatches.matches.at(0);
                const firstMatchWords = firstMatch?.words ?? [];
                if (firstMatch && firstMatchWords.length > 0) {
                    const allWords = collectWordsFromPageMatches(pageMatches);

                    const currentMatchWords = new Set<string>();
                    if (currentMatchValue && currentMatchValue.pageIndex === pageIndex && currentMatchValue.words) {
                        currentMatchValue.words.forEach((word) => {
                            currentMatchWords.add(word.text);
                        });
                    }

                    renderPageWordBoxes(
                        container,
                        allWords,
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

    function scrollToCurrentMatch(containerRoot: HTMLElement, behavior: ScrollBehavior = 'auto') {
        const currentMatchValue = toValue(deps.currentSearchMatch);
        if (!currentMatchValue) {
            return false;
        }

        const pageIndex = currentMatchValue.pageIndex;
        const targetContainer = containerRoot.querySelector<HTMLElement>(`.page_container[data-page="${pageIndex + 1}"]`)
            ?? containerRoot.querySelectorAll<HTMLElement>('.page_container')[pageIndex]
            ?? null;

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

        scrollToHighlight(currentHighlight, containerRoot, behavior);
        return true;
    }

    function cleanupTextLayerDom(textLayerDiv: HTMLElement) {
        clearHighlights(textLayerDiv);
        textLayerDiv.innerHTML = '';
    }

    function clearOcrDebug(container: HTMLElement) {
        clearOcrDebugBoxes(container);
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
        getCurrentMatchRanges,
    };
};
