import type {
    IPdfSearchExcerpt,
    IPdfSearchUtf16Range,
    IResolvedSearchMatchOptions,
} from '@pdf-core/pdfSearchCore';
import {
    buildPdfSearchExcerpt,
    iteratePdfSearchMatches,
} from '@pdf-core/pdfSearchCore';
import {
    SearchRegexLimitError,
    SEARCH_REGEX_MAX_EXECUTION_MS,
} from '@contracts/search';
import { EXCERPT_CONTEXT_CHARS } from '@electron/config/constants';

export type IPageSearchMatch = IPdfSearchUtf16Range;

export interface IPageSearchMatchOptions extends IResolvedSearchMatchOptions {deadlineAtMs?: number;}

function throwIfRegexDeadlineExceeded(
    options: IPageSearchMatchOptions,
) {
    if (
        !options.useRegex
        || options.deadlineAtMs === undefined
        || Date.now() < options.deadlineAtMs
    ) {
        return;
    }
    throw new SearchRegexLimitError(
        `Search regex exceeded the ${SEARCH_REGEX_MAX_EXECUTION_MS}ms matching budget`,
    );
}

export function buildExcerpt(
    text: string,
    startOffset: number,
    endOffset: number,
): IPdfSearchExcerpt {
    return buildPdfSearchExcerpt(text, startOffset, endOffset, EXCERPT_CONTEXT_CHARS);
}

export function findPageMatches(
    pageText: string,
    query: string,
    options: IPageSearchMatchOptions,
): IPageSearchMatch[] {
    return Array.from(iteratePageMatches(pageText, query, options));
}

export function* iteratePageMatches(
    pageText: string,
    query: string,
    options: IPageSearchMatchOptions,
): Generator<IPageSearchMatch> {
    throwIfRegexDeadlineExceeded(options);
    for (const match of iteratePdfSearchMatches(pageText, query, options)) {
        throwIfRegexDeadlineExceeded(options);
        yield match;
    }
    throwIfRegexDeadlineExceeded(options);
}
