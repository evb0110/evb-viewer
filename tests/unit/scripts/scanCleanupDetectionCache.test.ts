import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {
    IScanCleanupDetectionResult,
    IScanCleanupOptions,
} from '@contracts/electronApiScanCleanup';
import { requirePageNumber } from '@contracts/pageNumbers';
import {createFileBackedScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/fileBackedResultStore';
import {readDetectionResultsForPageNumbers} from '@evb/scan-cleanup/core/runScanCleanupConversion';
import {buildScanCleanupCliDetectionRequestFields} from '@scripts/scan-cleanup-convert';
import {
    createScanCleanupDetectionCacheKey,
    openScanCleanupDetectionCacheStore,
    readScanCleanupDetectionCache,
    writeScanCleanupDetectionCacheStore,
    writeScanCleanupDetectionCache,
} from '@scripts/scanCleanupDetectionCache';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const temporaryDirectories: string[] = [];

function detectorPaths(scanCleanupBinaryPath: string) {
    return {
        pdftoppmBinaryPath: process.execPath,
        scanCleanupBinaryPath,
    };
}

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'auto',
    binarization: 'auto',
    normalizeIllumination: true,
    readingOrder: 'ltr',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckleLevel: 'normal',
    autoDewarp: false,
    autoDewarpDepth: undefined,
    skipBlankPages: false,
    pageOverrides: {},
};

const result: IScanCleanupDetectionResult = {
    pageNumber: requirePageNumber(1),
    classification: 'single-uncut-page',
    confidence: 0.9,
    cutterXPx: null,
    documentPrior: null,
    tier1Verdict: 'single-uncut-page',
    reconciled: true,
    clusterAgreement: 1,
};

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
        force: true,
        recursive: true,
    })));
});

describe('scan-cleanup detection cache', () => {
    it('keys source bytes and every detection option canonically', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-detection-cache-key-'));
        temporaryDirectories.push(directory);
        const sourcePath = join(directory, 'source.pdf');
        const scanCleanupBinaryPath = join(directory, 'evb-scan-cleanup');
        await writeFile(sourcePath, 'source-a', 'utf8');
        await writeFile(scanCleanupBinaryPath, 'detector-a', 'utf8');

        const initial = await createScanCleanupDetectionCacheKey(
            sourcePath,
            options,
            detectorPaths(scanCleanupBinaryPath),
        );
        const reorderedOptions = {
            ...options,
            pageOverrides: {},
        };
        expect(await createScanCleanupDetectionCacheKey(
            sourcePath,
            reorderedOptions,
            detectorPaths(scanCleanupBinaryPath),
        )).toEqual(initial);
        expect(await createScanCleanupDetectionCacheKey(sourcePath, {
            ...options,
            matchPageSize: false,
        }, detectorPaths(scanCleanupBinaryPath))).not.toEqual(initial);

        await writeFile(sourcePath, 'source-b', 'utf8');
        expect(await createScanCleanupDetectionCacheKey(
            sourcePath,
            options,
            detectorPaths(scanCleanupBinaryPath),
        )).not.toEqual(initial);

        await writeFile(sourcePath, 'source-a', 'utf8');
        await writeFile(scanCleanupBinaryPath, 'detector-b-with-changed-bytes', 'utf8');
        expect(await createScanCleanupDetectionCacheKey(
            sourcePath,
            options,
            detectorPaths(scanCleanupBinaryPath),
        )).not.toEqual(initial);
    });

    it('round-trips results and rejects a cache entry for another key', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-detection-cache-file-'));
        temporaryDirectories.push(directory);
        const sourcePath = join(directory, 'source.pdf');
        const scanCleanupBinaryPath = join(directory, 'evb-scan-cleanup');
        const cachePath = join(directory, 'cache');
        await writeFile(sourcePath, 'source', 'utf8');
        await writeFile(scanCleanupBinaryPath, 'detector', 'utf8');
        const key = await createScanCleanupDetectionCacheKey(
            sourcePath,
            options,
            detectorPaths(scanCleanupBinaryPath),
        );

        await writeScanCleanupDetectionCache(cachePath, key, [result]);
        expect(await readScanCleanupDetectionCache(cachePath, key)).toEqual([result]);

        const cacheEntryPath = join(cachePath, `${key.key}.json`);
        const cacheFile = JSON.parse(await readFile(cacheEntryPath, 'utf8')) as Record<string, unknown>;
        cacheFile.key = 'wrong-key';
        await writeFile(cacheEntryPath, JSON.stringify(cacheFile), 'utf8');
        expect(await readScanCleanupDetectionCache(cachePath, key)).toBeNull();
    });

    it('hands a million-page CLI detection store through and reads only bounded ranges', async () => {
        const pageCount = 1_000_000;
        const readRange = vi.fn(async (firstPageNumber: number, _lastPageNumberExclusive: number) => [{
            ...result,
            pageNumber: requirePageNumber(firstPageNumber),
        }]);
        const store: IScanCleanupDetectionResultStore = {
            append: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
            forEachChunk: vi.fn(async () => undefined),
            getPage: vi.fn(async () => undefined),
            pageCount,
            readRange,
            replace: vi.fn(async () => undefined),
            resultCount: pageCount,
        };
        const fromEntries = vi.spyOn(Object, 'fromEntries');
        try {
            const fields = buildScanCleanupCliDetectionRequestFields({
                resultStore: store,
                results: [],
            });
            expect(fields).toEqual({detectionResultStore: store});
            expect(fromEntries).not.toHaveBeenCalled();

            const pageNumbers = Array.from({length: 2_049}, (_, index) => index + 1);
            await readDetectionResultsForPageNumbers(store, pageNumbers, new AbortController().signal);
            const calls = readRange.mock.calls.map(call => ({
                firstPageNumber: call[0],
                pageCount: call[1] - call[0],
            }));
            expect(calls).toEqual([
                {
                    firstPageNumber: 1,
                    pageCount: 1_024,
                },
                {
                    firstPageNumber: 1_025,
                    pageCount: 1_024,
                },
                {
                    firstPageNumber: 2_049,
                    pageCount: 1,
                },
            ]);
            expect(Math.max(...calls.map(call => call.pageCount))).toBeLessThanOrEqual(1_024);
        } finally {
            fromEntries.mockRestore();
        }
    });

    it.each([
        [
            1_024,
            false,
        ],
        [
            1_025,
            true,
        ],
        [
            2_646,
            true,
        ],
    ])('uses the bounded result-store seam above the %s-page compatibility boundary', (pageCount, expectsStore) => {
        const store: IScanCleanupDetectionResultStore = {
            append: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
            forEachChunk: vi.fn(async () => undefined),
            getPage: vi.fn(async () => undefined),
            pageCount,
            readRange: vi.fn(async () => []),
            replace: vi.fn(async () => undefined),
            resultCount: pageCount,
        };
        const fields = buildScanCleanupCliDetectionRequestFields({
            resultStore: store,
            // A real small run has a compatibility snapshot. The xlarge
            // result store remains authoritative even if a caller supplies a
            // partial snapshot while migrating an older detector.
            results: [result],
        });
        expect('detectionResultStore' in fields).toBe(expectsStore);
        if (expectsStore) {
            expect(fields).toEqual({detectionResultStore: store});
        }
    });

    it('round-trips an xlarge detection cache through its JSONL sidecar', {timeout: 30_000}, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-detection-cache-stream-'));
        temporaryDirectories.push(directory);
        const cachePath = join(directory, 'cache');
        const key = {
            key: 'streaming-key',
            sourceSha256: 'streaming-source',
        };
        const pageCount = 20_001;
        const store = await createFileBackedScanCleanupDetectionResultStore({
            pageCount,
            rootDir: directory,
        });
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
            await store.append({
                ...result,
                pageNumber: requirePageNumber(pageNumber),
            });
        }
        await writeScanCleanupDetectionCacheStore(cachePath, key, store);
        await store.close();

        const reopened = await openScanCleanupDetectionCacheStore(cachePath, key);
        expect(reopened).not.toBeNull();
        expect(reopened?.pageCount).toBe(pageCount);
        expect(reopened?.resultCount).toBe(pageCount);
        expect(await reopened?.readRange(20_000, 20_002)).toEqual([
            {
                ...result,
                pageNumber: requirePageNumber(20_000),
            },
            {
                ...result,
                pageNumber: requirePageNumber(20_001),
            },
        ]);
        await reopened?.close();
    });
});
