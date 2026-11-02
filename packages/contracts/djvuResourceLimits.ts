// Desktop previews a DjVu with more pages than this through the native
// renderer rather than the bundled DjVu.js decoder. It routes desktop work;
// the browser reads every page table in full.
export const DESKTOP_DJVUJS_PREVIEW_MAX_PAGES = 10_000;
export const DJVU_OUTLINE_MAX_DEPTH = 64;
export const DJVU_OUTLINE_MAX_NODES = 10_000;
export const DJVU_OUTLINE_MAX_TITLE_CHARS = 1_000_000;
export const DJVU_SEARCH_MAX_PAGE_TEXT_CHARS = 8 * 1024 * 1024;
export const DJVU_SEARCH_MAX_PAGE_ZONES = 200_000;
// A page preview renders at most this many pixels, the output budget desktop's
// native preview applies too. A larger page is scaled down, never refused.
export const DJVU_PREVIEW_MAX_OUTPUT_PIXELS = 45_000_000;
