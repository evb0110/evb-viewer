export {
    buildPdfSaveRestrictions,
    containsPdfEncryptMarker,
    createConservativePdfConformanceFallbackProfile,
    createDefaultPdfConformanceProfile,
    detectPdfaLevelFromPdfText,
    hasPdfEncryptMarkersInPdfText,
    hasPdfSignatureMarkersInPdfText,
    PDF_ENCRYPT_SCAN_REGION_BYTES,
} from '@pdf-core/pdfConformanceHelpers';
export { loadPdfStructure } from '@pdf-core/loadPdfStructure';
export type {
    IPdfPageBox,
    TPdfRect,
} from '@pdf-core/pdfPageBoxes';
export {
    arePdfPageBoxesEqual,
    fromPdfRect,
    intersectPdfPageBoxes,
    normalizePdfPageBox,
    numberFromPdfBox,
    readPdfRectFromDict,
    resolvePdfLibCropBox,
    resolvePdfLibMediaBox,
    resolvePdfLibPageView,
    toPdfRect,
    tryResolvePdfLibPageView,
} from '@pdf-core/pdfPageBoxes';
export {
    isPdfUnexpectedObjectTypeError,
    safePdfContextLookupArray,
    safePdfContextLookupDict,
    safePdfContextLookupStream,
    safePdfDictLookupArray,
    safePdfDictLookupDict,
    safePdfDictLookupName,
    safePdfDictLookupNumber,
    safePdfPageAnnots,
    safePdfPageInheritableDict,
} from '@pdf-core/safePdfLookup';
export { writePdfBookmarkOutlines } from '@pdf-core/writePdfBookmarkOutlines';
export {
    applyCombinedPdfPageLabels,
    inspectPdfCombineCatalog,
    offsetPdfCombineBookmarks,
    PDF_COMBINE_CATALOG_POLICY,
} from '@pdf-core/pdfCombineCatalog';
export type {IPdfCombinePageLabelRange} from '@pdf-core/pdfCombineCatalog';
export {
    DEFAULT_TIFF_DECODE_LIMITS,
    DEFAULT_TIFF_DECODE_MAX_FRAMES,
    DEFAULT_TIFF_DECODE_MAX_PIXELS,
    iterateDecodedTiffFrames,
} from '@pdf-core/iterateDecodedTiffFrames';
export type { IIterateDecodedTiffFramesOptions } from '@pdf-core/iterateDecodedTiffFrames';
export {
    extractPdfjsWordBoxesFromOperatorList,
    getPdfjsPageViewBox,
} from '@pdf-core/pdfjsTextGeometry';
export type {
    IPdfjsOperatorListLike,
    IPdfjsPageViewBox,
    TPdfjsTextOps,
} from '@pdf-core/pdfjsTextGeometry';
export { collectSearchMatchWords } from '@pdf-core/collectSearchMatchWords';
export type {
    INormalizedPdfSearchRequest,
    INormalizedPdfSearchWarmIndexRequest,
    IPdfSearchExcerpt,
    IPdfSearchUtf16Range,
    IResolvedSearchMatchOptions,
    ISearchMatchOptions,
    TPdfSearchUtf16Offset,
} from '@pdf-core/pdfSearchCore';
export {
    assertSafePdfSearchRegex,
    buildPdfSearchExcerpt,
    buildPdfSearchRegex,
    assembleSearchablePageText,
    collapseRepeatedPdfSearchPageText,
    escapeSearchRegex,
    findPdfSearchMatches,
    iteratePdfSearchMatches,
    mapAssembledSearchablePageTextRange,
    normalizeSearchText,
    normalizeOptionalSearchPageCount,
    normalizeOptionalSearchRequestId,
    normalizePdfSearchRequestPayload,
    normalizePdfSearchWarmIndexPayload,
    PDF_SEARCH_PROGRESS_RESULT_BATCH_LIMIT,
    SearchRegexLimitError,
    SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH,
    SEARCH_REGEX_MAX_EXECUTION_MS,
    SEARCH_PDF_PATH_MAX_LENGTH,
    SEARCH_REQUEST_ID_MAX_LENGTH,
    validateSearchQuery,
} from '@pdf-core/pdfSearchCore';
export {
    normalizePdfNativeAnnotationIdentityBindings,
    PDF_NATIVE_DATE_PATTERN,
    PDF_NATIVE_MUTATION_ENUM_VALUES,
    PDF_NATIVE_MUTATION_LIMITS,
    normalizePdfNativeModifiedAt,
    normalizePdfNativeMutationSet,
    normalizePdfNativeNoteChanges,
    normalizePdfNativeNoteTextUpdates,
} from '@contracts/nativePdfMutations';
export type {
    IPdfNativePlacedImageNativeToolPayload,
    IPdfNativeValidationOptions,
    TPdfNativeMutationSetNativeToolPayload,
} from '@contracts/nativePdfMutations';
export {
    buildTiffImageIfd,
    encodeTiffIfds,
    getTiffValueCount,
    measureTiffIfdSize,
} from '@pdf-core/tiffEncoding';
export type { ITiffImageDescriptor } from '@pdf-core/tiffEncoding';
export {
    buildPrintSpreadGroups,
    buildPrintablePdfData,
    canPrintSourcePdfDirectly,
    normalizePrintPageNumbers,
    shouldPrintPageMetricsDirectly,
    shouldPrintSourcePdfDirectly,
} from '@pdf-core/pdfPrintLayout';
export type {
    IBuildPrintablePdfDataOptions,
    IPrintablePageMetric,
} from '@pdf-core/pdfPrintLayout';
