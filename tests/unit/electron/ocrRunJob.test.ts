import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import type {IOcrDiagnostic} from '@contracts/electronApiOcr';
import {requirePageNumber} from '@contracts/pageNumbers';
import {createOcrEnginePool} from '@electron/features/ocr/main/ocrEnginePool';
import type {IOcrEngineLane} from '@electron/features/ocr/main/ocrEngineHostClient';
import {JobBroker} from '@electron/resources/jobBroker';
import {getUnprovenNativeTerminationDetail, markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import type {IOcrJob} from '@electron/features/ocr/pipeline/runOcrJob';

const mocks = vi.hoisted(() => ({
    selectOcrPagesForSupersession: vi.fn(),
    detectSourceDpiDetails: vi.fn(),
    createOcrPageSizeSource: vi.fn(),
    preparePdfForPoppler: vi.fn(),
    renderOcrPageToPpm: vi.fn(),
    prepareOcrPageRasterFile: vi.fn(),
    writeSearchablePdf: vi.fn(),
}));

vi.mock('@electron/features/ocr/pipeline/selectOcrPagesForSupersession', () => ({
    selectOcrPagesForSupersession: mocks.selectOcrPagesForSupersession,
}));
vi.mock('@electron/pdf/sourceDpiDetection', () => ({
    detectSourceDpiDetails: mocks.detectSourceDpiDetails,
}));
vi.mock('@electron/features/ocr/pipeline/pdfPageSizeProbe', () => ({
    createOcrPageSizeSource: mocks.createOcrPageSizeSource,
}));
vi.mock('@electron/features/ocr/pipeline/popplerStage', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    preparePdfForPoppler: mocks.preparePdfForPoppler,
    renderOcrPageToPpm: mocks.renderOcrPageToPpm,
}));
vi.mock('@electron/features/ocr/pipeline/tryPreprocessOcrImage', () => ({
    prepareOcrPageRasterFile: mocks.prepareOcrPageRasterFile,
}));
vi.mock('@electron/features/ocr/pipeline/writeSearchablePdf', () => ({
    writeSearchablePdf: mocks.writeSearchablePdf,
}));

const ocrRuntimePolicy = await import('@electron/features/ocr/main/ocrRuntimePolicy');
const {runOcrJob} = await import('@electron/features/ocr/pipeline/runOcrJob');
const {getHostResourceProfileSnapshot, initializeHostResourceProfile} = await import('@electron/resources/hostResourceProfile');
const {configureMainJobBroker} = await import('@electron/resources/jobBroker');

try {
    getHostResourceProfileSnapshot();
} catch {
    configureMainJobBroker(
        initializeHostResourceProfile({
            app: {getGPUFeatureStatus: () => ({})} as never,
            performanceMode: 'auto',
        }),
    );
}

const REVISION_TOKEN = parseDocumentRevisionToken('rev-original-1')!;
const FAKE_PAGE_PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');
const FAKE_TSV = new TextEncoder().encode(
    [
        'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
        '4\t1\t1\t1\t1\t0\t10\t10\t80\t20\t-1\t',
        '5\t1\t1\t1\t1\t1\t10\t10\t80\t20\t95\thello',
    ].join('\n'),
);

let tempDir: string;
let sourcePdfPath: string;
let pageSizeClose: ReturnType<typeof vi.fn>;
let pageSizeRead: ReturnType<typeof vi.fn>;
let mergedPageNumbers: number[];
let onMergeStart: (() => Promise<void>) | undefined;

function createJob(overrides: Partial<IOcrJob> = {}): IOcrJob {
    return {
        jobId: 'job-1',
        sourcePdfPath,
        documentRevision: {
            version: 1,
            documentRef: sourcePdfPath,
            authority: 'electron-working-copy',
            token: REVISION_TOKEN,
            contentRevision: 1,
            mintedAt: 1,
        } as IOcrJob['documentRevision'],
        pages: [
            {pageNumber: requirePageNumber(1), languages: ['eng']},
            {pageNumber: requirePageNumber(2), languages: ['eng']},
        ],
        options: {renderDpi: 150, supersessionPolicy: 'missing-only'},
        paths: {
            tessdataPath: tempDir,
            pdftoppmBinary: '/bin/pdftoppm',
            pdftotextBinary: '/bin/pdftotext',
            pdfPageOpsBinary: '/bin/evb-pdf-page-ops',
            tempDir,
        },
        signal: new AbortController().signal,
        publish: vi.fn(),
        log: vi.fn(),
        engineChargesBroker: true,
        runEngine: vi.fn(async () => ({
            passes: [{stderr: '', outputs: [FAKE_PAGE_PDF.slice(), FAKE_TSV.slice()]}],
        })),
        prepareEarlyPrintModels: vi.fn(async () => undefined),
        ...overrides,
    };
}

describe('runOcrJob', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        tempDir = await mkdtemp(join(tmpdir(), 'evb-run-ocr-job-'));
        sourcePdfPath = join(tempDir, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-1.7\n%%EOF\n');
        pageSizeClose = vi.fn(async () => undefined);
        pageSizeRead = vi.fn(async () => ({status: 'available', pageSizes: new Map()}));
        mergedPageNumbers = [];
        onMergeStart = undefined;
        mocks.createOcrPageSizeSource.mockReturnValue({read: pageSizeRead, close: pageSizeClose});
        mocks.detectSourceDpiDetails.mockResolvedValue(null);
        mocks.selectOcrPagesForSupersession.mockImplementation(async ({pages}: {pages: unknown[]}) => ({
            pages,
            warnings: [],
            diagnostics: [],
        }));
        mocks.renderOcrPageToPpm.mockImplementation(async (args: unknown[]) => {
            const renderedPath = args[4] as string;
            await writeFile(renderedPath, 'P5\n1 1\n255\n\x00');
        });
        mocks.prepareOcrPageRasterFile.mockImplementation(async ({renderedPath}: {renderedPath: string}) => ({
            width: 100,
            height: 100,
            image: {kind: 'file', path: renderedPath, width: 100, height: 100},
        }));
        mocks.writeSearchablePdf.mockImplementation(
            async ({sessionId, pages}: {sessionId: string; pages: AsyncIterable<{page: {pageNumber: number}}>}) => {
                await onMergeStart?.();
                for await (const checkpoint of pages) {
                    mergedPageNumbers.push(checkpoint.page.pageNumber);
                }
                if (mergedPageNumbers.length === 0) {
                    throw new Error('Cannot write searchable PDF without recognized page checkpoints');
                }
                const mergedPath = join(tempDir, `${sessionId}-merged.pdf`);
                await writeFile(mergedPath, '%PDF-1.7\nmerged\n%%EOF\n');
                return mergedPath;
            },
        );
    });

    afterEach(async () => {
        await rm(tempDir, {recursive: true, force: true});
    });

    it('publishes skipped-page progress and returns no-pages-to-process unless a warning diagnostic is present', async () => {
        const infoDiagnostic: IOcrDiagnostic = {
            code: 'OCR_EXISTING_TEXT_SKIPPED',
            severity: 'info',
            pageNumber: requirePageNumber(1),
            message: 'Page 1 already has text',
        };
        mocks.selectOcrPagesForSupersession.mockResolvedValueOnce({
            pages: [],
            warnings: [],
            diagnostics: [infoDiagnostic],
        });
        const publish = vi.fn();

        const skippedResult = await runOcrJob(createJob({publish}));

        expect(skippedResult).toEqual({
            success: false,
            errors: [],
            outcome: 'no-pages-to-process',
            diagnostics: [infoDiagnostic],
        });
        expect(publish).toHaveBeenCalledWith({
            currentPage: 2,
            processedCount: 2,
            totalPages: 2,
            phase: 'processing',
        });
        expect(pageSizeClose).toHaveBeenCalledOnce();

        const warningDiagnostic: IOcrDiagnostic = {
            code: 'OCR_EXISTING_TEXT_SKIPPED',
            severity: 'warning',
            pageNumber: requirePageNumber(1),
            message: 'Text inspection failed',
        };
        mocks.selectOcrPagesForSupersession.mockResolvedValueOnce({
            pages: [],
            warnings: ['Page 1 inspection failed'],
            diagnostics: [warningDiagnostic],
        });

        const failedResult = await runOcrJob(createJob());

        expect(failedResult).toEqual({
            success: false,
            errors: ['Page 1 inspection failed'],
        });
    });

    it('unlinks failed raster files on normal errors and preserves partial results, revision token, hash, and cleanup ack', async () => {
        const renderedPaths: string[] = [];
        let rasterStatCodesAtMerge: Array<string | undefined> = [];
        const pageDiagnostic: IOcrDiagnostic = {
            code: 'OCR_PREPROCESSING_FAILED',
            severity: 'warning',
            pageNumber: requirePageNumber(2),
            message: 'Cleanup fell back to rendered raster',
        };
        mocks.renderOcrPageToPpm.mockImplementation(async (args: unknown[]) => {
            const renderedPath = args[4] as string;
            renderedPaths.push(renderedPath);
            await writeFile(renderedPath, 'P5\n1 1\n255\n\x00');
        });
        mocks.prepareOcrPageRasterFile.mockImplementation(
            async ({renderedPath, pageNumber}: {renderedPath: string; pageNumber: number}) => {
                if (pageNumber === 1) {
                    throw new Error('raster cleanup crashed');
                }
                return {
                    width: 100,
                    height: 100,
                    image: {kind: 'file', path: renderedPath, width: 100, height: 100},
                    diagnostic: pageDiagnostic,
                };
            },
        );
        onMergeStart = async () => {
            rasterStatCodesAtMerge = await Promise.all(
                renderedPaths.map((path) =>
                    stat(path).then(
                        () => 'EXISTS',
                        (error: NodeJS.ErrnoException) => error.code,
                    ),
                ),
            );
        };

        const result = await runOcrJob(createJob());

        expect(result.success).toBe(true);
        if (!result.success) {
            throw new Error('expected partial success');
        }
        expect(mergedPageNumbers).toEqual([2]);
        expect(result.sourceDocumentRevisionToken).toBe(REVISION_TOKEN);
        expect(result.requiresCleanupAck).toBe(true);
        expect(result.resultSha256).toBe(createHash('sha256').update('%PDF-1.7\nmerged\n%%EOF\n').digest('hex'));
        expect(result.errors).toEqual(['Page 1: raster cleanup crashed']);
        expect(result.diagnostics).toEqual([pageDiagnostic]);
        expect(renderedPaths).toHaveLength(2);
        expect(rasterStatCodesAtMerge).toEqual(['ENOENT', 'ENOENT']);
        await expect(stat(result.pdfPath)).resolves.toBeDefined();
        expect(pageSizeClose).toHaveBeenCalledOnce();
    });

    it('aborts and retains rendered rasters and session files when raster preparation has unproven native termination', async () => {
        const unprovenError = markUnprovenNativeTermination(new Error('native helper still running'), 'pid still alive');
        let renderedPath = '';
        mocks.renderOcrPageToPpm.mockImplementation(async (args: unknown[]) => {
            renderedPath = args[4] as string;
            await writeFile(renderedPath, 'P5\n1 1\n255\n\x00');
        });
        mocks.prepareOcrPageRasterFile.mockRejectedValueOnce(unprovenError);

        await expect(
            runOcrJob(
                createJob({
                    pages: [{pageNumber: requirePageNumber(1), languages: ['eng']}],
                }),
            ),
        ).rejects.toBe(unprovenError);

        await expect(stat(renderedPath)).resolves.toBeDefined();
        const files = await readdir(tempDir);
        expect(files.some((name) => name.endsWith('.ppm'))).toBe(true);
        expect(pageSizeClose).toHaveBeenCalledOnce();
    });

    it('runs lazy Poppler fallback once across degraded batches, renders from the repaired PDF, and reports degraded geometry warning once', async () => {
        const repairedPdfPath = join(tempDir, 'repaired.pdf');
        const renderedPdfPaths: string[] = [];
        await writeFile(repairedPdfPath, '%PDF-1.7\nrepaired\n%%EOF\n');
        mocks.selectOcrPagesForSupersession.mockImplementation(async ({pages}: {pages: unknown[]}) => ({
            pages: pages.slice(0, 1),
            warnings: [],
            diagnostics: [],
        }));
        mocks.preparePdfForPoppler.mockResolvedValue({
            pdfPath: repairedPdfPath,
            warnings: ['Normalized PDF for Poppler'],
        });
        mocks.renderOcrPageToPpm.mockImplementation(async (args: unknown[]) => {
            renderedPdfPaths.push(args[3] as string);
            await writeFile(args[4] as string, 'P5\n1 1\n255\n\x00');
        });
        pageSizeRead.mockImplementation(async () => ({
            status: 'degraded',
            reason: 'native-tool-failed',
            message: 'Native PDF page-size inspection failed',
            pageSizes: new Map(),
        }));

        const result = await runOcrJob(
            createJob({
                pages: {
                    kind: 'range',
                    firstPage: requirePageNumber(1),
                    lastPage: requirePageNumber(5001),
                    languages: ['eng'],
                },
            }),
        );

        expect(result.success).toBe(true);
        if (!result.success) {
            throw new Error('expected success');
        }
        expect(mocks.selectOcrPagesForSupersession).toHaveBeenCalledTimes(2);
        expect(mocks.preparePdfForPoppler).toHaveBeenCalledOnce();
        expect(renderedPdfPaths).toEqual([repairedPdfPath, repairedPdfPath]);
        expect(mergedPageNumbers).toEqual([1, 5001]);
        expect(result.errors).toEqual(['Normalized PDF for Poppler', 'Native PDF page-size inspection failed']);
        expect(pageSizeClose).toHaveBeenCalledOnce();
    });

    const createLongSTsv = () => {
        // 35 in-word 'f' characters and 0 's' characters crosses the long-s signature threshold (>= 30 letters, >= 45% f).
        const words = Array.from({length: 18}, (_, index) => `5\t1\t1\t1\t1\t${index + 1}\t${10 + index * 20}\t10\t18\t20\t95\tfefto`);
        return new TextEncoder().encode(
            [
                'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
                '4\t1\t1\t1\t1\t0\t10\t10\t360\t20\t-1\t',
                ...words,
            ].join('\n'),
        );
    };

    const createEarlyPrintHocr = (word: string) => {
        const spans = Array.from(
            {length: 18},
            (_, index) =>
                `<span class='ocrx_word' id='word_1_${index + 1}' title='bbox ${10 + index * 20} 10 ${28 + index * 20} 30; x_wconf 95'>${word}</span>`,
        ).join(' ');
        return new TextEncoder().encode(
            `<!DOCTYPE html><html><body><div class='ocr_page' title='bbox 0 0 400 100'><span class='ocr_line' id='line_1_1' title='bbox 10 10 370 30'>${spans}</span></div></body></html>`,
        );
    };

    it('reuses the per-page prepared raster across Early Print reread passes and unlinks it once the page finishes', async () => {
        // Minimal 0-entry traineddata header so readEarlyPrintDictionary succeeds cleanly.
        await writeFile(join(tempDir, 'eng.traineddata'), new Uint8Array(4));
        const longSTsv = createLongSTsv();
        const baseHocr = createEarlyPrintHocr('fefto');
        const longSHocr = createEarlyPrintHocr('ſeſto');
        const engineCalls: Array<{path: string; existsDuringPass: boolean; passCount: number}> = [];
        let rasterStatAtMerge: string | undefined;

        const runEngine = vi.fn(async (request: Parameters<IOcrJob['runEngine']>[0]) => {
            if (request.image instanceof Uint8Array) {
                throw new Error('expected file-backed raster');
            }
            const existsDuringPass = await stat(request.image.path).then(
                () => true,
                () => false,
            );
            engineCalls.push({
                path: request.image.path,
                existsDuringPass,
                passCount: request.passes.length,
            });
            if (request.passes.length === 1) {
                return {
                    passes: [{stderr: '', outputs: [FAKE_PAGE_PDF.slice(), longSTsv.slice()]}],
                };
            }
            return {
                passes: [
                    {stderr: '', outputs: [FAKE_PAGE_PDF.slice(), longSTsv.slice(), baseHocr.slice()]},
                    {stderr: '', outputs: [longSHocr.slice()]},
                    {stderr: '', outputs: [baseHocr.slice()]},
                ],
            };
        });

        onMergeStart = async () => {
            rasterStatAtMerge = await stat(engineCalls[0]!.path).then(
                () => 'EXISTS',
                (error: NodeJS.ErrnoException) => error.code,
            );
        };

        const result = await runOcrJob(
            createJob({
                pages: [{pageNumber: requirePageNumber(1), languages: ['eng']}],
                runEngine,
            }),
        );

        expect(result.success).toBe(true);
        expect(mocks.renderOcrPageToPpm).toHaveBeenCalledTimes(1);
        expect(mocks.prepareOcrPageRasterFile).toHaveBeenCalledTimes(1);
        expect(engineCalls).toHaveLength(2);
        expect(engineCalls[0]).toMatchObject({existsDuringPass: true, passCount: 1});
        expect(engineCalls[1]).toEqual({
            path: engineCalls[0]!.path,
            existsDuringPass: true,
            passCount: 3,
        });
        expect(rasterStatAtMerge).toBe('ENOENT');
    });

    it('unlinks the page raster after an Early Print reread failure', async () => {
        await writeFile(join(tempDir, 'eng.traineddata'), new Uint8Array(4));
        const longSTsv = createLongSTsv();
        const failedRasterPaths: string[] = [];

        const failingEarlyPrintResult = await runOcrJob(
            createJob({
                pages: [{pageNumber: requirePageNumber(1), languages: ['eng']}],
                runEngine: vi.fn(async (request: Parameters<IOcrJob['runEngine']>[0]) => {
                    if (!(request.image instanceof Uint8Array)) {
                        failedRasterPaths.push(request.image.path);
                    }
                    if (request.passes.length === 1) {
                        return {passes: [{stderr: '', outputs: [FAKE_PAGE_PDF.slice(), longSTsv.slice()]}]};
                    }
                    throw new Error('early-print reread timed out');
                }),
            }),
        );

        expect(failingEarlyPrintResult.success).toBe(true);
        expect(mocks.renderOcrPageToPpm).toHaveBeenCalledTimes(1);
        expect(failedRasterPaths).toHaveLength(2);
        expect(failedRasterPaths[1]).toBe(failedRasterPaths[0]);
        await expect(stat(failedRasterPaths[0]!)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('unlinks the page raster when aborted mid-Early-Print reread', async () => {
        await writeFile(join(tempDir, 'eng.traineddata'), new Uint8Array(4));
        const longSTsv = createLongSTsv();
        const controller = new AbortController();
        let abortedRasterPath = '';

        await expect(
            runOcrJob(
                createJob({
                    pages: [{pageNumber: requirePageNumber(1), languages: ['eng']}],
                    signal: controller.signal,
                    runEngine: vi.fn(async (request: Parameters<IOcrJob['runEngine']>[0]) => {
                        if (!(request.image instanceof Uint8Array)) {
                            abortedRasterPath = request.image.path;
                        }
                        if (request.passes.length === 1) {
                            return {passes: [{stderr: '', outputs: [FAKE_PAGE_PDF.slice(), longSTsv.slice()]}]};
                        }
                        controller.abort(new DOMException('user canceled', 'AbortError'));
                        throw controller.signal.reason;
                    }),
                }),
            ),
        ).rejects.toMatchObject({name: 'AbortError'});

        expect(mocks.renderOcrPageToPpm).toHaveBeenCalledTimes(1);
        expect(abortedRasterPath).not.toBe('');
        await expect(stat(abortedRasterPath)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('retains the page raster when the engine fails with unproven native termination on first pass or Early Print reread', async () => {
        const unprovenError = markUnprovenNativeTermination(new Error('engine helper still alive'), 'pid still running');
        let rasterPath = '';
        await expect(
            runOcrJob(
                createJob({
                    pages: [{pageNumber: requirePageNumber(1), languages: ['eng']}],
                    runEngine: vi.fn(async (request: Parameters<IOcrJob['runEngine']>[0]) => {
                        if (!(request.image instanceof Uint8Array)) {
                            rasterPath = request.image.path;
                        }
                        throw unprovenError;
                    }),
                }),
            ),
        ).rejects.toBe(unprovenError);

        expect(rasterPath).not.toBe('');
        await expect(stat(rasterPath)).resolves.toBeDefined();

        // Also verify unproven termination during the Early Print reread propagates and retains the raster.
        await writeFile(join(tempDir, 'eng.traineddata'), new Uint8Array(4));
        const longSTsv = createLongSTsv();
        const rereadUnproven = markUnprovenNativeTermination(new Error('reread helper still alive'), 'pid still running');
        let rereadRasterPath = '';
        await expect(
            runOcrJob(
                createJob({
                    jobId: 'job-reread-unproven',
                    pages: [{pageNumber: requirePageNumber(1), languages: ['eng']}],
                    runEngine: vi.fn(async (request: Parameters<IOcrJob['runEngine']>[0]) => {
                        if (!(request.image instanceof Uint8Array)) {
                            rereadRasterPath = request.image.path;
                        }
                        if (request.passes.length === 1) {
                            return {passes: [{stderr: '', outputs: [FAKE_PAGE_PDF.slice(), longSTsv.slice()]}]};
                        }
                        throw rereadUnproven;
                    }),
                }),
            ),
        ).rejects.toBe(rereadUnproven);

        expect(rereadRasterPath).not.toBe('');
        await expect(stat(rereadRasterPath)).resolves.toBeDefined();
    });

    it('keeps the page raster on disk until a canceled engine lane confirms exit, and retains it if exit times out', async () => {
        const createDelayedExitLane = (exitGate: Promise<void>, onMessagePath: (path: string) => void): IOcrEngineLane => {
            const emitter = new EventEmitter();
            let exited = false;
            return {
                on: (event, listener) => emitter.on(event, listener),
                off: (event, listener) => emitter.off(event, listener),
                postMessage: (message) => {
                    if (!(message.request.image instanceof Uint8Array)) {
                        onMessagePath(message.request.image.path);
                    }
                },
                terminate: async () => {
                    await exitGate;
                    if (!exited) {
                        exited = true;
                        emitter.emit('exit', 0);
                    }
                },
            };
        };

        const broker = new JobBroker({
            cpuTokens: 2,
            estimatedResidentBytes: 1024 * 1024 * 1024,
            nativeProcesses: 2,
            ioWeight: 2,
        });

        // Case 1: Delayed lane exit completes within timeout -> raster stays intact while lane runs, then unlinks after exit.
        const exitGate1 = Promise.withResolvers<void>();
        const started1 = Promise.withResolvers<string>();
        const pool1 = createOcrEnginePool({
            size: () => 1,
            tessdataDir: tempDir,
            broker,
            exitProofTimeoutMs: 5_000,
            startLane: () => createDelayedExitLane(exitGate1.promise, (path) => started1.resolve(path)),
        });
        const abort1 = new AbortController();
        const job1 = runOcrJob(
            createJob({
                pages: [{pageNumber: requirePageNumber(1), languages: ['eng']}],
                signal: abort1.signal,
                engineChargesBroker: true,
                runEngine: (request, signal) => pool1.run(request, signal),
            }),
        );
        try {
            const rasterPath1 = await started1.promise;
            vi.useFakeTimers();
            abort1.abort(new DOMException('cancel delayed exit', 'AbortError'));
            await vi.advanceTimersByTimeAsync(1_000);
            vi.useRealTimers();
            // Lane has not acknowledged exit yet -> raster file MUST still exist on disk.
            await expect(stat(rasterPath1)).resolves.toBeDefined();

            exitGate1.resolve();
            await expect(job1).rejects.toMatchObject({name: 'AbortError'});
            await expect(stat(rasterPath1)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            vi.useRealTimers();
            exitGate1.resolve();
            pool1.terminate();
            await job1.catch(() => undefined);
        }

        // Case 2: Wedged lane never acknowledges exit -> unproven termination propagates and raster is retained.
        const exitGate2 = Promise.withResolvers<void>();
        const started2 = Promise.withResolvers<string>();
        const pool2 = createOcrEnginePool({
            size: () => 1,
            tessdataDir: tempDir,
            broker,
            exitProofTimeoutMs: 5_000,
            startLane: () => createDelayedExitLane(exitGate2.promise, (path) => started2.resolve(path)),
        });
        const abort2 = new AbortController();
        const job2 = runOcrJob(
            createJob({
                jobId: 'job-wedged',
                pages: [{pageNumber: requirePageNumber(1), languages: ['eng']}],
                signal: abort2.signal,
                engineChargesBroker: true,
                runEngine: (request, signal) => pool2.run(request, signal),
            }),
        );
        const job2Error = job2.then(
            () => null,
            (caught: unknown) => caught,
        );
        try {
            const rasterPath2 = await started2.promise;
            vi.useFakeTimers();
            abort2.abort(new DOMException('cancel wedged exit', 'AbortError'));
            await vi.advanceTimersByTimeAsync(5_000);
            vi.useRealTimers();
            const wedgedError = await job2Error;
            expect(getUnprovenNativeTerminationDetail(wedgedError)).toBeDefined();
            await expect(stat(rasterPath2)).resolves.toBeDefined();

            // Once the late exit acknowledgement finally arrives, deferred cleanup removes the raster.
            exitGate2.resolve();
            await vi.waitFor(async () => {
                await expect(stat(rasterPath2)).rejects.toMatchObject({code: 'ENOENT'});
            });
        } finally {
            vi.useRealTimers();
            exitGate2.resolve();
            pool2.terminate();
            await job2.catch(() => undefined);
        }

        // Case 3: Parallel 2-lane job where lane 1 is stuck and aborts the job while sibling lane 2 exits cleanly ->
        // sibling lane 2's raster is unlinked immediately without waiting for lane 1's stuck exit.
        const stuckExit = Promise.withResolvers<void>();
        const lanePaths: string[] = [];
        const bothStarted = Promise.withResolvers<void>();
        let stuckEmitter: EventEmitter | null = null;
        let laneIndex = 0;
        const pool3 = createOcrEnginePool({
            size: () => 2,
            tessdataDir: tempDir,
            broker,
            exitProofTimeoutMs: 5_000,
            startLane: () => {
                const isStuck = laneIndex++ === 0;
                const emitter = new EventEmitter();
                if (isStuck) {
                    stuckEmitter = emitter;
                }
                let exited = false;
                return {
                    on: (event, listener) => emitter.on(event, listener),
                    off: (event, listener) => emitter.off(event, listener),
                    postMessage: (message) => {
                        if (!(message.request.image instanceof Uint8Array)) {
                            lanePaths.push(message.request.image.path);
                            if (lanePaths.length === 2) {
                                bothStarted.resolve();
                            }
                        }
                    },
                    terminate: async () => {
                        if (isStuck) {
                            await stuckExit.promise;
                        }
                        if (!exited) {
                            exited = true;
                            emitter.emit('exit', 0);
                        }
                    },
                };
            },
        });
        // Pin policy to 2 lanes regardless of host RAM / CPU count so both lanes always start.
        const policySpy = vi.spyOn(ocrRuntimePolicy, 'getOcrRuntimePolicy').mockReturnValue({
            globalPageSlots: 2,
            modelDownloadConcurrency: 3,
        });
        vi.stubEnv('OCR_CONCURRENCY', '2');
        try {
            const job3 = runOcrJob(
                createJob({
                    jobId: 'job-parallel-sibling',
                    pages: [
                        {pageNumber: requirePageNumber(1), languages: ['eng']},
                        {pageNumber: requirePageNumber(2), languages: ['eng']},
                    ],
                    engineChargesBroker: true,
                    runEngine: (request, signal) => pool3.run(request, signal),
                }),
            );
            const job3Error = job3.then(
                () => null,
                (caught: unknown) => caught,
            );
            await bothStarted.promise;
            vi.useFakeTimers();
            // Emit lane 1's error only after both lanes have posted their rasters.
            stuckEmitter!.emit('error', new Error('lane 1 stuck'));
            await vi.advanceTimersByTimeAsync(5_000);
            vi.useRealTimers();
            const err3 = await job3Error;
            expect(getUnprovenNativeTerminationDetail(err3)).toBeDefined();
            // Stuck lane 1's raster stays on disk; cleanly exited sibling lane 2's raster is already unlinked.
            await expect(stat(lanePaths[0]!)).resolves.toBeDefined();
            await expect(stat(lanePaths[1]!)).rejects.toMatchObject({code: 'ENOENT'});

            stuckExit.resolve();
            await vi.waitFor(async () => {
                await expect(stat(lanePaths[0]!)).rejects.toMatchObject({code: 'ENOENT'});
            });
        } finally {
            vi.useRealTimers();
            policySpy.mockRestore();
            vi.unstubAllEnvs();
            stuckExit.resolve();
            pool3.terminate();
        }
    });
});
