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
import { EXPORT_RENDER_SCALE } from '@app/platform/browser-api/browserImageExportConfig';
import { toUint8Array } from '@app/platform/browser-api/browserBytes';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import {
    pickSaveTarget,
    saveBytesToPickerOrDownload,
    writeBytesToHandle,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import {
    buildImageExportPickerTypes,
    buildTiffSaveTypes,
} from '@app/platform/browser-api/browserFileAccepts';
import {
    buildTiffImageIfd,
    encodeTiffIfds,
} from '@pdf-core/tiffEncoding';
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
    normalizeImageExportFileName,
    resolveImageExportFormat,
    type TImageExportFormat as TBrowserImageExportFormat,
} from '@pdf-core/imageExportFileName';
type TBrowserImageExportProgressPayload = Omit<IImageExportProgress, 'format' | 'requestId'>;
type TUtifModule = typeof UTIFModule;

interface IRenderedPdfPage {
    pageNumber: number;
    rgba: Uint8Array;
    width: number;
    height: number;
    dpi: number;
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

const BROWSER_INLINE_TIFF_EXPORT_MAX_RGBA_BYTES = 64 * 1024 * 1024;
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

function buildBrowserImageExportFileName(pageNumber: number) {
    return `page-${String(pageNumber).padStart(3, '0')}.jpg`;
}

async function withRenderedPdfPageCanvas<T>(
    pdfDocument: Pick<IPdfDocument, 'getPage'>,
    pageNumber: number,
    callback: (rendered: IRenderedPdfPageCanvas) => Promise<T> | T,
): Promise<T> {
    const page = await pdfDocument.getPage(pageNumber);
    let canvas: HTMLCanvasElement | null = null;

    try {
        const viewport = page.getViewport({ scale: EXPORT_RENDER_SCALE });
        canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
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
): Promise<IRenderedPdfPage> {
    return withRenderedPdfPageCanvas(
        pdfDocument,
        pageNumber,
        ({
            canvas,
            context,
        }) => {
            const {data} = context.getImageData(0, 0, canvas.width, canvas.height);
            return {
                pageNumber,
                rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                width: canvas.width,
                height: canvas.height,
                dpi: 72 * EXPORT_RENDER_SCALE,
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
) {
    return withRenderedPdfPageCanvas(pdfDocument, pageNumber, ({canvas}) => encodeCanvasAs(canvas, format, 72 * EXPORT_RENDER_SCALE));
}

async function collectTiffPageDescriptors(
    pdfDocument: Pick<IPdfDocument, 'getPage'>,
    pageNumbers: number[],
) {
    const descriptors: IBrowserTiffPageDescriptor[] = [];

    for (const pageNumber of pageNumbers) {
        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({ scale: EXPORT_RENDER_SCALE });
        descriptors.push({
            pageNumber,
            width: Math.ceil(viewport.width),
            height: Math.ceil(viewport.height),
            dataLength: Math.ceil(viewport.width) * Math.ceil(viewport.height) * 4,
            dpiX: 72 * viewport.scale,
            dpiY: 72 * viewport.scale,
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

function alignOffset(offset: number, alignment: number) {
    if (alignment <= 1) {
        return offset;
    }

    const remainder = offset % alignment;
    return remainder === 0 ? offset : offset + (alignment - remainder);
}

function encodeMultiPageTiffHeader(
    pageDescriptors: IBrowserTiffPageDescriptor[],
    encoder: ITiffEncoderModule,
) {
    let firstDataOffset = 0;
    let header = new Uint8Array();

    for (let attempt = 0; attempt < 8; attempt += 1) {
        const pageOffsets = pageDescriptors.map(() => 0);
        let cursor = firstDataOffset;
        for (let index = 0; index < pageDescriptors.length; index += 1) {
            const descriptor = pageDescriptors[index];
            if (!descriptor) {
                throw new Error('Missing TIFF page descriptor');
            }
            pageOffsets[index] = cursor;
            cursor += descriptor.dataLength;
        }

        header = toUint8Array(encodeTiffIfds(
            pageDescriptors.map((page, index) =>
                buildTiffImageIfd(page, pageOffsets[index] ?? 0),
            ),
            encoder,
        ));

        const nextFirstDataOffset = alignOffset(header.length, 8);
        if (nextFirstDataOffset === firstDataOffset) {
            break;
        }
        firstDataOffset = nextFirstDataOffset;
    }

    const finalFirstDataOffset = alignOffset(header.length, 8);
    const totalByteLength = finalFirstDataOffset + sumBy(pageDescriptors, descriptor => descriptor.dataLength);
    if (totalByteLength > 0xFFFFFFFF) {
        throw new Error('Multi-page TIFF export exceeds the Classic TIFF 4GB limit');
    }

    return {
        header,
        firstDataOffset: finalFirstDataOffset,
    };
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

async function encodeRenderedTiffToWritable(
    pageDescriptors: IBrowserTiffPageDescriptor[],
    encoder: ITiffEncoderModule,
    renderPage: TTiffPageRenderer,
    handle: FileSystemFileHandle,
    onPageWritten?: (processed: number) => void,
) {
    const writable = await handle.createWritable();
    try {
        const {
            header,
            firstDataOffset,
        } = encodeMultiPageTiffHeader(pageDescriptors, encoder);
        await writable.write(header);
        const paddingLength = firstDataOffset - header.length;
        if (paddingLength > 0) {
            await writable.write(new Uint8Array(paddingLength));
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

            await writable.write(toUint8Array(rendered.rgba));
            onPageWritten?.(index + 1);
            await yieldToBrowser();
        }

        await writable.close();
        return header.length
            + Math.max(0, firstDataOffset - header.length)
            + sumBy(pageDescriptors, descriptor => descriptor.dataLength);
    } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
    }
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

// Encodes one page in the format its chosen name selects, writes it there and
// stores the transient output. A canceled download picker stores nothing.
async function saveImageExport(
    saveTarget: Pick<Awaited<ReturnType<typeof pickSaveTarget>>, 'fileName' | 'handle'>,
    encode: (format: TBrowserImageExportFormat) => Promise<Uint8Array>,
) {
    const format = resolveImageExportFormat(saveTarget.fileName, 'jpeg');
    const mimeType = IMAGE_EXPORT_FORMATS[format].mimeType;
    const bytes = await encode(format);
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
        storageMode: saveHandle ? 'handle' : 'inline',
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
    await Promise.allSettled(outputRefs.map(outputRef => browserDocumentStore.cleanupDetachedDocument(outputRef)));
}

async function loadPdfDocument(path: string) {
    const pdfDocument = await loadBrowserPdfjsDocument(path);
    return {
        pdfDocument,
        destroy: () => pdfDocument.loadingTask.destroy(),
    };
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

async function exportBrowserDjvuPagesAsImages(
    workingCopyPath: TDocumentRef,
    pageNumbers: number[] | undefined,
    requestId: TRequestId | undefined,
) {
    const worker = await createDjvuWorkerFromPath(workingCopyPath);
    const outputRefs: TDocumentRef[] = [];
    try {
        const sizes = await getDjvuWorkerPageSizes(worker);
        const targetPages = getTargetPages({numPages: sizes.length}, pageNumbers);
        if (targetPages.length === 0) {
            return {
                success: false as const,
                canceled: true as const,
            };
        }
        for (const [
            index,
            pageNumber,
        ] of targetPages.entries()) {
            const pageSize = sizes[pageNumber - 1];
            if (!pageSize) throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
            assertBrowserDjvuRasterDimensions(pageSize.width, pageSize.height, `DjVu page ${pageNumber}`);
            const saveTarget = await pickSaveTarget({
                suggestedName: `document-page-${String(pageNumber).padStart(3, '0')}.png`,
                pickerTypes: buildImageExportPickerTypes(),
            });
            // The decoder only produces PNG. The chosen name decides the encoding and the stored name.
            const outputRef = saveTarget.canceled ? null : await saveImageExport(saveTarget, async (format) => {
                const rendered = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
                try {
                    const response = await fetch(rendered.url);
                    if (!response.ok) throw new Error(`Failed to render DjVu page ${pageNumber}`);
                    const pngBytes = new Uint8Array(await response.arrayBuffer());
                    return format === 'png'
                        ? addPngPhysicalResolution(pngBytes, pageSize.dpi)
                        : await encodeDecodedPngAs(pngBytes, format, pageSize.dpi);
                } finally {
                    worker.revokeObjectURL(rendered.url);
                }
            });
            if (!outputRef) {
                await releaseImageExports(outputRefs);
                return {
                    success: false as const,
                    canceled: true as const,
                };
            }
            outputRefs.push(outputRef);
            emitBrowserImageExportProgress(requestId, 'images', {
                phase: 'rendering',
                processed: index + 1,
                total: targetPages.length,
                percent: ((index + 1) / targetPages.length) * 100,
            });
        }
        return {
            success: true as const,
            outputPaths: outputRefs,
        };
    } catch (error) {
        await releaseImageExports(outputRefs);
        throw error;
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

        const saveTarget = await pickSaveTarget({
            suggestedName: normalizeImageExportFileName('document.tiff', 'tiff'),
            pickerTypes: buildTiffSaveTypes(),
        });
        if (saveTarget.canceled) {
            return {
                success: false as const,
                canceled: true as const,
            };
        }

        const pageDescriptors = buildDjvuTiffPageDescriptors(sizes, targetPages);
        const estimatedRgbaBytes = sumBy(pageDescriptors, descriptor => descriptor.dataLength);
        if (estimatedRgbaBytes > BROWSER_INLINE_TIFF_EXPORT_MAX_RGBA_BYTES) {
            throw new Error('Browser DjVu TIFF export exceeds the 64MB decoded-image limit');
        }

        return await exportRenderedPagesAsTiff(pageDescriptors, pageNumber => renderBrowserDjvuPage(worker, pageNumber), saveTarget, requestId);
    } finally {
        worker.terminate();
    }
}

async function exportRenderedPagesAsTiff(
    pageDescriptors: IBrowserTiffPageDescriptor[],
    renderPage: TTiffPageRenderer,
    saveTarget: Awaited<ReturnType<typeof pickSaveTarget>>,
    requestId: TRequestId | undefined,
) {
    const encoder = await loadUtifEncoder();
    const emitPageProgress = (processed: number) => emitBrowserImageExportProgress(requestId, 'multipage-tiff', {
        phase: 'rendering',
        processed,
        total: pageDescriptors.length,
        percent: (processed / pageDescriptors.length) * 90,
    });
    emitPageProgress(0);

    if (saveTarget.handle) {
        const fileSize = await encodeRenderedTiffToWritable(
            pageDescriptors,
            encoder,
            renderPage,
            saveTarget.handle,
            emitPageProgress,
        );
        emitBrowserImageExportProgress(requestId, 'multipage-tiff', {
            phase: 'combining',
            processed: 1,
            total: 1,
            percent: 100,
        });
        const outputRef = await storeTiffAtHandle(saveTarget.handle, fileSize);
        return {
            success: true as const,
            outputPath: outputRef,
            outputPaths: [outputRef],
        };
    }

    const estimatedRgbaBytes = sumBy(pageDescriptors, descriptor => descriptor.dataLength);
    if (estimatedRgbaBytes > BROWSER_INLINE_TIFF_EXPORT_MAX_RGBA_BYTES) {
        throw new Error('Multi-page TIFF export without a file handle exceeds the 64MB decoded-image limit');
    }
    const bytes = await encodeRenderedTiffToBytes(
        pageDescriptors,
        encoder,
        renderPage,
        emitPageProgress,
    );
    const saveResult = await saveBytesToPickerOrDownload(bytes, {
        suggestedName: saveTarget.fileName,
        mimeType: 'image/tiff',
        pickerTypes: buildTiffSaveTypes(),
    });
    if (saveResult.canceled) {
        return {
            success: false as const,
            canceled: true as const,
        };
    }
    const outputRef = await browserDocumentStore.createStoredDocument(saveResult.fileName, bytes, {
        mimeType: 'image/tiff',
        saveKind: 'generic',
        kind: 'output',
        retention: 'transient',
        saveHandle: saveResult.handle ?? null,
        storageMode: saveResult.handle ? 'handle' : 'inline',
    });
    await browserDocumentStore.touchRecentFile(outputRef);
    emitBrowserImageExportProgress(requestId, 'multipage-tiff', {
        phase: 'combining',
        processed: 1,
        total: 1,
        percent: 100,
    });
    return {
        success: true as const,
        outputPath: outputRef,
        outputPaths: [outputRef],
    };
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
            const firstPageNumber = pageNumbers?.[0] ?? 1;
            const firstSaveTarget = await pickSaveTarget({
                suggestedName: buildBrowserImageExportFileName(firstPageNumber),
                pickerTypes: buildImageExportPickerTypes(),
            });
            if (firstSaveTarget.canceled) {
                return {
                    success: false,
                    canceled: true,
                };
            }
            const pdfDocument = await loadPdfDocument(workingCopyPath);
            let targetPages: number[];
            try {
                targetPages = getTargetPages(pdfDocument.pdfDocument, pageNumbers);
            } catch (error) {
                await pdfDocument.destroy();
                throw error;
            }
            const outputRefs: TDocumentRef[] = [];

            if (targetPages.length === 0) {
                await pdfDocument.destroy();
                return {
                    success: false,
                    canceled: true,
                };
            }

            try {
                emitBrowserImageExportProgress(requestId, 'images', {
                    phase: 'rendering',
                    processed: 0,
                    total: targetPages.length,
                    percent: 0,
                });
                for (let index = 0; index < targetPages.length; index += 1) {
                    const pageNumber = targetPages[index];
                    if (pageNumber === undefined) {
                        throw new Error('Missing image export page number');
                    }
                    const saveTarget = index === 0
                        ? firstSaveTarget
                        : await pickSaveTarget({
                            suggestedName: buildBrowserImageExportFileName(pageNumber),
                            pickerTypes: buildImageExportPickerTypes(),
                        });
                    const outputRef = saveTarget.canceled ? null : await saveImageExport(saveTarget, format => (
                        renderPdfPageToImageBytes(pdfDocument.pdfDocument, pageNumber, format)
                    ));
                    if (!outputRef) {
                        await releaseImageExports(outputRefs);
                        return {
                            success: false,
                            canceled: true,
                        };
                    }
                    outputRefs.push(outputRef);
                    emitBrowserImageExportProgress(requestId, 'images', {
                        phase: 'rendering',
                        processed: index + 1,
                        total: targetPages.length,
                        percent: ((index + 1) / targetPages.length) * 100,
                    });

                    if (index % 2 === 1) {
                        await yieldToBrowser();
                    }
                }
            } catch (error) {
                await releaseImageExports(outputRefs);
                throw error;
            } finally {
                await pdfDocument.destroy();
            }

            return {
                success: true,
                outputPaths: outputRefs,
            };
        },
        async exportPdfToMultiPageTiff(workingCopyPath, pageNumbers, requestId, sourceKind) {
            assertBrowserImageExportSource(workingCopyPath);
            if (sourceKind === 'djvu') {
                return exportBrowserDjvuAsTiff(workingCopyPath, pageNumbers, requestId);
            }
            const outputFileName = normalizeImageExportFileName(
                getBrowserDocumentFileName(workingCopyPath).replace(/\.pdf$/iu, ''), 'tiff',
            );
            const firstSaveTarget = await pickSaveTarget({
                suggestedName: outputFileName,
                pickerTypes: buildTiffSaveTypes(),
            });
            if (firstSaveTarget.canceled) {
                return {
                    success: false,
                    canceled: true,
                };
            }
            const pdfDocument = await loadPdfDocument(workingCopyPath);
            try {
                const targetPages = getTargetPages(pdfDocument.pdfDocument, pageNumbers);

                if (targetPages.length === 0) {
                    return {
                        success: false,
                        canceled: true,
                    };
                }

                const descriptors = await collectTiffPageDescriptors(pdfDocument.pdfDocument, targetPages);

                return await exportRenderedPagesAsTiff(descriptors, pageNumber => renderPdfPage(pdfDocument.pdfDocument, pageNumber), firstSaveTarget, requestId);
            } finally {
                await pdfDocument.destroy();
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
