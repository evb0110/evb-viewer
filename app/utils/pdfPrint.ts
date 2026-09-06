import type {
    IPdfDocument,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { range } from 'es-toolkit/math';
import pdfjsLib, {
    createPdfjsDocumentOptions,
    preparePdfjsBrowserRuntime,
} from '@app/services/pdfjs/runtimeLib';
import {
    BROWSER_PRINT_ROOT_SELECTOR,
    normalizePrintPageNumbers,
    type IBrowserPrintCanvas,
    type IBrowserPrintDocument,
    type IBrowserPrintRoot,
    type IBrowserPrintStyleElement,
} from '@app/utils/pdfPrintShared';
export {
    buildPrintSpreadGroups,
    buildPrintablePdfData,
    canPrintSourcePdfDirectly,
    shouldPrintPageMetricsDirectly,
    shouldPrintSourcePdfDirectly,
} from '@pdf-core';

interface IRenderPdfPagesForBrowserPrintOptions {signal?: AbortSignal;}

const BROWSER_PRINT_RESOLUTION_DPI = 300;
const PDF_POINTS_PER_INCH = 72;
const BROWSER_PRINT_RENDER_SCALE = BROWSER_PRINT_RESOLUTION_DPI / PDF_POINTS_PER_INCH;
const BROWSER_PRINT_PAGE_SIZE_TOLERANCE_PT = 0.5;
const BROWSER_PRINT_MAX_INPUT_BYTES = 256 * 1024 * 1024;
const BROWSER_PRINT_MAX_RESIDENT_CANVAS_BYTES = 256 * 1024 * 1024;
const BROWSER_PRINT_MAX_CANVAS_PIXELS = 64 * 1024 * 1024;
const BROWSER_PRINT_MAX_CANVAS_DIMENSION = 32_767;

function createBrowserPrintAbortError() {
    const error = new Error('Print preparation was canceled');
    error.name = 'AbortError';
    return error;
}

function throwIfBrowserPrintAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw createBrowserPrintAbortError();
    }
}

async function getPdfjsPrintLib() {
    await preparePdfjsBrowserRuntime(pdfjsLib);
    return pdfjsLib;
}

function clonePdfBytes(data: Uint8Array | ArrayBufferLike) {
    const source = data instanceof Uint8Array ? data : new Uint8Array(data);
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy;
}

function getBrowserPrintRoot(targetDocument: IBrowserPrintDocument) {
    const root = targetDocument.querySelector(BROWSER_PRINT_ROOT_SELECTOR);
    if (root && typeof root.append === 'function' && typeof root.replaceChildren === 'function') {
        return root;
    }

    throw new Error('Missing browser print root');
}

function createBrowserPrintPageContainer(targetDocument: IBrowserPrintDocument) {
    const element = targetDocument.createElement('section');
    if ('append' in element && 'className' in element) {
        return element;
    }

    throw new Error('Failed to create browser print page container');
}

function isBrowserPrintCanvas(element: unknown): element is IBrowserPrintCanvas {
    return typeof element === 'object'
        && element !== null
        && 'getContext' in element
        && typeof element.getContext === 'function'
        && 'style' in element
        && typeof element.style === 'object'
        && element.style !== null;
}

function requireBrowserPrintCanvas(element: unknown) {
    if (isBrowserPrintCanvas(element)) {
        return element;
    }

    throw new Error('Failed to create browser print canvas');
}

function createBrowserPrintCanvas(targetDocument: IBrowserPrintDocument) {
    if (
        typeof document !== 'undefined'
        && document !== targetDocument
        && typeof document.createElement === 'function'
    ) {
        return requireBrowserPrintCanvas(document.createElement('canvas'));
    }

    return requireBrowserPrintCanvas(targetDocument.createElement('canvas'));
}

function formatPdfPointSizeAsCssInches(sizeInPoints: number) {
    const sizeInInches = Math.max(1, sizeInPoints) / PDF_POINTS_PER_INCH;
    return `${Number(sizeInInches.toFixed(4))}in`;
}

function formatPdfPointSizeAsCssPoints(sizeInPoints: number) {
    return `${Number(Math.max(1, sizeInPoints).toFixed(2))}pt`;
}

function setBrowserPrintPageSize(
    targetDocument: IBrowserPrintDocument,
    width: number,
    height: number,
) {
    const head = (targetDocument as IBrowserPrintDocument & {head?: { appendChild?: (node: IBrowserPrintStyleElement) => unknown } | null;}).head;
    if (!head || typeof head.appendChild !== 'function') {
        return;
    }

    const style = targetDocument.createElement('style') as IBrowserPrintStyleElement;
    style.textContent = `
        @page {
            size: ${formatPdfPointSizeAsCssPoints(width)} ${formatPdfPointSizeAsCssPoints(height)};
            margin: 0;
        }
    `;
    head.appendChild(style);
}

function assertBrowserPrintPageMatchesFirstPage(
    pageNumber: number,
    width: number,
    height: number,
    firstPageSize: {
        width: number;
        height: number;
    },
) {
    const widthDelta = Math.abs(width - firstPageSize.width);
    const heightDelta = Math.abs(height - firstPageSize.height);

    if (
        widthDelta > BROWSER_PRINT_PAGE_SIZE_TOLERANCE_PT
        || heightDelta > BROWSER_PRINT_PAGE_SIZE_TOLERANCE_PT
    ) {
        throw new Error(
            `Browser printing does not support mixed page sizes or orientations. Page ${pageNumber} is ${width.toFixed(2)}x${height.toFixed(2)}pt, but page 1 is ${firstPageSize.width.toFixed(2)}x${firstPageSize.height.toFixed(2)}pt.`,
        );
    }
}

export async function renderPdfPagesForBrowserPrint(
    targetDocument: IBrowserPrintDocument,
    printablePdf: Blob | Uint8Array,
    options: IRenderPdfPagesForBrowserPrintOptions = {},
) {
    const root = getBrowserPrintRoot(targetDocument);
    root.replaceChildren();

    const pdfjsLib = await getPdfjsPrintLib();
    if (printablePdf instanceof Blob && printablePdf.size > BROWSER_PRINT_MAX_INPUT_BYTES) {
        throw new RangeError('Browser print input exceeds 256 MiB; use native printing');
    }
    if (printablePdf instanceof Uint8Array && printablePdf.byteLength > BROWSER_PRINT_MAX_INPUT_BYTES) {
        throw new RangeError('Browser print input exceeds 256 MiB; use native printing');
    }
    const pdfData = printablePdf instanceof Blob
        ? new Uint8Array(await printablePdf.arrayBuffer())
        : clonePdfBytes(printablePdf);
    const loadingTask = pdfjsLib.getDocument({
        data: pdfData,
        ...createPdfjsDocumentOptions(pdfjsLib),
    });
    let pdfDocument: IPdfDocument;
    try {
        throwIfBrowserPrintAborted(options.signal);
        pdfDocument = await loadingTask.promise;
        throwIfBrowserPrintAborted(options.signal);
    } catch (error) {
        await loadingTask.destroy();
        throwIfBrowserPrintAborted(options.signal);
        throw error;
    }

    try {
        await renderPdfPageNumbersForBrowserPrint(
            targetDocument,
            root,
            range(1, pdfDocument.numPages + 1),
            pageNumber => pdfDocument.getPage(pageNumber),
            options,
        );
    } finally {
        await pdfDocument.destroy();
        await loadingTask.destroy();
    }
}

export async function renderPdfDocumentPagesForBrowserPrint(
    targetDocument: IBrowserPrintDocument,
    pdfDocument: IPdfDocument,
    pageNumbers: number[],
    options: IRenderPdfPagesForBrowserPrintOptions = {},
) {
    const root = getBrowserPrintRoot(targetDocument);
    root.replaceChildren();
    await renderPdfPageNumbersForBrowserPrint(
        targetDocument,
        root,
        normalizePrintPageNumbers(pageNumbers, pdfDocument.numPages),
        pageNumber => pdfDocument.getPage(pageNumber),
        options,
    );
}

async function renderPdfPageNumbersForBrowserPrint(
    targetDocument: IBrowserPrintDocument,
    root: IBrowserPrintRoot,
    pageNumbers: number[],
    getPage: (pageNumber: number) => Promise<IPdfPage>,
    options: IRenderPdfPagesForBrowserPrintOptions,
) {
    let firstPageSize: {
        width: number;
        height: number;
    } | null = null;
    let residentCanvasBytes = 0;

    try {
        for (const pageNumber of pageNumbers) {
            throwIfBrowserPrintAborted(options.signal);
            const page = await getPage(pageNumber);

            try {
                throwIfBrowserPrintAborted(options.signal);
                const displayViewport = page.getViewport({ scale: 1 });
                if (!firstPageSize) {
                    firstPageSize = {
                        width: displayViewport.width,
                        height: displayViewport.height,
                    };
                    setBrowserPrintPageSize(targetDocument, displayViewport.width, displayViewport.height);
                } else {
                    assertBrowserPrintPageMatchesFirstPage(
                        pageNumber,
                        displayViewport.width,
                        displayViewport.height,
                        firstPageSize,
                    );
                }

                const renderViewport = page.getViewport({ scale: BROWSER_PRINT_RENDER_SCALE });
                const pageContainer = createBrowserPrintPageContainer(targetDocument);
                pageContainer.className = 'browser-print-page';

                const canvas = createBrowserPrintCanvas(targetDocument);
                const canvasWidth = Math.max(1, Math.ceil(renderViewport.width));
                const canvasHeight = Math.max(1, Math.ceil(renderViewport.height));
                const canvasPixels = canvasWidth * canvasHeight;
                if (
                    canvasWidth > BROWSER_PRINT_MAX_CANVAS_DIMENSION
                || canvasHeight > BROWSER_PRINT_MAX_CANVAS_DIMENSION
                || canvasPixels > BROWSER_PRINT_MAX_CANVAS_PIXELS
                ) {
                    throw new RangeError(`Page ${pageNumber} exceeds the browser print surface limit; use native printing`);
                }
                const canvasBytes = canvasPixels * 4;
                if (residentCanvasBytes + canvasBytes > BROWSER_PRINT_MAX_RESIDENT_CANVAS_BYTES) {
                    throw new RangeError('Browser print pages exceed the 256 MiB canvas budget; use native printing');
                }
                residentCanvasBytes += canvasBytes;
                canvas.width = canvasWidth;
                canvas.height = canvasHeight;
                canvas.style.width = formatPdfPointSizeAsCssInches(displayViewport.width);
                canvas.style.height = formatPdfPointSizeAsCssInches(displayViewport.height);

                const context = canvas.getContext('2d', { alpha: false });
                if (!context) {
                    throw new Error('Failed to create browser print canvas');
                }

                const renderTask = page.render({
                    canvas: context.canvas,
                    canvasContext: context,
                    viewport: renderViewport,
                });
                const abortRender = () => renderTask.cancel();
                options.signal?.addEventListener('abort', abortRender, { once: true });
                try {
                    throwIfBrowserPrintAborted(options.signal);
                    await renderTask.promise;
                    throwIfBrowserPrintAborted(options.signal);
                } catch (error) {
                    throwIfBrowserPrintAborted(options.signal);
                    throw error;
                } finally {
                    options.signal?.removeEventListener('abort', abortRender);
                }

                pageContainer.append(canvas);
                root.append(pageContainer);
            } finally {
                if (typeof page.cleanup === 'function') {
                    page.cleanup();
                }
            }
        }
    } catch (error) {
        root.replaceChildren();
        throw error;
    }
}

export function waitForPrintPaint(targetWindow: Window) {
    return new Promise<void>((resolve) => {
        const raf = typeof targetWindow.requestAnimationFrame === 'function'
            ? targetWindow.requestAnimationFrame.bind(targetWindow)
            : null;

        if (!raf) {
            resolve();
            return;
        }

        raf(() => raf(() => resolve()));
    });
}
