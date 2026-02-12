/** Hard cap per IPC read range to keep memory usage bounded (PDF.js will request more ranges if needed). */
export const MAX_CHUNK = 8 * 1024 * 1024;

/** Maximum number of search results before truncation. */
export const SEARCH_RESULT_LIMIT = 500;

/** Characters of context to include before/after a search match in excerpts. */
export const EXCERPT_CONTEXT_CHARS = 40;

/** Maximum number of entries in the recent-files list. */
export const MAX_RECENT_FILES = 10;

/** Duration (ms) the recent-files in-memory cache is considered fresh. */
export const CACHE_TTL_MS = 5000;

/** Timeout (ms) for waiting for the Nuxt server to become ready. */
export const SERVER_READY_TIMEOUT_MS = 30_000;

/** Polling interval (ms) when checking if the Nuxt server is running. */
export const SERVER_POLL_INTERVAL_MS = 250;

/** Maximum health-check retries after the server signals readiness. */
export const SERVER_HEALTH_MAX_ATTEMPTS = 10;

/** Delay (ms) between health-check retries. */
export const SERVER_HEALTH_RETRY_MS = 300;
