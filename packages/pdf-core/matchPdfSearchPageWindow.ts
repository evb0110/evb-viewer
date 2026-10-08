import type {
    IPdfSearchUtf16Range, ISearchMatchOptions, TSearchResultOffset,
} from '@contracts/search';
import { iteratePdfSearchMatches } from '@pdf-core/pdfSearchAlgorithms';

/** A bounded page window; ordinals count skipped matches without retaining them. */
export function matchPdfSearchPageWindow(text: string, query: string, options: ISearchMatchOptions, maxMatches: number, resultOffset: TSearchResultOffset = 0) {
    const matches: Array<IPdfSearchUtf16Range & {pageMatchIndex: number}> = [];
    let matchCount = 0;
    let truncated = false;
    for (const match of iteratePdfSearchMatches(text, query, options)) {
        const pageMatchIndex = matchCount++;
        if (typeof resultOffset === 'number' && pageMatchIndex < resultOffset) continue;
        if (resultOffset !== 'last' && matches.length >= maxMatches) {
            truncated = true;
            break;
        }
        const entry = {
            ...match,
            pageMatchIndex,
        };
        if (resultOffset === 'last') matches[pageMatchIndex % maxMatches] = entry;
        else matches.push(entry);
    }
    matches.sort((first, second) => first.pageMatchIndex - second.pageMatchIndex);
    return {
        matches,
        truncated,
        matchCount,
    };
}
