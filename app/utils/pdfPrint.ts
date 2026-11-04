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
    type IBrowserPrintImage,
    type IBrowserPrintRoot,
    type IBrowserPrintStyleElement,
} from '@app/utils/pdfPrintShared';
export { shouldPrintPageMetricsDirectly } from '@pdf-core';

interface IRenderPdfPagesForBrowserPrintOptions {signal?: AbortSignal;}

const BROWSER_PRINT_RESOLUTION_DPI = 300;
const PDF_POINTS_PER_INCH = 72;
const BROWSER_PRINT_RENDER_SCALE = BROWSER_PRINT_RESOLUTION_DPI / PDF_POINTS_PER_INCH;
// A page whose canvas this browser cannot back is rendered again at three
// quarters of the scale, down to a page of this many pixels on its long edge.
const BROWSER_PRINT_CANVAS_RETRY_SCALE = 0.75;
const BROWSER_PRINT_MIN_CANVAS_EDGE = 512;

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

function createBrowserPrintImage(targetDocument: IBrowserPrintDocument): IBrowserPrintImage {
    const element = targetDocument.createElement('img');
    if ('src' in element && 'style' in element) {
        return element;
    }

    throw new Error('Failed to create browser print page image');
}

function createBrowserPrintCanvas(targetDocument: IBrowserPrintDocument) {
    if (
        typeof document !== 'undefined'
        && document !== targetDocument
    ) {
        return requireBrowserPrintCanvas(document.createElement('canvas'));
    }

    return requireBrowserPrintCanvas(targetDocument.createElement('canvas'));
}

// Browsers return a context for a canvas beyond their size or memory limits
// and then draw nothing on it. A pixel written and read back at the far
// corner shows whether this canvas really holds the page.
function browserPrintCanvasHoldsPixels(context: CanvasRenderingContext2D, width: number, height: number) {
    try {
        context.fillStyle = '#ff0000';
        context.fillRect(width - 1, height - 1, 1, 1);
        const [
            red,
            green,
        ] = context.getImageData(width - 1, height - 1, 1, 1).data;
        return red === 255 && green === 0;
    } catch {
        return false;
    }
}

function releaseBrowserPrintCanvas(canvas: IBrowserPrintCanvas) {
    canvas.width = 0;
    canvas.height = 0;
}

function allocateBrowserPrintCanvas(targetDocument: IBrowserPrintDocument, page: IPdfPage) {
    for (let scale = BROWSER_PRINT_RENDER_SCALE; ; scale *= BROWSER_PRINT_CANVAS_RETRY_SCALE) {
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.ceil(viewport.width));
        const height = Math.max(1, Math.ceil(viewport.height));
        const canvas = createBrowserPrintCanvas(targetDocument);
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { alpha: false });
        if (context && browserPrintCanvasHoldsPixels(context, width, height)) {
            return {
                canvas,
                context,
                viewport,
            };
        }
        releaseBrowserPrintCanvas(canvas);
        if (Math.max(width, height) <= BROWSER_PRINT_MIN_CANVAS_EDGE) {
            throw new Error('Failed to create browser print canvas');
        }
    }
}

function encodeBrowserPrintCanvas(canvas: IBrowserPrintCanvas) {
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Failed to encode a browser print page'));
        }, 'image/png');
    });
}

// The print frame's own window creates the URL, so removing the frame
// releases the page image with it.
function loadBrowserPrintImage(targetDocument: IBrowserPrintDocument, image: IBrowserPrintImage, pageImage: Blob) {
    const frameUrl = targetDocument.defaultView?.URL;
    if (!frameUrl) {
        throw new Error('Missing browser print frame window');
    }
    return new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Failed to load a browser print page'));
        image.src = frameUrl.createObjectURL(pageImage);
    });
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
    pageNumber: number,
    width: number,
    height: number,
) {
    const head = (targetDocument as IBrowserPrintDocument & {head?: { appendChild?: (node: IBrowserPrintStyleElement) => unknown } | null;}).head;
    if (!head || typeof head.appendChild !== 'function') {
        return;
    }

    const style = targetDocument.createElement('style') as IBrowserPrintStyleElement;
    const pageName = `browser-print-page-${String(pageNumber)}`;
    style.textContent = `
        @page ${pageName} {
            size: ${formatPdfPointSizeAsCssPoints(width)} ${formatPdfPointSizeAsCssPoints(height)};
            margin: 0;
        }

        .${pageName} {
            page: ${pageName};
        }
    `;
    head.appendChild(style);
}

export async function renderPdfPagesForBrowserPrint(
    targetDocument: IBrowserPrintDocument,
    printablePdf: Blob | Uint8Array,
    options: IRenderPdfPagesForBrowserPrintOptions = {},
) {
    const root = getBrowserPrintRoot(targetDocument);
    root.replaceChildren();

    const pdfjsLib = await getPdfjsPrintLib();
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
        // The loading task owns the document and its worker, so destroying
        // it is the whole disposal.
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

// One page's canvas exists at a time: each page is encoded as an image for
// the print document and its canvas is released before the next page renders.
async function renderPdfPageNumbersForBrowserPrint(
    targetDocument: IBrowserPrintDocument,
    root: IBrowserPrintRoot,
    pageNumbers: number[],
    getPage: (pageNumber: number) => Promise<IPdfPage>,
    options: IRenderPdfPagesForBrowserPrintOptions,
) {
    try {
        for (const pageNumber of pageNumbers) {
            throwIfBrowserPrintAborted(options.signal);
            const page = await getPage(pageNumber);
            let canvas: IBrowserPrintCanvas | null = null;

            try {
                throwIfBrowserPrintAborted(options.signal);
                const displayViewport = page.getViewport({ scale: 1 });
                setBrowserPrintPageSize(
                    targetDocument,
                    pageNumber,
                    displayViewport.width,
                    displayViewport.height,
                );

                const pageContainer = createBrowserPrintPageContainer(targetDocument);
                pageContainer.className = `browser-print-page browser-print-page-${String(pageNumber)}`;

                const allocated = allocateBrowserPrintCanvas(targetDocument, page);
                canvas = allocated.canvas;
                // Print intent: annotations flagged to print, not those to show.
                const renderTask = page.render({
                    canvas: allocated.context.canvas,
                    canvasContext: allocated.context,
                    viewport: allocated.viewport,
                    intent: 'print',
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

                const pageImage = await encodeBrowserPrintCanvas(canvas);
                releaseBrowserPrintCanvas(canvas);
                canvas = null;
                throwIfBrowserPrintAborted(options.signal);
                const image = createBrowserPrintImage(targetDocument);
                image.style.width = formatPdfPointSizeAsCssInches(displayViewport.width);
                image.style.height = formatPdfPointSizeAsCssInches(displayViewport.height);
                await loadBrowserPrintImage(targetDocument, image, pageImage);
                throwIfBrowserPrintAborted(options.signal);

                pageContainer.append(image);
                root.append(pageContainer);
            } finally {
                if (canvas) {
                    releaseBrowserPrintCanvas(canvas);
                }
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
