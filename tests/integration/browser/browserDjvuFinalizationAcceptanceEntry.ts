// fallow-ignore-file unused-file -- bundled by browserDjvuFinalizationAcceptance.test.ts for Chromium.

import {
    PDFDocument, rgb,
} from 'pdf-lib';
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
import type {IBrowserPdfCombineWasmPageSpec} from '@contracts/browserPdfCombineWorker';
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
        const added = document.addPage([
            72,
            144,
        ]);
        added.drawRectangle({
            x: 0,
            y: 0,
            width: 72,
            height: 144,
            color: rgb((page + 1) / 10, 0.2, 0.3),
        });
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

// Multi-page TIFFs use one selected folder; an explicit one-page selection
// keeps the selected physical handle name.
async function exportMultiPageTiffAs(sourcePath: TDocumentRef, sourceKind: 'djvu' | 'pdf', chosenName: string, singlePage = false) {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(`tiff-${crypto.randomUUID()}`, {create: true});
    if (singlePage) {
        await installImageExportDestination(chosenName);
        Reflect.set(window, 'showDirectoryPicker', undefined);
    } else {
        Reflect.set(window, 'showSaveFilePicker', undefined);
        Reflect.set(window, 'showDirectoryPicker', async () => directory);
    }
    try {
        const result = await createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            sourcePath,
            singlePage ? [requirePageNumber(1)] : [
                requirePageNumber(1),
                requirePageNumber(2),
            ],
            requireRequestId(`browser-${sourceKind}-multi-page-tiff-export`),
            sourceKind,
        );
        if (!result.success || !result.outputPaths?.[0]) throw new Error('TIFF export did not succeed');
        const storedName = getBrowserDocumentFileName(result.outputPaths[0]);
        const file = await (singlePage ? imageExportHandle : await directory.getFileHandle(storedName)).getFile();
        return {
            bytesBase64: encodeBase64(new Uint8Array(await file.arrayBuffer())),
            savedName: file.name,
            storedName,
            pickerOptions: imageExportPickerOptions,
        };
    } catch (error) {
        if (!singlePage) throw error;
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
    } finally {
        Reflect.deleteProperty(window, 'showDirectoryPicker');
    }
}

async function runBrowserDjvuMultiPageTiffExportAcceptance(chosenName: string, singlePage = false) {
    // Pages 1 and 2 of this fixture are 72 and 300 DPI; the TIFF keeps each one.
    const sourcePath = await stageDjvuFixture('/fixtures/mixed-dpi.djvu');
    try {
        return await exportMultiPageTiffAs(sourcePath, 'djvu', chosenName, singlePage);
    } finally {
        await browserDocumentStore.remove(sourcePath);
    }
}

Reflect.set(globalThis, '__evbRunBrowserDjvuMultiPageTiffExportAcceptance', runBrowserDjvuMultiPageTiffExportAcceptance);

async function runBrowserPdfMultiPageTiffExportAcceptance(chosenName: string, singlePage = false) {
    const sourcePath = await stagePdfFixture(2);
    try {
        return await exportMultiPageTiffAs(sourcePath, 'pdf', chosenName, singlePage);
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
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(`large-tiff-${crypto.randomUUID()}`, {create: true});
    Reflect.set(window, 'showSaveFilePicker', undefined);
    Reflect.set(window, 'showDirectoryPicker', sourceKind === 'djvu' ? async () => directory : undefined);
    try {
        const result = await createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            sourcePath,
            Array.from({length: pageCount}, (_, index) => requirePageNumber(index + 1)),
            requireRequestId(`browser-large-${sourceKind}-multi-page-tiff-export`),
            sourceKind,
        );
        return {
            success: result.success,
            saved: sourceKind === 'djvu' ? summarizeTiff(new Uint8Array(await (await (await directory.getFileHandle('document.tiff')).getFile()).arrayBuffer())) : null,
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        Reflect.deleteProperty(window, 'showDirectoryPicker');
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

// Test-owned OPFS entries exercise the actual renderer, encoders and file sinks.
async function readDirectoryImages(directory: FileSystemDirectoryHandle) {
    const files: Array<{
        name: string;
        bytesBase64: string;
        decodable: boolean
    }> = [];
    const entries = Reflect.get(directory, 'entries') as () => AsyncIterable<[string, FileSystemHandle]>;
    for await (const [
        name,
        entry,
    ] of entries.call(directory)) {
        if (entry.kind !== 'file') continue;
        const file = await (entry as FileSystemFileHandle).getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const decodable = bytes[0] === 0xff || bytes[0] === 0x89
            ? await createImageBitmap(file).then(bitmap => { bitmap.close(); return true; }, () => false)
            : false;
        files.push({
            name,
            bytesBase64: encodeBase64(bytes),
            decodable,
        });
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function installFolderFailureAcceptance(mode: string) {
    const source = await stagePdfFixture(2);
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(`failed-${crypto.randomUUID()}`, {create: true});
    Reflect.set(window, 'showDirectoryPicker', async () => directory);
    const failedImages = Promise.withResolvers<Awaited<ReturnType<typeof readDirectoryImages>>>();
    Reflect.set(globalThis, '__evbReadFailedFolderImages', () => failedImages.promise);
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    const createWritable = FileSystemFileHandle.prototype.createWritable;
    const getFile = FileSystemFileHandle.prototype.getFile;
    let encodes = 0;
    HTMLCanvasElement.prototype.toBlob = function (...args) {
        encodes += 1;
        if (mode === 'encode' && encodes === 2) {
            void readDirectoryImages(directory).then(files => {
                failedImages.resolve(files);
                args[0](null);
            }, failedImages.reject);
            return;
        }
        return toBlob.apply(this, args);
    };
    let failedHandleName: string | null = null;
    FileSystemFileHandle.prototype.createWritable = async function (options) {
        if (this.name !== 'document-pages-002.jpg') return createWritable.call(this, options);
        failedHandleName = this.name;
        if (mode === 'open') throw new Error('second page writer refused');
        const writer = await createWritable.call(this, options);
        if (mode === 'close-unknown') {
            const close = writer.close.bind(writer);
            writer.close = async () => { await close(); throw new Error('close receipt lost'); };
            writer.abort = async () => { throw new Error('abort outcome unknown'); };
        } else {
            writer.write = async () => { throw new Error('second page write failed'); };
            const abort = writer.abort.bind(writer);
            writer.abort = async () => {
                if (mode === 'abort-unknown') { await abort(); throw new Error('abort receipt lost'); }
                await abort();
                if (mode === 'replaced') {
                    await directory.removeEntry(this.name);
                    const replacement = await directory.getFileHandle(this.name, {create: true});
                    const out = await createWritable.call(replacement);
                    await out.write('external revision');
                    await out.close();
                } else if (mode === 'nonempty') {
                    const out = await createWritable.call(this);
                    await out.write('external revision');
                    await out.close();
                }
            };
        }
        return writer;
    };
    if (mode === 'changed-empty') {
        let reads = 0;
        FileSystemFileHandle.prototype.getFile = async function () {
            const file = await getFile.call(this);
            if (this.name === 'document-pages-002.jpg' && ++reads > 1) {
                return new File([], file.name, {lastModified: file.lastModified + 1});
            }
            return file;
        };
    }
    document.body.insertAdjacentHTML('beforeend', '<button id="folder-failure-export">Export pages</button><output id="folder-failure-result"></output>');
    document.querySelector('#folder-failure-export')!.addEventListener('click', async event => {
        if (!event.isTrusted) throw new Error('Folder export requires trusted input');
        let error = '';
        try {
            await createBrowserImageExportCapability().exportPdfToImages(source, [
                requirePageNumber(1),
                requirePageNumber(2),
            ], requireRequestId('failed-folder'), 'pdf');
        } catch (failure) {
            error = failure instanceof Error ? failure.message : String(failure);
        } finally {
            HTMLCanvasElement.prototype.toBlob = toBlob;
            FileSystemFileHandle.prototype.createWritable = createWritable;
            FileSystemFileHandle.prototype.getFile = getFile;
        }
        if (mode === 'encode') await failedImages.promise;
        const failed = await readDirectoryImages(directory);
        const recent = await browserDocumentStore.getRecentFiles();
        const retainedOutputs = await Promise.all(recent.filter(item => /document-pages/u.test(item.fileName)).map(item => browserDocumentStore.exists(item.originalPath)));
        const retry = mode === 'encode'
            ? await createBrowserImageExportCapability().exportPdfToImages(source, [
                requirePageNumber(1),
                requirePageNumber(2),
            ], requireRequestId('retry-folder'), 'pdf')
            : null;
        const result = {
            error,
            failed,
            retried: retry ? await readDirectoryImages(directory) : [],
            retainedOutputs,
            failedHandle: failedHandleName,
        };
        document.querySelector('#folder-failure-result')!.textContent = JSON.stringify(result);
        await browserDocumentStore.remove(source);
    }, {once: true});
}
Reflect.set(globalThis, '__evbInstallFolderFailureAcceptance', installFolderFailureAcceptance);

async function installTiffPartsAcceptance(sourceKind: 'pdf' | 'djvu', destination: 'directory' | 'download' | 'cancel', collision: boolean, failPage: boolean) {
    const source = sourceKind === 'pdf' ? await stagePdfFixture(5) : await stageDjvuFixture('/fixtures/browser-boundary-501-pages.djvu');
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(`parts-${crypto.randomUUID()}`, {create: true});
    Reflect.set(window, 'showSaveFilePicker', undefined);
    Reflect.set(window, 'showDirectoryPicker', destination === 'download' ? undefined : async () => {
        if (destination === 'cancel') throw new DOMException('Canceled', 'AbortError');
        return directory;
    });
    const firstName = sourceKind === 'pdf' ? 'browser-pdf-image-export-part-001.tif' : 'document-part-001.tiff';
    if (collision) {
        const writer = await (await directory.getFileHandle(firstName, {create: true})).createWritable();
        await writer.write('earlier TIFF');
        await writer.close();
    }
    const capability = createBrowserImageExportCapability();
    const progress: number[] = [];
    const stop = capability.onProgress(event => {progress.push(event.percent);});
    const getImageData = CanvasRenderingContext2D.prototype.getImageData;
    let rendered = 0;
    if (failPage) CanvasRenderingContext2D.prototype.getImageData = function (...args) {
        if (++rendered === 3) throw new Error('third page raster failed');
        return getImageData.apply(this, args);
    };
    document.body.insertAdjacentHTML('beforeend', '<button id="tiff-parts-export">Export TIFF</button><output id="tiff-parts-result"></output>');
    document.querySelector('#tiff-parts-export')!.addEventListener('click', async event => {
        if (!event.isTrusted) throw new Error('TIFF export requires trusted input');
        let result;
        try {
            result = await capability.exportPdfToMultiPageTiff(source, Array.from({length: 5}, (_, index) => requirePageNumber(index + 1)), requireRequestId('tiff-parts'), sourceKind);
        } catch (error) {
            result = {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        } finally {
            stop();
            CanvasRenderingContext2D.prototype.getImageData = getImageData;
        }
        const files = destination === 'directory' ? await readDirectoryImages(directory) : [];
        document.querySelector('#tiff-parts-result')!.textContent = JSON.stringify({
            result,
            files,
            progress,
        });
        await browserDocumentStore.remove(source);
    }, {once: true});
}
Reflect.set(globalThis, '__evbInstallTiffPartsAcceptance', installTiffPartsAcceptance);

async function installTypedPdfSaveAcceptance() {
    const [
        {createBrowserDocumentsFileCapability},
        {configureBrowserFilePickerMessages},
        {default: messages},
    ] = await Promise.all([
        import('@app/platform/browser-api/createBrowserDocumentsFileCapability'),
        import('@app/platform/browser-api/browserFilePickerAdapter'),
        import('../../../packages/i18n-app/messages/fr'),
    ]);
    configureBrowserFilePickerMessages({saveExtensionMismatch: extensions => messages.errors.browser.saveExtensionMismatch.replace('{extensions}', extensions)});
    const source = await stagePdfFixture();
    const working = await browserDocumentStore.cloneAsWorkingCopy(source);
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('report.txt', {create: true});
    const writer = await handle.createWritable();
    await writer.write('sentinel bytes');
    await writer.close();
    Reflect.set(window, 'showSaveFilePicker', async () => handle);
    document.body.insertAdjacentHTML('beforeend', '<button id="typed-pdf-save">Save PDF As</button><output id="typed-save-message"></output>');
    document.querySelector('#typed-pdf-save')!.addEventListener('click', async event => {
        if (!event.isTrusted) throw new Error('Save As requires trusted input');
        let message = '';
        let saved: TDocumentRef | null = null;
        try {
            const revision = await browserDocumentStore.getDocumentRevision(working);
            saved = await createBrowserDocumentsFileCapability({clearSearchCaches: () => {}}).savePdfAs(working, undefined, {expectedDocumentRevisionToken: revision.token});
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        document.querySelector('#typed-save-message')!.textContent = message || 'Saved';
        Reflect.set(globalThis, '__evbTypedSaveResult', {
            saved,
            bytes: await (await handle.getFile()).text(),
            source: await browserDocumentStore.getSourceRef(working),
            originalSource: source,
        });
    }, {once: true});
}
Reflect.set(globalThis, '__evbInstallTypedPdfSaveAcceptance', installTypedPdfSaveAcceptance);
// Hold the first vacancy response until its rival has observed the vacancy or
// queued on the directory lock. The assertions read real OPFS files; these
// gates only arrange the reported overlap without wall-clock delays.
async function installConcurrentFolderAcceptance() {
    const source = await stagePdfFixture(2);
    const working = await browserDocumentStore.cloneAsWorkingCopy(source);
    const {createBrowserDocumentsFileCapability} = await import('@app/platform/browser-api/createBrowserDocumentsFileCapability');
    const root = await navigator.storage.getDirectory();
    const saveHandle = await root.getFileHandle(`concurrent-save-${crypto.randomUUID()}.pdf`, {create: true});
    Reflect.set(window, 'showSaveFilePicker', async () => saveHandle);
    const directory = await root.getDirectoryHandle(`concurrent-${crypto.randomUUID()}`, {create: true});
    Reflect.set(window, 'showDirectoryPicker', async () => directory);
    const vacancyReached = Promise.withResolvers<undefined>();
    const vacanciesReleased = Promise.withResolvers<undefined>();
    const writerOpened = Promise.withResolvers<undefined>();
    const writerReleased = Promise.withResolvers<undefined>();
    const getFileHandle = FileSystemDirectoryHandle.prototype.getFileHandle;
    const createWritable = FileSystemFileHandle.prototype.createWritable;
    const request = navigator.locks.request;
    let vacancyReads = 0;
    let firstPageWriters = 0;
    let directoryRequests = 0;
    FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, options) {
        try {
            return await getFileHandle.call(this, name, options);
        } catch (error) {
            if (this.name === directory.name && name === 'document-pages-001.jpg' && !options?.create
                && error instanceof DOMException && error.name === 'NotFoundError') {
                vacancyReads += 1;
                vacancyReached.resolve(undefined);
                if (vacancyReads === 2) vacanciesReleased.resolve(undefined);
                await vacanciesReleased.promise;
            }
            throw error;
        }
    };
    Reflect.set(navigator.locks, 'request', function (...args: unknown[]) {
        if (args[0] === 'evb-viewer:browser-directory-export' && ++directoryRequests === 2) {
            vacanciesReleased.resolve(undefined);
            writerReleased.resolve(undefined);
        }
        return Reflect.apply(request, navigator.locks, args);
    });
    FileSystemFileHandle.prototype.createWritable = async function (options) {
        if (!/^document-pages-001(?:-\d+)?\.jpg$/u.test(this.name)) return createWritable.call(this, options);
        firstPageWriters += 1;
        if (firstPageWriters === 2) {
            await writerOpened.promise;
            return createWritable.call(this, options);
        }
        const writer = await createWritable.call(this, options);
        const write = writer.write.bind(writer);
        writer.write = async chunk => {
            writerOpened.resolve(undefined);
            await writerReleased.promise;
            await write(chunk);
        };
        return writer;
    };
    document.body.insertAdjacentHTML('beforeend', '<button id="concurrent-folder-export">Export twice</button><output id="concurrent-folder-result"></output>');
    document.querySelector('#concurrent-folder-export')!.addEventListener('click', async event => {
        if (!event.isTrusted) throw new Error('Concurrent exports require trusted input');
        const capability = createBrowserImageExportCapability();
        const pages = [
            requirePageNumber(1),
            requirePageNumber(2),
        ];
        try {
            const first = capability.exportPdfToImages(source, pages, requireRequestId('concurrent-first'), 'pdf');
            await vacancyReached.promise;
            const revision = await browserDocumentStore.getDocumentRevision(working);
            await createBrowserDocumentsFileCapability({clearSearchCaches: () => {}}).savePdfAs(working, undefined, {expectedDocumentRevisionToken: revision.token});
            const savedPages = (await PDFDocument.load(await (await saveHandle.getFile()).arrayBuffer())).getPageCount();
            const second = capability.exportPdfToImages(source, pages, requireRequestId('concurrent-rival'), 'pdf')
                .finally(() => writerReleased.resolve(undefined));
            const results = await Promise.all([
                first,
                second,
            ]);
            document.querySelector('#concurrent-folder-result')!.textContent = JSON.stringify({
                results,
                savedPages,
                files: await readDirectoryImages(directory),
            });
        } finally {
            FileSystemDirectoryHandle.prototype.getFileHandle = getFileHandle;
            FileSystemFileHandle.prototype.createWritable = createWritable;
            Reflect.set(navigator.locks, 'request', request);
            await browserDocumentStore.remove(working);
            await browserDocumentStore.remove(source);
            await root.removeEntry(saveHandle.name);
        }
    }, {once: true});
}
Reflect.set(globalThis, '__evbInstallConcurrentFolderAcceptance', installConcurrentFolderAcceptance);
