import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import {
    assembleSearchablePageText,
    mapAssembledSearchablePageTextRange,
} from '@pdf-core';
import {
    SEARCH_REGEX_MAX_EXECUTION_MS,
    SEARCH_RESULT_LIMIT,
    type IAssembledSearchablePageText,
} from '@contracts/search';
import { matchPdfSearchPageWindow } from '@pdf-core/pdfSearchCore';
import { matchBrowserSearchPageWindowInWorker } from '@app/platform/browser-api/public';
import type { IHighlightMatchRange } from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';

interface IVisualSearchMatch {
    start: number;
    end: number;
    matchIndex: number;
    pageMatchIndex: number;
    canUseBackendIdentity: boolean;
}

function buildBackendVisualMatches(
    pageMatches: IPdfPageMatches,
    assembledLayerText: IAssembledSearchablePageText,
    compatible?: ReadonlySet<number>,
): IVisualSearchMatch[] {
    return pageMatches.matches
        .flatMap((match, index): IVisualSearchMatch[] => {
            if (compatible && !compatible.has(index)) return [];
            const mapped = mapAssembledSearchablePageTextRange(assembledLayerText, {
                startOffset: match.start,
                endOffset: match.end,
            });
            return mapped ? [{
                start: mapped.startOffset,
                end: mapped.endOffset,
                matchIndex: match.matchIndex,
                pageMatchIndex: match.pageMatchIndex ?? index,
                canUseBackendIdentity: true,
            }] : [];
        });
}

function isCurrentVisualMatch(
    match: IVisualSearchMatch,
    pageMatches: IPdfPageMatches,
    currentMatch: IPdfSearchMatch | null,
) {
    return currentMatch !== null
        && currentMatch.pageIndex === pageMatches.pageIndex
        && match.canUseBackendIdentity
        && (
            currentMatch.pageMatchIndex === match.pageMatchIndex
            || currentMatch.matchIndex === match.matchIndex
        );
}

function arePageMatchesInSearchOrder(pageMatches: IPdfPageMatches) {
    return pageMatches.matches.every((match, index) => {
        const previous = pageMatches.matches[index - 1];
        return previous === undefined || match.start >= previous.start;
    });
}

function getFallbackCurrentMatchIndex(
    matches: IVisualSearchMatch[],
    pageMatches: IPdfPageMatches,
    currentMatch: IPdfSearchMatch | null,
) {
    if (!currentMatch || matches.length === 0) {
        return -1;
    }

    const requestedPageMatchIndex = currentMatch.pageMatchIndex;
    // Equal counts preserve the page-local ordinal across extraction drift,
    // provided the native result order is still document order.
    if (
        matches.length === pageMatches.matches.length
        && arePageMatchesInSearchOrder(pageMatches)
        && typeof requestedPageMatchIndex === 'number'
        && Number.isSafeInteger(requestedPageMatchIndex)
    ) {
        return matches.findIndex(match => match.pageMatchIndex === requestedPageMatchIndex);
    }

    if (!matches.every(match => match.canUseBackendIdentity)) {
        const distance = (match: IVisualSearchMatch) => Math.abs(match.start - currentMatch.startOffset)
            + Math.abs(match.end - currentMatch.endOffset);
        return matches.reduce((bestIndex, match, index) => {
            const bestMatch = matches[bestIndex];
            return !bestMatch || distance(match) < distance(bestMatch) ? index : bestIndex;
        }, -1);
    }

    return 0;
}

function markVisualMatchesWithCurrent(
    matches: IVisualSearchMatch[],
    pageMatches: IPdfPageMatches,
    currentMatch: IPdfSearchMatch | null,
): IHighlightMatchRange[] {
    const ranges = matches.map((match): IHighlightMatchRange => ({
        start: match.start,
        end: match.end,
        isCurrent: isCurrentVisualMatch(match, pageMatches, currentMatch),
    }));

    const shouldHaveCurrent = currentMatch?.pageIndex === pageMatches.pageIndex;
    if (shouldHaveCurrent && ranges.length > 0 && !ranges.some(match => match.isCurrent)) {
        const fallbackIndex = getFallbackCurrentMatchIndex(matches, pageMatches, currentMatch);
        if (fallbackIndex >= 0) {
            const fallbackRange = ranges[fallbackIndex];
            if (fallbackRange) {
                ranges[fallbackIndex] = {
                    ...fallbackRange,
                    isCurrent: true,
                };
            }
        }
    }

    return ranges;
}

export function buildVisualMatchesWithCurrent(
    pageMatches: IPdfPageMatches,
    currentMatch: IPdfSearchMatch | null,
    layerText: string,
    assembledLayerText = assembleSearchablePageText([{text: layerText}]),
): IHighlightMatchRange[] {
    const verified = pageMatches.pageText === assembledLayerText.text
        ? assembledLayerText : assembleSearchablePageText([{text: layerText}]);
    if (pageMatches.pageText !== verified.text) return [];
    return markVisualMatchesWithCurrent(
        buildBackendVisualMatches(pageMatches, verified),
        pageMatches,
        currentMatch,
    );
}

/** Reconcile extraction drift through the existing interruptible match owner. */
export async function reconcileVisualMatchesWithCurrent(
    pageMatches: IPdfPageMatches,
    currentMatch: IPdfSearchMatch | null,
    layerText: string,
    assembledLayerText = assembleSearchablePageText([{text: layerText}]),
    signal = new AbortController().signal,
): Promise<IHighlightMatchRange[]> {
    if (pageMatches.matches.length === 0) return [];
    const contiguous = assembleSearchablePageText([{text: layerText}]);
    if (!pageMatches.searchQuery || pageMatches.pageText === contiguous.text || pageMatches.pageText === assembledLayerText.text) {
        return buildVisualMatchesWithCurrent(pageMatches, currentMatch, layerText, assembledLayerText);
    }
    const ordinals = pageMatches.matches.map((match, index) => match.pageMatchIndex ?? index);
    const firstOrdinal = Math.min(...ordinals);
    const maxMatches = Math.min(SEARCH_RESULT_LIMIT + 1, Math.max(...ordinals) - firstOrdinal + 2);
    const budget = {remainingMs: SEARCH_REGEX_MAX_EXECUTION_MS};
    const options = {
        matchCase: pageMatches.searchOptions?.matchCase ?? false,
        wholeWord: pageMatches.searchOptions?.wholeWord ?? false,
        useRegex: pageMatches.searchOptions?.useRegex ?? false,
    };
    const matchLayer = (assembled: IAssembledSearchablePageText) => options.useRegex
        ? matchBrowserSearchPageWindowInWorker(assembled.text, pageMatches.searchQuery, options, maxMatches, firstOrdinal, budget, signal)
        : matchPdfSearchPageWindow(assembled.text, pageMatches.searchQuery, options, maxMatches, firstOrdinal);
    const backendRangeCounts = new Map<string, number>();
    for (const match of pageMatches.matches) {
        const key = `${match.start}:${match.end}`;
        backendRangeCounts.set(key, (backendRangeCounts.get(key) ?? 0) + 1);
    }
    const evaluate = async (assembled: IAssembledSearchablePageText) => {
        const result = await matchLayer(assembled);
        const matchedRanges = new Set(result.matches.map(match => `${match.startOffset}:${match.endOffset}`));
        const compatible = new Set(pageMatches.matches.flatMap((match, index) => {
            const key = `${match.start}:${match.end}`;
            return backendRangeCounts.get(key) === 1 && matchedRanges.has(key) ? [index] : [];
        }));
        return {
            assembled,
            result,
            compatible,
        };
    };
    const candidates = [await evaluate(assembledLayerText)];
    if (assembledLayerText.text !== contiguous.text) candidates.push(await evaluate(contiguous));
    const coverage = (candidate: typeof candidates[number]) => ordinals.filter(ordinal => candidate.result.matches.some(match => match.pageMatchIndex === ordinal)).length;
    // Coverage alone can label the third word as ordinal 1 after missing a
    // fragmented second word. Prefer agreement with the authoritative ranges.
    const {
        assembled, result, compatible,
    } = candidates.sort((a, b) => b.compatible.size - a.compatible.size || coverage(b) - coverage(a))[0]!;
    const occurrences = new Map(result.matches.map(match => [
        match.pageMatchIndex,
        match,
    ]));
    const matches = buildBackendVisualMatches(pageMatches, assembled, compatible);
    const seenRanges = new Set(matches.map(match => `${match.start}:${match.end}`));
    const ordered = arePageMatchesInSearchOrder(pageMatches);
    pageMatches.matches.forEach((backendMatch, index) => {
        if (compatible.has(index)) return;
        const pageMatchIndex = ordinals[index]!;
        const occurrence = occurrences.get(pageMatchIndex);
        const mapped = occurrence && mapAssembledSearchablePageTextRange(assembled, occurrence);
        if (!mapped) return;
        const key = `${mapped.startOffset}:${mapped.endOffset}`;
        if (seenRanges.has(key)) return;
        seenRanges.add(key);
        matches.push({
            start: mapped.startOffset,
            end: mapped.endOffset,
            matchIndex: backendMatch.matchIndex,
            pageMatchIndex,
            canUseBackendIdentity: ordered,
        });
    });
    return markVisualMatchesWithCurrent(matches.sort((a, b) => a.pageMatchIndex - b.pageMatchIndex), pageMatches, currentMatch);
}
