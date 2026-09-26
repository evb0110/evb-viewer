/**
 * The array extraction APIs are kept for small documents only. Larger
 * documents use the page stream so page count does not become an allocation
 * request.
 */
export const BROWSER_SEARCH_LEGACY_ARRAY_PAGE_LIMIT = 1_024;
