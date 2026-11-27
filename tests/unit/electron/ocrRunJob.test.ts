import {createHash} from 'node:crypto';
import {
    mkdtemp,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import type {IOcrDiagnostic} from '@contracts/electronApiOcr';
import {requirePageNumber} from '@contracts/pageNumbers';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
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
vi.mock('@electron/features/ocr/pipeline/popplerStage', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    preparePdfForPoppler: mocks.preparePdfForPoppler,
    renderOcrPageToPpm: mocks.renderOcrPageToPpm,
}));
vi.mock('@electron/features/ocr/pipeline/tryPreprocessOcrImage', () => ({
    prepareOcrPageRasterFile: mocks.prepareOcrPageRasterFile,
}));
vi.mock('@electron/features/ocr/pipeline/writeSearchablePdf', () => ({
    writeSearchablePdf: mocks.writeSearchablePdf,
}));

const {runOcrJob} = await import('@electron/features/ocr/pipeline/runOcrJob');
const {
    getHostResourceProfileSnapshot,
    initializeHostResourceProfile,
} = await import('@electron/resources/hostResourceProfile');
const {configureMainJobBroker} = await import('@electron/resources/jobBroker');

try {
    getHostResourceProfileSnapshot();
} catch {
    configureMainJobBroker(initializeHostResourceProfile({
        app: {getGPUFeatureStatus: () => ({})} as never,
        performanceMode: 'auto',
    }));
}

const REVISION_TOKEN = parseDocumentRevisionToken('rev-original-1')!;
const FAKE_PAGE_PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');
const FAKE_TSV = new TextEncoder().encode([
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '4\t1\t1\t1\t1\t0\t10\t10\t80\t20\t-1\t',
    '5\t1\t1\t1\t1\t1\t10\t10\t80\t20\t95\thello',
].join('\n'));

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
        mocks.writeSearchablePdf.mockImplementation(async ({sessionId, pages}: {
            sessionId: string;
            pages: AsyncIterable<{page: {pageNumber: number}}>;
        }) => {
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
        });
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
        mocks.prepareOcrPageRasterFile.mockImplementation(async ({renderedPath, pageNumber}: {
            renderedPath: string;
            pageNumber: number;
        }) => {
            if (pageNumber === 1) {
                throw new Error('raster cleanup crashed');
            }
            return {
                width: 100,
                height: 100,
                image: {kind: 'file', path: renderedPath, width: 100, height: 100},
                diagnostic: pageDiagnostic,
            };
        });
        onMergeStart = async () => {
            rasterStatCodesAtMerge = await Promise.all(
                renderedPaths.map(path => stat(path).then(
                    () => 'EXISTS',
                    (error: NodeJS.ErrnoException) => error.code,
                )),
            );
        };

        const result = await runOcrJob(createJob());

        expect(result.success).toBe(true);
        if (!result.success) {throw new Error('expected partial success');}
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

        await expect(runOcrJob(createJob({
            pages: [{pageNumber: requirePageNumber(1), languages: ['eng']}],
        }))).rejects.toBe(unprovenError);

        await expect(stat(renderedPath)).resolves.toBeDefined();
        const files = await readdir(tempDir);
        expect(files.some(name => name.endsWith('.ppm'))).toBe(true);
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

        const result = await runOcrJob(createJob({
            pages: {
                kind: 'range',
                firstPage: requirePageNumber(1),
                lastPage: requirePageNumber(5001),
                languages: ['eng'],
            },
        }));

        expect(result.success).toBe(true);
        if (!result.success) {throw new Error('expected success');}
        expect(mocks.selectOcrPagesForSupersession).toHaveBeenCalledTimes(2);
        expect(mocks.preparePdfForPoppler).toHaveBeenCalledOnce();
        expect(renderedPdfPaths).toEqual([repairedPdfPath, repairedPdfPath]);
        expect(mergedPageNumbers).toEqual([1, 5001]);
        expect(result.errors).toEqual([
            'Normalized PDF for Poppler',
            'Native PDF page-size inspection failed',
        ]);
        expect(pageSizeClose).toHaveBeenCalledOnce();
    });
});
