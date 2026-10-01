import {isRecord} from '@contracts/runtimeGuards';
import {
    pdfSearchResultSchema,
    SEARCH_MAX_NORMALIZED_PAGE_TEXT_BYTES,
} from '@contracts/search';
import * as v from 'valibot';

const safeInteger = v.pipe(v.number(), v.safeInteger());

/**
 * The text budget of one document's index, in UTF-8 bytes of normalized page
 * text. A page above the page budget, or one that would take the index above
 * the total, ends the index there and its coverage reports it truncated.
 * Every shell's search uses the same page budget.
 */
export const SEARCH_INDEX_TEXT_BUDGET = {
    maxPageTextBytes: SEARCH_MAX_NORMALIZED_PAGE_TEXT_BYTES,
    maxTotalTextBytes: 256 * 1024 * 1024,
} as const;

/**
 * One line of `evb-pdf-search index` stdin: a page's text, in increasing page
 * order, or the page where the producer stopped because its text is over the
 * budget, which must be the last line.
 */
export type TSearchIndexInputLine =
    | {
        pageNumber: number;
        text: string
    }
    | {
        pageNumber: number;
        overBudget: true
    };

export function encodeSearchIndexInputLine(line: TSearchIndexInputLine) {
    return `${JSON.stringify(line)}\n`;
}

/**
 * `evb-pdf-search index` and `stat` stdout: how much of the document the
 * index covers. `truncated` means the index ends before the document does.
 */
export const SEARCH_INDEX_COVERAGE_SCHEMA = v.looseObject({
    pageCount: safeInteger,
    pagesScanned: safeInteger,
    pagesWritten: safeInteger,
    truncated: v.boolean(),
    missingTextPageSample: v.array(safeInteger),
});

export type ISearchIndexCoverage = v.InferOutput<typeof SEARCH_INDEX_COVERAGE_SCHEMA>;

/** `evb-pdf-search search` stdout; the page count also appears at the top level. */
export const SEARCH_INDEX_RESPONSE_SCHEMA = v.pipe(v.object({
    results: v.array(pdfSearchResultSchema),
    truncated: v.boolean(),
    coverage: SEARCH_INDEX_COVERAGE_SCHEMA,
}), v.transform(({
    results,
    truncated,
    coverage,
}) => ({
    results,
    truncated,
    pageCount: coverage.pageCount,
    coverage,
})));

export type ISearchIndexResponse = v.InferOutput<typeof SEARCH_INDEX_RESPONSE_SCHEMA>;

/**
 * Every `evb-pdf-search` command answers `{"stale":true}` when the index is
 * missing, unreadable, or describes another revision or format.
 */
export function isStaleSearchIndexAnswer(value: unknown) {
    return isRecord(value) && value.stale === true;
}
