import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {loadBrowserPdfjsDocument} from '@app/platform/browser-api/loadBrowserPdfjsDocument';
import type * as UTIFModule from 'utif';
import {
    range,
    sumBy,
    clamp,
} from 'es-toolkit/math';
import {
    assertCaptureImageBudget,
    CAPTURE_MAX_BYTES,
    type IMAGE_EXPORT_PLATFORM_FEATURE,
    type IImageExportCapability,
    type IImageExportProgress,
    type TImageExportProgressFormat,
} from '@contracts/imageExportPlatformFeature';
import type { TFeatureBrowserBindings } from '@contracts/platformFeature';
import {
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browserDocumentStore';
import {browserImageExportConfig} from '@app/platform/browser-api/browserImageExportConfig';
import { toUint8Array } from '@app/platform/browser-api/browserBytes';
import {runBrowserLock} from '@app/platform/browser/runBrowserLock';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import {
    BrowserFileWriteOutcomeError,
    openBrowserOutputSink,
    pickSaveTarget,
    saveBytesToPickerOrDownload,
    writeBytesToHandle,
    type IBrowserOutputSink,
    type TBrowserOutputTarget,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import {
    buildImageExportPickerTypes,
    buildTiffSaveTypes,
} from '@app/platform/browser-api/browserFileAccepts';
import {
    encodeMultiPageTiffHeader,
    splitTiffPageDescriptorsForClassicLimit,
} from '@pdf-core/tiffEncoding';
import {
    crc32,
    encodeUtf8,
    makeCentralHeader,
    makeEndOfCentralDirectory,
    makeLocalHeader,
} from '@app/utils/docxStreaming';
import type {
    ITiffEncoderModule,
    ITiffImageDescriptor,
} from '@pdf-core/tiffEncoding';
import { addJpegJfifDensity } from '@pdf-core/addJpegJfifDensity';
import { addPngPhysicalResolution } from '@pdf-core/addPngPhysicalResolution';
import {
    createDjvuWorkerFromPath,
    getDjvuWorkerPageSizes,
} from '@app/platform/browser-api/createDjvuWorkerFromPath';
import { assertBrowserDjvuRasterDimensions } from '@app/platform/browser-api/assertBrowserDjvuRasterDimensions';
import {
    isNativeLegacyDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    parseRequestId,
    type TRequestId,
} from '@contracts/shared';
import {PdfCombineCapabilityError} from '@contracts/pdfCombineErrors';

import {
    IMAGE_EXPORT_FORMATS,
    buildMultiPageTiffOutputSuffixes,
    buildOutputFileNameWithSuffix,
    normalizeImageExportFileName,
    resolveImageExportFormat,
    type TImageExportFormat as TBrowserImageExportFormat,
} from '@pdf-core/imageExportFileName';
type TBrowserImageExportProgressPayload = Omit<IImageExportProgress, 'format' | 'requestId'>;
type TUtifModule = typeof UTIFModule;

interface IRenderedPdfPage {
    rgba: Uint8Array;
    width: number;
    height: number;
}

interface IBrowserTiffPageDescriptor extends ITiffImageDescriptor {pageNumber: number;}

/**
 * Matches IMAGE_EXPORT_MAX_OUTPUT_PATHS in the main image-export resource limits
 * and the contract image-export collection budget. An all-pages browser export
 * must refuse above this page count instead of materializing a denser range.
 */
const BROWSER_IMAGE_EXPORT_MAX_TARGET_PAGES = 100_000;

class BrowserImageExportPageBudgetError extends RangeError {
    public readonly code = 'image-export-page-budget-exceeded';
    public readonly pageCount: number;

    public constructor(pageCount: number) {
        super(
            `Browser image export refuses all-pages exports above ${BROWSER_IMAGE_EXPORT_MAX_TARGET_PAGES.toLocaleString('en-US')} pages`
                + ` (document has ${pageCount.toLocaleString('en-US')} pages); export an explicit page selection instead`,
        );
        this.name = 'BrowserImageExportPageBudgetError';
        this.pageCount = pageCount;
    }
}

const imageExportProgressListeners = new Set<(progress: IImageExportProgress) => void>();
let utifModulePromise: Promise<TUtifModule> | null = null;

function assertBrowserImageExportSource(path: TDocumentRef) {
    if (!isNativeLegacyDocumentRef(path)) {
        return;
    }

    throw new PdfCombineCapabilityError(
        'native-unavailable',
        `Browser image export cannot process a native document path: ${path}`,
        {operation: 'image-export'},
    );
}

function loadUtifEncoder(): Promise<ITiffEncoderModule> {
    utifModulePromise ??= import('utif');
    return utifModulePromise.then(module => module.default);
}

function normalizeBrowserExportRequestId(requestId: unknown): TRequestId | null {
    return parseRequestId(requestId);
}

function emitBrowserImageExportProgress(
    requestId: TRequestId | undefined,
    format: TImageExportProgressFormat,
    progress: TBrowserImageExportProgressPayload,
) {
    const normalizedRequestId = normalizeBrowserExportRequestId(requestId);
    if (normalizedRequestId === null) {
        return;
    }

    const total = Math.max(1, Math.trunc(progress.total));
    const processed = clamp(Math.trunc(progress.processed), 0, total);
    const event = {
        requestId: normalizedRequestId,
        format,
        phase: progress.phase,
        processed,
        total,
        percent: clamp(progress.percent, 0, 100),
    } satisfies IImageExportProgress;

    imageExportProgressListeners.forEach((listener) => listener(event));
}

interface IRenderedPdfPageCanvas {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
}

function releaseCanvas(canvas: HTMLCanvasElement) {
    canvas.width = 0;
    canvas.height = 0;
}

function padImageExportNumber(value: number) {
    return String(value).padStart(3, '0');
}

// Desktop's names: one page saves under the chosen name, suggested as below;
// several pages save beside each other under the template's stem.
function buildSinglePageImageExportName(pageNumber: number) {
    return `document-page-${padImageExportNumber(pageNumber)}.jpg`;
}

const MULTI_PAGE_IMAGE_EXPORT_TEMPLATE = 'document-pages.jpg';

function buildMultiPageImageExportName(sourceKind: 'pdf' | 'djvu', pageNumber: number, index: number) {
    const stem = MULTI_PAGE_IMAGE_EXPORT_TEMPLATE.replace(/\.jpg$/u, '');
    return sourceKind === 'pdf'
        ? `${stem}-${padImageExportNumber(index + 1)}.jpg`
        : `${stem}-page-${padImageExportNumber(pageNumber)}.jpg`;
}

async function withRenderedPdfPageCanvas<T>(
    pdfDocument: Pick<IPdfDocument, 'getPage'>,
    pageNumber: number,
    dpi: number,
    callback: (rendered: IRenderedPdfPageCanvas) => Promise<T> | T,
): Promise<T> {
    const page = await pdfDocument.getPage(pageNumber);
    let canvas: HTMLCanvasElement | null = null;

    try {
        const viewport = page.getViewport({ scale: dpi / 72 });
        const size = page.getViewport({scale: 1});
        canvas = document.createElement('canvas');
        canvas.width = Math.ceil(size.width * dpi / 72);
        canvas.height = Math.ceil(size.height * dpi / 72);
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Canvas 2D context is unavailable');
        }

        await page.render({
            canvas,
            canvasContext: context,
            viewport,
        }).promise;

        return await callback({
            canvas,
            context,
        });
    } finally {
        if (canvas) {
            releaseCanvas(canvas);
        }
        try {
            await Promise.resolve(page.cleanup());
        } catch {
            // Cleanup is best effort.
        }
    }
}

async function renderPdfPage(
    pdfDocument: Pick<IPdfDocument, 'getPage'>,
    pageNumber: number,
    dpi: number,
): Promise<IRenderedPdfPage> {
    return withRenderedPdfPageCanvas(
        pdfDocument,
        pageNumber,
        dpi,
        ({
            canvas,
            context,
        }) => {
            const {data} = context.getImageData(0, 0, canvas.width, canvas.height);
            return {
                rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                width: canvas.width,
                height: canvas.height,
            };
        },
    );
}

async function canvasToBlob(
    canvas: HTMLCanvasElement,
    mimeType: string,
    quality?: number,
) {
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Failed to export rendered page'));
                return;
            }

            resolve(blob);
        }, mimeType, quality);
    });
}

async function encodeCanvasAs(
    canvas: HTMLCanvasElement,
    format: TBrowserImageExportFormat,
    dpi: number,
) {
    if (format === 'tiff') {
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D context is unavailable');
        const {data} = context.getImageData(0, 0, canvas.width, canvas.height);
        const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        return encodeRenderedTiffToBytes([{
            pageNumber: 1,
            width: canvas.width,
            height: canvas.height,
            dataLength: rgba.byteLength,
            dpiX: dpi,
            dpiY: dpi,
        }], await loadUtifEncoder(), () => Promise.resolve({
            rgba,
            width: canvas.width,
            height: canvas.height,
        }));
    }
    const blob = await canvasToBlob(canvas, IMAGE_EXPORT_FORMATS[format].mimeType, format === 'jpeg' ? 0.92 : undefined);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return format === 'png' ? addPngPhysicalResolution(bytes, dpi) : addJpegJfifDensity(bytes, dpi);
}

function renderPdfPageToImageBytes(
    pdfDocument: Pick<IPdfDocument, 'getPage'>,
    pageNumber: number,
    format: TBrowserImageExportFormat,
    dpi: number,
) {
    return withRenderedPdfPageCanvas(pdfDocument, pageNumber, dpi, ({canvas}) => encodeCanvasAs(canvas, format, dpi));
}

async function collectTiffPageDescriptors(
    pdfDocument: Pick<IPdfDocument, 'getPage'>,
    pageNumbers: number[],
    dpi: number,
) {
    const descriptors: IBrowserTiffPageDescriptor[] = [];

    for (const pageNumber of pageNumbers) {
        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({scale: 1});
        const width = Math.ceil(viewport.width * dpi / 72);
        const height = Math.ceil(viewport.height * dpi / 72);
        descriptors.push({
            pageNumber,
            width,
            height,
            dataLength: width * height * 4,
            dpiX: dpi,
            dpiY: dpi,
        });

        try {
            await Promise.resolve(page.cleanup());
        } catch {
            // Cleanup is best effort.
        }

        if (descriptors.length % 2 === 0) {
            await yieldToBrowser();
        }
    }

    return descriptors;
}

function createMultiPageTiffOutput(
    pageDescriptors: IBrowserTiffPageDescriptor[],
    encoder: ITiffEncoderModule,
) {
    const {
        header,
        firstDataOffset,
    } = encodeMultiPageTiffHeader(pageDescriptors, encoder);
    const output = new Uint8Array(
        firstDataOffset + sumBy(pageDescriptors, descriptor => descriptor.dataLength),
    );
    output.set(header);
    return {
        output,
        firstDataOffset,
    };
}

type TTiffPageRenderer = (
    pageNumber: number,
) => Promise<Pick<IRenderedPdfPage, 'rgba' | 'width' | 'height'>>;

// Streams the header and then each page's RGBA as it renders, so one page is
// in memory at a time. The header's offsets are fixed before any page renders.
async function writeRenderedTiff(
    pageDescriptors: IBrowserTiffPageDescriptor[],
    encoder: ITiffEncoderModule,
    renderPage: TTiffPageRenderer,
    sink: IBrowserOutputSink,
    onPageWritten?: (processed: number) => void,
) {
    const {
        header,
        firstDataOffset,
    } = encodeMultiPageTiffHeader(pageDescriptors, encoder);
    await sink.write(header);
    const paddingLength = firstDataOffset - header.length;
    if (paddingLength > 0) {
        await sink.write(new Uint8Array(paddingLength));
    }

    for (let index = 0; index < pageDescriptors.length; index += 1) {
        const descriptor = pageDescriptors[index];
        if (!descriptor) {
            throw new Error('Missing TIFF page descriptor');
        }
        const rendered = await renderPage(descriptor.pageNumber);
        if (rendered.rgba.byteLength !== descriptor.dataLength) {
            throw new Error('Rendered TIFF page size did not match the expected descriptor size');
        }

        await sink.write(toUint8Array(rendered.rgba));
        onPageWritten?.(index + 1);
        await yieldToBrowser();
    }

    return firstDataOffset + sumBy(pageDescriptors, descriptor => descriptor.dataLength);
}

async function encodeRenderedTiffToBytes(
    pageDescriptors: IBrowserTiffPageDescriptor[],
    encoder: ITiffEncoderModule,
    renderPage: TTiffPageRenderer,
    onPageWritten?: (processed: number) => void,
) {
    const {
        output,
        firstDataOffset,
    } = createMultiPageTiffOutput(pageDescriptors, encoder);
    let offset = firstDataOffset;

    for (let index = 0; index < pageDescriptors.length; index += 1) {
        const descriptor = pageDescriptors[index];
        if (!descriptor) {
            throw new Error('Missing TIFF page descriptor');
        }
        const rendered = await renderPage(descriptor.pageNumber);
        if (rendered.rgba.byteLength !== descriptor.dataLength) {
            throw new Error('Rendered TIFF page size did not match the expected descriptor size');
        }

        output.set(rendered.rgba, offset);
        offset += descriptor.dataLength;
        onPageWritten?.(index + 1);
        await yieldToBrowser();
    }

    return output;
}

async function storeTiffAtHandle(
    handle: FileSystemFileHandle,
    fileSize: number,
) {
    const outputRef = await browserDocumentStore.createStoredDocument(
        handle.name,
        new Uint8Array(),
        {
            mimeType: 'image/tiff',
            saveKind: 'generic',
            kind: 'output',
            retention: 'transient',
            saveHandle: handle,
            storageMode: 'handle',
        },
    );
    await browserDocumentStore.replaceWithHandleBackedDocument(outputRef, {
        fileSize,
        saveHandle: handle,
        saveName: handle.name,
    });
    await browserDocumentStore.touchRecentFile(outputRef);
    return outputRef;
}

// Writes an already encoded page in the format its chosen name selects and
// stores the transient output. A canceled download picker stores nothing.
async function saveImageExport(
    saveTarget: Pick<Awaited<ReturnType<typeof pickSaveTarget>>, 'fileName' | 'handle'>,
    bytes: Uint8Array,
) {
    const format = resolveImageExportFormat(saveTarget.fileName, 'jpeg');
    const mimeType = IMAGE_EXPORT_FORMATS[format].mimeType;
    let saveName = saveTarget.fileName;
    let saveHandle = saveTarget.handle;
    if (saveHandle) {
        await writeBytesToHandle(saveHandle, bytes);
    } else {
        const downloadResult = await saveBytesToPickerOrDownload(bytes, {
            suggestedName: normalizeImageExportFileName(saveName, format),
            mimeType,
            pickerTypes: buildImageExportPickerTypes(format),
        });
        if (downloadResult.canceled) {
            return null;
        }
        saveName = downloadResult.fileName;
        saveHandle = downloadResult.handle ?? null;
    }
    const outputRef = await browserDocumentStore.createStoredDocument(saveName, saveHandle ? new Uint8Array() : bytes, {
        mimeType,
        saveKind: 'generic',
        kind: 'output',
        retention: 'transient',
        saveHandle,
        ...(saveHandle ? {storageMode: 'handle' as const} : {}),
    });
    if (saveHandle) {
        await browserDocumentStore.replaceWithHandleBackedDocument(outputRef, {
            fileSize: bytes.byteLength,
            saveHandle,
            saveName,
        });
    }
    await browserDocumentStore.touchRecentFile(outputRef);
    return outputRef;
}

// An export that does not finish releases the store entries it created.
// The files already written at their chosen destinations stay.
async function releaseImageExports(outputRefs: TDocumentRef[]) {
    await Promise.allSettled(outputRefs.map(outputRef => browserDocumentStore.remove(outputRef)));
}

function getTargetPages(pdfDocument: { numPages: number }, pageNumbers?: number[]) {
    // Only the dense all-pages fallback materializes range(1, numPages + 1);
    // partial explicit selections stay below the contract collection budget.
    if (!pageNumbers?.length && pdfDocument.numPages > BROWSER_IMAGE_EXPORT_MAX_TARGET_PAGES) {
        throw new BrowserImageExportPageBudgetError(pdfDocument.numPages);
    }

    const targetPages = (
        pageNumbers?.length
            ? pageNumbers
            : range(1, pdfDocument.numPages + 1)
    ).filter((pageNumber) => pageNumber >= 1 && pageNumber <= pdfDocument.numPages);

    return targetPages;
}

type TImagePageRenderer = (pageNumber: number, format: TBrowserImageExportFormat) => Promise<Uint8Array>;

type TBrowserOutputDirectoryPicker = (options?: {
    mode?: 'read' | 'readwrite';
    id?: string
}) => Promise<FileSystemDirectoryHandle>;

/** The chosen output folder, null when the person cancels, undefined when this browser has no folder picker. */
async function pickImageExportDirectory() {
    const showDirectoryPicker = typeof window === 'undefined'
        ? undefined
        : (window as Window & {showDirectoryPicker?: TBrowserOutputDirectoryPicker}).showDirectoryPicker;
    if (typeof showDirectoryPicker !== 'function') return undefined;
    try {
        return await showDirectoryPicker.call(window, {
            mode: 'readwrite',
            id: 'evb-image-export',
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return null;
        throw error;
    }
}

async function hasDirectoryEntry(directory: FileSystemDirectoryHandle, name: string) {
    try {
        await directory.getFileHandle(name);
        return true;
    } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        if (error.name === 'NotFoundError') return false;
        // A folder of that name occupies the name; lost access ends the export.
        if (error.name === 'TypeMismatchError') return true;
        throw error;
    }
}

// As desktop does, an existing file keeps its name: the output takes "-1", "-2" and on.
async function claimDirectoryFileName(directory: FileSystemDirectoryHandle, name: string, claimed: Set<string>) {
    const extension = name.slice(name.lastIndexOf('.'));
    const stem = name.slice(0, -extension.length);
    let candidate = name;
    for (let conflict = 1; claimed.has(candidate) || await hasDirectoryEntry(directory, candidate); conflict += 1) {
        candidate = `${stem}-${conflict}${extension}`;
    }
    claimed.add(candidate);
    return candidate;
}

// A failed writer may leave the new directory entry it opened. Remove only
// the same, unchanged empty entry, after a known discard. Complete files stay.
async function removeFailedDirectoryExport(
    directory: FileSystemDirectoryHandle,
    handle: FileSystemFileHandle,
    initial: File,
    error: unknown,
) {
    if (initial.size !== 0 || error instanceof BrowserFileWriteOutcomeError) return;
    try {
        const current = await directory.getFileHandle(handle.name);
        if (!await handle.isSameEntry(current)) return;
        const file = await current.getFile();
        if (file.size === 0 && file.lastModified === initial.lastModified) {
            await directory.removeEntry(handle.name);
        }
    } catch {
        // Lost access, a removed entry, or an uncertain identity is not ownership.
    }
}

async function exportImagePagesToDirectory(
    directory: FileSystemDirectoryHandle,
    names: string[],
    targetPages: number[],
    renderPage: TImagePageRenderer,
    onPageWritten: (processed: number) => void,
) {
    const outputRefs: TDocumentRef[] = [];
    const claimed = new Set<string>();
    try {
        for (const [
            index,
            pageNumber,
        ] of targetPages.entries()) {
            const bytes = await renderPage(pageNumber, resolveImageExportFormat(names[index]!, 'jpeg'));
            const fileName = await claimDirectoryFileName(directory, names[index]!, claimed);
            const handle = await directory.getFileHandle(fileName, {create: true});
            const initial = await handle.getFile();
            const outputRef = await saveImageExport({
                fileName,
                handle,
            }, bytes).catch(async (error: unknown) => {
                await removeFailedDirectoryExport(directory, handle, initial, error);
                throw error;
            });
            if (!outputRef) throw new Error('A handle-backed image export cannot be canceled');
            outputRefs.push(outputRef);
            onPageWritten(index + 1);
            if (index % 2 === 1) await yieldToBrowser();
        }
    } catch (error) {
        await releaseImageExports(outputRefs);
        throw error;
    }
    return outputRefs;
}

// Where no folder can be chosen, the pages download as one ZIP of STORED
// entries (they are compressed images already), streamed as they encode.
async function exportImagePagesAsZip(
    names: string[],
    targetPages: number[],
    renderPage: TImagePageRenderer,
    onPageWritten: (processed: number) => void,
) {
    const zipName = MULTI_PAGE_IMAGE_EXPORT_TEMPLATE.replace(/\.jpg$/u, '.zip');
    const stagingRef = await browserDocumentStore.createStoredDocument(zipName, new Uint8Array(), {
        mimeType: 'application/zip',
        saveKind: 'generic',
        kind: 'output',
        retention: 'transient',
        saveHandle: null,
    });
    try {
        const sink = await openBrowserOutputSink({
            fileName: zipName,
            stagingRef,
        }, {mimeType: 'application/zip'});
        try {
            const centralHeaders: Uint8Array[] = [];
            let offset = 0;
            for (const [
                index,
                pageNumber,
            ] of targetPages.entries()) {
                const entryName = encodeUtf8(names[index]!);
                const bytes = await renderPage(pageNumber, resolveImageExportFormat(names[index]!, 'jpeg'));
                const crc = crc32(bytes);
                const localHeader = makeLocalHeader(entryName, crc, bytes.byteLength);
                centralHeaders.push(makeCentralHeader(entryName, crc, bytes.byteLength, offset));
                await sink.write(localHeader);
                await sink.write(bytes);
                offset += localHeader.byteLength + bytes.byteLength;
                onPageWritten(index + 1);
                await yieldToBrowser();
            }
            const centralSize = sumBy(centralHeaders, header => header.byteLength);
            for (const header of centralHeaders) await sink.write(header);
            await sink.write(makeEndOfCentralDirectory(centralHeaders.length, centralSize, offset));
        } catch (error) {
            await sink.abort();
            throw error;
        }
        await sink.close();
    } finally {
        // The download holds its own copy; a ZIP is not a document to reopen.
        await browserDocumentStore.remove(stagingRef).catch(() => undefined);
    }
}

type TImageExportDestination =
    | {
        kind: 'file';
        saveTarget: Awaited<ReturnType<typeof pickSaveTarget>>
    }
    | {
        kind: 'directory';
        directory: FileSystemDirectoryHandle
    }
    | {kind: 'download'};

// Keep directory claims, publication and cleanup under their own origin-wide
// owner. Document saves use a separate lock and remain available.
function withDirectoryPublication<T>(destination: TImageExportDestination, publish: () => Promise<T>) {
    return destination.kind === 'directory' ? runBrowserLock('evb-viewer:browser-directory-export', publish) : publish();
}

// One page goes to the file the person names, in the format its name selects.
// Several pages go, as on desktop, into one chosen folder under deterministic
// names, or into one ZIP download where the browser cannot choose a folder.
// The picker opens before slow work where it can, while the click that asked
// for the export still allows it.
async function chooseImageExportDestination(
    pageCount: number,
    firstPage: number,
    singleFile = {
        suggestedName: buildSinglePageImageExportName(firstPage),
        pickerTypes: buildImageExportPickerTypes(),
    },
): Promise<TImageExportDestination | null> {
    if (pageCount === 1) {
        const saveTarget = await pickSaveTarget(singleFile);
        return saveTarget.canceled ? null : {
            kind: 'file',
            saveTarget,
        };
    }
    const directory = await pickImageExportDirectory();
    if (directory === null) return null;
    return directory ? {
        kind: 'directory',
        directory,
    } : {kind: 'download'};
}

const CANCELED_IMAGE_EXPORT = {
    success: false as const,
    canceled: true as const,
};

async function writeBrowserImagePages(
    destination: TImageExportDestination,
    sourceKind: 'pdf' | 'djvu',
    targetPages: number[],
    renderPage: TImagePageRenderer,
    requestId: TRequestId | undefined,
) {
    const onPageWritten = (processed: number) => emitBrowserImageExportProgress(requestId, 'images', {
        phase: 'rendering',
        processed,
        total: targetPages.length,
        percent: (processed / targetPages.length) * 100,
    });
    const [firstPage] = targetPages;
    if (firstPage === undefined) return CANCELED_IMAGE_EXPORT;
    if (destination.kind === 'file') {
        const bytes = await renderPage(firstPage, resolveImageExportFormat(destination.saveTarget.fileName, 'jpeg'));
        const outputRef = await saveImageExport(destination.saveTarget, bytes);
        if (!outputRef) return CANCELED_IMAGE_EXPORT;
        onPageWritten(1);
        return {
            success: true as const,
            outputPaths: [outputRef],
        };
    }
    const names = targetPages.map((pageNumber, index) => buildMultiPageImageExportName(sourceKind, pageNumber, index));
    onPageWritten(0);
    if (destination.kind === 'directory') {
        return {
            success: true as const,
            outputPaths: await withDirectoryPublication(destination, () => exportImagePagesToDirectory(destination.directory, names, targetPages, renderPage, onPageWritten)),
        };
    }
    await exportImagePagesAsZip(names, targetPages, renderPage, onPageWritten);
    // The ZIP is one download, not a stored output: the count of exported
    // pages is the selection's.
    return {
        success: true as const,
        outputPaths: [],
    };
}

async function exportBrowserDjvuPagesAsImages(
    workingCopyPath: TDocumentRef,
    pageNumbers: number[] | undefined,
    requestId: TRequestId | undefined,
) {
    const worker = await createDjvuWorkerFromPath(workingCopyPath);
    try {
        const sizes = await getDjvuWorkerPageSizes(worker);
        const targetPages = getTargetPages({numPages: sizes.length}, pageNumbers);
        const pageSizes = targetPages.map((pageNumber) => {
            const pageSize = sizes[pageNumber - 1];
            if (!pageSize) {
                throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
            }
            assertBrowserDjvuRasterDimensions(pageSize.width, pageSize.height, `DjVu page ${pageNumber}`);
            return pageSize;
        });
        const destination = targetPages.length ? await chooseImageExportDestination(targetPages.length, targetPages[0]!) : null;
        if (!destination) return CANCELED_IMAGE_EXPORT;
        // The decoder only produces PNG; the output name decides the encoding.
        return await writeBrowserImagePages(destination, 'djvu', targetPages, async (pageNumber, format) => {
            const pageSize = pageSizes[targetPages.indexOf(pageNumber)]!;
            const rendered = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
            try {
                const response = await fetch(rendered.url);
                if (!response.ok) {
                    throw new Error(`Failed to render DjVu page ${pageNumber}`);
                }
                const pngBytes = new Uint8Array(await response.arrayBuffer());
                return format === 'png'
                    ? addPngPhysicalResolution(pngBytes, pageSize.dpi)
                    : await encodeDecodedPngAs(pngBytes, format, pageSize.dpi);
            } finally {
                worker.revokeObjectURL(rendered.url);
            }
        }, requestId);
    } finally {
        worker.terminate();
    }
}

async function withDecodedPngCanvas<T>(bytes: Uint8Array, read: (canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) => T | Promise<T>) {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], {type: 'image/png'}));
    const canvas = document.createElement('canvas');
    try {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d', {willReadFrequently: true});
        if (!context) throw new Error('Canvas 2D context is unavailable for DjVu image export');
        context.drawImage(bitmap, 0, 0);
        return await read(canvas, context);
    } finally {
        bitmap.close();
        releaseCanvas(canvas);
    }
}

function encodeDecodedPngAs(pngBytes: Uint8Array, format: Exclude<TBrowserImageExportFormat, 'png'>, dpi: number) {
    return withDecodedPngCanvas(pngBytes, canvas => encodeCanvasAs(canvas, format, dpi));
}

type TDjvuTiffWorker = Awaited<ReturnType<typeof createDjvuWorkerFromPath>>;

async function renderBrowserDjvuPage(
    worker: TDjvuTiffWorker,
    pageNumber: number,
) {
    const rendered = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
    try {
        const response = await fetch(rendered.url);
        if (!response.ok) throw new Error(`Failed to render DjVu page ${pageNumber}`);
        return await withDecodedPngCanvas(new Uint8Array(await response.arrayBuffer()), (canvas, context) => ({
            width: canvas.width,
            height: canvas.height,
            rgba: new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data.buffer),
        }));
    } finally {
        worker.revokeObjectURL(rendered.url);
    }
}

function buildDjvuTiffPageDescriptors(
    sizes: Array<{
        width: number;
        height: number;
        dpi: number;
    }>,
    targetPages: number[],
) {
    return targetPages.map((pageNumber) => {
        const pageSize = sizes[pageNumber - 1];
        if (!pageSize) throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
        assertBrowserDjvuRasterDimensions(pageSize.width, pageSize.height, `DjVu page ${pageNumber}`);
        return {
            pageNumber,
            width: pageSize.width,
            height: pageSize.height,
            dataLength: pageSize.width * pageSize.height * 4,
            dpiX: pageSize.dpi,
            dpiY: pageSize.dpi,
        };
    });
}

async function exportBrowserDjvuAsTiff(
    workingCopyPath: TDocumentRef,
    pageNumbers: number[] | undefined,
    requestId: TRequestId | undefined,
) {
    const fileName = normalizeImageExportFileName('document.tiff', 'tiff');
    const destination = await chooseImageExportDestination(pageNumbers?.length ?? 2, pageNumbers?.[0] ?? 1, {
        suggestedName: fileName,
        pickerTypes: buildTiffSaveTypes(),
    });
    if (!destination) return CANCELED_IMAGE_EXPORT;
    const worker = await createDjvuWorkerFromPath(workingCopyPath);
    try {
        const sizes = await getDjvuWorkerPageSizes(worker);
        const targetPages = getTargetPages({numPages: sizes.length}, pageNumbers);
        if (targetPages.length === 0) {
            return {
                success: false as const,
                canceled: true as const,
            };
        }

        const pageDescriptors = buildDjvuTiffPageDescriptors(sizes, targetPages);
        return await withDirectoryPublication(destination, () => exportRenderedPagesAsTiff(pageDescriptors, pageNumber => renderBrowserDjvuPage(worker, pageNumber), destination, fileName, requestId));
    } finally {
        worker.terminate();
    }
}

async function exportRenderedPagesAsTiff(
    pageDescriptors: IBrowserTiffPageDescriptor[],
    renderPage: TTiffPageRenderer,
    destination: TImageExportDestination,
    suggestedName: string,
    requestId: TRequestId | undefined,
) {
    const encoder = await loadUtifEncoder();
    const groups = splitTiffPageDescriptorsForClassicLimit(pageDescriptors, encoder);
    const suffixes = buildMultiPageTiffOutputSuffixes(groups.length);
    const outputRefs: TDocumentRef[] = [];
    const claimed = new Set<string>();
    let processedPages = 0;
    const emitPageProgress = (processed: number) => emitBrowserImageExportProgress(requestId, 'multipage-tiff', {
        phase: 'rendering',
        processed,
        total: pageDescriptors.length,
        percent: (processed / pageDescriptors.length) * 90,
    });
    emitPageProgress(0);

    try {
        for (const [
            index,
            group,
        ] of groups.entries()) {
            let fileName = buildOutputFileNameWithSuffix(suggestedName, suffixes[index]!);
            let handle: FileSystemFileHandle | null = null;
            let initial: File | null = null;
            if (destination.kind === 'file') {
                // Explicit one-page selections are the only file-picker route.
                fileName = destination.saveTarget.fileName;
                handle = destination.saveTarget.handle;
            } else if (destination.kind === 'directory') {
                fileName = await claimDirectoryFileName(destination.directory, fileName, claimed);
                handle = await destination.directory.getFileHandle(fileName, {create: true});
                initial = await handle.getFile();
            }
            const target: TBrowserOutputTarget = handle ? {
                fileName,
                handle,
            } : {
                fileName,
                stagingRef: await browserDocumentStore.createStoredDocument(fileName, new Uint8Array(), {
                    mimeType: 'image/tiff',
                    saveKind: 'generic',
                    kind: 'output',
                    retention: 'transient',
                    saveHandle: null,
                }),
            };
            let published = false;
            try {
                const sink = await openBrowserOutputSink(target, {mimeType: 'image/tiff'});
                let fileSize: number;
                try {
                    fileSize = await writeRenderedTiff(group, encoder, renderPage, sink,
                        processed => emitPageProgress(processedPages + processed));
                } catch (error) {
                    await sink.abort();
                    throw error;
                }
                await sink.close();
                const outputRef = 'handle' in target
                    ? await storeTiffAtHandle(target.handle, fileSize)
                    : target.stagingRef;
                if ('stagingRef' in target) await browserDocumentStore.touchRecentFile(outputRef);
                outputRefs.push(outputRef);
                published = true;
                processedPages += group.length;
            } catch (error) {
                if (destination.kind === 'directory' && handle && initial) {
                    await removeFailedDirectoryExport(destination.directory, handle, initial, error);
                }
                throw error;
            } finally {
                if (!published && 'stagingRef' in target) {
                    await browserDocumentStore.remove(target.stagingRef).catch(() => undefined);
                }
            }
        }
        emitBrowserImageExportProgress(requestId, 'multipage-tiff', {
            phase: 'combining',
            processed: groups.length,
            total: groups.length,
            percent: 100,
        });
        return {
            success: true as const,
            outputPath: outputRefs[0]!,
            outputPaths: outputRefs,
        };
    } catch (error) {
        await releaseImageExports(outputRefs);
        throw error;
    }
}

interface ICaptureHandleTrack extends MediaStreamTrack {
    getCaptureHandle(): {
        handle?: string;
        origin?: string
    } | null;
    cropTo(target: object): Promise<void>;
}
interface ICaptureHandleDevices extends MediaDevices {setCaptureHandleConfig(config: {
    handle: string;
    exposeOrigin: boolean;
    permittedOrigins: string[]
}): void;}
interface IRegionCaptureGlobal {CropTarget?: {fromElement(element: Element): Promise<object>};}

export function createBrowserImageExportCapability(): IImageExportCapability {
    const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices as ICaptureHandleDevices | undefined;
    const cropFactory = (globalThis as IRegionCaptureGlobal).CropTarget;
    let handle: string | null = null;
    try {
        if (typeof devices?.setCaptureHandleConfig === 'function') {
            handle = crypto.randomUUID();
            devices.setCaptureHandleConfig({
                handle,
                exposeOrigin: true,
                permittedOrigins: [location.origin],
            });
        }
    } catch {handle = null;}
    return {
        async captureCurrentView(region, local) {
            const constraints = devices?.getSupportedConstraints() as (MediaTrackSupportedConstraints & {resizeMode?: boolean}) | undefined;
            if (!local || !handle || !cropFactory || typeof ImageCapture !== 'function' || !devices?.getDisplayMedia || !constraints?.resizeMode) {
                throw new DOMException('Current-tab region capture is unavailable', 'NotSupportedError');
            }
            local.assertCurrent();
            // No await precedes the public chooser: the confirmation supplies activation.
            let stream: MediaStream;
            try {
                const options: DisplayMediaStreamOptions & Record<string, unknown> = {
                    audio: false,
                    video: {displaySurface: 'browser'},
                    preferCurrentTab: true,
                    selfBrowserSurface: 'include',
                    surfaceSwitching: 'exclude',
                    monitorTypeSurfaces: 'exclude',
                };
                stream = await devices.getDisplayMedia(options);
            } catch (error) {
                if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) return null;
                throw error;
            }
            const stop = () => stream.getTracks().forEach(track => track.stop());
            const track = stream.getVideoTracks()[0] as ICaptureHandleTrack | undefined;
            let bitmap: ImageBitmap | undefined;
            let canvas: HTMLCanvasElement | undefined;
            const assertSource = () => {
                local.assertCurrent();
                const captured = track?.getCaptureHandle?.();
                if (stream.getAudioTracks().length || stream.getVideoTracks().length !== 1 || !track
                    || track.readyState !== 'live' || track.muted || typeof track.cropTo !== 'function'
                    || track.getSettings().displaySurface !== 'browser' || captured?.handle !== handle || captured.origin !== location.origin) {
                    throw new DOMException('The selected source is not this document tab', 'SecurityError');
                }
            };
            const invalidate = () => { local.cancel(); stop(); };
            const events = [
                'capturehandlechange',
                'ended',
                'mute',
            ];
            try {
                local.signal.throwIfAborted();
                assertSource();
                local.signal.addEventListener('abort', stop, {once: true});
                events.forEach(name => track!.addEventListener(name, invalidate));
                await local.prepareFrame();
                assertSource();
                await track!.applyConstraints({resizeMode: 'none'} as MediaTrackConstraints);
                assertSource();
                if (!local.target.isConnected) throw new DOMException('The capture target retired', 'AbortError');
                const target = await cropFactory.fromElement(local.target);
                assertSource();
                await track!.cropTo(target);
                assertSource();
                const frameSize = track!.getSettings();
                assertCaptureImageBudget(frameSize.width ?? 0, frameSize.height ?? 0);
                bitmap = await new ImageCapture(track!).grabFrame();
                assertSource();
                // The immutable frame owns the pixels now; sharing ends before encoding.
                stop();
                events.forEach(name => track!.removeEventListener(name, invalidate));
                assertCaptureImageBudget(bitmap.width, bitmap.height);
                if (Math.abs(bitmap.width - region.width * region.pixelRatio) > 1 || Math.abs(bitmap.height - region.height * region.pixelRatio) > 1) {
                    throw new RangeError('Capture density changed or the source was downsampled');
                }
                local.assertCurrent();
                canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const context = canvas.getContext('2d');
                if (!context) throw new Error('Capture canvas is unavailable');
                context.drawImage(bitmap, 0, 0);
                const encoded = await canvasToBlob(canvas, 'image/png');
                if (encoded.size > CAPTURE_MAX_BYTES) throw new RangeError('Capture exceeds the encoded byte limit');
                const png = new Uint8Array(await encoded.arrayBuffer());
                local.assertCurrent();
                return png;
            } finally {
                stop();
                local.signal.removeEventListener('abort', stop);
                events.forEach(name => track?.removeEventListener(name, invalidate));
                bitmap?.close();
                if (canvas) releaseCanvas(canvas);
            }
        },
        async exportPdfToImages(workingCopyPath, pageNumbers, requestId, sourceKind) {
            assertBrowserImageExportSource(workingCopyPath);
            if (sourceKind === 'djvu') {
                return exportBrowserDjvuPagesAsImages(workingCopyPath, pageNumbers, requestId);
            }
            // An explicit selection knows its size, so its picker opens before
            // the document loads; all pages need the page count first.
            let destination = pageNumbers?.length
                ? await chooseImageExportDestination(pageNumbers.length, pageNumbers[0]!)
                : undefined;
            if (destination === null) return CANCELED_IMAGE_EXPORT;
            const pdfDocument = await loadBrowserPdfjsDocument(workingCopyPath);
            try {
                const targetPages = getTargetPages(pdfDocument, pageNumbers);
                destination ??= targetPages.length ? await chooseImageExportDestination(targetPages.length, targetPages[0]!) : null;
                if (!destination) return CANCELED_IMAGE_EXPORT;
                const dpi = await browserImageExportConfig(pdfDocument, targetPages);
                return await writeBrowserImagePages(
                    destination,
                    'pdf',
                    targetPages,
                    (pageNumber, format) => renderPdfPageToImageBytes(pdfDocument, pageNumber, format, dpi),
                    requestId,
                );
            } finally {
                await pdfDocument.loadingTask.destroy();
            }
        },
        async exportPdfToMultiPageTiff(workingCopyPath, pageNumbers, requestId, sourceKind) {
            assertBrowserImageExportSource(workingCopyPath);
            if (sourceKind === 'djvu') {
                return exportBrowserDjvuAsTiff(workingCopyPath, pageNumbers, requestId);
            }
            const outputFileName = normalizeImageExportFileName(
                getBrowserDocumentFileName(workingCopyPath).replace(/\.pdf$/iu, ''), 'tiff',
            );
            const destination = await chooseImageExportDestination(pageNumbers?.length ?? 2, pageNumbers?.[0] ?? 1, {
                suggestedName: outputFileName,
                pickerTypes: buildTiffSaveTypes(),
            });
            if (!destination) {
                return {
                    success: false,
                    canceled: true,
                };
            }
            const pdfDocument = await loadBrowserPdfjsDocument(workingCopyPath);
            try {
                const targetPages = getTargetPages(pdfDocument, pageNumbers);

                if (targetPages.length === 0) {
                    return {
                        success: false,
                        canceled: true,
                    };
                }

                const dpi = await browserImageExportConfig(pdfDocument, targetPages);
                const descriptors = await collectTiffPageDescriptors(pdfDocument, targetPages, dpi);

                return await withDirectoryPublication(destination, () => exportRenderedPagesAsTiff(descriptors, pageNumber => renderPdfPage(pdfDocument, pageNumber, dpi), destination, outputFileName, requestId));
            } finally {
                await pdfDocument.loadingTask.destroy();
            }
        },
        onProgress: (callback) => {
            imageExportProgressListeners.add(callback);
            return () => {
                imageExportProgressListeners.delete(callback);
            };
        },
    } satisfies TFeatureBrowserBindings<typeof IMAGE_EXPORT_PLATFORM_FEATURE>;
}
