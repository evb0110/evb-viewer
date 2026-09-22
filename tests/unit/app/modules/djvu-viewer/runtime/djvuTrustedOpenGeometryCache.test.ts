import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IDjvuPageSourceInfo} from '@contracts/electronApiDjvu';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {IRecentFile} from '@contracts/shared';
import {requireEpochMs} from '@contracts/timestamps';
import {
    prewarmRecentDjvuOpeningGeometry,
    readPrevalidatedTrustedDjvuOpenGeometry,
} from '@app/modules/djvu-viewer/runtime/djvuTrustedOpenGeometryCache';

describe('DjVu trusted opening geometry cache', () => {
    it('makes exact Recent geometry synchronously available before the click transaction', async () => {
        const readStat = vi.fn().mockRejectedValue(new Error('generic file stat is not authorized yet'));
        const readSourceInfo = vi.fn().mockResolvedValue({
            pageCount: 431,
            pageNumber: requirePageNumber(1),
            pageSize: {
                width: 600,
                height: 800,
                dpi: 300,
            },
            sourceSize: 28_000_000,
            sourceModifiedAt: requireEpochMs(42),
        });

        await prewarmRecentDjvuOpeningGeometry([{
            fileName: 'scan.djvu',
            originalPath: requireDocumentRef('/docs/scan.djvu'),
            timestamp: requireEpochMs(Date.now()),
        }], {
            readStat,
            readSourceInfo,
        });

        expect(readPrevalidatedTrustedDjvuOpenGeometry('/docs/scan.djvu', 1, {
            size: 28_000_000,
            modifiedAt: 42,
        })).toEqual({
            documentId: '/docs/scan.djvu',
            pageNumber: 1,
            pageCount: 431,
            width: 144,
            height: 192,
            rotation: 0,
            size: 28_000_000,
            modifiedAt: 42,
        });
        expect(readStat).not.toHaveBeenCalled();
        expect(readSourceInfo).toHaveBeenCalledTimes(1);
    });

    it('rejects a cached seed when the current source revision differs', async () => {
        const path = requireDocumentRef('/docs/replaced.djvu');
        await prewarmRecentDjvuOpeningGeometry([{
            fileName: 'replaced.djvu',
            originalPath: path,
            timestamp: requireEpochMs(3),
        }], {readSourceInfo: vi.fn().mockResolvedValue({
            pageCount: 2,
            pageNumber: requirePageNumber(1),
            pageSize: {
                width: 600,
                height: 800,
                dpi: 300,
            },
            sourceSize: 100,
            sourceModifiedAt: requireEpochMs(10),
        })});

        expect(readPrevalidatedTrustedDjvuOpenGeometry(path, 1, {
            size: 101,
            modifiedAt: 10,
        })).toBeNull();
    });

    it('evicts the least recently used geometry after the bounded limit', async () => {
        const files: IRecentFile[] = Array.from({length: 257}, (_, index) => ({
            fileName: `bounded-${String(index + 1)}.djvu`,
            originalPath: requireDocumentRef(`/docs/bounded-${String(index + 1)}.djvu`),
            timestamp: requireEpochMs(index + 1),
        }));
        await prewarmRecentDjvuOpeningGeometry(files, {readSourceInfo: vi.fn().mockResolvedValue({
            pageCount: 2,
            pageNumber: requirePageNumber(1),
            pageSize: {
                width: 600,
                height: 800,
                dpi: 300,
            },
            sourceSize: 100,
            sourceModifiedAt: requireEpochMs(10),
        })}, {
            limit: files.length,
            concurrency: 32,
        });

        expect(readPrevalidatedTrustedDjvuOpenGeometry(files[0]!.originalPath, 1, {
            size: 100,
            modifiedAt: 10,
        })).toBeNull();
        expect(readPrevalidatedTrustedDjvuOpenGeometry(files.at(-1)!.originalPath, 1, {
            size: 100,
            modifiedAt: 10,
        })).not.toBeNull();
    });

    it('fails a stalled Recent probe open without blocking a ready sibling', async () => {
        const stalledPath = requireDocumentRef('/docs/stalled.djvu');
        const readyPath = requireDocumentRef('/docs/ready.djvu');
        const settled = new Map<string, boolean>();
        const results = await prewarmRecentDjvuOpeningGeometry([
            {
                fileName: 'stalled.djvu',
                originalPath: stalledPath,
                timestamp: requireEpochMs(2),
            },
            {
                fileName: 'ready.djvu',
                originalPath: readyPath,
                timestamp: requireEpochMs(1),
            },
        ], {
            readStat: vi.fn().mockResolvedValue({
                size: 1_000,
                modifiedAt: requireEpochMs(2_000),
            }),
            readSourceInfo: vi.fn((path: string): Promise<IDjvuPageSourceInfo> => path === stalledPath
                ? new Promise<IDjvuPageSourceInfo>(() => undefined)
                : Promise.resolve({
                    pageCount: 2,
                    pageNumber: requirePageNumber(1),
                    pageSize: {
                        width: 600,
                        height: 800,
                        dpi: 300,
                    },
                })),
        }, {
            concurrency: 2,
            settleTimeoutMs: 20,
            onSettled: (file, geometry) => settled.set(file.originalPath, geometry !== null),
        });

        expect(results.get(stalledPath)).toBeNull();
        expect(results.get(readyPath)).not.toBeNull();
        expect(settled).toEqual(new Map([
            [
                readyPath,
                true,
            ],
            [
                stalledPath,
                false,
            ],
        ]));
    });

    it('does not stack more native probes behind timed-out worker slots', async () => {
        const files: IRecentFile[] = Array.from({length: 4}, (_, index) => ({
            originalPath: requireDocumentRef(`/docs/permanently-stalled-${String(index + 1)}.djvu`),
            fileName: `permanently-stalled-${String(index + 1)}.djvu`,
            timestamp: requireEpochMs(4 - index),
        }));
        const readSourceInfo = vi.fn(() => new Promise<IDjvuPageSourceInfo>(() => undefined));

        const results = await prewarmRecentDjvuOpeningGeometry(files, {readSourceInfo}, {
            concurrency: 2,
            settleTimeoutMs: 5,
        });

        expect(readSourceInfo).toHaveBeenCalledTimes(2);
        expect(results.size).toBe(files.length);
        files.forEach(file => {
            expect(results.get(file.originalPath)).toBeNull();
        });
    });
});
