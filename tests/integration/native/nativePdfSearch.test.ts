import {
    mkdtemp,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    degrees,
    PDFDocument,
    PDFName,
    PDFString,
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
import * as pdfSearchWorkerClient from '@electron/features/search/pdfSearchWorkerClient';
import {
    runPdfSearchWorkerCommand,
    shutdownPdfSearchWorkers,
} from '@electron/features/search/pdfSearchWorkerClient';
import {
    searchIndexedDocument,
    type IProvisionalSearchMatches,
} from '@electron/features/search/searchIndex';
import {pdfSearchDocument} from '@electron/features/search/main/ipc';
import {streamPdfPageTexts} from '@electron/features/search/pdfPageTexts';
import {
    createDocument,
    type IDocumentStore,
    type IPublicationPort,
} from '@document-store/documentDirectory';
import {createNodeStorePort} from '@document-store/nodeStorePort';
import {hasPreservedDocumentTextIdentity} from '@electron/features/documents/main/registerDocumentRevisionInvalidationEffects';
import {
    openDocumentFromFile,
    setDocumentStoreRootForTests,
} from '@electron/file-access/documentStore';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {createEpochMs} from '@contracts/timestamps';
import {
    inspectPdfPageTextVisibility,
    openPdfPageTextVisibilitySession,
} from '@electron/pdf/inspectPdfPageTextVisibility';
import {buildPopplerEnv} from '@electron/native-tools/buildPopplerEnv';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
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
        for await (const page of streamPdfPageTexts(pdfPath)) {popplerPages.push(page);}
        expect(popplerPages).toHaveLength(2);
        const worker = vi.spyOn(workerTasks, 'runResultWorkerTask');
        const controller = new AbortController();
        const reason = new Error('Reader canceled the RTL search');
        const readSearchPages = async (signal?: AbortSignal) => {
            const pages = [];
            for await (const page of streamPdfPageTexts(pdfPath, {
                visiblePageOnly: true,
                signal,
            })) {pages.push(page);}
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
                if (diff <= 0) {return buf;}
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

    it('scans provisional desktop search pages incrementally without re-scanning earlier chunks and preserves global ordinals', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'evb-provisional-inc-'));
        const indexPath = join(tempDir, 'provisional.evb-search-index');
        const scannedPageNumbersPerCall: number[][] = [];
        const decodePageNumbers = (buf: Uint8Array) => {
            const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            const pages: number[] = [];
            let offset = 0;
            while (offset + 12 <= buf.byteLength) {
                const pageNumber = view.getUint32(offset, true);
                const textLen = view.getUint32(offset + 8, true);
                pages.push(pageNumber);
                offset += 12 + textLen;
            }
            return pages;
        };
        const originalRunPdfSearchWorkerCommand = pdfSearchWorkerClient.runPdfSearchWorkerCommand;
        const workerSpy = vi.spyOn(pdfSearchWorkerClient, 'runPdfSearchWorkerCommand').mockImplementation((command, signal, options) => {
            if (command.op === 'searchPages') {
                scannedPageNumbersPerCall.push(decodePageNumbers(command.pagesBuffer));
            }
            return originalRunPdfSearchWorkerCommand(command, signal, options);
        });
        try {
            const pageGates = [
                Promise.withResolvers<void>(),
                Promise.withResolvers<void>(),
                Promise.withResolvers<void>(),
                Promise.withResolvers<void>(),
            ];
            const provisionalUpdates: IProvisionalSearchMatches[] = [];
            const searchPromise = searchIndexedDocument(
                {
                    indexPath,
                    documentRevision: 'rev-inc-1',
                    async *readPages(_signal, _pageCount, onProgress) {
                        const texts = ['alpha needle', 'beta needle', 'gamma needle', 'delta needle'];
                        for (let i = 0; i < texts.length; i += 1) {
                            await pageGates[i]!.promise;
                            onProgress(i + 1);
                            yield {pageNumber: i + 1, text: texts[i]!};
                        }
                    },
                },
                'needle',
                {matchCase: false, wholeWord: false, useRegex: false, limit: 2},
                {
                    onProvisionalMatches(matches) {
                        provisionalUpdates.push(matches);
                    },
                },
            );

            // Release page 1 -> provisional scan scans page 1 only (1 match).
            pageGates[0]!.resolve();
            await vi.waitFor(() => expect(provisionalUpdates).toHaveLength(1));
            expect(provisionalUpdates[0]).toMatchObject({
                truncated: false,
                results: [expect.objectContaining({pageNumber: 1, matchIndex: 0})],
            });

            // Release page 2 -> provisional scan scans page 2 only (reaches limit=2, not yet truncated).
            pageGates[1]!.resolve();
            await vi.waitFor(() => expect(provisionalUpdates).toHaveLength(2));
            expect(provisionalUpdates[1]).toMatchObject({
                truncated: false,
                results: [
                    expect.objectContaining({pageNumber: 1, matchIndex: 0}),
                    expect.objectContaining({pageNumber: 2, matchIndex: 1}),
                ],
            });

            // Release page 3 -> provisional scan probes page 3 only and discovers overflow -> truncated: true!
            pageGates[2]!.resolve();
            await vi.waitFor(() => expect(provisionalUpdates).toHaveLength(3));
            expect(provisionalUpdates[2]).toMatchObject({
                truncated: true,
                results: [
                    expect.objectContaining({pageNumber: 1, matchIndex: 0}),
                    expect.objectContaining({pageNumber: 2, matchIndex: 1}),
                ],
            });

            // Release page 4 -> provisional search already finished, so page 4 is NEVER provisionally scanned.
            pageGates[3]!.resolve();
            const finalResponse = await searchPromise;
            expect(finalResponse.truncated).toBe(true);
            expect(finalResponse.results.map((hit) => ({page: hit.pageNumber, index: hit.matchIndex}))).toEqual([
                {page: 1, index: 0},
                {page: 2, index: 1},
            ]);

            // Every provisional searchPages call received strictly disjoint, incremental page chunks.
            expect(scannedPageNumbersPerCall).toEqual([[1], [2], [3]]);
        } finally {
            workerSpy.mockRestore();
            await rm(tempDir, {recursive: true, force: true});
        }
    });

    it('drains the remaining unscanned provisional delta while the final index write is still running', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'evb-provisional-tail-'));
        const indexPath = join(tempDir, 'provisional-tail.evb-search-index');
        const originalRun = pdfSearchWorkerClient.runPdfSearchWorkerCommand;
        const firstProvisionalGate = Promise.withResolvers<void>();
        const indexGate = Promise.withResolvers<void>();
        let searchPagesCalls = 0;
        let indexStarted = false;
        const workerSpy = vi.spyOn(pdfSearchWorkerClient, 'runPdfSearchWorkerCommand').mockImplementation(async (command, signal, options) => {
            if (command.op === 'searchPages') {
                searchPagesCalls += 1;
                if (searchPagesCalls === 1) {
                    await firstProvisionalGate.promise;
                }
            } else if (command.op === 'index') {
                indexStarted = true;
                await indexGate.promise;
            }
            return originalRun(command, signal, options);
        });
        try {
            const provisionalUpdates: IProvisionalSearchMatches[] = [];
            const searchPromise = searchIndexedDocument(
                {
                    indexPath,
                    documentRevision: 'rev-tail-1',
                    async *readPages(_signal, _pageCount, onProgress) {
                        onProgress(1);
                        yield {pageNumber: 1, text: 'first needle'};
                        onProgress(2);
                        yield {pageNumber: 2, text: 'second needle'};
                    },
                },
                'needle',
                {matchCase: false, wholeWord: false, useRegex: false, limit: 10},
                {
                    onProvisionalMatches(matches) {
                        provisionalUpdates.push(matches);
                    },
                },
            );

            // Wait until extraction finished and the final `index` command started while the first provisional call is still held.
            await vi.waitFor(() => expect(indexStarted).toBe(true));
            expect(searchPagesCalls).toBe(1);

            // Release the held provisional call while `index` is STILL blocked: the follower must still drain page 2!
            firstProvisionalGate.resolve();
            await vi.waitFor(() => expect(provisionalUpdates.at(-1)?.results).toHaveLength(2));
            expect(provisionalUpdates.at(-1)?.results.map((hit) => hit.pageNumber)).toEqual([1, 2]);

            indexGate.resolve();
            const finalResponse = await searchPromise;
            expect(finalResponse.results).toHaveLength(2);
        } finally {
            firstProvisionalGate.resolve();
            indexGate.resolve();
            workerSpy.mockRestore();
            await rm(tempDir, {recursive: true, force: true});
        }
    });

    it('proves before/after extracted-text byte equality for metadata, outline, and non-text annotations while invalidating rotation and text edits', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'evb-text-lineage-proof-'));
        try {
            const createBasePdf = async () => {
                const doc = await PDFDocument.create();
                const font = await doc.embedFont(StandardFonts.Helvetica);
                const p1 = doc.addPage([400, 260]);
                // Non-square page with CropBox [0, 0, 200, 260] and hidden text at x=250 so CropBox & rotation geometry matter.
                p1.setCropBox(0, 0, 200, 260);
                p1.drawText('VisibleAlpha', {x: 20, y: 180, size: 14, font});
                p1.drawText('CroppedHidden', {x: 250, y: 180, size: 14, font});
                const p2 = doc.addPage([400, 260]);
                p2.drawText('SecondPageBeta', {x: 20, y: 180, size: 14, font});
                return doc;
            };

            const extractUtf8Bytes = async (pdfPath: string) => {
                const pages: Array<{pageNumber: number; text: string}> = [];
                for await (const page of streamPdfPageTexts(pdfPath, {visiblePageOnly: true})) {
                    pages.push({pageNumber: page.pageNumber, text: page.text});
                }
                return Buffer.from(JSON.stringify(pages), 'utf8');
            };

            const readPageOneGeometry = async (pdfPath: string) => {
                const paths = getPdfNativeToolPaths();
                const env = buildPopplerEnv(paths);
                const {stdout} = await runNativeToolCommand(paths.pdfinfo, ['-box', '-f', '1', '-l', '1', pdfPath], {
                    ...(env === undefined ? {} : {env}),
                    commandLabel: 'pdfinfo(lineage geometry)',
                });
                const sizeMatch = /^Page\s+1\s+size:\s+(\d+(?:\.\d+)?)\s+x\s+(\d+(?:\.\d+)?)/mu.exec(stdout);
                const rotMatch = /^Page\s+1\s+rot:\s+(-?\d+)$/mu.exec(stdout);
                const width = Number(sizeMatch?.[1] ?? Number.NaN);
                const height = Number(sizeMatch?.[2] ?? Number.NaN);
                const rot = (((Number(rotMatch?.[1] ?? Number.NaN) % 360) + 360) % 360);
                const quarterTurn = rot === 90 || rot === 270;
                return {
                    rot,
                    renderedWidth: quarterTurn ? height : width,
                    renderedHeight: quarterTurn ? width : height,
                };
            };

            const basePdfPath = join(tempDir, 'base.pdf');
            const baseDoc = await createBasePdf();
            await writeFile(basePdfPath, await baseDoc.save());
            const baseExtracted = await extractUtf8Bytes(basePdfPath);
            const baseGeometry = await readPageOneGeometry(basePdfPath);
            expect(baseExtracted.toString('utf8')).toContain('VisibleAlpha');
            expect(baseExtracted.toString('utf8')).not.toContain('CroppedHidden');
            expect(baseGeometry).toEqual({rot: 0, renderedWidth: 200, renderedHeight: 260});

            // 1. Metadata-only edit: extracted UTF-8 bytes and page geometry are 100% identical.
            const metaDoc = await PDFDocument.load(await (await createBasePdf()).save());
            metaDoc.setTitle('Updated Document Title');
            metaDoc.setAuthor('Lineage Proof Author');
            metaDoc.setSubject('Metadata only');
            const metaPdfPath = join(tempDir, 'meta.pdf');
            await writeFile(metaPdfPath, await metaDoc.save());
            expect((await extractUtf8Bytes(metaPdfPath)).equals(baseExtracted)).toBe(true);
            expect(await readPageOneGeometry(metaPdfPath)).toEqual(baseGeometry);

            // 2. Bookmark/outline-only edit: extracted UTF-8 bytes and page geometry are 100% identical.
            const outlineDoc = await PDFDocument.load(await (await createBasePdf()).save());
            const outlineItemRef = outlineDoc.context.nextRef();
            const outlinesRef = outlineDoc.context.nextRef();
            outlineDoc.context.assign(
                outlineItemRef,
                outlineDoc.context.obj({
                    Title: PDFString.of('Chapter 1'),
                    Parent: outlinesRef,
                    Dest: [outlineDoc.getPage(0).ref, PDFName.of('Fit')],
                }),
            );
            outlineDoc.context.assign(
                outlinesRef,
                outlineDoc.context.obj({
                    Type: PDFName.of('Outlines'),
                    First: outlineItemRef,
                    Last: outlineItemRef,
                    Count: 1,
                }),
            );
            outlineDoc.catalog.set(PDFName.of('Outlines'), outlinesRef);
            const outlinePdfPath = join(tempDir, 'outline.pdf');
            await writeFile(outlinePdfPath, await outlineDoc.save());
            expect((await extractUtf8Bytes(outlinePdfPath)).equals(baseExtracted)).toBe(true);
            expect(await readPageOneGeometry(outlinePdfPath)).toEqual(baseGeometry);

            // 3. Pure non-text annotation write (Highlight + Sticky Note /Text): extracted UTF-8 bytes and geometry are 100% identical.
            const annotDoc = await PDFDocument.load(await (await createBasePdf()).save());
            const highlightRef = annotDoc.context.register(
                annotDoc.context.obj({
                    Type: PDFName.of('Annot'),
                    Subtype: PDFName.of('Highlight'),
                    Rect: [18, 175, 120, 198],
                    QuadPoints: [18, 198, 120, 198, 18, 175, 120, 175],
                    C: [1, 1, 0],
                }),
            );
            const stickyNoteRef = annotDoc.context.register(
                annotDoc.context.obj({
                    Type: PDFName.of('Annot'),
                    Subtype: PDFName.of('Text'),
                    Rect: [140, 175, 164, 199],
                    Contents: PDFString.of('Sticky note comment'),
                }),
            );
            annotDoc.getPage(0).node.set(PDFName.of('Annots'), annotDoc.context.obj([highlightRef, stickyNoteRef]));
            const annotPdfPath = join(tempDir, 'annot.pdf');
            await writeFile(annotPdfPath, await annotDoc.save());
            expect((await extractUtf8Bytes(annotPdfPath)).equals(baseExtracted)).toBe(true);
            expect(await readPageOneGeometry(annotPdfPath)).toEqual(baseGeometry);

            // 4. Page rotation changes page rotation and rendered MediaBox/CropBox geometry (pdfPageTexts.ts:69): MUST NOT be exempted!
            const rotatedDoc = await PDFDocument.load(await (await createBasePdf()).save());
            rotatedDoc.getPage(0).setRotation(degrees(90));
            const rotatedPdfPath = join(tempDir, 'rotated.pdf');
            await writeFile(rotatedPdfPath, await rotatedDoc.save());
            const rotatedGeometry = await readPageOneGeometry(rotatedPdfPath);
            expect(rotatedGeometry).not.toEqual(baseGeometry);
            expect(rotatedGeometry).toEqual({rot: 90, renderedWidth: 260, renderedHeight: 200});

            // 5. Text-modifying edit (page delete) changes extracted text.
            const deletedDoc = await PDFDocument.load(await (await createBasePdf()).save());
            deletedDoc.removePage(1);
            const deletedPdfPath = join(tempDir, 'deleted.pdf');
            await writeFile(deletedPdfPath, await deletedDoc.save());
            expect((await extractUtf8Bytes(deletedPdfPath)).equals(baseExtracted)).toBe(false);

            // Wire DocumentDirectory + searchIndexedDocument + hasPreservedDocumentTextIdentity end to end:
            await setDocumentStoreRootForTests(join(tempDir, 'store'));
            try {
                const entry = await openDocumentFromFile(basePdfPath, {});
                const indexPath = join(tempDir, 'lineage.evb-search-index');
                const readPagesSpy = vi.fn(async function* (pages: Array<{pageNumber: number; text: string}>) {
                    for (const p of pages) {
                        yield p;
                    }
                });

                const ti1 = entry.doc.state().textIdentity!;
                expect(ti1).toMatch(/^ti1:/u);

                // Cold search on rev 1 builds the index once.
                const first = await searchIndexedDocument(
                    {
                        indexPath,
                        documentRevision: entry.session.token(),
                        textIdentity: ti1,
                        readPages: () => readPagesSpy([{pageNumber: 1, text: 'VisibleAlpha'}]),
                    },
                    'VisibleAlpha',
                    {matchCase: false, wholeWord: false, useRegex: false},
                );
                expect(first.results).toHaveLength(1);
                expect(readPagesSpy).toHaveBeenCalledTimes(1);

                // Retain rev 1 & rev 2 for undo/redo tests.
                await entry.doc.retain([1, 2, 3]);

                // Non-text edit (e.g. metadata/bookmark/highlight) inherits textIdentity -> cache HIT + invalidation skipped!
                const prevTok1 = entry.session.token();
                await entry.doc.mutate(null, {
                    kind: 'rewrite',
                    source: metaPdfPath,
                    drafts: 'clear',
                    textIdentity: 'inherit',
                });
                const tok2 = entry.session.token();
                expect(entry.doc.state().textIdentity).toBe(ti1);
                expect(
                    hasPreservedDocumentTextIdentity({
                        version: 1,
                        documentRef: requireDocumentRef(entry.ref),
                        authority: 'electron-working-copy',
                        token: requireDocumentRevisionToken(tok2),
                        previousToken: requireDocumentRevisionToken(prevTok1),
                        contentRevision: 2,
                        mintedAt: createEpochMs(),
                        reason: 'native-mutation',
                    }),
                ).toBe(true);
                const second = await searchIndexedDocument(
                    {
                        indexPath,
                        documentRevision: tok2,
                        textIdentity: entry.doc.state().textIdentity,
                        readPages: () => readPagesSpy([{pageNumber: 1, text: 'SHOULD_NOT_REINDEX'}]),
                    },
                    'VisibleAlpha',
                    {matchCase: false, wholeWord: false, useRegex: false},
                );
                expect(second.results).toHaveLength(1);
                expect(readPagesSpy).toHaveBeenCalledTimes(1);

                // Text-modifying edit (default refresh) -> invalidates cache and triggers rebuild!
                await entry.doc.mutate(2, {
                    kind: 'rewrite',
                    source: deletedPdfPath,
                    drafts: 'clear',
                });
                const tok3 = entry.session.token();
                const ti3 = entry.doc.state().textIdentity!;
                expect(ti3).not.toBe(ti1);
                // Older retained revision file (`r2.pdf`) must NOT inherit current revision 3's textIdentity.
                const staleRevisionPath = join(entry.ref, '..', 'r2.pdf');
                expect(pdfSearchDocument(staleRevisionPath, requireDocumentRevisionToken(tok3)).textIdentity).toBeUndefined();
                // Current revision file (`r3.pdf`) carries revision 3's exact textIdentity.
                const currentRevisionPath = join(entry.ref, '..', entry.doc.state().current!.file);
                expect(pdfSearchDocument(currentRevisionPath, requireDocumentRevisionToken(tok3)).textIdentity).toBe(ti3);
                expect(
                    hasPreservedDocumentTextIdentity({
                        version: 1,
                        documentRef: requireDocumentRef(entry.ref),
                        authority: 'electron-working-copy',
                        token: requireDocumentRevisionToken(tok3),
                        previousToken: requireDocumentRevisionToken(tok2),
                        contentRevision: 3,
                        mintedAt: createEpochMs(),
                        reason: 'page-ops',
                    }),
                ).toBe(false);
                const third = await searchIndexedDocument(
                    {
                        indexPath,
                        documentRevision: tok3,
                        textIdentity: ti3,
                        readPages: () => readPagesSpy([{pageNumber: 1, text: 'UpdatedAfterDelete'}]),
                    },
                    'UpdatedAfterDelete',
                    {matchCase: false, wholeWord: false, useRegex: false},
                );
                expect(third.results).toHaveLength(1);
                expect(readPagesSpy).toHaveBeenCalledTimes(2);

                // Undo from rev 3 -> rev 2 restores ti1 (different from ti3 so invalidates rev 3's index and rebuilds for ti1).
                await entry.doc.restore(3, 2);
                expect(entry.doc.state().textIdentity).toBe(ti1);
                expect(
                    hasPreservedDocumentTextIdentity({
                        version: 1,
                        documentRef: requireDocumentRef(entry.ref),
                        authority: 'electron-working-copy',
                        token: requireDocumentRevisionToken(entry.session.token()),
                        previousToken: requireDocumentRevisionToken(tok3),
                        contentRevision: 2,
                        mintedAt: createEpochMs(),
                        reason: 'write',
                    }),
                ).toBe(false);

                // Undo from rev 2 -> rev 1 preserves ti1 across both revisions!
                const tok2BeforeUndo = entry.session.token();
                await entry.doc.restore(2, 1);
                expect(entry.doc.state().textIdentity).toBe(ti1);
                expect(
                    hasPreservedDocumentTextIdentity({
                        version: 1,
                        documentRef: requireDocumentRef(entry.ref),
                        authority: 'electron-working-copy',
                        token: requireDocumentRevisionToken(entry.session.token()),
                        previousToken: requireDocumentRevisionToken(tok2BeforeUndo),
                        contentRevision: 1,
                        mintedAt: createEpochMs(),
                        reason: 'write',
                    }),
                ).toBe(true);

                // Legacy fallback: when textIdentity is null, searchIndexedDocument keys cleanly on documentRevision.
                const legacyDoc = await createDocument(
                    {
                        port: createNodeStorePort(join(tempDir, 'legacy-store')),
                        publication: {
                            witness: async () => 'w1',
                            source: async () => basePdfPath,
                            publish: async () => ({status: 'published', witness: 'w1'}),
                        } satisfies IPublicationPort,
                    } satisfies IDocumentStore,
                    {ext: 'pdf', destination: basePdfPath},
                );
                await legacyDoc.close();
                const legacyRev1 = await searchIndexedDocument(
                    {
                        indexPath: join(tempDir, 'legacy.evb-search-index'),
                        documentRevision: '1',
                        textIdentity: null,
                        readPages: () => readPagesSpy([{pageNumber: 1, text: 'LegacyOne'}]),
                    },
                    'LegacyOne',
                    {matchCase: false, wholeWord: false, useRegex: false},
                );
                expect(legacyRev1.results).toHaveLength(1);
                const callsBeforeLegacyRev2 = readPagesSpy.mock.calls.length;
                const legacyRev2 = await searchIndexedDocument(
                    {
                        indexPath: join(tempDir, 'legacy.evb-search-index'),
                        documentRevision: '2',
                        textIdentity: null,
                        readPages: () => readPagesSpy([{pageNumber: 1, text: 'LegacyTwo'}]),
                    },
                    'LegacyTwo',
                    {matchCase: false, wholeWord: false, useRegex: false},
                );
                expect(legacyRev2.results).toHaveLength(1);
                expect(readPagesSpy).toHaveBeenCalledTimes(callsBeforeLegacyRev2 + 1);
            } finally {
                await setDocumentStoreRootForTests(null);
            }
        } finally {
            await rm(tempDir, {recursive: true, force: true});
        }
    });
});
