// @vitest-environment happy-dom

import { requirePageNumber } from '@contracts/pageNumbers';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireEpochMs } from '@contracts/timestamps';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IRecentFile } from '@contracts/shared';
import { prewarmRecentPdfOpeningGeometry } from '@app/modules/pdf-viewer/runtime/lifecycle/prewarmRecentPdfOpeningGeometry';
import {
    invalidateTrustedPdfOpenGeometry,
    readPrevalidatedTrustedPdfOpenGeometry,
    writeTrustedPdfOpenGeometry,
} from '@app/modules/pdf-viewer/runtime/lifecycle/pdfTrustedOpenGeometryCache';

const pdfPaths = Array.from({length: 6}, (_, index) => requireDocumentRef(
    `/documents/recent-${String(index + 1)}.pdf`,
));
const mocks = vi.hoisted(() => ({performanceProfile: {
    tier: 'medium',
    lowCpu: false,
    lowMemory: false,
    maxCachedPdfPages: 48,
}}));

vi.mock('@app/utils/performanceProfile', () => ({
    getPerformanceProfile: () => mocks.performanceProfile,
    resolvePerformanceProfile: () => mocks.performanceProfile,
}));

function createRecentFile(
    originalPath: TDocumentRef,
    timestamp: number,
    fileSize = 1_000,
): IRecentFile {
    return {
        originalPath,
        fileName: String(originalPath).split('/').at(-1) ?? String(originalPath),
        timestamp: requireEpochMs(timestamp),
        fileSize,
    };
}

describe('Recent PDF opening geometry application warmup', () => {
    beforeEach(() => {
        localStorage.clear();
        for (const path of pdfPaths) {
            invalidateTrustedPdfOpenGeometry(path, requirePageNumber(1));
        }
        mocks.performanceProfile.lowCpu = false;
        mocks.performanceProfile.lowMemory = false;
    });

    it('warms only the bounded leading PDF set before an empty tab can be clicked', async () => {
        const activeReads = new Set<string>();
        let maxConcurrentReads = 0;
        const readOpeningGeometry = vi.fn(async (path: string) => {
            activeReads.add(path);
            maxConcurrentReads = Math.max(maxConcurrentReads, activeReads.size);
            await Promise.resolve();
            activeReads.delete(path);
            return {
                pageNumber: requirePageNumber(1),
                pageCount: 10,
                width: 612,
                height: 792,
                rotation: 0 as const,
                size: 1_000,
                modifiedAt: requireEpochMs(2_000),
            };
        });
        const files = [
            createRecentFile(requireDocumentRef('/documents/readme.txt'), 10, 20),
            ...pdfPaths.map((path, index) => createRecentFile(path, 9 - index)),
        ];

        const results = await prewarmRecentPdfOpeningGeometry(files, {
            readStat: vi.fn(async () => {
                throw new Error('source stat is intentionally unavailable before open');
            }),
            readOpeningGeometry,
        }, {
            concurrency: 2,
            limit: 4,
        });

        expect([...results.keys()]).toHaveLength(4);
        expect(readOpeningGeometry).toHaveBeenCalledTimes(4);
        expect(maxConcurrentReads).toBeLessThanOrEqual(2);
        for (const path of pdfPaths.slice(0, 4)) {
            expect(readPrevalidatedTrustedPdfOpenGeometry(path, requirePageNumber(1))).toMatchObject({
                documentId: path,
                pageNumber: 1,
                width: 612,
                height: 792,
            });
        }
        expect(readPrevalidatedTrustedPdfOpenGeometry(pdfPaths[4]!, requirePageNumber(1))).toBeNull();
    });

    it('authoritatively refreshes a validated same-path source revision before making it ready again', async () => {
        const file = {...createRecentFile(pdfPaths[0]!, 1)};
        let sourceRevision = 2_000;
        const readOpeningGeometry = vi.fn(async () => ({
            pageNumber: requirePageNumber(1),
            pageCount: 10,
            width: 612,
            height: 792,
            rotation: 0 as const,
            size: 1_000,
            modifiedAt: requireEpochMs(sourceRevision),
        }));
        const port = {
            readStat: vi.fn(async () => ({
                size: 1_000,
                modifiedAt: 2_000,
            })),
            readOpeningGeometry,
        };

        await prewarmRecentPdfOpeningGeometry([file], port);
        sourceRevision = 3_000;
        await prewarmRecentPdfOpeningGeometry([file], port);

        expect(readOpeningGeometry).toHaveBeenCalledTimes(2);
        expect(readPrevalidatedTrustedPdfOpenGeometry(file.originalPath, requirePageNumber(1))).toMatchObject({
            size: 1_000,
            modifiedAt: 3_000,
        });
    });

    it('silently settles a retired working-copy geometry miss', async () => {
        const file = {...createRecentFile(requireDocumentRef('/tmp/pdf-work-retired/old.pdf'), 1)};
        const onError = vi.fn();
        const onSettled = vi.fn();

        const results = await prewarmRecentPdfOpeningGeometry(
            [file],
            {readOpeningGeometry: vi.fn(async () => null)},
            {
                onError,
                onSettled,
            },
        );

        expect(results.get(file.originalPath)).toBeNull();
        expect(onError).not.toHaveBeenCalled();
        expect(onSettled).toHaveBeenCalledWith(file, null);
    });

    it('settles a stalled file independently without delaying a ready sibling', async () => {
        const stalledPath = '/documents/stalled.pdf';
        const readyPath = '/documents/ready.pdf';
        const settled = new Map<string, boolean>();
        const results = await prewarmRecentPdfOpeningGeometry([
            createRecentFile(requireDocumentRef(stalledPath), 2),
            createRecentFile(requireDocumentRef(readyPath), 1),
        ], {
            readStat: vi.fn(async () => {
                throw new Error('managed stat unavailable before open');
            }),
            readOpeningGeometry: vi.fn((path: string): Promise<IPdfOpeningGeometry> => path === stalledPath
                ? new Promise<IPdfOpeningGeometry>(() => undefined)
                : Promise.resolve({
                    pageNumber: requirePageNumber(1),
                    pageCount: 2,
                    width: 612,
                    height: 792,
                    rotation: 0,
                    size: 1_000,
                    modifiedAt: requireEpochMs(2_000),
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
        const files = Array.from({length: 4}, (_, index) => ({...createRecentFile(
            requireDocumentRef(`/documents/permanently-stalled-${String(index + 1)}.pdf`),
            4 - index,
        )}));
        const readOpeningGeometry = vi.fn(() => new Promise<IPdfOpeningGeometry>(() => undefined));

        const results = await prewarmRecentPdfOpeningGeometry(files, {readOpeningGeometry}, {
            concurrency: 2,
            settleTimeoutMs: 5,
        });

        expect(readOpeningGeometry).toHaveBeenCalledTimes(2);
        expect([...results.entries()]).toEqual(files.slice(0, 2).map(file => [
            file.originalPath,
            null,
        ]));
    });

    it('does not launch a cold geometry probe on constrained profiles', async () => {
        mocks.performanceProfile.lowMemory = true;
        const file = {...createRecentFile(pdfPaths[0]!, 1)};
        const readOpeningGeometry = vi.fn();

        const results = await prewarmRecentPdfOpeningGeometry(
            [file],
            {readOpeningGeometry},
        );

        expect(readOpeningGeometry).not.toHaveBeenCalled();
        expect(results.get(file.originalPath)).toBeNull();
    });

    it('validates an existing constrained cache entry without geometry IPC', async () => {
        mocks.performanceProfile.lowCpu = true;
        const file = {...createRecentFile(pdfPaths[0]!, 1)};
        writeTrustedPdfOpenGeometry({
            documentId: file.originalPath,
            pageNumber: requirePageNumber(1),
            pageCount: 10,
            width: 612,
            height: 792,
            rotation: 0,
            size: 1_000,
            modifiedAt: 2_000,
            savedAt: 3_000,
        });
        const readOpeningGeometry = vi.fn();

        await prewarmRecentPdfOpeningGeometry([file], {
            readStat: vi.fn(async () => ({
                size: 1_000,
                modifiedAt: 2_000,
            })),
            readOpeningGeometry,
        });

        expect(readOpeningGeometry).not.toHaveBeenCalled();
        expect(readPrevalidatedTrustedPdfOpenGeometry(file.originalPath, requirePageNumber(1))).toMatchObject({
            size: 1_000,
            modifiedAt: 2_000,
        });
    });
});
