import {loadPdfjsTextExtractor} from '@electron/features/search/loadPdfjsTextExtractor';
import type {
    IExtractPdfjsTextOptions,
    IExtractPdfjsWordBoxOptions,
    IPageTextWithWordBoxes,
} from '@electron/features/search/extractTextWithPdfjs';
import type {IPageText} from '@electron/features/search/pageText';

export {
    prepareSearchMainBindings,
    resolveSearchablePdfPath,
    resolveSearchWorkerPath,
    searchWorkerService,
} from '@electron/features/search/main/ipc';
export {
    parseOptionalSearchPageCount,
    validateSearchQuery,
} from '@electron/features/search/main/searchRequestValidation';
export {
    normalizeOptionalSearchPageCount,
    normalizeOptionalSearchRequestId,
    normalizePdfSearchWarmIndexPayload,
    SEARCH_PDF_PATH_MAX_LENGTH,
    SEARCH_REQUEST_ID_MAX_LENGTH,
    normalizePdfSearchRequestPayload,
} from '@electron/features/search/searchRequestPayload';
export {SearchWorkerService} from '@electron/features/search/main/searchWorkerService';
export {
    buildExcerpt, findPageMatches, iteratePageMatches,
} from '@electron/features/search/worker/searchMatch';
export {
    buildSearchIndex, loadSearchIndex,
} from '@electron/features/search/searchIndexBuilderPublic';
export {
    classifySearchIndexOperation,
    invalidateSearchIndexSidecars,
} from '@electron/features/search/searchIndexOperationPolicy';
export {
    ensureSearchIndex, getIndexCacheKey,
} from '@electron/features/search/worker/ensureSearchIndex';
export {
    ensureXlargeSearchIndex, resetXlargeSearchIndexBuilds,
} from '@electron/features/search/xlargeSearchRouting';
export {
    classifyXlargeSearchPath,
    classifyXlargeSearchPathFromFile,
    SEARCH_JS_WHOLE_VALUE_MAX_BYTES,
    SEARCH_XLARGE_PAGE_COUNT_THRESHOLD,
} from '@electron/features/search/xlargeSearchClassification';
export {
    ensureNativeSearchIndexBestEffort,
    getNativeSearchIndexPath,
    persistNativeSearchIndex,
} from '@electron/features/search/nativeSearchIndex';
export {isNativeSearchSupportedOptions} from '@electron/features/search/nativeSearch';
export {
    isXlargeNativeSearchCapabilityError,
    tryRunNativeSearch,
    XlargeNativeSearchCapabilityError,
} from '@electron/features/search/nativeSearch';
export {
    resetPersistentNativeSearchServiceCaches,
    shutdownPersistentNativeSearchServices,
} from '@electron/features/search/tryRunPersistentNativeSearch';
export {rebindSearchIndexes} from '@electron/features/search/rebindSearchIndexes';
export {stringifyLegacyJsonSearchIndex} from '@electron/features/search/stringifyLegacyJsonSearchIndex';
export {createPdfjsNodeDocumentOptions} from '@electron/features/search/createPdfjsNodeDocumentOptions';
export {
    extractTextFromPdf,
    isPdfTextExtractionCapabilityError,
} from '@electron/features/search/extractTextFromPdf';
export {loadPdfjsTextExtractor} from '@electron/features/search/loadPdfjsTextExtractor';
export async function extractTextWithPdfjs(
    pdfPath: string,
    options?: IExtractPdfjsTextOptions,
): Promise<IPageText[]> {
    const extractor = await loadPdfjsTextExtractor();
    return extractor.extractTextWithPdfjs(pdfPath, options);
}
export async function extractTextWithPdfjsWordBoxes(
    pdfPath: string,
    options?: IExtractPdfjsWordBoxOptions,
): Promise<IPageTextWithWordBoxes[]> {
    const extractor = await loadPdfjsTextExtractor();
    return extractor.extractTextWithPdfjsWordBoxes(pdfPath, options);
}
export {
    COMPACT_SEARCH_INDEX_MAGIC,
    COMPACT_SEARCH_INDEX_SCHEMA_VERSION,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
    getCompactSearchIndexPath,
    loadCompactSearchIndex,
    openCompactSearchIndexWriter,
    persistCompactSearchIndex,
    persistCompactSearchIndexBestEffort,
    persistCompactSearchIndexStreaming,
} from '@electron/features/search/searchIndexSidecar';
export {SEARCH_INDEX_SCHEMA_VERSION} from '@electron/features/search/searchIndexSchemaVersion';
export type {
    IPageIndex,
    IPdfSearchIndex,
} from '@electron/features/search/searchIndexTypes';
export type {IPageText} from '@electron/features/search/pageText';
export type {IPageTextWithWordBoxes} from '@electron/features/search/extractTextWithPdfjs';
export type {ICompactSearchIndex} from '@electron/features/search/searchIndexSidecar';
export type {ICachedIndex} from '@electron/features/search/worker/ensureSearchIndex';
export type {IXlargeSearchIndexBuildProgress} from '@electron/features/search/xlargeIndexBuilder';
