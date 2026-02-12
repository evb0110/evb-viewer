import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    ISearchExcerpt,
} from '@app/types/pdf';
import {
    buildTextLayerIndex,
    highlightTextInSpan,
    clearDomHighlights,
    scrollToHighlight,
} from '@app/composables/pdfSearchHighlightDom';
import {
    canUseHighlightAPI,
    getHighlightMode,
    isHighlightDebugEnabled,
    createHighlightRangesInSpan,
    createCssHighlightState,
    updateHighlightAPI,
    registerHighlightRange,
    clearHighlightAPIForLayer,
} from '@app/composables/pdfSearchHighlightCss';

export {
    type TTextLayerRun,
    buildTextLayerIndex,
    highlightTextInSpan,
    clearDomHighlights,
    scrollToHighlight,
} from '@app/composables/pdfSearchHighlightDom';
export {
    canUseHighlightAPI,
    getHighlightMode,
    isHighlightDebugEnabled,
    createHighlightRangesInSpan,
    createCssHighlightState,
    updateHighlightAPI,
    registerHighlightRange,
    clearHighlightAPIForLayer,
    type THighlightRange,
    type ICssHighlightState,
} from '@app/composables/pdfSearchHighlightCss';

const HIGHLIGHT_CLASS = 'pdf-search-highlight';
const HIGHLIGHT_CURRENT_CLASS = 'pdf-search-highlight--current';

const HIGHLIGHT_API_NAME = 'pdf-search-match';
const HIGHLIGHT_API_CURRENT_NAME = 'pdf-search-current-match';

const EXCERPT_CONTEXT_CHARS = 40;

export interface IHighlightResult {
    elements: HTMLElement[];
    currentMatchElements: HTMLElement[];
    currentMatchRanges: Range[];
}

export const usePdfSearchHighlight = () => {
    const cssState = createCssHighlightState();

    function clearHighlights(container: HTMLElement) {
        clearHighlightAPIForLayer(cssState, container, HIGHLIGHT_API_NAME, HIGHLIGHT_API_CURRENT_NAME);
        clearDomHighlights(container, HIGHLIGHT_CLASS);
    }

    function highlightPage(
        textLayerDiv: HTMLElement,
        pageMatches: IPdfPageMatches | null,
        currentMatch: IPdfSearchMatch | null,
    ): IHighlightResult {
        clearHighlights(textLayerDiv);

        if (!pageMatches || pageMatches.matches.length === 0) {
            return {
                elements: [],
                currentMatchElements: [],
                currentMatchRanges: [],
            };
        }

        const query = pageMatches.searchQuery?.trim() ?? '';
        if (!query) {
            return {
                elements: [],
                currentMatchElements: [],
                currentMatchRanges: [],
            };
        }

        const {
            text: layerText,
            runs,
        } = buildTextLayerIndex(textLayerDiv);
        const lowerText = layerText.toLowerCase();
        const lowerQuery = query.toLowerCase();

        const matchRanges: Array<{
            start: number;
            end: number;
        }> = [];
        let pos = 0;
        while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
            matchRanges.push({
                start: pos,
                end: pos + lowerQuery.length,
            });
            pos += lowerQuery.length;
        }

        if (matchRanges.length === 0) {
            return {
                elements: [],
                currentMatchElements: [],
                currentMatchRanges: [],
            };
        }

        const normalizeContext = (value: string) =>
            value.replace(/\s+/g, ' ').trim().toLowerCase();

        const commonPrefixLength = (a: string, b: string) => {
            const limit = Math.min(a.length, b.length);
            let count = 0;
            while (count < limit && a[count] === b[count]) {
                count += 1;
            }
            return count;
        };

        const commonSuffixLength = (a: string, b: string) => {
            const limit = Math.min(a.length, b.length);
            let count = 0;
            while (count < limit && a[a.length - 1 - count] === b[b.length - 1 - count]) {
                count += 1;
            }
            return count;
        };

        const buildExcerpt = (text: string, startOffset: number, endOffset: number): ISearchExcerpt => {
            const excerptStart = Math.max(0, startOffset - EXCERPT_CONTEXT_CHARS);
            const excerptEnd = Math.min(text.length, endOffset + EXCERPT_CONTEXT_CHARS);

            const beforeRaw = text.slice(excerptStart, startOffset);
            const match = text.slice(startOffset, endOffset);
            const afterRaw = text.slice(endOffset, excerptEnd);

            const beforeNormalized = beforeRaw.replace(/\s+/g, ' ').trimStart();
            const afterNormalized = afterRaw.replace(/\s+/g, ' ').trimEnd();

            const isWordChar = (ch: string) => /[0-9A-Za-z]/.test(ch);
            const matchLen = match.length;

            let before = beforeNormalized;
            let after = afterNormalized;

            if (matchLen >= 4 && matchLen > 0) {
                const beforeHasBoundaryWhitespace = /\s$/.test(beforeRaw);
                const afterHasBoundaryWhitespace = /^\s/.test(afterRaw);

                const beforeLast = beforeNormalized.at(-1) ?? '';
                const matchFirst = match.at(0) ?? '';
                const matchLast = match.at(-1) ?? '';
                const afterFirst = afterNormalized.at(0) ?? '';

                if (!beforeHasBoundaryWhitespace && beforeLast && matchFirst && isWordChar(beforeLast) && isWordChar(matchFirst)) {
                    before = `${beforeNormalized} `;
                }

                const looksLikePluralSuffix = afterNormalized === 's' || afterNormalized.startsWith('s ');
                if (
                    !afterHasBoundaryWhitespace
                    && !looksLikePluralSuffix
                    && matchLast
                    && afterFirst
                    && isWordChar(matchLast)
                    && isWordChar(afterFirst)
                ) {
                    after = ` ${afterNormalized}`;
                }
            }

            return {
                prefix: excerptStart > 0,
                suffix: excerptEnd < text.length,
                before,
                match,
                after,
            };
        };

        let backendIndexOnPage = -1;
        if (currentMatch !== null && currentMatch.pageIndex === pageMatches.pageIndex) {
            backendIndexOnPage = pageMatches.matches.findIndex(
                (m, index) => currentMatch.matchIndex === (m.matchIndex ?? index),
            );
        }

        let currentIndexOnPage = -1;

        if (currentMatch && currentMatch.pageMatchIndex !== undefined && currentMatch.pageIndex === pageMatches.pageIndex) {
            currentIndexOnPage = currentMatch.pageMatchIndex;
            if (isHighlightDebugEnabled()) {
                console.log('[PDF-HIGHLIGHT] Using pageMatchIndex:', currentMatch.pageMatchIndex);
            }
        } else if (backendIndexOnPage !== -1 && currentMatch?.excerpt) {
            const expectedIndex = backendIndexOnPage;
            const targetBefore = normalizeContext(currentMatch.excerpt.before);
            const targetAfter = normalizeContext(currentMatch.excerpt.after);

            let bestIndex = -1;
            let bestScore = Number.NEGATIVE_INFINITY;

            for (let i = 0; i < matchRanges.length; i += 1) {
                const candidate = matchRanges[i]!;
                const candidateExcerpt = buildExcerpt(layerText, candidate.start, candidate.end);

                const candidateBefore = normalizeContext(candidateExcerpt.before);
                const candidateAfter = normalizeContext(candidateExcerpt.after);

                const beforeScore = commonSuffixLength(
                    targetBefore.slice(-EXCERPT_CONTEXT_CHARS),
                    candidateBefore.slice(-EXCERPT_CONTEXT_CHARS),
                );
                const afterScore = commonPrefixLength(
                    targetAfter.slice(0, EXCERPT_CONTEXT_CHARS),
                    candidateAfter.slice(0, EXCERPT_CONTEXT_CHARS),
                );

                const proximityPenalty = Math.abs(i - expectedIndex);
                const score = beforeScore + afterScore - proximityPenalty;

                if (score > bestScore) {
                    bestScore = score;
                    bestIndex = i;
                }
            }

            if (bestIndex !== -1) {
                currentIndexOnPage = bestIndex;
            }
        } else if (backendIndexOnPage !== -1) {
            currentIndexOnPage = backendIndexOnPage;
        }

        const matchesWithCurrent = matchRanges.map((m, index) => ({
            ...m,
            isCurrent: index === currentIndexOnPage,
        }));

        if (isHighlightDebugEnabled() && matchRanges.length !== pageMatches.matches.length && backendIndexOnPage !== -1) {
            console.warn('[PDF-HIGHLIGHT] Text-layer match count differs from backend results', {
                pageIndex: pageMatches.pageIndex,
                query,
                backendCount: pageMatches.matches.length,
                textLayerCount: matchRanges.length,
                backendIndexOnPage,
                mappedTextLayerIndex: currentIndexOnPage,
            });
        }

        if (canUseHighlightAPI() && getHighlightMode() === 'css') {
            const currentRanges: Range[] = [];

            for (const run of runs) {
                if (run.kind !== 'span') {
                    continue;
                }

                if (!run.textNode) {
                    continue;
                }

                const ranges = createHighlightRangesInSpan(run.textNode, run.startOffset, matchesWithCurrent);
                ranges.forEach((rangeEntry, idx) => {
                    const {
                        range,
                        isCurrent,
                    } = rangeEntry;
                    const id = `pdf-${pageMatches.pageIndex}-${run.startOffset}-${idx}-${isCurrent ? 'c' : 'n'}`;
                    registerHighlightRange(cssState, textLayerDiv, range, isCurrent, id);
                    if (isCurrent) {
                        currentRanges.push(range);
                    }
                });
            }

            cssState.layerCurrentRanges.set(textLayerDiv, currentRanges);
            updateHighlightAPI(cssState, HIGHLIGHT_API_NAME, HIGHLIGHT_API_CURRENT_NAME);

            return {
                elements: [],
                currentMatchElements: [],
                currentMatchRanges: currentRanges,
            };
        }

        const allHighlightElements: HTMLElement[] = [];
        const currentMatchElements: HTMLElement[] = [];

        for (const run of runs) {
            if (run.kind !== 'span') {
                continue;
            }

            const elements = highlightTextInSpan(run.span, run.startOffset, matchesWithCurrent, HIGHLIGHT_CLASS, HIGHLIGHT_CURRENT_CLASS);
            allHighlightElements.push(...elements);

            elements.forEach((el) => {
                if (el.classList.contains(HIGHLIGHT_CURRENT_CLASS)) {
                    currentMatchElements.push(el);
                }
            });
        }

        return {
            elements: allHighlightElements,
            currentMatchElements,
            currentMatchRanges: [],
        };
    }

    function getCurrentMatchRanges(textLayerDiv: HTMLElement): Range[] {
        return cssState.layerCurrentRanges.get(textLayerDiv) ?? [];
    }

    return {
        clearHighlights,
        highlightPage,
        scrollToHighlight,
        getCurrentMatchRanges,
        HIGHLIGHT_CLASS,
        HIGHLIGHT_CURRENT_CLASS,
    };
};
