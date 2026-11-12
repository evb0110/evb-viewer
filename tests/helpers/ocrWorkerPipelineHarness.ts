import {
    mkdtemp,
    writeFile,
} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {vi} from 'vitest';
import type {TOcrJobResult} from '@electron/features/ocr/pipeline/types';
import type {IOcrEngineRequest} from '@ocr-core/tesseractEngine';
import {readPnmSize} from '@ocr-core/ppmRaster';
import {getErrorMessage} from '@electron/utils/error';
import {requirePageNumber} from '@contracts/pageNumbers';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';

export interface IOcrWorkerPipelineHarness {
    /** The pages this harness's engine recognized, in order. */
    calls: number[];
    close: () => Promise<void>;
    root: string;
    sourcePdfPath: string;
    start: (jobId?: string) => Promise<{result: TOcrJobResult}>;
    /** The word the engine reads before "page N"; change it to tell a fresh recognition from a restored one. */
    word: string;
}

// Page N is 600 + 10 N points wide, so its 72 DPI raster tells the engine which page it reads.
const PAGE_WIDTH = (pageNumber: number) => 600 + 10 * pageNumber;

/**
 * Runs the real desktop OCR job in this process with real Poppler rasters and
 * a scripted engine in place of the worker pool.
 */
export async function createOcrWorkerPipelineHarness(options: {
    concurrency?: number;
    pageCount?: number;
    stallPage?: number;
    tempRoot?: string;
} = {}): Promise<IOcrWorkerPipelineHarness> {
    const root = options.tempRoot ?? await mkdtemp(join(tmpdir(), 'evb-ocr-worker-pipeline-'));
    const sourcePdfPath = join(root, 'source.pdf');
    const document = await PDFDocument.create();
    const pages = Array.from({length: options.pageCount ?? 3}, (_, index) => index + 1);
    for (const pageNumber of pages) {
        document.addPage([
            PAGE_WIDTH(pageNumber),
            800,
        ]);
    }
    await writeFile(sourcePdfPath, await document.save());

    const engineDocument = await PDFDocument.create();
    const engineFont = await engineDocument.embedFont('Helvetica');
    engineDocument.addPage([
        600,
        800,
    ]).drawText('checkpoint', {font: engineFont});
    const enginePdf = await engineDocument.save();

    const env: Record<string, string> = {
        OCR_CONCURRENCY: String(options.concurrency ?? 1),
        // The low-memory Windows guest defaults to one page per job. Keep the
        // requested fixture concurrency.
        OCR_GLOBAL_PAGE_SLOTS: String(options.concurrency ?? 1),
    };
    for (const [
        name,
        value,
    ] of Object.entries(env)) {
        vi.stubEnv(name, value);
    }
    const {runOcrJob} = await import('@electron/features/ocr/pipeline/runOcrJob');
    const {
        getHostResourceProfileSnapshot,
        initializeHostResourceProfile,
    } = await import('@electron/resources/hostResourceProfile');
    const {configureMainJobBroker} = await import('@electron/resources/jobBroker');
    try {
        getHostResourceProfileSnapshot();
    } catch {
        // Main configures both at startup; the job sizes its lanes from them.
        configureMainJobBroker(initializeHostResourceProfile({
            app: {getGPUFeatureStatus: () => ({})} as never,
            performanceMode: 'auto',
        }));
    }
    let active: {
        controller: AbortController;
        settled: Promise<unknown>;
    } | null = null;

    const harness: IOcrWorkerPipelineHarness = {
        calls: [],
        word: 'checkpoint',
        close: async () => {
            if (active) {
                active.controller.abort(new Error('OCR pipeline harness closed'));
                await active.settled;
                active = null;
            }
        },
        root,
        sourcePdfPath,
        start: async (jobId = 'ocr-pipeline-test') => {
            for (const [
                name,
                value,
            ] of Object.entries(env)) {
                vi.stubEnv(name, value);
            }
            const controller = new AbortController();
            const runEngine = async (request: IOcrEngineRequest, signal: AbortSignal) => {
                const pageNumber = (readPnmSize(request.image).width - 600) / 10;
                if (pageNumber === options.stallPage) {
                    await new Promise((_resolve, reject) => {
                        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
                    });
                }
                harness.calls.push(pageNumber);
                const tsv = [
                    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
                    '4\t1\t1\t1\t1\t0\t20\t30\t300\t30\t-1\t',
                    `5\t1\t1\t1\t1\t1\t20\t30\t120\t30\t95\t${harness.word}`,
                    '5\t1\t1\t1\t1\t2\t150\t30\t70\t30\t95\tpage',
                    `5\t1\t1\t1\t1\t3\t230\t30\t30\t30\t95\t${pageNumber}`,
                ].join('\n');
                return {passes: [{
                    stderr: '',
                    outputs: [
                        enginePdf.slice(),
                        new TextEncoder().encode(`${tsv}\n`),
                    ],
                }]};
            };
            const run = runOcrJob({
                jobId,
                sourcePdfPath,
                documentRevision: {
                    version: 1,
                    documentRef: sourcePdfPath,
                    authority: 'electron-working-copy',
                    token: 'ocr-pipeline-revision',
                    contentRevision: 1,
                    mintedAt: 1,
                } as Parameters<typeof runOcrJob>[0]['documentRevision'],
                pages: pages.map(pageNumber => ({
                    pageNumber: requirePageNumber(pageNumber),
                    languages: ['eng'],
                })),
                options: {
                    // Checkpoint semantics do not need a high-resolution blank raster.
                    renderDpi: 72,
                    supersessionPolicy: 'replace-all',
                    replaceAllAcknowledged: true,
                },
                paths: {
                    tessdataPath: root,
                    pdftoppmBinary: getPdfNativeToolPaths().pdftoppm,
                    pdftotextBinary: getPdfNativeToolPaths().pdftotext,
                    qpdfBinary: getPdfNativeToolPaths().qpdf,
                    tempDir: root,
                },
                runEngine,
                prepareEarlyPrintModels: async () => {},
                signal: controller.signal,
                publish: () => undefined,
                log: () => undefined,
            });
            active = {
                controller,
                settled: run.catch(() => undefined),
            };
            try {
                return {result: await run};
            } catch (error) {
                return {result: {
                    success: false,
                    errors: [getErrorMessage(error)],
                } satisfies TOcrJobResult};
            }
        },
    };
    return harness;
}

/** Probe the same bundled/system executables the pipeline will spawn. */
export async function hasOcrWorkerPipelineTools() {
    const tools = getPdfNativeToolPaths();
    const run = promisify(execFile);
    return Promise.all([
        run(tools.qpdf, ['--version']),
        run(tools.pdftoppm, ['-v']),
        run(tools.pdftotext, ['-v']),
    ]).then(() => true).catch(() => false);
}
