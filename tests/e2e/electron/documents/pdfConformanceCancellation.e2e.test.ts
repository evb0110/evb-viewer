import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdirSync, readFileSync, statSync, watch, writeFileSync,
} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {electronFileLogDir} from '@scripts/electron-run/electronRunSessionPaths';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {observeRendererErrors} from '@tests/e2e/electron/helpers/rendererErrorObservation';
import {
    openPdfInApp,
    triggerOpenPathInApp,
    waitForActiveDocumentSource,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';

const CONFORMANCE_WORKER = 'pdfConformanceWorker.js';
const CONFORMANCE_WORKER_START_TIMEOUT_MS = 90_000;

function readAppLog(sessionName: string) {
    return readFileSync(resolve(electronFileLogDir(sessionName), 'app.ndjson'), 'utf8');
}

async function createLargeConformancePdf() {
    const evidenceDirectory = resolve('.devkit/project12/879');
    mkdirSync(evidenceDirectory, {recursive: true});
    const filePath = resolve(evidenceDirectory, 'conformance-cancellation-158-pages.pdf');
    const pdf = await PDFDocument.create();
    for (let page = 0; page < 158; page += 1) {
        pdf.addPage([
            612,
            792,
        ]);
    }
    await pdf.attach(randomBytes(96 * 1024 * 1024), 'conformance-payload.bin', {
        mimeType: 'application/octet-stream',
        description: 'Large payload for PDF conformance close coverage',
        creationDate: new Date('2026-01-01T00:00:00.000Z'),
        modificationDate: new Date('2026-01-01T00:00:00.000Z'),
    });
    writeFileSync(filePath, await pdf.save());
    return filePath;
}

describe('Electron E2E - PDF Conformance Cancellation', () => {
    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-pdf-conformance-cancellation-${Date.now()}`});

    it('keeps conformance analysis quiet when its working copy is closed', async () => {
        const session = sessionFixture.getSession();
        const stablePdf = resolve('tests/fixtures/electron/generated-text.pdf');
        const largePdf = await createLargeConformancePdf();
        expect(statSync(largePdf).size).toBeGreaterThan(64 * 1024 * 1024);

        const logPath = resolve(electronFileLogDir(session.name), 'app.ndjson');
        const initialLog = readFileSync(logPath, 'utf8');
        const observer = await observeRendererErrors(session.page);
        try {
            await openPdfInApp(session.page, stablePdf);
            await expect.poll(() => readAppLog(session.name).slice(initialLog.length), {timeout: CONFORMANCE_WORKER_START_TIMEOUT_MS}).toMatch(new RegExp(`"msg":"Worker completed".*${CONFORMANCE_WORKER}|${CONFORMANCE_WORKER}.*"msg":"Worker completed"`, 'u'));

            const stableLog = readAppLog(session.name).slice(initialLog.length);
            const largeAnalysisStart = initialLog.length + stableLog.length;
            await triggerOpenPathInApp(session.page, largePdf, CONFORMANCE_WORKER_START_TIMEOUT_MS);
            await waitForActiveDocumentSource(session.page, largePdf, CONFORMANCE_WORKER_START_TIMEOUT_MS);
            const closeButton = await session.page.$('.tab-list .tab.is-active .tab-close');
            const closeBounds = await closeButton?.boundingBox();
            expect(closeBounds).not.toBeNull();
            const cdp = await session.page.createCDPSession();
            let startWatcher: ReturnType<typeof watch> | null = null;
            const pressCloseOnAnalysisStart = new Promise<void>((resolveStart, rejectStart) => {
                let clickStarted = false;
                const tryClick = () => {
                    if (clickStarted) {
                        return;
                    }
                    const chunk = readAppLog(session.name).slice(largeAnalysisStart);
                    if (!chunk.includes('"msg":"Worker online"') || !chunk.includes(CONFORMANCE_WORKER)) {
                        return;
                    }
                    clickStarted = true;
                    startWatcher?.close();
                    if (/"msg":"Worker (completed|reported failure|reported cancellation)"/u.test(chunk)) {
                        rejectStart(new Error('PDF conformance finished before the tab could be closed'));
                        return;
                    }
                    void cdp.send('Input.dispatchMouseEvent', {
                        type: 'mousePressed',
                        x: closeBounds!.x + (closeBounds!.width / 2),
                        y: closeBounds!.y + (closeBounds!.height / 2),
                        button: 'left',
                        clickCount: 1,
                    }).then(() => cdp.send('Input.dispatchMouseEvent', {
                        type: 'mouseReleased',
                        x: closeBounds!.x + (closeBounds!.width / 2),
                        y: closeBounds!.y + (closeBounds!.height / 2),
                        button: 'left',
                        clickCount: 1,
                    })).then(() => resolveStart(), rejectStart);
                };
                startWatcher = watch(logPath, {persistent: false}, tryClick);
                tryClick();
                setTimeout(() => {
                    startWatcher?.close();
                    rejectStart(new Error('PDF conformance worker did not start before the close deadline'));
                }, CONFORMANCE_WORKER_START_TIMEOUT_MS).unref();
            });
            await pressCloseOnAnalysisStart;
            await waitForActiveDocumentSource(session.page, stablePdf, 15_000);
            await waitForPdfLoaded(session.page, 15_000);

            await expect.poll(() => readAppLog(session.name).slice(largeAnalysisStart), {timeout: 30_000}).toMatch(/"msg":"Worker (completed|reported failure|reported cancellation)"/u);
            const remainingLog = readAppLog(session.name).slice(initialLog.length);
            const newConformanceLog = remainingLog.slice(stableLog.length);
            writeFileSync(resolve('.devkit/project12/879/repro-current.ndjson'), remainingLog);
            expect(newConformanceLog).toMatch(/"msg":"Worker reported cancellation"/u);
            expect(newConformanceLog).not.toContain('Worker reported failure');
            expect(newConformanceLog).not.toContain('PdfConformanceCapabilityError');
            expect((await observer.collect()).visibleErrorSurfaces).toEqual([]);
            expect(remainingLog).toContain('"msg":"Worker completed"');
        } finally {
            observer.dispose();
        }
    }, 150_000);
});
