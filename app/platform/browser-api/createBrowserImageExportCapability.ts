import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type * as UTIFModule from 'utif';
import {
    range,
    sumBy,
    clamp,
} from 'es-toolkit/math';
import type {
    IImageExportProgress,
    TImageExportProgressFormat,
} from '@contracts/electronApiDocuments';
import type {
    IMAGE_EXPORT_PLATFORM_FEATURE,
    IImageExportCapability,
} from '@contracts/imageExportPlatformFeature';
import type { TFeatureBrowserBindings } from '@contracts/platformFeature';
import {
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browserDocumentStore';
import {
    createPdfjsDocumentInitFromBrowserDocument,
    getPdfjsLib,
} from '@app/platform/browser-api/browserPdfjsDocumentInit';
import { EXPORT_RENDER_SCALE } from '@app/platform/browser-api/browserImageExportConfig';
import { ensurePdfExtension } from '@app/platform/browser-api/browserFileName';
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
import {
    createDjvuWorkerFromPath,
    getDjvuWorkerPageSizes,
} from '@app/platform/browser-api/createDjvuWorkerFromPath';
import { assertBrowserDjvuRasterDimensions } from '@app/platform/browser-api/assertBrowserDjvuRasterDimensions';
import { isNativeLegacyDocumentRef } from '@contracts/documentRef';
import {PdfCombineCapabilityError} from '@contracts/pdfCombineErrors';

type TBrowserImageExportFormat = 'jpeg' | 'png' | 'tiff';
type TBrowserImageExportProgressPayload = Omit<IImageExportProgress, 'format' | 'requestId'>;
type TUtifModule = typeof UTIFModule;

interface IRenderedPdfPage {
    pageNumber: number;
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

const BROWSER_INLINE_TIFF_EXPORT_MAX_RGBA_BYTES = 64 * 1024 * 1024;
const imageExportProgressListeners = new Set<(progress: IImageExportProgress) => void>();
let utifModulePromise: Promise<TUtifModule> | null = null;

function assertBrowserImageExportSource(path: string) {
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

function normalizeBrowserExportRequestId(requestId: unknown) {
    return typeof requestId === 'string' ? requestId.trim() : '';
}

function emitBrowserImageExportProgress(
    requestId: string | undefined,
    format: TImageExportProgressFormat,
    progress: TBrowserImageExportProgressPayload,
) {
    const normalizedRequestId = normalizeBrowserExportRequestId(requestId);
    if (!normalizedRequestId) {
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
    pageNumber: number;
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
}

function releaseCanvas(canvas: HTMLCanvasElement) {
    canvas.width = 0;
    canvas.height = 0;
}

function resolveBrowserImageExportExtension(format: TBrowserImageExportFormat) {
    if (format === 'jpeg') {
        return '.jpg';
    }
    if (format === 'tiff') {
        return '.tif';
    }
    return '.png';
}

function resolveBrowserImageMimeType(format: TBrowserImageExportFormat) {
    if (format === 'jpeg') {
        return 'image/jpeg';
    }
    if (format === 'tiff') {
        return 'image/tiff';
    }
    return 'image/png';
}

function resolveBrowserImageExportFormat(fileName: string): TBrowserImageExportFormat {
    if (/\.png$/iu.test(fileName)) {
        return 'png';
    }
    if (/\.(?:tif|tiff)$/iu.test(fileName)) {
        return 'tiff';
    }
    return 'jpeg';
}

function normalizeBrowserImageExportFileName(
    fileName: string,
    fallbackFormat: TBrowserImageExportFormat,
) {
    const trimmedFileName = fileName.trim();
    if (/\.(?:jpg|jpeg|png|tif|tiff)$/iu.test(trimmedFileName)) {
        return trimmedFileName;
    }
    return `${trimmedFileName}${resolveBrowserImageExportExtension(fallbackFormat)}`;
}

function buildBrowserImageExportFileName(
    pageNumber: number,
    format: TBrowserImageExportFormat = 'jpeg',
) {
    return `page-${String(pageNumber).padStart(3, '0')}${resolveBrowserImageExportExtension(format)}`;
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
            pageNumber,
            canvas,
            context,
        });
    } finally {
        if (canvas) {
            releaseCanvas(canvas);
        }
        try {
            await Promise.resolve(page.cleanup?.());
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
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            return {
                pageNumber,
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

async function renderPdfPageToImageBytes(
    pdfDocument: Pick<IPdfDocument, 'getPage'>,
    pageNumber: number,
    format: TBrowserImageExportFormat,
) {
    if (format === 'tiff') {
        const rendered = await renderPdfPage(pdfDocument, pageNumber);
        const encoder = await loadUtifEncoder();
        return {
            bytes: encodeMultiPageTiff([{
                rgba: rendered.rgba,
                width: rendered.width,
                height: rendered.height,
            }], encoder),
            mimeType: resolveBrowserImageMimeType(format),
        };
    }

    return withRenderedPdfPageCanvas(pdfDocument, pageNumber, async ({ canvas }) => {
        const imageBlob = await canvasToBlob(
            canvas,
            resolveBrowserImageMimeType(format),
            format === 'jpeg' ? 0.92 : undefined,
        );
        return {
            bytes: new Uint8Array(await imageBlob.arrayBuffer()),
            mimeType: resolveBrowserImageMimeType(format),
        };
    });
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
        });

        try {
            await Promise.resolve(page.cleanup?.());
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
            const descriptor = pageDescriptors[index]!;
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
            const descriptor = pageDescriptors[index]!;
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
        const descriptor = pageDescriptors[index]!;
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

async function encodeTiffToWritable(
    pdfDocument: Pick<IPdfDocument, 'getPage'>,
    pageDescriptors: IBrowserTiffPageDescriptor[],
    encoder: ITiffEncoderModule,
    handle: FileSystemFileHandle,
    onPageWritten?: (processed: number) => void,
) {
    return encodeRenderedTiffToWritable(
        pageDescriptors,
        encoder,
        pageNumber => renderPdfPage(pdfDocument, pageNumber),
        handle,
        onPageWritten,
    );
}

async function encodeTiffToBytes(
    pdfDocument: Pick<IPdfDocument, 'getPage'>,
    pageDescriptors: IBrowserTiffPageDescriptor[],
    encoder: ITiffEncoderModule,
    onPageWritten?: (processed: number) => void,
) {
    return encodeRenderedTiffToBytes(
        pageDescriptors,
        encoder,
        pageNumber => renderPdfPage(pdfDocument, pageNumber),
        onPageWritten,
    );
}

async function storeTiffAtHandle(
    fileName: string,
    handle: FileSystemFileHandle,
    fileSize: number,
) {
    const outputRef = await browserDocumentStore.createStoredDocument(
        fileName,
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
        saveName: fileName,
    });
    await browserDocumentStore.touchRecentFile(outputRef);
    return outputRef;
}

async function loadPdfDocument(path: string) {
    const pdfjsLib = await getPdfjsLib();
    let rejectRangeReadFailure: ((error: Error) => void) | null = null;
    const rangeReadFailure = new Promise<never>((_resolve, reject) => {
        rejectRangeReadFailure = reject;
    });
    const loadingTask = pdfjsLib.getDocument(await createPdfjsDocumentInitFromBrowserDocument(pdfjsLib, path, {onRangeReadFailure: (error) => {
        const reject = rejectRangeReadFailure;
        rejectRangeReadFailure = null;
        reject?.(error);
    }}));
    let pdfDocument: Awaited<typeof loadingTask.promise>;
    try {
        pdfDocument = await Promise.race([
            loadingTask.promise,
            rangeReadFailure,
        ]);
    } catch (error) {
        await loadingTask.destroy();
        throw error;
    } finally {
        rejectRangeReadFailure = null;
    }
    return {
        pdfDocument,
        destroy: async () => {
            await pdfDocument.destroy();
        },
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
    workingCopyPath: string,
    pageNumbers: number[] | undefined,
    requestId: string | undefined,
) {
    const worker = await createDjvuWorkerFromPath(workingCopyPath);
    const outputRefs: string[] = [];
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
            const rendered = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
            try {
                const response = await fetch(rendered.url);
                if (!response.ok) throw new Error(`Failed to render DjVu page ${pageNumber}`);
                const bytes = new Uint8Array(await response.arrayBuffer());
                const saveResult = await saveBytesToPickerOrDownload(bytes, {
                    suggestedName: `document-page-${String(pageNumber).padStart(3, '0')}.png`,
                    mimeType: 'image/png',
                    pickerTypes: buildImageExportPickerTypes(),
                });
                if (saveResult.canceled) {
                    return {
                        success: false as const,
                        canceled: true as const,
                    };
                }
                const outputRef = await browserDocumentStore.createStoredDocument(saveResult.fileName, bytes, {
                    mimeType: 'image/png',
                    saveKind: 'generic',
                    kind: 'output',
                    retention: 'transient',
                    saveHandle: saveResult.handle ?? null,
                    storageMode: saveResult.handle ? 'handle' : 'inline',
                });
                await browserDocumentStore.touchRecentFile(outputRef);
                outputRefs.push(outputRef);
                emitBrowserImageExportProgress(requestId, 'images', {
                    phase: 'rendering',
                    processed: index + 1,
                    total: targetPages.length,
                    percent: ((index + 1) / targetPages.length) * 100,
                });
            } finally {
                worker.revokeObjectURL(rendered.url);
            }
        }
        return {
            success: true as const,
            outputPaths: outputRefs,
        };
    } finally {
        worker.terminate();
    }
}

async function decodePngToRgba(bytes: Uint8Array) {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], {type: 'image/png'}));
    const canvas = document.createElement('canvas');
    try {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d', {willReadFrequently: true});
        if (!context) throw new Error('Canvas 2D context is unavailable for DjVu TIFF export');
        context.drawImage(bitmap, 0, 0);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        return {
            width: canvas.width,
            height: canvas.height,
            rgba: new Uint8Array(image.data.buffer.slice(0)),
        };
    } finally {
        bitmap.close();
        releaseCanvas(canvas);
    }
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
        return await decodePngToRgba(new Uint8Array(await response.arrayBuffer()));
    } finally {
        worker.revokeObjectURL(rendered.url);
    }
}

function buildDjvuTiffPageDescriptors(
    sizes: Array<{
        width: number;
        height: number;
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
        };
    });
}

async function exportBrowserDjvuAsTiff(
    workingCopyPath: string,
    pageNumbers: number[] | undefined,
    requestId: string | undefined,
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

        const pageDescriptors = buildDjvuTiffPageDescriptors(sizes, targetPages);
        const estimatedRgbaBytes = sumBy(pageDescriptors, descriptor => descriptor.dataLength);
        if (estimatedRgbaBytes > BROWSER_INLINE_TIFF_EXPORT_MAX_RGBA_BYTES) {
            throw new Error('Browser DjVu TIFF export exceeds the 64MB decoded-image limit');
        }

        const saveTarget = await pickSaveTarget({
            suggestedName: 'document.tiff',
            pickerTypes: buildTiffSaveTypes(),
        });
        if (saveTarget.canceled) {
            return {
                success: false as const,
                canceled: true as const,
            };
        }

        const encoder = await loadUtifEncoder();
        const emitPageProgress = (processed: number) => emitBrowserImageExportProgress(requestId, 'multipage-tiff', {
            phase: 'rendering',
            processed,
            total: pageDescriptors.length,
            percent: (processed / pageDescriptors.length) * 90,
        });
        emitPageProgress(0);
        const renderPage: TTiffPageRenderer = pageNumber => renderBrowserDjvuPage(worker, pageNumber);

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
            const outputRef = await storeTiffAtHandle(saveTarget.fileName, saveTarget.handle, fileSize);
            return {
                success: true as const,
                outputPath: outputRef,
                outputPaths: [outputRef],
            };
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
    } finally {
        worker.terminate();
    }
}

export function createBrowserImageExportCapability(): IImageExportCapability {
    return {
        async exportPdfToImages(workingCopyPath, pageNumbers, requestId, sourceKind) {
            assertBrowserImageExportSource(workingCopyPath);
            if (sourceKind === 'djvu') {
                return exportBrowserDjvuPagesAsImages(workingCopyPath, pageNumbers, requestId);
            }
            const pdfDocument = await loadPdfDocument(workingCopyPath);
            let targetPages: number[];
            try {
                targetPages = getTargetPages(pdfDocument.pdfDocument, pageNumbers);
            } catch (error) {
                await pdfDocument.destroy();
                throw error;
            }
            const outputRefs: string[] = [];

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
                    const pageNumber = targetPages[index]!;
                    const saveTarget = await pickSaveTarget({
                        suggestedName: buildBrowserImageExportFileName(pageNumber),
                        pickerTypes: buildImageExportPickerTypes(),
                    });
                    if (saveTarget.canceled) {
                        await Promise.allSettled(
                            outputRefs.map(async (outputRef) => {
                                await browserDocumentStore.cleanupDetachedDocument(outputRef);
                            }),
                        );
                        return {
                            success: false,
                            canceled: true,
                        };
                    }

                    const format = resolveBrowserImageExportFormat(saveTarget.fileName);
                    const renderedPage = await renderPdfPageToImageBytes(
                        pdfDocument.pdfDocument,
                        pageNumber,
                        format,
                    );
                    let saveName = normalizeBrowserImageExportFileName(saveTarget.fileName, format);
                    let saveHandle = saveTarget.handle ?? null;

                    if (saveTarget.handle) {
                        await writeBytesToHandle(saveTarget.handle, renderedPage.bytes);
                    } else {
                        const downloadResult = await saveBytesToPickerOrDownload(renderedPage.bytes, {
                            suggestedName: saveName,
                            mimeType: renderedPage.mimeType,
                            pickerTypes: buildImageExportPickerTypes(),
                        });
                        if (downloadResult.canceled) {
                            await Promise.allSettled(
                                outputRefs.map(async (outputRef) => {
                                    await browserDocumentStore.cleanupDetachedDocument(outputRef);
                                }),
                            );
                            return {
                                success: false,
                                canceled: true,
                            };
                        }
                        saveName = normalizeBrowserImageExportFileName(downloadResult.fileName, format);
                        saveHandle = downloadResult.handle ?? null;
                    }

                    const outputRef = await browserDocumentStore.createStoredDocument(
                        saveName,
                        saveHandle ? new Uint8Array() : renderedPage.bytes,
                        {
                            mimeType: renderedPage.mimeType,
                            saveKind: 'generic',
                            kind: 'output',
                            retention: 'transient',
                            saveHandle,
                            ...(saveHandle ? { storageMode: 'handle' as const } : {}),
                        },
                    );
                    if (saveHandle) {
                        await browserDocumentStore.replaceWithHandleBackedDocument(outputRef, {
                            fileSize: renderedPage.bytes.byteLength,
                            saveHandle,
                            saveName,
                        });
                    }
                    await browserDocumentStore.touchRecentFile(outputRef);
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
                await Promise.allSettled(
                    outputRefs.map(async (outputRef) => {
                        await browserDocumentStore.cleanupDetachedDocument(outputRef);
                    }),
                );
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
            const pdfDocument = await loadPdfDocument(workingCopyPath);
            try {
                const targetPages = getTargetPages(pdfDocument.pdfDocument, pageNumbers);
                const outputFileName = ensurePdfExtension(
                    getBrowserDocumentFileName(workingCopyPath).replace(/\.pdf$/iu, ''),
                ).replace(/\.pdf$/iu, '.tiff');

                if (targetPages.length === 0) {
                    return {
                        success: false,
                        canceled: true,
                    };
                }

                const descriptors = await collectTiffPageDescriptors(pdfDocument.pdfDocument, targetPages);
                const saveTarget = await pickSaveTarget({
                    suggestedName: outputFileName,
                    pickerTypes: buildTiffSaveTypes(),
                });

                if (saveTarget.canceled) {
                    return {
                        success: false,
                        canceled: true,
                    };
                }

                const encoder = await loadUtifEncoder();
                const emitPageProgress = (processed: number) => emitBrowserImageExportProgress(requestId, 'multipage-tiff', {
                    phase: 'rendering',
                    processed,
                    total: descriptors.length,
                    percent: (processed / descriptors.length) * 90,
                });
                emitPageProgress(0);

                if (saveTarget.handle) {
                    const fileSize = await encodeTiffToWritable(
                        pdfDocument.pdfDocument,
                        descriptors,
                        encoder,
                        saveTarget.handle,
                        emitPageProgress,
                    );
                    emitBrowserImageExportProgress(requestId, 'multipage-tiff', {
                        phase: 'combining',
                        processed: 1,
                        total: 1,
                        percent: 100,
                    });
                    const outputRef = await storeTiffAtHandle(saveTarget.fileName, saveTarget.handle, fileSize);
                    return {
                        success: true,
                        outputPath: outputRef,
                        outputPaths: [outputRef],
                    };
                }

                const estimatedRgbaBytes = sumBy(descriptors, descriptor => descriptor.dataLength);
                if (estimatedRgbaBytes > BROWSER_INLINE_TIFF_EXPORT_MAX_RGBA_BYTES) {
                    throw new Error(
                        `Multi-page TIFF export without a file handle is disabled for exports larger than ${Math.floor(BROWSER_INLINE_TIFF_EXPORT_MAX_RGBA_BYTES / (1024 * 1024))}MB`,
                    );
                }

                const tiffBytes = await encodeTiffToBytes(
                    pdfDocument.pdfDocument,
                    descriptors,
                    encoder,
                    emitPageProgress,
                );
                emitBrowserImageExportProgress(requestId, 'multipage-tiff', {
                    phase: 'combining',
                    processed: 1,
                    total: 1,
                    percent: 100,
                });

                const saveResult = await saveBytesToPickerOrDownload(tiffBytes, {
                    suggestedName: saveTarget.fileName,
                    mimeType: 'image/tiff',
                    pickerTypes: buildTiffSaveTypes(),
                });

                if (saveResult.canceled) {
                    return {
                        success: false,
                        canceled: true,
                    };
                }

                const outputRef = await browserDocumentStore.createStoredDocument(
                    saveResult.fileName,
                    tiffBytes,
                    {
                        mimeType: 'image/tiff',
                        saveKind: 'generic',
                        kind: 'output',
                        retention: 'transient',
                        saveHandle: saveResult.handle ?? null,
                        storageMode: saveResult.handle ? 'handle' : 'inline',
                    },
                );
                await browserDocumentStore.touchRecentFile(outputRef);
                return {
                    success: true,
                    outputPath: outputRef,
                    outputPaths: [outputRef],
                };
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

function encodeMultiPageTiff(
    pages: Array<{
        rgba: Uint8Array;
        width: number;
        height: number;
    }>,
    encoder: ITiffEncoderModule,
) {
    if (pages.length === 0) {
        throw new Error('No pages available for TIFF export');
    }

    const pageDescriptors = pages.map((page, index) => ({
        pageNumber: index + 1,
        width: page.width,
        height: page.height,
        dataLength: page.rgba.byteLength,
    }));
    const {
        firstDataOffset,
        output,
    } = createMultiPageTiffOutput(pageDescriptors, encoder);
    let offset = firstDataOffset;
    for (const page of pages) {
        output.set(page.rgba, offset);
        offset += page.rgba.byteLength;
    }

    return output;
}
