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
import {buildBrowserDjvuCompactPage} from '@app/platform/browser-api/buildBrowserDjvuCompactPage';
import {
    normalizeDjvuPdfSubsample,
    resolveDjvuCompactFidelityPreset,
} from '@contracts/djvuConversionPolicy';
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

async function installBrowserCompactDjvuAcceptance(documentCount = 1) {
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
            // The export below passes no subsample, which selects this preset.
            const page = await buildBrowserDjvuCompactPage(
                worker,
                index + 1,
                pageSize,
                resolveDjvuCompactFidelityPreset(normalizeDjvuPdfSubsample(undefined)),
            );
            pageSpecs.push(page.spec);
        }
        const result = await tryCombineImageInputsWithWasm([], {pageSpecs});
        if (result.status !== 'success') {
            throw new Error(`Compact DjVu encoder control failed: ${result.status}`);
        }
        return result.data;
    }, 'convert');
    Reflect.set(globalThis, 'WebAssembly', undefined);

    document.body.innerHTML = '';
    let finished = 0;
    for (let index = 0; index < documentCount; index += 1) {
        const suffix = index === 0 ? '' : '-other';
        const jobId = requireJobId(`browser-compact-finalization${suffix}`);
        const requestId = requireRequestId(`browser-compact-finalization${suffix}`);
        const documentSource = index === 0 ? sourcePath : await browserDocumentStore.createStoredDocument('other.djvu', fixtureBytes.slice(), {
            mimeType: 'image/vnd.djvu',
            kind: 'source',
            retention: 'transient',
            saveKind: 'generic',
        });
        const documentOutput = index === 0 ? outputPath : await browserDocumentStore.createStoredDocument('other.pdf', new Uint8Array(), {
            mimeType: 'application/pdf',
            kind: 'working',
            retention: 'transient',
            saveKind: 'pdf',
        });
        document.body.insertAdjacentHTML('beforeend', `<button id="compact-export${suffix}">Export compact PDF${suffix}</button><button id="compact-cancel${suffix}">Cancel${suffix}</button><output id="compact-status${suffix}">Ready</output>`);
        const status = document.querySelector(`#compact-status${suffix}`)!;
        document.querySelector(`#compact-cancel${suffix}`)!.addEventListener('click', (event) => {
            if (!event.isTrusted) throw new Error('Compact cancellation requires trusted input');
            void browserDjvuCapability.cancel(jobId);
        });
        document.querySelector(`#compact-export${suffix}`)!.addEventListener('click', (event) => {
            if (!event.isTrusted) throw new Error('Compact export requires trusted input');
            status.textContent = 'Converting';
            const stop = browserDjvuCapability.onConvertComplete((result) => {
                if (result.requestId !== requestId) return;
                stop();
                void (async () => {
                    try {
                        const bytes = await browserDocumentStore.read(documentOutput);
                        const pdf = result.success ? await PDFDocument.load(bytes) : null;
                        Reflect.set(globalThis, `__evbBrowserCompactDjvuAcceptanceResult${suffix}`, {
                            success: result.success,
                            expected: result.expected,
                            error: result.error,
                            terminalStatus: browserDurableDjvuJobs.getState(jobId)?.status,
                            outputBytes: bytes.byteLength,
                            generatedPdfHeader: new TextDecoder().decode(bytes.slice(0, 5)),
                            pageSizes: pdf?.getPages().map(page => page.getSize()),
                            referenceMatches: bytes.byteLength === reference.byteLength
                                && bytes.every((value, offset) => value === reference[offset]),
                        });
                        status.textContent = result.success ? 'Completed' : 'Canceled';
                    } finally {
                        finished += 1;
                        if (finished === documentCount) browserDurableDjvuJobs.clearForTests();
                        await browserDocumentStore.remove(documentOutput);
                        await browserDocumentStore.remove(documentSource);
                    }
                })();
            });
            void browserDjvuCapability.startConvertToPdf(documentSource, documentOutput, {
                jobId,
                requestId,
                pdfStrategy: 'compact-djvu-aware',
                preserveBookmarks: false,
            });
        });
    }
}

Reflect.set(globalThis, '__evbInstallBrowserCompactDjvuAcceptance', installBrowserCompactDjvuAcceptance);

let imageExportHandle: FileSystemFileHandle;
let imageExportPickerOptions: {
    suggestedName?: string;
    excludeAcceptAllOption?: boolean;
    types?: Array<{accept: Record<string, string[]>}>;
};

async function installImageExportDestination(chosenName: string) {
    const directory = await navigator.storage.getDirectory();
    imageExportHandle = await directory.getFileHandle(chosenName, {create: true});
    const writable = await imageExportHandle.createWritable();
    await writable.write(new Uint8Array());
    await writable.close();
    Reflect.set(window, 'showSaveFilePicker', async (options: typeof imageExportPickerOptions) => {
        imageExportPickerOptions = options;
        return imageExportHandle;
    });
}

async function readImageExportDestination() {
    const file = await imageExportHandle.getFile();
    return {
        savedName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        pickerOptions: imageExportPickerOptions,
    };
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

async function stagePdfFixture(pageCount = 1) {
    const document = await PDFDocument.create();
    for (let page = 0; page < pageCount; page += 1) {
        document.addPage([
            72,
            144,
        ]);
    }
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

async function stageLetterPdfFixture(pageCount: number) {
    const document = await PDFDocument.create();
    for (let page = 0; page < pageCount; page += 1) {
        document.addPage([
            612,
            792,
        ]);
    }
    return browserDocumentStore.createStoredDocument(
        'browser-letter-image-export.pdf',
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
    await installImageExportDestination(chosenName);
    const result = await createBrowserImageExportCapability().exportPdfToImages(
        sourcePath,
        [requirePageNumber(1)],
        requireRequestId(`browser-${sourceKind}-image-export-${chosenName}`),
        sourceKind,
    );
    const {
        bytes, savedName, pickerOptions,
    } = await readImageExportDestination();
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
        savedName,
        pickerOptions,
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

// Exports pages 1 and 2 as one TIFF under the chosen name and reads back the saved bytes and stored name.
async function exportMultiPageTiffAs(sourcePath: TDocumentRef, sourceKind: 'djvu' | 'pdf', chosenName: string) {
    await installImageExportDestination(chosenName);
    let result;
    try {
        result = await createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            sourcePath,
            [
                requirePageNumber(1),
                requirePageNumber(2),
            ],
            requireRequestId(`browser-${sourceKind}-multi-page-tiff-export`),
            sourceKind,
        );
    } catch (error) {
        const {
            bytes, savedName, pickerOptions,
        } = await readImageExportDestination();
        return {
            refused: true,
            error: error instanceof Error ? error.message : String(error),
            bytesBase64: encodeBase64(bytes),
            savedName,
            pickerOptions,
        };
    }
    const {
        bytes, savedName, pickerOptions,
    } = await readImageExportDestination();
    if (!result.success || bytes.byteLength === 0) {
        throw new Error(`Browser ${sourceKind} multi-page TIFF export did not write ${chosenName}`);
    }
    return {
        bytesBase64: encodeBase64(bytes),
        savedName,
        pickerOptions,
        storedName: getBrowserDocumentFileName(result.outputPaths?.[0] ?? ''),
    };
}

async function runBrowserDjvuMultiPageTiffExportAcceptance(chosenName: string) {
    // Pages 1 and 2 of this fixture are 72 and 300 DPI; the TIFF keeps each one.
    const sourcePath = await stageDjvuFixture('/fixtures/mixed-dpi.djvu');
    try {
        return await exportMultiPageTiffAs(sourcePath, 'djvu', chosenName);
    } finally {
        await browserDocumentStore.remove(sourcePath);
    }
}

Reflect.set(globalThis, '__evbRunBrowserDjvuMultiPageTiffExportAcceptance', runBrowserDjvuMultiPageTiffExportAcceptance);

async function runBrowserPdfMultiPageTiffExportAcceptance(chosenName: string) {
    const sourcePath = await stagePdfFixture(2);
    try {
        return await exportMultiPageTiffAs(sourcePath, 'pdf', chosenName);
    } finally {
        await browserDocumentStore.remove(sourcePath);
    }
}

Reflect.set(globalThis, '__evbRunBrowserPdfMultiPageTiffExportAcceptance', runBrowserPdfMultiPageTiffExportAcceptance);

// Counts the frames of a big-endian classic TIFF by walking its IFD chain.
function summarizeTiff(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frames: Array<{
        width: number;
        height: number
    }> = [];
    for (let offset = view.getUint32(4); offset !== 0; offset = view.getUint32(offset + 2 + view.getUint16(offset) * 12)) {
        const frame = {
            width: 0,
            height: 0,
        };
        for (let entry = 0; entry < view.getUint16(offset); entry += 1) {
            const at = offset + 2 + entry * 12;
            const tag = view.getUint16(at);
            const value = view.getUint16(at + 2) === 3 ? view.getUint16(at + 8) : view.getUint32(at + 8);
            if (tag === 256) frame.width = value;
            if (tag === 257) frame.height = value;
        }
        frames.push(frame);
    }
    return {
        byteLength: bytes.byteLength,
        frames,
    };
}

// Exports pages 1..pageCount as one TIFF whose decoded pages exceed 64 MiB:
// DjVu through a chosen file handle, PDF as a download without one.
async function runBrowserLargeMultiPageTiffExportAcceptance(sourceKind: 'djvu' | 'pdf', pageCount: number) {
    const sourcePath = sourceKind === 'djvu'
        ? await stageDjvuFixture('/fixtures/browser-boundary-501-pages.djvu')
        : await stageLetterPdfFixture(pageCount);
    if (sourceKind === 'djvu') await installImageExportDestination('large.tiff');
    else Reflect.set(window, 'showSaveFilePicker', undefined);
    try {
        const result = await createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            sourcePath,
            Array.from({length: pageCount}, (_, index) => requirePageNumber(index + 1)),
            requireRequestId(`browser-large-${sourceKind}-multi-page-tiff-export`),
            sourceKind,
        );
        return {
            success: result.success,
            saved: sourceKind === 'djvu' ? summarizeTiff((await readImageExportDestination()).bytes) : null,
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        await browserDocumentStore.remove(sourcePath);
    }
}

Reflect.set(globalThis, '__evbRunBrowserLargeMultiPageTiffExportAcceptance', runBrowserLargeMultiPageTiffExportAcceptance);

// Exports pages 1..pageCount as images. With a folder picker the folder is an
// OPFS directory holding one earlier export; without one the pages download.
async function runBrowserBatchImageExportAcceptance(sourceKind: 'djvu' | 'pdf', pageCount: number, withDirectoryPicker: boolean) {
    const sourcePath = sourceKind === 'djvu'
        ? await stageDjvuFixture('/fixtures/browser-boundary-501-pages.djvu')
        : await stagePdfFixture(pageCount);
    const prompts = {
        directory: 0,
        save: 0,
    };
    Reflect.set(window, 'showSaveFilePicker', async () => {
        prompts.save += 1;
        throw new DOMException('Batch export must not ask for a file', 'AbortError');
    });
    let directory: FileSystemDirectoryHandle | null = null;
    if (withDirectoryPicker) {
        const root = await navigator.storage.getDirectory();
        const folderName = `batch-${sourceKind}-${Date.now()}`;
        directory = await root.getDirectoryHandle(folderName, {create: true});
        const earlier = await (await directory.getFileHandle('document-pages-001.jpg', {create: true})).createWritable();
        await earlier.write(new TextEncoder().encode('earlier export'));
        await earlier.close();
        Reflect.set(window, 'showDirectoryPicker', async (options: {mode?: string}) => {
            prompts.directory += 1;
            if (options.mode !== 'readwrite') throw new Error('Batch export must ask for a writable folder');
            return directory;
        });
    } else {
        Reflect.set(window, 'showSaveFilePicker', undefined);
        Reflect.set(window, 'showDirectoryPicker', undefined);
    }
    try {
        const result = await createBrowserImageExportCapability().exportPdfToImages(
            sourcePath,
            Array.from({length: pageCount}, (_, index) => requirePageNumber(index + 1)),
            requireRequestId(`browser-batch-${sourceKind}-image-export`),
            sourceKind,
        );
        const files: Array<{
            name: string;
            head: number[];
            text: string | null
        }> = [];
        if (directory) {
            // The DOM library here does not declare directory iteration.
            const listEntries = Reflect.get(directory, 'entries') as () => AsyncIterable<[string, FileSystemHandle]>;
            for await (const [
                name,
                entry,
            ] of listEntries.call(directory)) {
                if (entry.kind !== 'file') continue;
                const bytes = new Uint8Array(await (await (entry as FileSystemFileHandle).getFile()).arrayBuffer());
                files.push({
                    name,
                    head: Array.from(bytes.slice(0, 3)),
                    text: name === 'document-pages-001.jpg' ? new TextDecoder().decode(bytes) : null,
                });
            }
            files.sort((left, right) => left.name.localeCompare(right.name));
        }
        return {
            success: result.success,
            outputCount: result.outputPaths?.length ?? null,
            prompts,
            files,
        };
    } finally {
        Reflect.deleteProperty(window, 'showDirectoryPicker');
        await browserDocumentStore.remove(sourcePath);
    }
}

Reflect.set(globalThis, '__evbRunBrowserBatchImageExportAcceptance', runBrowserBatchImageExportAcceptance);
