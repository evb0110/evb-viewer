// fallow-ignore-file unused-file -- bundled by browserDjvuFinalizationAcceptance.test.ts for Chromium.

import {PDFDocument} from 'pdf-lib';
import type {TDocumentRef} from '@contracts/documentRef';
import {browserDjvuCapability} from '@app/platform/browser-api/browserDjvuCapability';
import {browserDurableDjvuJobs} from '@app/platform/browser-api/browserDurableDjvuJobs';
import {
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browserDocumentStore';
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
import {createBrowserImageExportCapability} from '@app/platform/browser-api/createBrowserImageExportCapability';
import {requirePageNumber} from '@contracts/pageNumbers';

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

let capturedImageExportChunks: Uint8Array[] = [];

// The methods sit on the prototype: the stored output keeps this handle, and
// IndexedDB cannot clone function-valued properties.
class ImageExportSaveHandle {
    readonly kind = 'file';

    readonly name: string;

    constructor(name: string) {
        this.name = name;
    }

    async queryPermission() {
        return 'granted';
    }

    async requestPermission() {
        return 'granted';
    }

    async createWritable() {
        return {
            write: async (data: BodyInit) => {
                capturedImageExportChunks.push(new Uint8Array(await new Response(data).arrayBuffer()));
            },
            close: async () => {},
            abort: async () => {},
        };
    }
}

// A multi-page TIFF arrives in several writes; the capture keeps them in order.
function takeCapturedImageExportBytes() {
    const chunks = capturedImageExportChunks;
    capturedImageExportChunks = [];
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

// Chunked so a multi-megabyte TIFF stays under the argument limit of fromCharCode.
function encodeBase64(bytes: Uint8Array) {
    let binary = '';
    for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

async function stageDjvuFixture(fixturePath: string) {
    const fixtureResponse = await fetch(fixturePath);
    if (!fixtureResponse.ok) {
        throw new Error(`Failed to load browser DjVu fixture: ${fixtureResponse.status}`);
    }
    return browserDocumentStore.createStoredDocument(
        'browser-djvu-image-export.djvu',
        new Uint8Array(await fixtureResponse.arrayBuffer()),
        {
            mimeType: 'image/vnd.djvu',
            kind: 'source',
            retention: 'transient',
            saveKind: 'generic',
        },
    );
}

async function stagePdfFixture() {
    const document = await PDFDocument.create();
    document.addPage([
        240,
        240,
    ]);
    return browserDocumentStore.createStoredDocument(
        'browser-pdf-image-export.pdf',
        await document.save(),
        {
            mimeType: 'application/pdf',
            kind: 'source',
            retention: 'transient',
            saveKind: 'generic',
        },
    );
}

// Exports page 1 under the chosen name and reads back the saved bytes and stored name.
async function exportFirstPageAs(sourcePath: TDocumentRef, sourceKind: 'djvu' | 'pdf', chosenName: string) {
    capturedImageExportChunks = [];
    Reflect.set(window, 'showSaveFilePicker', async () => new ImageExportSaveHandle(chosenName));
    const result = await createBrowserImageExportCapability().exportPdfToImages(
        sourcePath,
        [requirePageNumber(1)],
        requireRequestId(`browser-${sourceKind}-image-export-${chosenName}`),
        sourceKind,
    );
    const bytes = takeCapturedImageExportBytes();
    if (!result.success || bytes.byteLength === 0) {
        throw new Error(`Browser ${sourceKind} image export did not write ${chosenName}`);
    }
    const decodable = await createImageBitmap(new Blob([bytes]))
        .then((bitmap) => {
            bitmap.close();
            return true;
        }, () => false);
    return {
        head: Array.from(bytes.slice(0, 4)),
        decodable,
        storedName: getBrowserDocumentFileName(result.outputPaths?.[0] ?? ''),
        bytesBase64: encodeBase64(bytes),
    };
}

async function runBrowserDjvuImageExportAcceptance(chosenName: string) {
    const sourcePath = await stageDjvuFixture('/fixtures/bitonal-faint-pencil.djvu');
    try {
        return await exportFirstPageAs(sourcePath, 'djvu', chosenName);
    } finally {
        await browserDocumentStore.remove(sourcePath);
    }
}

Reflect.set(globalThis, '__evbRunBrowserDjvuImageExportAcceptance', runBrowserDjvuImageExportAcceptance);

async function runBrowserPdfImageExportAcceptance(chosenName: string) {
    const sourcePath = await stagePdfFixture();
    try {
        return await exportFirstPageAs(sourcePath, 'pdf', chosenName);
    } finally {
        await browserDocumentStore.remove(sourcePath);
    }
}

Reflect.set(globalThis, '__evbRunBrowserPdfImageExportAcceptance', runBrowserPdfImageExportAcceptance);

async function runBrowserDjvuMultiPageTiffExportAcceptance() {
    // Pages 1 and 2 of this fixture are 72 and 300 DPI; the TIFF keeps each one.
    const sourcePath = await stageDjvuFixture('/fixtures/mixed-dpi.djvu');
    capturedImageExportChunks = [];
    Reflect.set(window, 'showSaveFilePicker', async () => new ImageExportSaveHandle('document.tiff'));
    try {
        const result = await createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            sourcePath,
            [
                requirePageNumber(1),
                requirePageNumber(2),
            ],
            requireRequestId('browser-djvu-multi-page-tiff-export'),
            'djvu',
        );
        const bytes = takeCapturedImageExportBytes();
        if (!result.success || bytes.byteLength === 0) {
            throw new Error('Browser DjVu multi-page TIFF export did not write');
        }
        return {bytesBase64: encodeBase64(bytes)};
    } finally {
        await browserDocumentStore.remove(sourcePath);
    }
}

Reflect.set(globalThis, '__evbRunBrowserDjvuMultiPageTiffExportAcceptance', runBrowserDjvuMultiPageTiffExportAcceptance);
