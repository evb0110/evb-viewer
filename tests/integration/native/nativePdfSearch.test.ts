import {
    mkdtemp,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    PDFDocument,
    StandardFonts,
} from 'pdf-lib';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {
    afterAll,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    encodePdfSearchPagesPayload,
    SEARCH_INDEX_TEXT_BUDGET,
    type ISearchIndexCoverage,
    type ISearchIndexResponse,
} from '@contracts/searchIndexWire';
import {
    createPdfSearchWasmRunner,
    loadPdfSearchWasmModule,
} from '@electron/features/search/pdfSearchWasmRunner';
import {executePdfSearchWorkerCommand} from '@electron/features/search/pdfSearchWorkerOps';
import {
    runPdfSearchWorkerCommand,
    shutdownPdfSearchWorkers,
} from '@electron/features/search/pdfSearchWorkerClient';
import {streamPdfPageTexts} from '@electron/features/search/pdfPageTexts';
import {
    inspectPdfPageTextVisibility,
    openPdfPageTextVisibilitySession,
} from '@electron/pdf/inspectPdfPageTextVisibility';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public/nativePageOpsPath';
import * as workerTasks from '@electron/utils/workerTask';
import {findPdfSearchMatches} from '@pdf-core/pdfSearchAlgorithms';
import {mainJobBroker} from '@electron/resources/jobBroker';

/** Every broker admission slot is free: no native command leases remain active or queued. */
function expectNativeCommandSlotsFree() {
    expect(mainJobBroker.getSnapshot()).toMatchObject({
        active: 0,
        queued: 0,
    });
}

afterAll(() => {
    shutdownPdfSearchWorkers();
});

describe('evb-pdf-search.wasm unified desktop worker', () => {
    it('matches a leading-space literal across blank layout space and multibyte text across a line break', async () => {
        const blank = ' '.repeat(256 * 1024);
        const pages = [
            {
                pageNumber: 1,
                text: `${blank}x needle`,
            },
            {
                pageNumber: 2,
                text: '\u{1D538} naïve café\nrésumé',
            },
        ];
        const search = async (query: string) => await runPdfSearchWorkerCommand({
            op: 'searchPages',
            documentRevision: 'revision',
            query,
            limit: 500,
            contextChars: 8,
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pagesBuffer: encodePdfSearchPagesPayload(pages),
        }) as ISearchIndexResponse;

        expect((await search(' needle')).results).toEqual([expect.objectContaining({
            pageNumber: 1,
            matchIndex: 0,
            startOffset: blank.length + 1,
            endOffset: blank.length + 8,
            excerpt: expect.objectContaining({match: ' needle'}),
        })]);
        // A space in the query matches the line break; offsets count UTF-16 units.
        expect((await search('café résumé')).results).toEqual([expect.objectContaining({
            pageNumber: 2,
            startOffset: 9,
            endOffset: 20,
            excerpt: expect.objectContaining({match: 'café\nrésumé'}),
        })]);
        expectNativeCommandSlotsFree();
    });

    it('builds an EVBSIDX4 index in memory with no temp input files, supports full query modes, and detects stale revisions', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-pdf-search-wasm-'));
        const indexPath = join(directory, 'doc.evb-search-index');
        try {
            const pagesBuffer = encodePdfSearchPagesPayload([
                {
                    pageNumber: 1,
                    text: 'Café naïve résumé\nneedle Needle',
                },
                {
                    pageNumber: 2,
                    text: 'Whole word: cat caterpillar cat',
                },
            ]);
            const coverage = await runPdfSearchWorkerCommand({
                op: 'index',
                indexPath,
                documentRevision: 'rev-1',
                pageCount: 2,
                maxPageTextBytes: SEARCH_INDEX_TEXT_BUDGET.maxPageTextBytes,
                maxTotalTextBytes: SEARCH_INDEX_TEXT_BUDGET.maxTotalTextBytes,
                pagesBuffer,
            }) as ISearchIndexCoverage;

            expect(coverage).toEqual({
                pageCount: 2,
                pagesScanned: 2,
                pagesWritten: 2,
                truncated: false,
                missingTextPageSample: [],
            });
            // Only the atomic final index file exists — no leftover temp or .input files.
            expect(await readdir(directory)).toEqual(['doc.evb-search-index']);

            const stat = await runPdfSearchWorkerCommand({
                op: 'stat',
                indexPath,
                documentRevision: 'rev-1',
            }) as ISearchIndexCoverage;
            expect(stat).toEqual(coverage);

            const exact = await runPdfSearchWorkerCommand({
                op: 'search',
                indexPath,
                documentRevision: 'rev-1',
                query: 'Needle',
                limit: 50,
                contextChars: 12,
                matchCase: true,
                wholeWord: false,
                useRegex: false,
            }) as ISearchIndexResponse;
            expect(exact.results).toHaveLength(1);
            expect(exact.results[0]).toMatchObject({
                pageNumber: 1,
                excerpt: expect.objectContaining({match: 'Needle'}),
            });

            const wholeWord = await runPdfSearchWorkerCommand({
                op: 'search',
                indexPath,
                documentRevision: 'rev-1',
                query: 'cat',
                limit: 50,
                contextChars: 12,
                matchCase: false,
                wholeWord: true,
                useRegex: false,
            }) as ISearchIndexResponse;
            expect(wholeWord.results).toHaveLength(2);
            expect(wholeWord.results.map(hit => hit.pageNumber)).toEqual([
                2,
                2,
            ]);

            const regexUnicodeNormalized = await runPdfSearchWorkerCommand({
                op: 'search',
                indexPath,
                documentRevision: 'rev-1',
                query: 'cafe\u0301\\s+nai\u0308ve',
                limit: 50,
                contextChars: 12,
                matchCase: false,
                wholeWord: false,
                useRegex: true,
            }) as ISearchIndexResponse;
            expect(regexUnicodeNormalized.results).toHaveLength(1);
            expect(regexUnicodeNormalized.results[0]).toMatchObject({
                pageNumber: 1,
                excerpt: expect.objectContaining({match: 'Café naïve'}),
            });

            const stale = await runPdfSearchWorkerCommand({
                op: 'stat',
                indexPath,
                documentRevision: 'rev-2',
            });
            expect(stale).toEqual({stale: true});
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('cancels an aborted search without wedging the warm worker pool', async () => {
        const controller = new AbortController();
        const cancelReason = new Error('Search canceled');
        controller.abort(cancelReason);

        await expect(runPdfSearchWorkerCommand({
            op: 'searchPages',
            documentRevision: 'revision',
            query: 'needle',
            limit: 500,
            contextChars: 8,
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pagesBuffer: encodePdfSearchPagesPayload([{
                pageNumber: 1,
                text: 'a needle',
            }]),
        }, controller.signal)).rejects.toBe(cancelReason);

        const followUp = await runPdfSearchWorkerCommand({
            op: 'searchPages',
            documentRevision: 'revision',
            query: 'needle',
            limit: 500,
            contextChars: 8,
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pagesBuffer: encodePdfSearchPagesPayload([{
                pageNumber: 1,
                text: 'a needle',
            }]),
        }) as ISearchIndexResponse;
        expect(followUp.results).toHaveLength(1);
        expectNativeCommandSlotsFree();
    });

    it('refuses a truncated binary page record and keeps the warm worker reusable', async () => {
        const encoded = encodePdfSearchPagesPayload([{
            pageNumber: 1,
            text: 'a needle',
        }]);
        await expect(runPdfSearchWorkerCommand({
            op: 'searchPages',
            documentRevision: 'revision',
            query: 'needle',
            limit: 500,
            contextChars: 8,
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pagesBuffer: encoded.subarray(0, Math.floor(encoded.byteLength / 2)),
        })).rejects.toThrow(/Invalid search index input page/u);

        const recovered = await runPdfSearchWorkerCommand({
            op: 'searchPages',
            documentRevision: 'revision',
            query: 'needle',
            limit: 500,
            contextChars: 8,
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            pagesBuffer: encoded,
        }) as ISearchIndexResponse;
        expect(recovered.results).toHaveLength(1);
        expectNativeCommandSlotsFree();
    });

    it('reclaims WASM linear memory after crossing its high-water bound and keeps serving queries', async () => {
        const wasmModule = await loadPdfSearchWasmModule();
        // Set a small 2 MiB high-water threshold so a single large index request triggers instance recycling.
        const runner = createPdfSearchWasmRunner(wasmModule, {highWaterBytes: 2 * 1024 * 1024});
        const directory = await mkdtemp(join(tmpdir(), 'evb-pdf-search-highwater-'));
        const indexPath = join(directory, 'large.evb-search-index');
        try {
            const largeText = `${'alpha beta gamma delta '.repeat(60_000)}unique-marker`;
            const coverage = await executePdfSearchWorkerCommand(runner, {
                op: 'index',
                indexPath,
                documentRevision: 'large-rev',
                pageCount: 1,
                maxPageTextBytes: SEARCH_INDEX_TEXT_BUDGET.maxPageTextBytes,
                maxTotalTextBytes: SEARCH_INDEX_TEXT_BUDGET.maxTotalTextBytes,
                pagesBuffer: encodePdfSearchPagesPayload([{
                    pageNumber: 1,
                    text: largeText,
                }]),
            }) as ISearchIndexCoverage;
            expect(coverage.pagesWritten).toBe(1);
            // Instance was reclaimed immediately after the large call exceeded highWaterBytes.
            expect(runner.memoryBytes()).toBe(0);

            const found = await executePdfSearchWorkerCommand(runner, {
                op: 'search',
                indexPath,
                documentRevision: 'large-rev',
                query: 'unique-marker',
                limit: 10,
                contextChars: 12,
                matchCase: false,
                wholeWord: false,
                useRegex: false,
            }) as ISearchIndexResponse;
            expect(found.results).toHaveLength(1);
            expect(found.results[0]?.excerpt.match).toBe('unique-marker');
        } finally {
            runner.dispose();
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });
});

describe('native PDF search integration', () => {
    it.each([
        'failure',
        'abort',
    ] as const)('preserves Poppler search results or cancellation after a partial RTL reread: %s', async (outcome) => {
        const pdfPath = resolve('tests/fixtures/electron/semtext/search.pdf');
        const popplerPages = [];
        for await (const page of streamPdfPageTexts(pdfPath)) popplerPages.push(page);
        expect(popplerPages).toHaveLength(2);
        const worker = vi.spyOn(workerTasks, 'runResultWorkerTask');
        const controller = new AbortController();
        const reason = new Error('Reader canceled the RTL search');
        const readSearchPages = async (signal?: AbortSignal) => {
            const pages = [];
            for await (const page of streamPdfPageTexts(pdfPath, {
                visiblePageOnly: true,
                signal,
            })) pages.push(page);
            return pages;
        };
        try {
            // The first page arrives before the worker fails on the second.
            // Neither page of that range may replace the Poppler search text.
            worker.mockImplementation(async (options) => {
                options.onProgressMessage?.({
                    type: 'page',
                    page: {
                        pageNumber: 1,
                        text: 'incomplete reread',
                    },
                });
                if (outcome === 'abort') {
                    controller.abort(reason);
                    throw reason;
                }
                throw new Error('PDF.js could not reread the second RTL page');
            });
            if (outcome === 'abort') {
                await expect(readSearchPages(controller.signal)).rejects.toBe(reason);
            } else {
                const pages = await readSearchPages();
                expect(pages).toEqual(popplerPages);
                const matches = pages.flatMap(page => findPdfSearchMatches(page.text, 'abc')
                    .map(match => ({
                        pageNumber: page.pageNumber,
                        text: page.text.slice(match.startOffset, match.endOffset),
                    })));
                expect(matches).toEqual([
                    {
                        pageNumber: 1,
                        text: 'abc',
                    },
                    {
                        pageNumber: 2,
                        text: 'abc',
                    },
                ]);
            }
            expect(worker).toHaveBeenCalled();
        } finally {
            worker.mockRestore();
        }
    }, 20_000);

    it('reads bounded OCR visibility windows through a single-open WASM session matching one-shot inspection', async () => {
        const pdfPath = resolve('tests/fixtures/electron/semtext/search.pdf');
        const pdfPageOpsBinary = resolveNativePageOpsPath() ?? undefined;
        expect(pdfPageOpsBinary).toBeTruthy();
        const tempDir = await mkdtemp(join(tmpdir(), 'evb-visibility-session-'));
        try {
            const oneShot = await inspectPdfPageTextVisibility({
                pdfPath,
                pageNumbers: [
                    1,
                    2,
                ],
                pdfPageOpsBinary,
                tempDir,
                withEvbOcrText: true,
            });
            expect(oneShot.status).toBe('available');

            const session = openPdfPageTextVisibilitySession({
                pdfPath,
                pdfPageOpsBinary,
                tempDir,
                withEvbOcrText: true,
                reuseSession: true,
            });
            try {
                const win1 = await session.inspectPages([1]);
                const win2 = await session.inspectPages([2]);
                expect(win1.status).toBe('available');
                expect(win2.status).toBe('available');
                expect(win1.visibility.get(1)).toEqual(oneShot.visibility.get(1));
                expect(win2.visibility.get(2)).toEqual(oneShot.visibility.get(2));
            } finally {
                await session.close();
            }

            // Replacing the file at the same path with a DIFFERENT PDF of the exact same
            // byte length must evict the cached descriptor-bound index instead of reusing it.
            const makeTwoPagePdf = async (drawTextOnPage2: boolean, titlePadding: number) => {
                const doc = await PDFDocument.create();
                doc.setTitle('p'.repeat(titlePadding));
                doc.addPage([
                    200,
                    200,
                ]);
                const page2 = doc.addPage([
                    200,
                    200,
                ]);
                if (drawTextOnPage2) {
                    const font = await doc.embedFont(StandardFonts.Helvetica);
                    page2.drawText('Visible text on page two', {
                        x: 20,
                        y: 100,
                        size: 12,
                        font,
                    });
                }
                return Buffer.from(await doc.save({useObjectStreams: false}));
            };
            const rawWithText = await makeTwoPagePdf(true, 10);
            const rawBlank = await makeTwoPagePdf(false, 10);
            const padToLength = (buf: Uint8Array, targetLen: number): Uint8Array => {
                const diff = targetLen - buf.byteLength;
                if (diff <= 0) return buf;
                return Buffer.concat([
                    buf,
                    Buffer.from(diff === 1 ? '\n' : `\n%${' '.repeat(diff - 2)}`),
                ]);
            };
            const maxLen = Math.max(rawWithText.byteLength, rawBlank.byteLength);
            const pdfWithText = padToLength(rawWithText, maxLen);
            const pdfBlank = padToLength(rawBlank, maxLen);
            expect(pdfBlank.byteLength).toBe(pdfWithText.byteLength);

            const targetPath = join(tempDir, 'swapped.pdf');
            await writeFile(targetPath, pdfWithText);
            const swapSession = openPdfPageTextVisibilitySession({
                pdfPath: targetPath,
                pdfPageOpsBinary,
                tempDir,
                withEvbOcrText: true,
                reuseSession: true,
            });
            try {
                const beforeSwap = await swapSession.inspectPages([2]);
                expect(beforeSwap.status).toBe('available');
                expect(beforeSwap.visibility.get(2)?.paintedText).toBe(true);

                // Replace the file at the same path with a different PDF of identical length.
                await rm(targetPath);
                await writeFile(targetPath, pdfBlank);

                const afterSwap = await swapSession.inspectPages([2]);
                expect(afterSwap.status).toBe('available');
                expect(afterSwap.visibility.get(2)?.paintedText).toBe(false);
            } finally {
                await swapSession.close();
            }
            expectNativeCommandSlotsFree();
        } finally {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    });
});
