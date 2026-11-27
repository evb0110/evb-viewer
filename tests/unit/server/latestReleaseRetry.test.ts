import {describe, expect, it, vi} from 'vitest';
import {
    createReleaseCatalogLoader,
    fetchReleaseDataWithRetry,
    getMissingConfiguredReleaseTags,
    parseRetryAfterMs,
    shouldRetryReleaseFetch,
} from '@releaseSelection';

interface IReleaseFixture {
    assets: string[];
    tag: string;
}

function createResponseError(status: number, retryAfter: string | null = null) {
    return {
        response: {
            status,
            headers: {get: (name: string) => (name === 'retry-after' ? retryAfter : null)},
        },
    };
}

function createOptions(fetchRelease: () => Promise<IReleaseFixture>) {
    return {
        fetchResult: fetchRelease,
        random: () => 0.5,
        shouldRetryResult: (release: IReleaseFixture) => release.assets.length === 0,
        sleep: vi.fn(async () => {}),
    };
}

describe('latest landing release retry', () => {
    it('retries an initial server failure and returns the first usable release', async () => {
        const fetchRelease = vi
            .fn()
            .mockRejectedValueOnce(createResponseError(503))
            .mockResolvedValue({
                tag: 'v2',
                assets: ['installer'],
            });
        const options = createOptions(fetchRelease);

        await expect(fetchReleaseDataWithRetry(options)).resolves.toEqual({
            tag: 'v2',
            assets: ['installer'],
        });
        expect(fetchRelease).toHaveBeenCalledTimes(2);
        expect(options.sleep).toHaveBeenCalledWith(450);
    });

    it('honors a bounded Retry-After delay for rate limits', async () => {
        const fetchRelease = vi
            .fn()
            .mockRejectedValueOnce(createResponseError(429, '2'))
            .mockResolvedValue({
                tag: 'v2',
                assets: ['installer'],
            });
        const options = createOptions(fetchRelease);

        await fetchReleaseDataWithRetry(options);

        expect(options.sleep).toHaveBeenCalledWith(2_000);
        expect(parseRetryAfterMs('60')).toBe(8_000);
    });

    it('does not retry a permanent client error', async () => {
        const error = createResponseError(404);
        const fetchRelease = vi.fn().mockRejectedValue(error);
        const options = createOptions(fetchRelease);

        await expect(fetchReleaseDataWithRetry(options)).rejects.toBe(error);
        expect(fetchRelease).toHaveBeenCalledTimes(1);
        expect(options.sleep).not.toHaveBeenCalled();
        expect(shouldRetryReleaseFetch(error)).toBe(false);
    });

    it('bounds repeated network failures to the configured attempt count', async () => {
        const error = new Error('socket closed');
        const fetchRelease = vi.fn().mockRejectedValue(error);
        const options = createOptions(fetchRelease);

        await expect(fetchReleaseDataWithRetry(options)).rejects.toBe(error);
        expect(fetchRelease).toHaveBeenCalledTimes(3);
        expect(options.sleep).toHaveBeenCalledTimes(2);
    });

    it('jitters retry delays to avoid synchronized upstream refreshes', async () => {
        const fetchRelease = vi
            .fn()
            .mockRejectedValueOnce(createResponseError(503))
            .mockResolvedValue({
                tag: 'v2',
                assets: ['installer'],
            });
        const options = {
            ...createOptions(fetchRelease),
            random: () => 0,
        };

        await fetchReleaseDataWithRetry(options);

        expect(options.sleep).toHaveBeenCalledWith(338);

        const upperFetch = vi
            .fn()
            .mockRejectedValueOnce(createResponseError(503))
            .mockResolvedValue({
                tag: 'v2',
                assets: ['installer'],
            });
        const upperOptions = {
            ...createOptions(upperFetch),
            random: () => 1,
        };
        await fetchReleaseDataWithRetry(upperOptions);

        expect(upperOptions.sleep).toHaveBeenCalledWith(563);
    });

    it('aborts a hung upstream attempt at the total deadline', async () => {
        vi.useFakeTimers();
        try {
            let upstreamSignal: AbortSignal | undefined;
            const fetchResult = fetchReleaseDataWithRetry({
                ...createOptions(
                    vi.fn((signal?: AbortSignal) => {
                        upstreamSignal = signal;
                        return new Promise<IReleaseFixture>((_resolve, reject) => {
                            signal?.addEventListener(
                                'abort',
                                () => {
                                    reject(signal.reason);
                                },
                                {once: true},
                            );
                        });
                    }),
                ),
                totalTimeoutMs: 50,
            });
            const rejection = expect(fetchResult).rejects.toMatchObject({name: 'TimeoutError'});

            await vi.advanceTimersByTimeAsync(51);

            expect(upstreamSignal?.aborted).toBe(true);
            await rejection;
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries empty releases but preserves the final empty response', async () => {
        const fetchRelease = vi
            .fn()
            .mockResolvedValueOnce({
                tag: 'v1',
                assets: [],
            })
            .mockResolvedValueOnce({
                tag: 'v2',
                assets: [],
            })
            .mockResolvedValue({
                tag: 'v3',
                assets: [],
            });
        const options = createOptions(fetchRelease);

        await expect(fetchReleaseDataWithRetry(options)).resolves.toEqual({
            tag: 'v3',
            assets: [],
        });
        expect(fetchRelease).toHaveBeenCalledTimes(3);
    });

    it('returns the latest successful empty result when the remaining deadline cannot fit a retry', async () => {
        const fetchRelease = vi.fn().mockResolvedValue({
            tag: 'v1',
            assets: [],
        });

        await expect(
            fetchReleaseDataWithRetry({
                ...createOptions(fetchRelease),
                totalTimeoutMs: 100,
            }),
        ).resolves.toEqual({
            tag: 'v1',
            assets: [],
        });
        expect(fetchRelease).toHaveBeenCalledOnce();
    });

    it('still reports a deadline when no upstream attempt has succeeded', async () => {
        await expect(
            fetchReleaseDataWithRetry({
                ...createOptions(vi.fn().mockRejectedValue(createResponseError(503))),
                totalTimeoutMs: 100,
            }),
        ).rejects.toMatchObject({name: 'TimeoutError'});
    });

    it('identifies configured rollback tags omitted from the catalog page', () => {
        expect(getMissingConfiguredReleaseTags([{tag_name: 'v100'}, {tag_name: 'v99'}], ['v100', 'v20', 'v20'])).toEqual(['v20']);
    });
});

describe('release catalog cache', () => {
    it('coalesces concurrent refreshes and reuses the raw catalog across request variants', async () => {
        let resolveCatalog!: (value: string[]) => void;
        const pendingCatalog = new Promise<string[]>((resolve) => {
            resolveCatalog = resolve;
        });
        const fetchCatalog = vi.fn(() => pendingCatalog);
        const loader = createReleaseCatalogLoader<string[]>();

        const first = loader({
            cacheKey: 'github/repository/config',
            fetchCatalog,
        });
        const second = loader({
            cacheKey: 'github/repository/config',
            fetchCatalog,
        });
        resolveCatalog(['v2']);

        await expect(Promise.all([first, second])).resolves.toEqual([
            {
                catalog: ['v2'],
                stale: false,
            },
            {
                catalog: ['v2'],
                stale: false,
            },
        ]);
        await expect(
            loader({
                cacheKey: 'github/repository/config',
                fetchCatalog,
            }),
        ).resolves.toEqual({
            catalog: ['v2'],
            stale: false,
        });
        expect(fetchCatalog).toHaveBeenCalledTimes(1);
    });

    it('serves last-known-good data only within the bounded stale window', async () => {
        let now = 0;
        const loader = createReleaseCatalogLoader<string[]>({
            freshForMs: 10,
            staleForMs: 100,
            now: () => now,
        });
        await loader({
            cacheKey: 'catalog',
            fetchCatalog: async () => ['v2'],
        });
        now = 11;

        await expect(
            loader({
                cacheKey: 'catalog',
                fetchCatalog: async () => {
                    throw new Error('upstream unavailable');
                },
            }),
        ).resolves.toEqual({
            catalog: ['v2'],
            stale: true,
        });

        now = 101;
        await expect(
            loader({
                cacheKey: 'catalog',
                fetchCatalog: async () => {
                    throw new Error('still unavailable');
                },
            }),
        ).rejects.toThrow('still unavailable');
    });

    it('does not replace last-known-good data with an unusable empty catalog', async () => {
        let now = 0;
        const loader = createReleaseCatalogLoader<string[]>({
            freshForMs: 10,
            staleForMs: 100,
            now: () => now,
        });
        await loader({
            cacheKey: 'catalog',
            fetchCatalog: async () => ['v2'],
            isUsableCatalog: (catalog) => catalog.length > 0,
        });
        now = 11;

        await expect(
            loader({
                cacheKey: 'catalog',
                fetchCatalog: async () => [],
                isUsableCatalog: (catalog) => catalog.length > 0,
            }),
        ).resolves.toEqual({
            catalog: ['v2'],
            stale: true,
        });
    });
});
