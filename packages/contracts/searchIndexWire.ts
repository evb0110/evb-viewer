import {isRecord} from '@contracts/runtimeGuards';
import {pdfSearchResultSchema} from '@contracts/search';
import * as v from 'valibot';

const safeInteger = v.pipe(v.number(), v.safeInteger());

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
