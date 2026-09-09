export type {
    IAssembledSearchablePageText,
    INormalizedPdfSearchRequest,
    INormalizedPdfSearchWarmIndexRequest,
    IPdfSearchExcerpt,
    IPdfSearchUtf16Range,
    IResolvedSearchMatchOptions,
    ISearchMatchOptions,
    TPdfSearchUtf16Offset,
} from '@contracts/search';

export {
    buildPdfSearchExcerpt,
    findPdfSearchMatches,
    iteratePdfSearchMatches,
    mapAssembledSearchablePageTextRange,
    normalizeSearchText,
    SearchTextBudgetError,
} from '@pdf-core/pdfSearchAlgorithms';

export { PDF_SEARCH_PROGRESS_RESULT_BATCH_LIMIT } from '@pdf-core/pdfSearchProgressResultBatchLimit';

export {
    assertSafePdfSearchRegex,
    buildPdfSearchRegex,
    assembleSearchablePageText,
    collapseRepeatedPdfSearchPageText,
    escapeSearchRegex,
    normalizeOptionalSearchPageCount,
    normalizeOptionalSearchRequestId,
    normalizePdfSearchRequestPayload,
    normalizePdfSearchWarmIndexPayload,
    SearchRegexLimitError,
    SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH,
    SEARCH_REGEX_MAX_EXECUTION_MS,
    SEARCH_PDF_PATH_MAX_LENGTH,
    SEARCH_REQUEST_ID_MAX_LENGTH,
    validateSearchQuery,
} from '@contracts/search';
