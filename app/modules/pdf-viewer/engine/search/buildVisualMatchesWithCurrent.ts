import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import {
    assembleSearchablePageText,
    buildPdfSearchRegex,
    mapAssembledSearchablePageTextRange,
} from '@pdf-core';
import type { IAssembledSearchablePageText } from '@contracts/search';
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

function buildLayerSearchMatches(
    pageMatches: IPdfPageMatches,
    assembledLayerText: IAssembledSearchablePageText,
    pattern: RegExp,
    compatible: ReadonlySet<number>,
): IVisualSearchMatch[] {
    pattern.lastIndex = 0;
    const requested = new Map(pageMatches.matches.flatMap((match, index) => compatible.has(index) ? [] : [[
        match.pageMatchIndex ?? index,
        index,
    ]] as const));
    const lastRequested = Math.max(-1, ...requested.keys());
    const ordered = arePageMatchesInSearchOrder(pageMatches);
    const matches = buildBackendVisualMatches(pageMatches, assembledLayerText, compatible);
    const seenRanges = new Set(matches.map(match => `${match.start}:${match.end}`));
    let index = 0;
    for (const match of assembledLayerText.text.matchAll(pattern)) {
        if (match[0].length === 0) continue;
        const pageMatchIndex = index++;
        if (pageMatchIndex > lastRequested) break;
        const backendIndex = requested.get(pageMatchIndex);
        if (backendIndex !== undefined) {
            const backendMatch = pageMatches.matches[backendIndex]!;
            const mapped = mapAssembledSearchablePageTextRange(assembledLayerText, {
                startOffset: match.index,
                endOffset: match.index + match[0].length,
            });
            if (!mapped) continue;
            const key = `${mapped.startOffset}:${mapped.endOffset}`;
            if (seenRanges.has(key)) continue;
            seenRanges.add(key);
            matches.push({
                start: mapped.startOffset,
                end: mapped.endOffset,
                matchIndex: backendMatch.matchIndex,
                pageMatchIndex,
                canUseBackendIdentity: ordered,
            });
        }
    }
    return matches.sort((first, second) => first.pageMatchIndex - second.pageMatchIndex);
}

function findCompatibleBackendMatches(
    pageMatches: IPdfPageMatches,
    text: string,
    pattern: RegExp,
) {
    const anchored = new RegExp(pattern.source, pattern.flags.replace('g', 'y'));
    const seen = new Map<string, number>();
    const compatible = new Set<number>();
    pageMatches.matches.forEach((match, index) => {
        const key = `${match.start}:${match.end}`;
        const previous = seen.get(key);
        if (previous !== undefined) {
            compatible.delete(previous);
            return;
        }
        seen.set(key, index);
        anchored.lastIndex = match.start;
        const occurrence = anchored.exec(text);
        if (occurrence?.index === match.start && occurrence.index + occurrence[0].length === match.end) compatible.add(index);
    });
    return compatible;
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

function getCurrentMatchOffsetDistance(
    match: IVisualSearchMatch,
    currentMatch: IPdfSearchMatch,
) {
    return Math.abs(match.start - currentMatch.startOffset)
        + Math.abs(match.end - currentMatch.endOffset);
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

    const shouldUseBackendIdentity = matches.every(match => match.canUseBackendIdentity);
    if (!shouldUseBackendIdentity) {
        return matches.reduce((bestIndex, match, index) => {
            if (bestIndex < 0) {
                return index;
            }

            const bestMatch = matches[bestIndex];
            if (!bestMatch) {
                return index;
            }

            return getCurrentMatchOffsetDistance(match, currentMatch) < getCurrentMatchOffsetDistance(bestMatch, currentMatch)
                ? index
                : bestIndex;
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
    const backendMatches = buildBackendVisualMatches(pageMatches, assembledLayerText);
    let pattern: RegExp | undefined;
    if (pageMatches.searchQuery) {
        try {
            pattern = buildPdfSearchRegex(pageMatches.searchQuery, {
                matchCase: pageMatches.searchOptions?.matchCase ?? false,
                wholeWord: pageMatches.searchOptions?.wholeWord ?? false,
                useRegex: pageMatches.searchOptions?.useRegex ?? false,
            });
        } catch {
            return [];
        }
    }
    const compatible = pattern ? findCompatibleBackendMatches(pageMatches, assembledLayerText.text, pattern) : new Set<number>();
    const backendMatchesPointAtLayerOccurrences = !pattern || compatible.size === pageMatches.matches.length;
    const matches = backendMatches.length === pageMatches.matches.length
        && backendMatchesPointAtLayerOccurrences
        ? backendMatches
        : pattern ? buildLayerSearchMatches(pageMatches, assembledLayerText, pattern, compatible) : [];
    return markVisualMatchesWithCurrent(matches, pageMatches, currentMatch);
}
