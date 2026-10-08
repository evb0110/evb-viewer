// fallow-ignore-file unused-file -- bundled by browserDjvuFinalizationAcceptance.test.ts for Chromium.

import {PDFDocument} from 'pdf-lib';
import {browserDjvuCapability} from '@app/platform/browser-api/browserDjvuCapability';
import {browserDurableDjvuJobs} from '@app/platform/browser-api/browserDurableDjvuJobs';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import type {
    IDjvuConvertResult,
    IDjvuOpenResult,
} from '@contracts/electronApiDjvu';
import {
    requireJobId,
    requireRequestId,
} from '@contracts/shared';
import {withBrowserDjvuWorker} from '@app/platform/browser-api/browserDjvuConversionPipeline';
import {getDjvuWorkerPageSizes} from '@app/platform/browser-api/createDjvuWorkerFromPath';
import {
    DJVU_COMPACT_PHOTO_PPI_CAP,
    renderDjvuPageAsPpm,
} from '@app/platform/browser-api/browserDjvuRasterizer';
import type {IBrowserPdfCombineWasmPageSpec} from '@app/platform/browser-api/browserPdfCombineWorker.types';
import {tryCombineImageInputsWithWasm} from '@app/platform/browser-api/tryCombineImageInputsWithWasm';

async function runBrowserDjvuFinalizationAcceptance() {
    const fixtureResponse = await fetch('/fixtures/bitonal-faint-pencil.djvu');
    if (!fixtureResponse.ok) {
        throw new Error(`Failed to load browser DjVu fixture: ${fixtureResponse.status}`);
    }
    const fixtureBytes = new Uint8Array(await fixtureResponse.arrayBuffer());
    const sourcePath = await browserDocumentStore.createStoredDocument(
        'browser-djvu-finalization.djvu',
        fixtureBytes,
        {
            mimeType: 'image/vnd.djvu',
            kind: 'source',
            retention: 'transient',
            saveKind: 'generic',
        },
    );
    const outputPath = await browserDocumentStore.createStoredDocument(
        'browser-djvu-finalization.pdf',
        new Uint8Array(),
        {
            mimeType: 'application/pdf',
            kind: 'working',
            retention: 'transient',
            saveKind: 'pdf',
        },
    );

    let stopOpenCompletion = () => {};
    try {
        const openRequestId = requireRequestId('browser-djvu-open-finalization');
        const openCompletion = new Promise<IDjvuOpenResult>((resolve) => {
            stopOpenCompletion = browserDjvuCapability.onOpenComplete((result) => {
                if (result.requestId === openRequestId) {
                    resolve(result);
                }
            });
        });
        const openHandle = await browserDjvuCapability.startOpenForViewing(
            sourcePath,
            openRequestId,
        );
        const openResult = await openCompletion;
        const openTerminalState = browserDurableDjvuJobs.getState(openHandle.jobId);
        if (!openResult.success) {
            throw new Error(`Browser DjVu open did not succeed: ${openResult.error ?? 'unknown error'}`);
        }
        const requestId = requireRequestId('browser-djvu-finalization');
        const completion = new Promise<IDjvuConvertResult>((resolve) => {
            const stop = browserDjvuCapability.onConvertComplete((result) => {
                if (result.requestId === requestId) {
                    stop();
                    resolve(result);
                }
            });
        });
        const handle = await browserDjvuCapability.startConvertToPdf(
            sourcePath,
            outputPath,
            {
                pdfStrategy: 'direct',
                preserveBookmarks: false,
                requestId,
                subsample: 4,
            },
        );
        const result = await completion;
        const terminalState = browserDurableDjvuJobs.getState(handle.jobId);
        const generatedPdfPath = result.pdfPath;
        if (!result.success || !generatedPdfPath) {
            throw new Error(`Browser DjVu conversion did not produce a PDF: ${result.error ?? 'unknown error'}`);
        }
        const generatedPdfBytes = await browserDocumentStore.read(generatedPdfPath);
        const reopenedPdf = await PDFDocument.load(generatedPdfBytes);
        return {
            sourceByteLength: fixtureBytes.byteLength,
            openSuccess: openResult.success,
            openPageCount: openResult.pageCount,
            openTerminalStatus: openTerminalState?.status ?? null,
            resultSuccess: result.success,
            terminalStatus: terminalState?.status ?? null,
            generatedPdfHeader: new TextDecoder().decode(generatedPdfBytes.slice(0, 5)),
            reopenedPageCount: reopenedPdf.getPageCount(),
        };
    } finally {
        stopOpenCompletion();
        browserDurableDjvuJobs.clearForTests();
        await browserDjvuCapability.releaseViewingPath(sourcePath).catch(() => undefined);
        await browserDocumentStore.remove(outputPath).catch(() => undefined);
        await browserDocumentStore.remove(sourcePath).catch(() => undefined);
    }
}

Reflect.set(globalThis, '__evbRunBrowserDjvuFinalizationAcceptance', runBrowserDjvuFinalizationAcceptance);

async function installBrowserCompactDjvuAcceptance() {
    const fixtureBytes = new Uint8Array(await (await fetch('/fixtures/bitonal-faint-pencil.djvu')).arrayBuffer());
    const sourcePath = await browserDocumentStore.createStoredDocument('compact.djvu', fixtureBytes, {
        mimeType: 'image/vnd.djvu',
        kind: 'source',
        retention: 'transient',
        saveKind: 'generic',
    });
    const outputPath = await browserDocumentStore.createStoredDocument('compact.pdf', new Uint8Array(), {
        mimeType: 'application/pdf',
        kind: 'working',
        retention: 'transient',
        saveKind: 'pdf',
    });
    // A trusted export must produce exactly the old encoder's bytes even when
    // the UI cannot run WASM. This small control is setup, never a fallback.
    const reference = await withBrowserDjvuWorker(sourcePath, async (worker) => {
        const pageSizes = await getDjvuWorkerPageSizes(worker);
        const pageSpecs: IBrowserPdfCombineWasmPageSpec[] = [];
        for (const [
            index,
            pageSize,
        ] of pageSizes.entries()) {
            const rendered = await renderDjvuPageAsPpm(worker, index + 1, pageSize);
            pageSpecs.push({
                kind: 'image',
                pageSize: rendered.pageSize,
                jpegQuality: 85,
                ppiCap: DJVU_COMPACT_PHOTO_PPI_CAP,
                image: rendered.input,
            });
        }
        const result = await tryCombineImageInputsWithWasm([], {pageSpecs});
        if (result.status !== 'success') {
            throw new Error(`Compact DjVu encoder control failed: ${result.status}`);
        }
        return result.data;
    }, 'convert');
    Reflect.set(globalThis, 'WebAssembly', undefined);

    const jobId = requireJobId('browser-compact-finalization');
    const requestId = requireRequestId('browser-compact-finalization');
    document.body.innerHTML = '<button id="compact-export">Export compact PDF</button><button id="compact-cancel">Cancel</button><output id="compact-status">Ready</output>';
    const status = document.querySelector('#compact-status')!;
    document.querySelector('#compact-cancel')!.addEventListener('click', (event) => {
        if (!event.isTrusted) {
            throw new Error('Compact cancellation requires trusted input');
        }
        void browserDjvuCapability.cancel(jobId);
    });
    document.querySelector('#compact-export')!.addEventListener('click', (event) => {
        if (!event.isTrusted) {
            throw new Error('Compact export requires trusted input');
        }
        status.textContent = 'Converting';
        const stop = browserDjvuCapability.onConvertComplete((result) => {
            if (result.requestId !== requestId) {
                return;
            }
            stop();
            void (async () => {
                try {
                    const bytes = await browserDocumentStore.read(outputPath);
                    const pdf = result.success ? await PDFDocument.load(bytes) : null;
                    Reflect.set(globalThis, '__evbBrowserCompactDjvuAcceptanceResult', {
                        success: result.success,
                        expected: result.expected,
                        error: result.error,
                        terminalStatus: browserDurableDjvuJobs.getState(jobId)?.status,
                        outputBytes: bytes.byteLength,
                        generatedPdfHeader: new TextDecoder().decode(bytes.slice(0, 5)),
                        pageSizes: pdf?.getPages().map(page => page.getSize()),
                        referenceMatches: bytes.byteLength === reference.byteLength
                            && bytes.every((value, index) => value === reference[index]),
                    });
                    status.textContent = result.success ? 'Completed' : 'Canceled';
                } finally {
                    browserDurableDjvuJobs.clearForTests();
                    await browserDocumentStore.remove(outputPath);
                    await browserDocumentStore.remove(sourcePath);
                }
            })();
        });
        void browserDjvuCapability.startConvertToPdf(sourcePath, outputPath, {
            jobId,
            requestId,
            pdfStrategy: 'compact-djvu-aware',
            preserveBookmarks: false,
        });
    });
}

Reflect.set(globalThis, '__evbInstallBrowserCompactDjvuAcceptance', installBrowserCompactDjvuAcceptance);
