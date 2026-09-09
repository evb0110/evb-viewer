import {
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IScanCleanupDetectionResult} from '@contracts/electronApiScanCleanup';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';
import {
    openScanCleanupDetectionResultStoreDescriptor,
    persistScanCleanupDetectionResultStore,
    removeScanCleanupDetectionResultStoreDescriptor,
} from '@electron/features/scan-cleanup/detectionResultStoreDescriptor';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        force: true,
        recursive: true,
    })));
});

describe('scan cleanup detection result-store handoff', () => {
    it('round-trips records through a bounded JSONL descriptor', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-detection-handoff-test-'));
        roots.push(root);
        const results = [
            {pageNumber: 1},
            {pageNumber: 2},
            {pageNumber: 3},
        ] as IScanCleanupDetectionResult[];
        const close = vi.fn(async () => undefined);
        const store: IScanCleanupDetectionResultStore = {
            append: async () => undefined,
            close,
            forEachChunk: async callback => callback(results, 1),
            getPage: async pageNumber => results[pageNumber - 1],
            pageCount: results.length,
            readRange: async (firstPageNumber, lastPageNumberExclusive) => results.slice(
                firstPageNumber - 1,
                lastPageNumberExclusive - 1,
            ),
            replace: async () => undefined,
            resultCount: results.length,
        };

        const descriptor = await persistScanCleanupDetectionResultStore(store, root);
        expect(descriptor.pageCount).toBe(3);
        expect(descriptor.resultCount).toBe(3);
        expect((await readFile(descriptor.recordsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual(results);

        const reopened = await openScanCleanupDetectionResultStoreDescriptor(descriptor);
        expect(reopened.pageCount).toBe(3);
        expect(reopened.resultCount).toBe(3);
        expect(await reopened.readRange(2, 3)).toEqual([{pageNumber: 2}]);
        await reopened.close();
        await removeScanCleanupDetectionResultStoreDescriptor(descriptor);
        expect(close).not.toHaveBeenCalled();
    });
});
