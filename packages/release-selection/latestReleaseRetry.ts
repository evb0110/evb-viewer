import {waitForBoundedOperation} from '../node-runtime/waitForBoundedOperation';

interface IHeadersLike {get: (name: string) => string | null}
interface ITaggedRelease {tag_name: string}

interface IReleaseDataRetryOptions<TResult> {
    fetchResult: (signal: AbortSignal) => Promise<TResult>
    shouldRetryResult?: (result: TResult) => boolean
    sleep?: (delayMs: number) => Promise<void>
    retries?: number
    random?: () => number
    totalTimeoutMs?: number
}

interface IReleaseCatalogLoaderOptions {
    freshForMs?: number
    staleForMs?: number
    now?: () => number
}

interface IReleaseCatalogLoadOptions<TCatalog> {
    cacheKey: string
    fetchCatalog: () => Promise<TCatalog>
    isUsableCatalog?: (catalog: TCatalog) => boolean
}

const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 450;
const RELEASE_RETRY_JITTER_FRACTION = 0.25;
const DEFAULT_TOTAL_TIMEOUT_MS = 9_000;
const MAX_RETRY_AFTER_MS = 8_000;
const DEFAULT_CATALOG_FRESH_MS = 5 * 60_000;
const DEFAULT_CATALOG_STALE_MS = 7 * 24 * 60 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isHeadersLike(value: unknown): value is IHeadersLike {
    return isRecord(value) && typeof value.get === 'function';
}

function toStatusCode(value: unknown) {
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

export function getReleaseFetchStatusCode(error: unknown) {
    if (!isRecord(error)) {
        return null;
    }

    const directStatus = toStatusCode(error.statusCode) ?? toStatusCode(error.status);
    if (directStatus !== null) {
        return directStatus;
    }

    return isRecord(error.response) ? toStatusCode(error.response.status) : null;
}

function getRetryAfterHeader(error: unknown) {
    if (!isRecord(error) || !isRecord(error.response) || !isHeadersLike(error.response.headers)) {
        return null;
    }

    return error.response.headers.get('retry-after');
}

export function parseRetryAfterMs(value: string | null, now = Date.now()) {
    if (!value) {
        return null;
    }

    const seconds = Number(value);
    const parsedDelay = Number.isFinite(seconds)
        ? seconds * 1_000
        : Date.parse(value) - now;

    if (!Number.isFinite(parsedDelay)) {
        return null;
    }

    return Math.min(Math.max(0, parsedDelay), MAX_RETRY_AFTER_MS);
}

export function shouldRetryReleaseFetch(error: unknown) {
    const statusCode = getReleaseFetchStatusCode(error);
    return statusCode === null || statusCode === 429 || statusCode >= 500;
}

export function getMissingConfiguredReleaseTags(
    releases: readonly ITaggedRelease[],
    configuredTags: readonly string[],
) {
    const listedTags = new Set(releases.map(release => release.tag_name));
    return Array.from(new Set(configuredTags)).filter(tag => !listedTags.has(tag));
}

function sleep(delayMs: number) {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
    });
}

function createDeadlineError() {
    const error = new Error('Latest release fetch exceeded its total deadline.');
    error.name = 'TimeoutError';
    return error;
}

function jitterDelay(delayMs: number, random: () => number) {
    const normalizedRandom = Math.min(1, Math.max(0, random()));
    const lowerBound = 1 - RELEASE_RETRY_JITTER_FRACTION;
    const span = 2 * RELEASE_RETRY_JITTER_FRACTION;
    return Math.round(delayMs * (lowerBound + normalizedRandom * span));
}

export async function fetchReleaseDataWithRetry<TResult>(
    options: IReleaseDataRetryOptions<TResult>,
) {
    const retryCount = options.retries ?? DEFAULT_RETRIES;
    const wait = options.sleep ?? sleep;
    const random = options.random ?? Math.random;
    const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    const startedAt = Date.now();
    let latestResult: { value: TResult } | null = null;

    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        try {
            const remainingMs = totalTimeoutMs - (Date.now() - startedAt);
            if (remainingMs <= 0) {
                throw createDeadlineError();
            }
            const result = await waitForBoundedOperation(options.fetchResult, {
                timeoutMs: remainingMs,
                timeoutError: createDeadlineError,
            });
            if (!options.shouldRetryResult?.(result) || attempt === retryCount) {
                return result;
            }
            latestResult = { value: result };
        } catch (error) {
            if (!shouldRetryReleaseFetch(error)) {
                throw error;
            }
            if (attempt === retryCount) {
                if (latestResult) {
                    return latestResult.value;
                }
                throw error;
            }

            const retryAfterMs = parseRetryAfterMs(getRetryAfterHeader(error));
            const delayMs = retryAfterMs ?? jitterDelay(DEFAULT_RETRY_DELAY_MS * (attempt + 1), random);
            const remainingMs = totalTimeoutMs - (Date.now() - startedAt);
            if (delayMs >= remainingMs) {
                if (latestResult) {
                    return latestResult.value;
                }
                throw createDeadlineError();
            }
            await wait(delayMs);
            continue;
        }

        const delayMs = jitterDelay(DEFAULT_RETRY_DELAY_MS * (attempt + 1), random);
        const remainingMs = totalTimeoutMs - (Date.now() - startedAt);
        if (delayMs >= remainingMs) {
            return latestResult.value;
        }
        await wait(delayMs);
    }

    if (latestResult) {
        return latestResult.value;
    }

    throw new Error('Release data fetch exhausted without a result.');
}

/** Keeps one raw upstream catalog per warm server instance, independent of request headers. */
export function createReleaseCatalogLoader<TCatalog>(options: IReleaseCatalogLoaderOptions = {}) {
    const freshForMs = options.freshForMs ?? DEFAULT_CATALOG_FRESH_MS;
    const staleForMs = options.staleForMs ?? DEFAULT_CATALOG_STALE_MS;
    const now = options.now ?? Date.now;
    let cached: {
        cacheKey: string
        catalog: TCatalog
        fetchedAt: number
    } | null = null;
    let inFlight: {
        cacheKey: string
        promise: Promise<{
            catalog: TCatalog
            stale: boolean
        }>
    } | null = null;

    function isCurrentInFlight(promise: Promise<unknown>) {
        return inFlight !== null && inFlight.promise === promise;
    }

    return async ({
        cacheKey,
        fetchCatalog,
        isUsableCatalog = () => true,
    }: IReleaseCatalogLoadOptions<TCatalog>): Promise<{
        catalog: TCatalog
        stale: boolean
    }> => {
        const ageMs = cached?.cacheKey === cacheKey ? now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
        if (cached && cached.cacheKey === cacheKey && ageMs <= freshForMs) {
            return {
                catalog: cached.catalog,
                stale: false,
            };
        }
        if (inFlight?.cacheKey === cacheKey) {
            return inFlight.promise;
        }

        const staleCandidate = cached?.cacheKey === cacheKey && ageMs <= staleForMs ? cached : null;
        const promise = (async () => {
            try {
                const catalog = await fetchCatalog();
                if (!isUsableCatalog(catalog)) {
                    if (staleCandidate) {
                        return {
                            catalog: staleCandidate.catalog,
                            stale: true,
                        };
                    }

                    return {
                        catalog,
                        stale: false,
                    };
                }
                cached = {
                    cacheKey,
                    catalog,
                    fetchedAt: now(),
                };
                return {
                    catalog,
                    stale: false,
                };
            } catch (error) {
                if (staleCandidate) {
                    return {
                        catalog: staleCandidate.catalog,
                        stale: true,
                    };
                }
                throw error;
            }
        })();
        inFlight = {
            cacheKey,
            promise,
        };

        try {
            return await promise;
        } finally {
            if (isCurrentInFlight(promise)) {
                inFlight = null;
            }
        }
    };
}
