import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdtempSync, readFileSync, statSync, watch, writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {electronFileLogDir} from '@scripts/electron-run/electronRunSessionPaths';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {observeRendererErrors} from '@tests/e2e/electron/helpers/rendererErrorObservation';
import {
    openPdfInApp,
    triggerOpenPathInApp,
    waitForActiveDocumentSource,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';

const CONFORMANCE_WORKER_START_TIMEOUT_MS = 90_000;
const MATERIALIZED_PDF_BYTES = 48 * 1024 * 1024;
const MATERIALIZED_PDF_PAGE_COUNT = 8_000;

function readAppLog(sessionName: string) {
    return readFileSync(resolve(electronFileLogDir(sessionName), 'app.ndjson'), 'utf8');
}

const CONFORMANCE_WORKER = 'pdfConformanceWorker.js';

function readWorkerTaskEvents(log: string) {
    return log.split(/\r?\n/u)
        .filter(Boolean)
        .map(line => JSON.parse(line) as {
            level?: string;
            scope?: string;
            msg?: string;
            data?: {workerName?: string};
        })
        .filter(entry => entry.scope === 'worker-task');
}

function hasWorkerTaskMessage(log: string, message: string) {
    return readWorkerTaskEvents(log)
        .some(entry => entry.msg === message && entry.data?.workerName === CONFORMANCE_WORKER);
}

function readWorkerTaskErrors(sessionName: string) {
    return readWorkerTaskEvents(readAppLog(sessionName))
        .filter(entry => entry.level === 'error');
}

async function createLargeConformancePdf() {
    const evidenceDirectory = mkdtempSync(resolve(tmpdir(), 'evb-e2e-conformance-cancellation-'));
    const unencryptedPath = resolve(evidenceDirectory, 'conformance-cancellation-unencrypted-8000-pages.pdf');
    const filePath = resolve(evidenceDirectory, 'conformance-cancellation-materialized-8000-pages.pdf');
    const pdf = await PDFDocument.create();
    for (let page = 0; page < MATERIALIZED_PDF_PAGE_COUNT; page += 1) {
        pdf.addPage([
            612,
            792,
        ]);
    }
    await pdf.attach(randomBytes(MATERIALIZED_PDF_BYTES), 'conformance-payload.bin', {
        mimeType: 'application/octet-stream',
        description: 'Large payload for PDF conformance close coverage',
        creationDate: new Date('2026-01-01T00:00:00.000Z'),
        modificationDate: new Date('2026-01-01T00:00:00.000Z'),
    });
    writeFileSync(unencryptedPath, await pdf.save());
    const qpdfPath = getPdfNativeToolPaths().qpdf;
    expect(qpdfPath).toBeTruthy();
    execFileSync(qpdfPath!, [
        '--encrypt',
        '',
        'conformance-close-test-owner',
        '256',
        '--',
        unencryptedPath,
        filePath,
    ]);
    return filePath;
}

describe('Electron E2E - PDF Conformance Cancellation', () => {
    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-pdf-conformance-cancellation-${Date.now()}`});

    it('keeps conformance analysis quiet when its working copy is closed', async () => {
        const session = sessionFixture.getSession();
        const stablePdf = resolve('tests/fixtures/electron/generated-text.pdf');
        const largePdf = await createLargeConformancePdf();
        expect(statSync(largePdf).size).toBeGreaterThan(MATERIALIZED_PDF_BYTES);
        expect(statSync(largePdf).size).toBeLessThan(64 * 1024 * 1024);

        const logPath = resolve(electronFileLogDir(session.name), 'app.ndjson');
        const initialLog = readFileSync(logPath, 'utf8');
        const observer = await observeRendererErrors(session.page);
        try {
            await openPdfInApp(session.page, stablePdf);
            await expect.poll(
                () => hasWorkerTaskMessage(readAppLog(session.name).slice(initialLog.length), 'Worker completed'),
                {timeout: CONFORMANCE_WORKER_START_TIMEOUT_MS},
            ).toBe(true);

            const stableLog = readAppLog(session.name).slice(initialLog.length);
            const largeAnalysisStart = initialLog.length + stableLog.length;
            let startWatcher: ReturnType<typeof watch> | null = null;
            const pressCloseOnAnalysisStart = new Promise<void>((resolveStart, rejectStart) => {
                let clickStarted = false;
                const tryClick = () => {
                    if (clickStarted) {
                        return;
                    }
                    const chunk = readAppLog(session.name).slice(largeAnalysisStart);
                    if (!hasWorkerTaskMessage(chunk, 'Worker online')) {
                        return;
                    }
                    clickStarted = true;
                    startWatcher?.close();
                    void session.page.click('.tab-list .tab.is-active .tab-close')
                        .then(() => resolveStart(), rejectStart);
                };
                startWatcher = watch(logPath, {persistent: false}, tryClick);
                tryClick();
                setTimeout(() => {
                    startWatcher?.close();
                    rejectStart(new Error('PDF conformance worker did not start before the close deadline'));
                }, CONFORMANCE_WORKER_START_TIMEOUT_MS).unref();
            });
            await triggerOpenPathInApp(session.page, largePdf, CONFORMANCE_WORKER_START_TIMEOUT_MS);
            await waitForPdfLoaded(session.page, CONFORMANCE_WORKER_START_TIMEOUT_MS);
            await pressCloseOnAnalysisStart;
            await waitForActiveDocumentSource(session.page, stablePdf, 15_000);
            await waitForPdfLoaded(session.page, 15_000);
            await expect.poll(() => {
                const analysisLog = readAppLog(session.name).slice(largeAnalysisStart);
                return hasWorkerTaskMessage(analysisLog, 'Worker reported cancellation')
                    || hasWorkerTaskMessage(analysisLog, 'Worker reported failure');
            }, {timeout: 30_000}).toBe(true);
            const visibleErrors = (await observer.collect()).visibleErrorSurfaces;
            const workerTaskErrors = readWorkerTaskErrors(session.name);
            expect({
                visibleErrors,
                workerTaskErrors,
            }).toEqual({
                visibleErrors: [],
                workerTaskErrors: [],
            });
            const analysisLog = readAppLog(session.name).slice(largeAnalysisStart);
            expect(hasWorkerTaskMessage(analysisLog, 'Worker reported cancellation')).toBe(true);
            expect(hasWorkerTaskMessage(stableLog, 'Worker completed')).toBe(true);
        } finally {
            observer.dispose();
        }
    }, 150_000);
});
