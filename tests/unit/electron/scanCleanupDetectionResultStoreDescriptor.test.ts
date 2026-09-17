import {
    mkdtemp,
    open,
    readFile,
    readdir,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    dirname,
    join,
} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IScanCleanupDetectionResult} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';
import {
    openScanCleanupDetectionResultStoreDescriptor,
    persistScanCleanupDetectionResultStore,
    removeScanCleanupDetectionResultStoreDescriptor,
} from '@electron/features/scan-cleanup/detectionResultStoreDescriptor';

const roots: string[] = [];
type TFileHandle = Awaited<ReturnType<typeof open>>;
interface IFileHandleWriteResult {
    bytesWritten: number;
    buffer: Uint8Array;
}
type TFileHandleWrite = (
    this: TFileHandle,
    data: Buffer,
    offset: number,
    length: number,
    position?: number,
) => Promise<IFileHandleWriteResult>;
type TFileHandleWritePrototype = Record<'write', TFileHandleWrite>;

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
        expect((await readdir(dirname(descriptor.recordsPath))).sort()).toEqual([
            'descriptor.json',
            'index.bin',
            'records.jsonl',
        ]);
        expect((await readFile(descriptor.recordsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual(results);

        const reopened = await openScanCleanupDetectionResultStoreDescriptor(descriptor);
        expect(reopened.pageCount).toBe(3);
        expect(reopened.resultCount).toBe(3);
        expect(await reopened.readRange(2, 3)).toEqual([{pageNumber: 2}]);
        await expect(reopened.append(results[0]!)).rejects.toThrow('read-only');
        expect((await readdir(dirname(descriptor.recordsPath))).sort()).toEqual([
            'descriptor.json',
            'index.bin',
            'records.jsonl',
        ]);
        await reopened.close();
        expect((await readdir(dirname(descriptor.recordsPath))).sort()).toEqual([
            'descriptor.json',
            'index.bin',
            'records.jsonl',
        ]);
        await removeScanCleanupDetectionResultStoreDescriptor(descriptor);
        expect(close).not.toHaveBeenCalled();
    });

    it('persists indexed records when file writes are partial', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-detection-handoff-partial-write-test-'));
        roots.push(root);
        const results = [
            {pageNumber: 1},
            {pageNumber: 2},
            {pageNumber: 3},
        ] as IScanCleanupDetectionResult[];
        const store: IScanCleanupDetectionResultStore = {
            append: async () => undefined,
            close: async () => undefined,
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
        const probe = await open(join(root, 'write-probe'), 'w+');
        const prototype = Object.getPrototypeOf(probe) as TFileHandleWritePrototype;
        const originalWrite = prototype.write;
        const partialWrite = vi.spyOn(prototype, 'write').mockImplementation(async function(
            this: TFileHandle,
            data: Buffer,
            offset: number,
            length: number,
            position?: number,
        ) {
            return originalWrite.call(this, data, offset, Math.max(1, Math.floor(length / 2)), position);
        });

        try {
            const descriptor = await persistScanCleanupDetectionResultStore(store, root);
            const reopened = await openScanCleanupDetectionResultStoreDescriptor(descriptor);
            expect(await reopened.readRange(1, 4)).toEqual(results);
            await reopened.close();
            await removeScanCleanupDetectionResultStoreDescriptor(descriptor);
        } finally {
            partialWrite.mockRestore();
            await probe.close();
        }
    });
});
