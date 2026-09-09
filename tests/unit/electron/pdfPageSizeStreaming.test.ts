import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDF_PAGE_SIZE_SIDECAR_FORMAT,
    PDF_PAGE_SIZE_SIDECAR_MAX_CHUNK_BYTES,
    PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION,
    PdfPageSizeStore,
    parsePdfPageSizeSidecarHeader,
    readPdfPageSizeChunks,
    readPdfPageSizeSidecarChunks,
} from '@evb/scan-cleanup/core/pdfPageSizes';
import {createFileBackedScanCleanupResultStore} from '@evb/scan-cleanup/core/fileBackedResultStore';

let tempDir: string | null = null;

afterEach(async () => {
    if (tempDir !== null) {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
        tempDir = null;
    }
});

function page(pageNumber: number) {
    return {
        pageNumber,
        xPoints: 0,
        yPoints: 0,
        widthPoints: 612,
        heightPoints: 792,
        widthInches: 8.5,
        heightInches: 11,
        rotation: 0,
    };
}

describe('page-size sidecar reader', () => {
    it.each([
        [
            'performed',
            'normal page-ops analysis',
        ],
        [
            'unavailable',
            'qpdf structural analysis',
        ],
        [
            'skipped',
            'explicitly skipped analysis',
        ],
    ] as const)('decodes the %s dominant-image analysis status (%s)', (status, description) => {
        void description;
        expect(parsePdfPageSizeSidecarHeader({
            format: PDF_PAGE_SIZE_SIDECAR_FORMAT,
            schemaVersion: PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION,
            pageCount: 1,
            chunkBytes: 512,
            declaredPageCount: 1,
            reachablePageCount: 1,
            dominantImageAnalysis: status,
        }).dominantImageAnalysis).toBe(status);
    });

    it('maps a pre-status sidecar header to unknown for compatibility', () => {
        const header = parsePdfPageSizeSidecarHeader({
            format: PDF_PAGE_SIZE_SIDECAR_FORMAT,
            schemaVersion: PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION,
            pageCount: 1,
            chunkBytes: 512,
        });
        expect(header.dominantImageAnalysis).toBe('unknown');
        expect(header.declaredPageCount).toBe(1);
        expect(header.reachablePageCount).toBe(1);
    });

    it('rejects a sidecar whose declared and reachable counts disagree', () => {
        expect(() => parsePdfPageSizeSidecarHeader({
            format: PDF_PAGE_SIZE_SIDECAR_FORMAT,
            schemaVersion: PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION,
            pageCount: 2,
            declaredPageCount: 2,
            reachablePageCount: 1,
            chunkBytes: 512,
        })).toThrow('declared 2 pages and reached 1 pages');
    });

    it('uses collision-proof native sidecar names for concurrent reads', async () => {
        const nativeTempDir = await mkdtemp(join(tmpdir(), 'evb-page-size-native-'));
        tempDir = nativeTempDir;
        const outputPaths: string[] = [];
        const release = Promise.withResolvers<undefined>();
        let commandCalls = 0;
        const runCommand = async (_command: string, args: string[]) => {
            const outputPath = args[args.indexOf('--output') + 1];
            if (outputPath === undefined) throw new Error('native output path is missing');
            outputPaths.push(outputPath);
            commandCalls += 1;
            if (commandCalls === 2) release.resolve(undefined);
            await release.promise;
            await writeFile(outputPath, JSON.stringify({pages: [page(1)]}));
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        };
        const read = async () => {
            const chunks = [];
            for await (const chunk of readPdfPageSizeChunks('/tmp/source.pdf', {
                pdfPageOpsBinary: '/tmp/evb-pdf-page-ops',
                tempDir: nativeTempDir,
                log: () => undefined,
                runCommand,
            })) {
                chunks.push(chunk);
            }
            return chunks;
        };

        const [
            first,
            second,
        ] = await Promise.all([
            read(),
            read(),
        ]);

        expect(outputPaths).toHaveLength(2);
        expect(new Set(outputPaths).size).toBe(2);
        expect(first.flatMap(chunk => chunk.pages).map(value => value.pageNumber)).toEqual([1]);
        expect(second.flatMap(chunk => chunk.pages).map(value => value.pageNumber)).toEqual([1]);
    });

    it('reads a chunk that crosses the bounded stream window without building a document array', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-page-size-sidecar-'));
        const sidecarPath = join(tempDir, 'page-sizes.jsonl');
        const pages = Array.from({length: 5_000}, (_, index) => page(index + 1));
        const header = {
            format: PDF_PAGE_SIZE_SIDECAR_FORMAT,
            schemaVersion: PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION,
            pageCount: pages.length,
            chunkBytes: PDF_PAGE_SIZE_SIDECAR_MAX_CHUNK_BYTES,
            declaredPageCount: pages.length,
            reachablePageCount: pages.length,
            dominantImageAnalysis: 'performed',
        };
        const chunk = {
            chunkIndex: 0,
            firstPageNumber: 1,
            pages,
        };
        const lines = `${JSON.stringify(header)}\n${JSON.stringify(chunk)}\n`;
        expect(Buffer.byteLength(JSON.stringify(chunk), 'utf8')).toBeGreaterThan(512 * 1024);
        await writeFile(sidecarPath, lines);

        const chunks = [];
        for await (const value of readPdfPageSizeSidecarChunks(sidecarPath)) {
            chunks.push(value);
        }

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.pageCount).toBe(5_000);
        expect(chunks[0]?.declaredPageCount).toBe(5_000);
        expect(chunks[0]?.reachablePageCount).toBe(5_000);
        expect(chunks[0]?.firstPageNumber).toBe(1);
        expect(chunks[0]?.pages).toHaveLength(5_000);
        expect(chunks[0]?.pages[4_999]?.pageNumber).toBe(5_000);
        expect(chunks[0]?.dominantImageAnalysis).toBe('performed');
        expect(chunks[0]?.offset).toBe(Buffer.byteLength(`${JSON.stringify(header)}\n`, 'utf8'));
        expect(chunks[0]?.byteLength).toBe(Buffer.byteLength(`${JSON.stringify(chunk)}\n`, 'utf8'));
    });

    it('rejects a bounded store chunk whose declared count is not reachable', async () => {
        const store = new PdfPageSizeStore(async function* () {
            yield {
                pageCount: 2,
                declaredPageCount: 2,
                reachablePageCount: 1,
                chunkIndex: 0,
                firstPageNumber: 1,
                offset: 0,
                byteLength: 0,
                pages: [page(1)],
            };
        });

        await expect(store.getPage(1)).rejects.toThrow('declared 2 pages and reached 1 pages');
        await store.close();
    });

    it('stops between sidecar chunks when the caller cancels', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-page-size-sidecar-'));
        const sidecarPath = join(tempDir, 'page-sizes.jsonl');
        const lines = [
            JSON.stringify({
                format: PDF_PAGE_SIZE_SIDECAR_FORMAT,
                schemaVersion: PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION,
                pageCount: 2,
                declaredPageCount: 2,
                reachablePageCount: 2,
                chunkBytes: 512,
                dominantImageAnalysis: 'unavailable',
            }),
            JSON.stringify({
                chunkIndex: 0,
                firstPageNumber: 1,
                pages: [page(1)],
            }),
            JSON.stringify({
                chunkIndex: 1,
                firstPageNumber: 2,
                pages: [page(2)],
            }),
            '',
        ].join('\n');
        await writeFile(sidecarPath, lines);

        const controller = new AbortController();
        const iterator = readPdfPageSizeSidecarChunks(sidecarPath, controller.signal);
        await expect(iterator.next()).resolves.toMatchObject({done: false});
        controller.abort(new Error('test cancellation'));
        await expect(iterator.next()).rejects.toThrow('test cancellation');
        await iterator.return(undefined);
    });

    it('keeps scalar and range reads bounded across a sparse high-page store', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-page-size-store-'));
        const store = new PdfPageSizeStore(async function* () {
            const pageCount = 100_003;
            for (let firstPageNumber = 1, chunkIndex = 0;
                firstPageNumber <= pageCount;
                firstPageNumber += 1_024, chunkIndex += 1) {
                const pages = Array.from(
                    {length: Math.min(1_024, pageCount - firstPageNumber + 1)},
                    (_, index) => page(firstPageNumber + index),
                );
                yield {
                    pageCount,
                    chunkIndex,
                    firstPageNumber,
                    offset: 0,
                    byteLength: 0,
                    pages,
                };
            }
        });

        expect((await store.getPage(100_003)).pageNumber).toBe(100_003);
        const boundaryRange = await store.readRange(1_023, 1_027);
        expect(boundaryRange.map(value => value.pageNumber)).toEqual([
            1_023,
            1_024,
            1_025,
            1_026,
        ]);
        await expect(store.readRange(1, 1_026)).rejects.toThrow('1024-page bound');
        let chunkCount = 0;
        let largestChunk = 0;
        await store.forEachChunk(chunk => {
            chunkCount += 1;
            largestChunk = Math.max(largestChunk, chunk.pages.length);
        });
        expect(chunkCount).toBe(98);
        expect(largestChunk).toBe(1_024);
        await store.close();
        await expect(store.getPage(1)).rejects.toThrow('Page-size store is closed');
    });

    it('keeps concurrent sparse windows independent', async () => {
        const pageCount = 4_097;
        const store = new PdfPageSizeStore(async function* () {
            for (let firstPageNumber = 1, chunkIndex = 0;
                firstPageNumber <= pageCount;
                firstPageNumber += 1_024, chunkIndex += 1) {
                await new Promise(resolve => setTimeout(resolve, 0));
                yield {
                    pageCount,
                    chunkIndex,
                    firstPageNumber,
                    offset: 0,
                    byteLength: 0,
                    pages: Array.from(
                        {length: Math.min(1_024, pageCount - firstPageNumber + 1)},
                        (_, index) => page(firstPageNumber + index),
                    ),
                };
            }
        });

        const [
            first,
            last,
            range,
        ] = await Promise.all([
            store.getPage(1),
            store.getPage(pageCount),
            store.readRange(2_047, 2_050),
        ]);

        expect(first.pageNumber).toBe(1);
        expect(last.pageNumber).toBe(pageCount);
        expect(range.map(value => value.pageNumber)).toEqual([
            2_047,
            2_048,
            2_049,
        ]);
        await store.close();
    });

    it('reuses a scalar cursor while forks advance independently', async () => {
        let readerCount = 0;
        const store = new PdfPageSizeStore(async function* () {
            readerCount += 1;
            yield {
                pageCount: 3,
                chunkIndex: 0,
                firstPageNumber: 1,
                offset: 0,
                byteLength: 0,
                pages: [
                    page(1),
                    page(2),
                    page(3),
                ],
            };
        });

        await store.getPage(1);
        await store.getPage(2);
        await store.getPage(3);
        expect(readerCount).toBe(1);

        const fork = store.fork();
        await expect(fork.getPage(3)).resolves.toMatchObject({pageNumber: 3});
        expect(readerCount).toBe(2);

        await fork.close();
        await store.close();
    });

    it('uses a fixed-width index for sparse result reads without a document map', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-result-store-'));
        const pageCount = 100_003;
        const store = await createFileBackedScanCleanupResultStore<{
            classification: string;
            pageNumber: number;
        }>({
            rootDir: tempDir,
            pageCount,
            pageNumberOf: (result: {pageNumber: number}) => result.pageNumber,
            maxReadPages: 1_024,
        });
        await store.append({
            pageNumber: 1,
            classification: 'first',
        });
        await store.append({
            pageNumber: pageCount,
            classification: 'last',
        });
        expect(store.resultCount).toBe(2);
        expect(await store.getPage(pageCount)).toEqual({
            pageNumber: pageCount,
            classification: 'last',
        });
        expect(await store.readRange(pageCount - 2, pageCount + 1)).toEqual([{
            pageNumber: pageCount,
            classification: 'last',
        }]);
        let largestChunk = 0;
        let visitedChunks = 0;
        await store.forEachChunk((results, firstPageNumber) => {
            visitedChunks += 1;
            largestChunk = Math.max(largestChunk, results.length);
            expect(firstPageNumber).toBeGreaterThanOrEqual(1);
        });
        expect(visitedChunks).toBe(98);
        expect(largestChunk).toBe(1);
        await store.replace(pageCount, {
            pageNumber: pageCount,
            classification: 'replaced',
        });
        expect(await store.getPage(pageCount)).toEqual({
            pageNumber: pageCount,
            classification: 'replaced',
        });
        await store.close();
        await expect(store.getPage(1)).rejects.toThrow('Scan cleanup result store is closed');
    }, 15_000);
});
