import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {
    existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {
    basename, resolve,
} from 'node:path';
import {decodeWorkspaceCheckpoint} from '@contracts/workspaceCheckpoint';
import {readWorkspaceRecoveryRecords} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {PDFDocument} from 'pdf-lib';
import {electronFileLogDir} from '@scripts/electron-run/electronRunSessionPaths';
import {runDesktopQpdfWasm} from '@electron/native-tools/qpdfWasmWorkerClient';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {observeRendererErrors} from '@tests/e2e/electron/helpers/rendererErrorObservation';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
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

function readConformanceEvents(log: string) {
    return log.split(/\r?\n/u)
        .filter(Boolean)
        .map(line => JSON.parse(line) as {
            level?: string;
            scope?: string;
            msg?: string;
        })
        .filter(entry => entry.scope === 'documents-pdfConformance' || entry.scope === 'worker-task');
}

function hasConformanceMessage(log: string, message: string) {
    return readConformanceEvents(log)
        .some(entry => entry.scope === 'documents-pdfConformance' && entry.msg === message);
}

function readConformanceErrors(sessionName: string) {
    return readConformanceEvents(readAppLog(sessionName))
        .filter(entry => entry.level === 'error');
}

async function createLargeConformancePdf() {
    const evidenceDirectory = mkdtempSync(resolve(tmpdir(), 'evb-e2e-conformance-cancellation-'));
    onTestFinished(() => rmSync(evidenceDirectory, {
        recursive: true,
        force: true,
    }));
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
    await runDesktopQpdfWasm([
        '--encrypt',
        '',
        'conformance-close-test-owner',
        '256',
        '--',
        unencryptedPath,
        filePath,
    ], {commandLabel: 'qpdf(e2e-conformance-encrypt)'});
    return filePath;
}

// A controlled conformance child stays alive until close cancels it. Fixture size alone
// cannot guarantee that conformance is still running when trusted input lands.
function createConformanceCancellationGate() {
    const directory = mkdtempSync(resolve(tmpdir(), 'evb-e2e-conformance-gate-'));
    const hook = resolve(directory, 'hold-conformance.cjs');
    const armed = resolve(directory, 'armed');
    const ready = resolve(directory, 'ready');
    writeFileSync(hook, `const fs=require('node:fs'),wt=require('node:worker_threads'),origPost=wt.Worker.prototype.postMessage;
wt.Worker.prototype.postMessage=function(value,transferList){
 if(value&&typeof value==='object'&&Array.isArray(value.args)&&value.args[0]==='pdf-conformance'&&fs.existsSync(${JSON.stringify(armed)})){
  fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));
  return;
 }
 return origPost.call(this,value,transferList);
};
require('node:module').syncBuiltinESMExports();
`);
    onTestFinished(() => rmSync(directory, {
        recursive: true,
        force: true,
    }));
    return {
        hook,
        armed,
        ready,
    };
}

// Readers ignore bytes after the last %%EOF, so such a file opens normally.
// The Windows report that led here had them, and its conformance read failed.
function createPdfWithBytesAfterEof() {
    const evidenceDirectory = mkdtempSync(resolve(tmpdir(), 'evb-e2e-conformance-trailing-bytes-'));
    onTestFinished(() => rmSync(evidenceDirectory, {
        recursive: true,
        force: true,
    }));
    const filePath = resolve(evidenceDirectory, 'bytes-after-eof.pdf');
    writeFileSync(filePath, Buffer.concat([
        readFileSync(resolve('tests/fixtures/electron/generated-text.pdf')),
        Buffer.from('\0\0<html>download trailer</html>\n', 'latin1'),
    ]));
    return filePath;
}

describe('Electron E2E - PDF Conformance', () => {
    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-pdf-conformance-${Date.now()}`});

    it('keeps conformance analysis quiet when its working copy is closed', async () => {
        const gate = createConformanceCancellationGate();
        const session = await sessionFixture.restart({
            hard: true,
            extraEnv: {NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(gate.hook)}`},
        });
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
                () => hasConformanceMessage(readAppLog(session.name).slice(initialLog.length), 'PDF conformance analysis completed'),
                {timeout: CONFORMANCE_WORKER_START_TIMEOUT_MS},
            ).toBe(true);

            const stableLog = readAppLog(session.name).slice(initialLog.length);
            const largeAnalysisStart = initialLog.length + stableLog.length;
            writeFileSync(gate.armed, '');
            await triggerOpenPathInApp(session.page, largePdf, CONFORMANCE_WORKER_START_TIMEOUT_MS);
            await waitForPdfLoaded(session.page, CONFORMANCE_WORKER_START_TIMEOUT_MS);
            await expect.poll(() => existsSync(gate.ready), {timeout: CONFORMANCE_WORKER_START_TIMEOUT_MS}).toBe(true);
            // Close must stop the reader even while the durable checkpoint still owns its bytes.
            await expect.poll(() => readWorkspaceRecoveryRecords(session.name)
                .some(record => decodeWorkspaceCheckpoint(record.checkpoint)?.tabs.some(tab => (
                    tab.fileName === basename(largePdf) && tab.workingCopyRef !== null
                ))), {timeout: CONFORMANCE_WORKER_START_TIMEOUT_MS}).toBe(true);
            await clickAsUser(session.page, '.tab-list .tab.is-active .tab-close');
            await waitForActiveDocumentSource(session.page, stablePdf, 15_000);
            await waitForPdfLoaded(session.page, 15_000);
            await expect.poll(() => {
                const analysisLog = readAppLog(session.name).slice(largeAnalysisStart);
                return hasConformanceMessage(analysisLog, 'PDF conformance analysis canceled')
                    || readConformanceEvents(analysisLog).some(entry => entry.scope === 'documents-pdfConformance' && entry.level === 'warn');
            }, {timeout: 30_000}).toBe(true);
            const visibleErrors = (await observer.collect()).visibleErrorSurfaces;
            const conformanceErrors = readConformanceErrors(session.name);
            expect({
                visibleErrors,
                conformanceErrors,
            }).toEqual({
                visibleErrors: [],
                conformanceErrors: [],
            });
            const analysisLog = readAppLog(session.name).slice(largeAnalysisStart);
            expect(hasConformanceMessage(analysisLog, 'PDF conformance analysis canceled')).toBe(true);
            expect(hasConformanceMessage(stableLog, 'PDF conformance analysis completed')).toBe(true);
        } finally {
            observer.dispose();
            await sessionFixture.restart({
                hard: true,
                extraEnv: {NODE_OPTIONS: process.env.NODE_OPTIONS ?? ''},
            });
        }
    }, 150_000);

    it('reads conformance without an error report when a PDF has bytes after its EOF marker', async () => {
        const session = sessionFixture.getSession();
        const pdf = createPdfWithBytesAfterEof();
        const initialLog = readAppLog(session.name);
        const observer = await observeRendererErrors(session.page);
        try {
            await openPdfInApp(session.page, pdf);
            const readAnalysisLog = () => readAppLog(session.name).slice(initialLog.length);
            await expect.poll(
                () => hasConformanceMessage(readAnalysisLog(), 'PDF conformance analysis completed')
                    || readConformanceEvents(readAnalysisLog()).some(entry => entry.scope === 'documents-pdfConformance' && entry.level === 'warn'),
                {timeout: CONFORMANCE_WORKER_START_TIMEOUT_MS},
            ).toBe(true);
            const visibleErrors = (await observer.collect()).visibleErrorSurfaces;
            const conformanceErrors = readConformanceEvents(readAnalysisLog())
                .filter(entry => entry.level === 'error');
            expect({
                visibleErrors,
                conformanceErrors,
            }).toEqual({
                visibleErrors: [],
                conformanceErrors: [],
            });
            expect(hasConformanceMessage(readAnalysisLog(), 'PDF conformance analysis completed')).toBe(true);
        } finally {
            observer.dispose();
        }
    }, 150_000);
});
