import {
    mkdtemp,
    readFile,
    writeFile,
} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {vi} from 'vitest';
import type {TOcrJobResult} from '@electron/features/ocr/pipeline/types';
import {getErrorMessage} from '@electron/utils/error';
import {requirePageNumber} from '@contracts/pageNumbers';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';

export interface IOcrWorkerPipelineHarness {
    callLogPath: string;
    close: () => Promise<void>;
    root: string;
    sourcePdfPath: string;
    start: (jobId?: string) => Promise<{result: TOcrJobResult}>;
}

/**
 * Runs the real OCR pipeline in this process with a scripted Tesseract. The
 * storage limits are read when the pipeline modules load, so a harness sets
 * them before its first import in a test file.
 */
export async function createOcrWorkerPipelineHarness(options: {
    concurrency?: number;
    failPage?: number;
    growOutputKb?: number;
    jobMaxTempMb?: number;
    stallPage?: number;
    tempRoot?: string;
} = {}): Promise<IOcrWorkerPipelineHarness> {
    const root = options.tempRoot ?? await mkdtemp(join(tmpdir(), 'evb-ocr-worker-pipeline-'));
    // Synthetic size fixture for page admission; the scripted recognizer never
    // loads it. Real-model RSS is measured separately with pinned tessdata_best.
    await writeFile(join(root, 'eng.traineddata'), Buffer.alloc(1_024));
    const sourcePdfPath = join(root, 'source.pdf');
    const document = await PDFDocument.create();
    for (let page = 0; page < 3; page += 1) {
        document.addPage([
            600,
            800,
        ]);
    }
    await writeFile(sourcePdfPath, await document.save());

    const fakeTesseractPdf = join(root, 'fake-tesseract-template.pdf');
    const fakeOutputDocument = await PDFDocument.create();
    const fakeOutputFont = await fakeOutputDocument.embedFont('Helvetica');
    fakeOutputDocument.addPage([
        600,
        800,
    ]).drawText('checkpoint', {font: fakeOutputFont});
    await writeFile(fakeTesseractPdf, await fakeOutputDocument.save());
    // The production runner spawns an executable with Tesseract's arguments,
    // without a shell. A Node preload keeps that boundary runnable on Windows.
    const fakeTesseract = join(root, 'fake-tesseract.cjs');
    await writeFile(fakeTesseract, `
const fs = require('node:fs');
const [input, output] = process.argv.slice(1);
const page = /-page-(\\d+)/.exec(input)[1];
function recognize() {
    const sleep = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    if (process.env.EVB_FAKE_OCR_FAIL_PAGE === page) process.exit(86);
    if (process.env.EVB_FAKE_OCR_STALL_PAGE === page) {
        sleep(30_000);
    }
    fs.appendFileSync(process.env.EVB_FAKE_OCR_CALL_LOG, page + '\\n');
    fs.copyFileSync(process.env.EVB_FAKE_OCR_PDF_TEMPLATE, output + '.pdf');
    if (process.env.EVB_FAKE_OCR_GROW_KB) {
        fs.writeFileSync(output + '.tsv', '');
        for (let written = 0; written < Number(process.env.EVB_FAKE_OCR_GROW_KB); written += 64) {
            fs.appendFileSync(output + '.tsv', Buffer.alloc(64 * 1024));
            sleep(20);
        }
        return;
    }
    fs.writeFileSync(output + '.tsv', [
        'level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext',
        '4\\t1\\t1\\t1\\t1\\t0\\t20\\t30\\t300\\t30\\t-1\\t',
        '5\\t1\\t1\\t1\\t1\\t1\\t20\\t30\\t120\\t30\\t95\\tcheckpoint',
        '5\\t1\\t1\\t1\\t1\\t2\\t150\\t30\\t70\\t30\\t95\\tpage',
        '5\\t1\\t1\\t1\\t1\\t3\\t230\\t30\\t30\\t30\\t95\\t' + page,
    ].join('\\n') + '\\n');
}
recognize();
process.exit(0);
`);
    const callLogPath = join(root, 'tesseract-calls.txt');
    const env: Record<string, string> = {
        NODE_OPTIONS: `--require=${JSON.stringify(fakeTesseract)}`,
        OCR_CONCURRENCY: String(options.concurrency ?? 1),
        // The low-memory Windows guest defaults to one page per job. Keep the
        // requested fixture concurrency while the real broker caps resources.
        OCR_GLOBAL_PAGE_SLOTS: String(options.concurrency ?? 1),
        OCR_TESSERACT_THREADS: '1',
        EVB_OCR_JOB_MAX_TEMP_MB: String(options.jobMaxTempMb ?? 4_096),
        EVB_FAKE_OCR_CALL_LOG: callLogPath,
        EVB_FAKE_OCR_FAIL_PAGE: options.failPage === undefined ? '' : String(options.failPage),
        EVB_FAKE_OCR_GROW_KB: options.growOutputKb === undefined ? '' : String(options.growOutputKb),
        EVB_FAKE_OCR_STALL_PAGE: options.stallPage === undefined ? '' : String(options.stallPage),
        EVB_FAKE_OCR_PDF_TEMPLATE: fakeTesseractPdf,
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
        // Main configures both at startup; page leases need them.
        configureMainJobBroker(initializeHostResourceProfile({
            app: {getGPUFeatureStatus: () => ({})} as never,
            performanceMode: 'auto',
        }));
    }
    let active: {
        controller: AbortController;
        settled: Promise<unknown>;
    } | null = null;

    const start = async (jobId = 'ocr-pipeline-test') => {
        for (const [
            name,
            value,
        ] of Object.entries(env)) {
            vi.stubEnv(name, value);
        }
        const controller = new AbortController();
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
            pages: [
                1,
                2,
                3,
            ].map(pageNumber => ({
                pageNumber: requirePageNumber(pageNumber),
                languages: ['eng'],
            })),
            options: {
                renderDpi: 150,
                supersessionPolicy: 'replace-all',
                replaceAllAcknowledged: true,
            },
            paths: {
                tesseractBinary: process.execPath,
                tessdataPath: root,
                pdftoppmBinary: getPdfNativeToolPaths().pdftoppm,
                pdftotextBinary: getPdfNativeToolPaths().pdftotext,
                qpdfBinary: getPdfNativeToolPaths().qpdf,
                tempDir: root,
            },
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
    };

    return {
        callLogPath,
        close: async () => {
            if (active) {
                active.controller.abort(new Error('OCR pipeline harness closed'));
                await active.settled;
                active = null;
            }
        },
        root,
        sourcePdfPath,
        start,
    };
}

export async function readOcrWorkerCallLog(path: string) {
    return readFile(path, 'utf8').then(text => text.trim().split(/\s+/u).filter(Boolean).map(Number)).catch(() => []);
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
