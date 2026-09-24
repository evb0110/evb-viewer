import {
    chmod,
    mkdtemp,
    readFile,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {vi} from 'vitest';
import type {TOcrJobResult} from '@electron/features/ocr/pipeline/types';
import {getErrorMessage} from '@electron/utils/error';
import {requirePageNumber} from '@contracts/pageNumbers';
import {resolveTestQpdfBinary} from '@tests/helpers/resolveTestQpdfBinary';

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
    storagePollMs?: number;
    tempRoot?: string;
} = {}): Promise<IOcrWorkerPipelineHarness> {
    const root = options.tempRoot ?? await mkdtemp(join(tmpdir(), 'evb-ocr-worker-pipeline-'));
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
    const fakeTesseract = join(root, 'fake-tesseract.sh');
    await writeFile(fakeTesseract, `#!/bin/sh
input="$1"
output="$2"
tail="\${input#*-page-}"
page="\${tail%%-*}"
page="\${page%%.*}"
if [ "\${EVB_FAKE_OCR_FAIL_PAGE:-}" = "$page" ]; then
    exit 86
fi
if [ "\${EVB_FAKE_OCR_STALL_PAGE:-}" = "$page" ]; then
    sleep 30
fi
printf '%s\\n' "$page" >> "$EVB_FAKE_OCR_CALL_LOG"
cp "$EVB_FAKE_OCR_PDF_TEMPLATE" "$output.pdf"
if [ -n "\${EVB_FAKE_OCR_GROW_KB:-}" ]; then
    : > "$output.tsv"
    written=0
    while [ "$written" -lt "$EVB_FAKE_OCR_GROW_KB" ]; do
        dd if=/dev/zero bs=1024 count=64 >> "$output.tsv" 2>/dev/null
        written=$((written + 64))
        sleep 0.02
    done
    exit 0
fi
printf 'level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n4\\t1\\t1\\t1\\t1\\t0\\t20\\t30\\t300\\t30\\t-1\\t\\n5\\t1\\t1\\t1\\t1\\t1\\t20\\t30\\t120\\t30\\t95\\tcheckpoint\\n5\\t1\\t1\\t1\\t1\\t2\\t150\\t30\\t70\\t30\\t95\\tpage\\n5\\t1\\t1\\t1\\t1\\t3\\t230\\t30\\t30\\t30\\t95\\t%s\\n' "$page" > "$output.tsv"
`);
    await chmod(fakeTesseract, 0o755);
    const callLogPath = join(root, 'tesseract-calls.txt');
    const env: Record<string, string> = {
        OCR_CONCURRENCY: String(options.concurrency ?? 1),
        OCR_TESSERACT_THREADS: '1',
        EVB_OCR_JOB_MAX_TEMP_MB: String(options.jobMaxTempMb ?? 4_096),
        EVB_OCR_MIN_FREE_SPACE_MB: '1',
        EVB_OCR_STORAGE_POLL_MS: String(options.storagePollMs ?? 250),
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
                tesseractBinary: fakeTesseract,
                tessdataPath: root,
                pdftoppmBinary: process.env.EVB_PDFTOPPM_PATH ?? 'pdftoppm',
                pdftotextBinary: process.env.EVB_PDFTOTEXT_PATH ?? 'pdftotext',
                qpdfBinary: resolveTestQpdfBinary(),
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
