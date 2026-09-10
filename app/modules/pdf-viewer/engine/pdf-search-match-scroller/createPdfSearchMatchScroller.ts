import type {
    TPageIndex,
    TPageNumber,
} from '@contracts/pageNumbers';

import type {
    IPdfSearchExcerpt,
    ISearchMatchOptions,
} from '@contracts/search';
import type {TOcrIndexRotation} from '@contracts/ocrIndex';
import {
    pageIndexToPageNumber,
    requirePageIndex,
} from '@contracts/pageNumbers';
import type {IScrollToPageOptions} from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';

interface ICurrentSearchMatchWord {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface ICurrentSearchMatch {
    pageIndex: TPageIndex;
    pageMatchIndex?: number | undefined;
    matchIndex?: number | undefined;
    startOffset?: number | undefined;
    endOffset?: number | undefined;
    excerpt?: IPdfSearchExcerpt | undefined;
    pageWidth?: number | undefined;
    pageHeight?: number | undefined;
    rotation?: TOcrIndexRotation | undefined;
    words?: readonly ICurrentSearchMatchWord[] | undefined;
}

interface ICurrentSearchPageMatches {
    searchQuery: string;
    searchOptions?: ISearchMatchOptions;
    matches?: ReadonlyArray<{start: number}>;
}

interface ICurrentSearchMatchMarkerRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

type ISearchNavigationTargetOptions = Pick<IScrollToPageOptions, 'markerRect' | 'textAnchor'>;

interface IPdfSearchMatchScrollerDeps {
    getContainer: () => HTMLElement | null;
    getCurrentSearchMatch: () => ICurrentSearchMatch | null;
    getCurrentSearchPageMatches?: (pageIndex: TPageIndex) => ICurrentSearchPageMatches | null;
    scrollToCurrentMatch: () => boolean;
    scheduleRenderForSinglePage: (pageNumber: TPageNumber) => void;
    scrollToPage?: (
        pageNumber: TPageNumber,
        options?: {
            preferExactDom?: boolean;
            navigationSource?: 'search';
        } & ISearchNavigationTargetOptions,
    ) => void;
    suppressSnap?: () => void;
    beginSearchNavigation?: (pageNumber: TPageNumber) => void;
    revealSearchNavigationTarget?: (
        pageNumber: TPageNumber,
        options?: ISearchNavigationTargetOptions,
    ) => void;
    endSearchNavigation?: (settleMs?: number) => void;
    beginSearchTransaction?: (
        pageNumber: TPageNumber,
        options?: ISearchNavigationTargetOptions,
    ) => number | null;
    isSearchTransactionCurrent?: (transactionId: number) => boolean;
    settleSearchTransaction?: (transactionId: number) => void;
    cancelSearchTransaction?: (transactionId: number) => void;
    isPageRenderPending?: (pageNumber: TPageNumber) => boolean;
}

function clampRatio(value: number) {
    return Math.min(1, Math.max(0, value));
}

function isInSearchOrder(matches: ReadonlyArray<{start: number}>) {
    return matches.every((match, index) => {
        const previous = matches[index - 1];
        return previous === undefined || match.start >= previous.start;
    });
}

function resolveCurrentMatchMarkerRect(
    currentMatch: ICurrentSearchMatch | null,
    targetPageIndex: TPageIndex,
): ICurrentSearchMatchMarkerRect | null {
    if (
        !currentMatch
        || currentMatch.pageIndex !== targetPageIndex
        || !currentMatch.words?.length
        || !currentMatch.pageWidth
        || !currentMatch.pageHeight
    ) {
        return null;
    }
    const boxes = currentMatch.words.filter(word => (
        Number.isFinite(word.x)
        && Number.isFinite(word.y)
        && Number.isFinite(word.width)
        && Number.isFinite(word.height)
        && word.width > 0
        && word.height > 0
    ));
    if (boxes.length === 0) {
        return null;
    }
    const left = Math.min(...boxes.map(word => word.x));
    const top = Math.min(...boxes.map(word => word.y));
    const right = Math.max(...boxes.map(word => word.x + word.width));
    const bottom = Math.max(...boxes.map(word => word.y + word.height));
    const normalizedLeft = clampRatio(left / currentMatch.pageWidth);
    const normalizedTop = clampRatio(top / currentMatch.pageHeight);
    const normalizedRect = {
        left: normalizedLeft,
        top: normalizedTop,
        width: clampRatio(right / currentMatch.pageWidth) - normalizedLeft,
        height: clampRatio(bottom / currentMatch.pageHeight) - normalizedTop,
    };
    switch (currentMatch.rotation ?? 0) {
        case 90:
            return {
                left: 1 - normalizedRect.top - normalizedRect.height,
                top: normalizedRect.left,
                width: normalizedRect.height,
                height: normalizedRect.width,
            };
        case 180:
            return {
                left: 1 - normalizedRect.left - normalizedRect.width,
                top: 1 - normalizedRect.top - normalizedRect.height,
                width: normalizedRect.width,
                height: normalizedRect.height,
            };
        case 270:
            return {
                left: normalizedRect.top,
                top: 1 - normalizedRect.left - normalizedRect.width,
                width: normalizedRect.height,
                height: normalizedRect.width,
            };
        case 0:
            return normalizedRect;
    }
}

function resolveCurrentMatchTextAnchor(
    currentMatch: ICurrentSearchMatch | null,
    targetPageIndex: TPageIndex,
    pageMatches: ICurrentSearchPageMatches | null,
): IScrollToPageOptions['textAnchor'] {
    const excerpt = currentMatch?.excerpt;
    const startOffset = currentMatch?.startOffset;
    const endOffset = currentMatch?.endOffset;
    if (
        !currentMatch
        || currentMatch.pageIndex !== targetPageIndex
        || !excerpt?.match
        || typeof startOffset !== 'number'
        || typeof endOffset !== 'number'
        || !Number.isSafeInteger(startOffset)
        || !Number.isSafeInteger(endOffset)
        || startOffset < 0
        || endOffset <= startOffset
    ) {
        return null;
    }

    const orderedMatches = pageMatches?.matches;
    const expectedPageMatchCount = orderedMatches !== undefined && isInSearchOrder(orderedMatches)
        ? orderedMatches.length
        : undefined;
    return {
        text: excerpt.match,
        ...(excerpt.before ? {prefix: excerpt.before} : {}),
        ...(excerpt.after ? {suffix: excerpt.after} : {}),
        ...(currentMatch.pageMatchIndex === undefined ? {} : {pageMatchIndex: currentMatch.pageMatchIndex}),
        ...(currentMatch.matchIndex === undefined ? {} : {matchIndex: currentMatch.matchIndex}),
        ...(pageMatches?.searchQuery ? {searchQuery: pageMatches.searchQuery} : {}),
        ...(pageMatches?.searchOptions ? {searchOptions: pageMatches.searchOptions} : {}),
        ...(expectedPageMatchCount === undefined ? {} : {expectedPageMatchCount}),
        searchRange: {
            startOffset,
            endOffset,
        },
    };
}

/**
 * Search is now a semantic request producer. ViewportAuthority owns target
 * mounting, text-layer readiness, supersession, placement and highlighting.
 */
export function createPdfSearchMatchScroller(deps: IPdfSearchMatchScrollerDeps) {
    let generation = 0;

    function invalidatePendingRequests() {
        generation += 1;
        deps.endSearchNavigation?.(0);
    }

    function requestScrollToMatch(matchPageIndex: number | null) {
        invalidatePendingRequests();
        if (matchPageIndex === null) {
            return;
        }
        const requestGeneration = generation;
        const pageIndex = requirePageIndex(matchPageIndex);
        const pageNumber = pageIndexToPageNumber(pageIndex);
        const currentMatch = deps.getCurrentSearchMatch();
        const pageMatches = deps.getCurrentSearchPageMatches?.(pageIndex) ?? null;
        const markerRect = resolveCurrentMatchMarkerRect(
            currentMatch,
            pageIndex,
        );
        const textAnchor = markerRect
            ? null
            : resolveCurrentMatchTextAnchor(currentMatch, pageIndex, pageMatches);
        const navigationOptions = markerRect
            ? {markerRect}
            : textAnchor
                ? {textAnchor}
                : undefined;
        if (requestGeneration !== generation) {
            return;
        }
        if (deps.revealSearchNavigationTarget) {
            deps.revealSearchNavigationTarget(pageNumber, navigationOptions);
            return;
        }
        deps.scrollToPage?.(pageNumber, {
            navigationSource: 'search',
            ...(navigationOptions ?? {}),
        });
    }

    return {
        requestScrollToMatch,
        invalidatePendingRequests,
    };
}
