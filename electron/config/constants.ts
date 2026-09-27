import {SEARCH_RESULT_LIMIT} from '@contracts/search';

/** Hard cap per IPC read range to keep memory usage bounded (PDF.js will request more ranges if needed). */
export const MAX_CHUNK = 8 * 1024 * 1024;

/** Maximum number of search results before truncation. */
export { SEARCH_RESULT_LIMIT };

/** Maximum number of entries in the recent-files list. */
export const MAX_RECENT_FILES = 10;

/** Duration (ms) the recent-files in-memory cache is considered fresh. */
export const CACHE_TTL_MS = 5000;

/** Timeout (ms) for waiting for the first renderer to fully signal readiness. */
export const WINDOW_RENDERER_READY_TIMEOUT_MS = 30_000;
