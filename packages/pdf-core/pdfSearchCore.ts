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
    assertSafePdfSearchRegex,
    buildPdfSearchExcerpt,
    buildPdfSearchRegex,
    buildOcrTextLayerIndexText,
    assembleSearchablePageText,
    collapseRepeatedPdfSearchPageText,
    escapeSearchRegex,
    findPdfSearchMatches,
    iteratePdfSearchMatches,
    mapAssembledSearchablePageTextRange,
    normalizeSearchText,
    SearchRegexLimitError,
    SearchTextBudgetError,
    validateSearchQuery,
} from '@pdf-core/pdfSearchAlgorithms';

export { PDF_SEARCH_PROGRESS_RESULT_BATCH_LIMIT } from '@pdf-core/pdfSearchProgressResultBatchLimit';

export {
    normalizeOptionalSearchPageCount,
    normalizeOptionalSearchRequestId,
    normalizePdfSearchRequestPayload,
    normalizePdfSearchWarmIndexPayload,
    SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH,
    SEARCH_REGEX_MAX_EXECUTION_MS,
    SEARCH_PDF_PATH_MAX_LENGTH,
    SEARCH_REQUEST_ID_MAX_LENGTH,
} from '@contracts/search';
