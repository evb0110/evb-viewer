import type { TPageIndex } from '@contracts/pageNumbers';

import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import {
    assembleTextLayerSearchText,
    buildRunMatchOverlaps,
    clearDomHighlights,
    getCachedTextLayerIndex,
    highlightTextRunInPdfjsStyle,
    resetTextLayerMappedText,
} from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';
import type {
    IHighlightMatchRange,
    TTextLayerRun,
} from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';
import {
    canUseHighlightAPI,
    clearHighlightAPIForLayer,
    createCssHighlightState,
    createHighlightRangesInSpan,
    getHighlightMode,
    registerHighlightRange,
    updateHighlightAPI,
} from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightCss';
import type { ICssHighlightState } from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightCss';
import { buildVisualMatchesWithCurrent } from '@app/modules/pdf-viewer/engine/search/buildVisualMatchesWithCurrent';

const HIGHLIGHT_CLASS = 'pdf-search-highlight';
const HIGHLIGHT_CURRENT_CLASS = 'pdf-search-highlight--current';

const HIGHLIGHT_API_NAME = 'pdf-search-match';
const HIGHLIGHT_API_CURRENT_NAME = 'pdf-search-current-match';

interface IHighlightResult {
    elements: HTMLElement[];
    currentMatchElements: HTMLElement[];
    currentMatchRanges: Range[];
}

function createHighlightResult(overrides: Partial<IHighlightResult> = {}): IHighlightResult {
    return {
        elements: overrides.elements ?? [],
        currentMatchElements: overrides.currentMatchElements ?? [],
        currentMatchRanges: overrides.currentMatchRanges ?? [],
    };
}

function renderCssHighlights(
    cssState: ICssHighlightState,
    textLayerDiv: HTMLElement,
    pageIndex: TPageIndex,
    runs: TTextLayerRun[],
    matchesWithCurrent: IHighlightMatchRange[],
    runOverlaps: IHighlightMatchRange[][],
): IHighlightResult {
    const currentRanges: Range[] = [];

    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
        const run = runs[runIndex];
        if (!run) {
            continue;
        }
        if (run.kind !== 'span' || !run.textNode) {
            continue;
        }

        const overlaps = runOverlaps[runIndex];
        if (!overlaps || overlaps.length === 0) {
            continue;
        }

        const ranges = createHighlightRangesInSpan(
            run.textNode,
            run.startOffset,
            matchesWithCurrent,
            overlaps,
        );
        ranges.forEach((rangeEntry, idx) => {
            const {
                range,
                isCurrent,
            } = rangeEntry;
            const id = `pdf-${pageIndex}-${run.startOffset}-${idx}-${isCurrent ? 'c' : 'n'}`;
            registerHighlightRange(cssState, textLayerDiv, range, isCurrent, id);
            if (isCurrent) {
                currentRanges.push(range);
            }
        });
    }

    cssState.layerCurrentRanges.set(textLayerDiv, currentRanges);
    updateHighlightAPI(cssState, HIGHLIGHT_API_NAME, HIGHLIGHT_API_CURRENT_NAME);

    return createHighlightResult({ currentMatchRanges: currentRanges });
}

function collectCurrentMatchElements(elements: HTMLElement[]) {
    return elements.filter(element => element.classList.contains(HIGHLIGHT_CURRENT_CLASS));
}

function renderDomHighlights(
    runs: TTextLayerRun[],
    matchesWithCurrent: IHighlightMatchRange[],
    runOverlaps: IHighlightMatchRange[][],
): IHighlightResult {
    const allHighlightElements: HTMLElement[] = [];
    const currentMatchElements: HTMLElement[] = [];

    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
        const run = runs[runIndex];
        if (!run) {
            continue;
        }
        if (run.kind !== 'span') {
            continue;
        }

        const overlaps = runOverlaps[runIndex];
        if (!overlaps || overlaps.length === 0) {
            continue;
        }

        const elements = highlightTextRunInPdfjsStyle(
            run,
            matchesWithCurrent,
            HIGHLIGHT_CLASS,
            HIGHLIGHT_CURRENT_CLASS,
            overlaps,
        );
        allHighlightElements.push(...elements);
        currentMatchElements.push(...collectCurrentMatchElements(elements));
    }

    return createHighlightResult({
        elements: allHighlightElements,
        currentMatchElements,
    });
}

export const usePdfSearchHighlight = () => {
    const cssState = createCssHighlightState();

    function clearHighlights(container: HTMLElement) {
        clearHighlightAPIForLayer(cssState, container, HIGHLIGHT_API_NAME, HIGHLIGHT_API_CURRENT_NAME);
        clearDomHighlights(container, HIGHLIGHT_CLASS);
        resetTextLayerMappedText(container);
    }

    function highlightPage(
        textLayerDiv: HTMLElement,
        pageMatches: IPdfPageMatches | null,
        currentMatch: IPdfSearchMatch | null,
    ): IHighlightResult {
        clearHighlights(textLayerDiv);

        if (!pageMatches || pageMatches.matches.length === 0) {
            return createHighlightResult();
        }

        const {
            text: layerText,
            runs,
        } = getCachedTextLayerIndex(textLayerDiv);

        const assembledLayerText = assembleTextLayerSearchText({
            text: layerText,
            runs,
        }, pageMatches.searchQuery, pageMatches.searchOptions, pageMatches.matches.length);
        const matchesWithCurrent = buildVisualMatchesWithCurrent(
            pageMatches,
            currentMatch,
            layerText,
            assembledLayerText,
        );

        if (matchesWithCurrent.length === 0) {
            return createHighlightResult();
        }

        const runOverlaps = buildRunMatchOverlaps(runs, matchesWithCurrent);

        if (canUseHighlightAPI() && getHighlightMode() === 'css') {
            return renderCssHighlights(
                cssState,
                textLayerDiv,
                pageMatches.pageIndex,
                runs,
                matchesWithCurrent,
                runOverlaps,
            );
        }

        return renderDomHighlights(runs, matchesWithCurrent, runOverlaps);
    }

    function getCurrentMatchRanges(textLayerDiv: HTMLElement): Range[] {
        return cssState.layerCurrentRanges.get(textLayerDiv) ?? [];
    }

    return {
        clearHighlights,
        highlightPage,
        getCurrentMatchRanges,
        HIGHLIGHT_CLASS,
        HIGHLIGHT_CURRENT_CLASS,
    };
};
