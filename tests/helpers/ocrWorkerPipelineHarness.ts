import {Worker} from 'node:worker_threads';
import {
    chmod,
    mkdtemp,
    readFile,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {build} from 'esbuild';
import {PDFDocument} from 'pdf-lib';
import type {TOcrWorkerOutboundMessage} from '@electron/ocr/worker/types';
import {resolveTestQpdfBinary} from '@tests/helpers/resolveTestQpdfBinary';

export interface IOcrWorkerPipelineHarness {
    callLogPath: string;
    close: () => Promise<void>;
    logs: string[];
    root: string;
    sourcePdfPath: string;
    start: (jobId?: string) => Promise<Extract<TOcrWorkerOutboundMessage, {type: 'complete'}>>;
    worker: Worker;
}

async function buildWorkerBundle(root: string) {
    const result = await build({
        bundle: true,
        entryPoints: [resolve('electron/ocr/worker/main.ts')],
        format: 'cjs',
        platform: 'node',
        target: 'node22',
        tsconfig: resolve('tsconfig.base.json'),
        write: false,
    });
    const output = result.outputFiles[0]?.contents;
    if (!output) throw new Error('OCR worker harness bundle produced no output');
    const path = join(root, 'ocr-worker.cjs');
    await writeFile(path, output);
    return path;
}

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
    const workerPath = await buildWorkerBundle(root);
    const sourcePdfPath = join(root, 'source.pdf');
    const document = await PDFDocument.create();
    document.addPage([
        600,
        800,
    ]);
    document.addPage([
        600,
        800,
    ]);
    document.addPage([
        600,
        800,
    ]);
    await writeFile(sourcePdfPath, await document.save());

    const fakeTesseractPdf = join(root, 'fake-tesseract-template.pdf');
    const fakeOutputDocument = await PDFDocument.create();
    const fakeOutputFont = await fakeOutputDocument.embedFont('Helvetica');
    const fakeOutputPage = fakeOutputDocument.addPage([
        600,
        800,
    ]);
    fakeOutputPage.drawText('checkpoint', {font: fakeOutputFont});
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
    const worker = new Worker(workerPath, {
        env: {
            ...process.env,
            OCR_CONCURRENCY: String(options.concurrency ?? 1),
            OCR_TESSERACT_THREADS: '1',
            EVB_OCR_JOB_MAX_TEMP_MB: String(options.jobMaxTempMb ?? 4_096),
            EVB_OCR_MIN_FREE_SPACE_MB: '1',
            EVB_OCR_STORAGE_POLL_MS: String(options.storagePollMs ?? 250),
            EVB_FAKE_OCR_CALL_LOG: callLogPath,
            ...(options.failPage === undefined ? {} : {EVB_FAKE_OCR_FAIL_PAGE: String(options.failPage)}),
            ...(options.growOutputKb === undefined ? {} : {EVB_FAKE_OCR_GROW_KB: String(options.growOutputKb)}),
            ...(options.stallPage === undefined ? {} : {EVB_FAKE_OCR_STALL_PAGE: String(options.stallPage)}),
            EVB_FAKE_OCR_PDF_TEMPLATE: fakeTesseractPdf,
        },
        workerData: {
            tesseractBinary: fakeTesseract,
            tessdataPath: root,
            pdftoppmBinary: process.env.EVB_PDFTOPPM_PATH ?? 'pdftoppm',
            pdftotextBinary: process.env.EVB_PDFTOTEXT_PATH ?? 'pdftotext',
            qpdfBinary: resolveTestQpdfBinary(),
            tempDir: root,
        },
    });
    let activeJobId: string | null = null;
    const logs: string[] = [];
    worker.on('message', (message: TOcrWorkerOutboundMessage) => {
        if (message.type === 'log') {
            logs.push(`${message.level}: ${message.message}`);
        }
        if (message.type === 'resource-acquire') {
            worker.postMessage({
                type: 'resource-acquired',
                jobId: message.jobId,
                requestId: message.requestId,
                token: `test-${message.pageNumber}`,
                effectiveDpi: message.requestedDpi,
            });
        }
        if (message.type === 'native-child-intent') {
            worker.postMessage({
                type: 'native-child-intent-ack',
                jobId: message.jobId,
                childId: message.childId,
                accepted: true,
            });
        }
        if (message.type === 'native-child-register') {
            worker.postMessage({
                type: 'native-child-register-ack',
                jobId: message.jobId,
                childId: message.childId,
                accepted: true,
            });
        }
        if (message.type === 'native-child-exit') {
            worker.postMessage({
                type: 'native-child-exit-ack',
                jobId: message.jobId,
                childId: message.childId,
                accepted: true,
            });
        }
    });

    const start = (jobId = 'ocr-pipeline-test') => new Promise<Extract<TOcrWorkerOutboundMessage, {type: 'complete'}>>((resolvePromise, rejectPromise) => {
        activeJobId = jobId;
        const timeout = setTimeout(() => rejectPromise(new Error('Timed out waiting for OCR worker completion')), 60_000);
        const onError = (error: Error) => {
            clearTimeout(timeout);
            rejectPromise(error);
        };
        const onMessage = (message: TOcrWorkerOutboundMessage) => {
            if (message.type !== 'complete' || message.jobId !== jobId) {
                return;
            }
            clearTimeout(timeout);
            worker.off('error', onError);
            worker.off('message', onMessage);
            activeJobId = null;
            resolvePromise(message);
        };
        worker.on('error', onError);
        worker.on('message', onMessage);
        worker.postMessage({
            type: 'start',
            jobId,
            data: {
                sourcePdfPath,
                documentRevision: {
                    version: 1,
                    documentRef: sourcePdfPath,
                    authority: 'electron-working-copy',
                    token: 'ocr-pipeline-revision',
                    contentRevision: 1,
                    mintedAt: 1,
                },
                pages: [
                    1,
                    2,
                    3,
                ].map(pageNumber => ({
                    pageNumber,
                    languages: ['eng'],
                })),
                options: {
                    renderDpi: 150,
                    supersessionPolicy: 'replace-all',
                    replaceAllAcknowledged: true,
                },
            },
        });
    });

    async function cancelActiveJobBeforeTerminate() {
        const jobId = activeJobId;
        if (!jobId) {
            return;
        }
        await new Promise<void>((resolvePromise) => {
            const timeout = setTimeout(resolvePromise, 5_000);
            const onMessage = (message: TOcrWorkerOutboundMessage) => {
                if (message.type !== 'cleanup-complete' || message.jobId !== jobId) {
                    return;
                }
                clearTimeout(timeout);
                worker.off('message', onMessage);
                resolvePromise();
            };
            worker.on('message', onMessage);
            worker.postMessage({
                type: 'cancel',
                jobId,
            });
        });
        activeJobId = null;
    }

    return {
        callLogPath,
        close: async () => {
            await cancelActiveJobBeforeTerminate();
            await worker.terminate();
        },
        logs,
        root,
        sourcePdfPath,
        start,
        worker,
    };
}

export async function readOcrWorkerCallLog(path: string) {
    return readFile(path, 'utf8').then(text => text.trim().split(/\s+/u).filter(Boolean).map(Number)).catch(() => []);
}
