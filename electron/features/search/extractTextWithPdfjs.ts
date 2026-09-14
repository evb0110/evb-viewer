import {stat} from 'fs/promises';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import {
    dirname,
    join,
} from 'path';
import {
    fileURLToPath,
    pathToFileURL,
} from 'url';
// Must set up DOM stubs before importing pdfjs — the legacy build still
// references DOMMatrix at module evaluation time (canvas rendering code).
import '@electron/features/search/domPolyfill';
// Must use the legacy build — the default build uses DOMMatrix and other
// browser-only APIs that don't exist in Node.js worker threads.
import {
    getDocument,
    GlobalWorkerOptions,
    OPS,
    VerbosityLevel,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';
import { resolveUnpackedWorkerPath } from '@electron/utils/workerTask';
import { buildOcrTextLayerIndexText } from '@pdf-core';
import type { IPageText } from '@electron/features/search/pageText';
import type { IOcrWord } from '@contracts/shared';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';
import type {
    DocumentInitParameters,
    PDFDocumentLoadingTask,
} from 'pdfjs-dist/types/src/display/api';
import { assembleSearchablePageText } from '@pdf-core/pdfSearchCore';
import {
    extractPdfjsWordBoxesFromOperatorList,
    getPdfjsPageViewBox,
} from '@pdf-core/pdfjsTextGeometry';
import { createPdfjsNodeDocumentOptions } from '@electron/features/search/createPdfjsNodeDocumentOptions';
import {
    extractTextFromPdf,
    isPdfTextExtractionCapabilityError,
} from '@electron/features/search/extractTextFromPdf';

function resolvePdfjsFakeWorkerSrc() {
    // pdfjs's Node fallback dynamically imports workerSrc; the default
    // "./pdf.worker.mjs" resolves relative to the importing bundle, which
    // breaks for asar-unpacked workers. Resolve an absolute path instead.
    const moduleUrl = (import.meta as ImportMeta & {url?: string}).url;
    const bundleDir = moduleUrl === undefined ? process.cwd() : dirname(fileURLToPath(moduleUrl));
    const siblingWorkerPath = resolveUnpackedWorkerPath(bundleDir, 'pdf.worker.mjs');
    if (existsSync(siblingWorkerPath)) {
        return pathToFileURL(siblingWorkerPath).href;
    }

    // Source-context execution (unit tests, tsx) has no sibling copy; fall
    // back to the package's own worker module.
    const requireFromHere = moduleUrl === undefined
        ? createRequire(pathToFileURL(join(process.cwd(), 'package.json')))
        : createRequire(moduleUrl);
    return pathToFileURL(requireFromHere.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
}

GlobalWorkerOptions.workerSrc = resolvePdfjsFakeWorkerSrc();

const log = createLogger('pdfjsTextExtractor');
// Keep PDF.js as the compatibility route for small files. Desktop paths above
// this threshold use Poppler so extraction can stay page-bounded. This is a
// routing threshold, not a refusal to open a larger document.
const PDFJS_COMPATIBILITY_MAX_INPUT_BYTES = 16 * 1024 * 1024;
const PDFJS_RANGE_CHUNK_SIZE = 1 * 1024 * 1024;

interface IPdfjsDocumentLifecycle {
    cleanup?: () => Promise<void>;
    destroy?: () => Promise<void>;
}

async function destroyPdfjsDocument(document: IPdfjsDocumentLifecycle) {
    if (document.destroy) {
        await document.destroy();
        return;
    }
    await document.cleanup?.();
}

export interface IExtractPdfjsTextOptions {
    signal?: AbortSignal;
    onPageText?: (page: IPageText) => void;
    collectPages?: boolean;
    pages?: readonly number[];
    pageCount?: number;
    /** Keeps the independent PDF.js benchmark route active for large fixtures. */
    forcePdfjs?: boolean;
}

function isInvisibleTextRenderingMode(args: unknown) {
    return Array.isArray(args) && args[0] === 3;
}

interface IPdfjsTextItemForAssembly {
    text: string;
    separatorAfter: 'line' | 'none';
    transform: readonly number[];
    width: number;
    fontName: string;
    isGlyphRun: boolean;
    direction: string;
}

function restorePdfjsCombiningMarkOrder(text: string, direction: string) {
    if (direction !== 'rtl') {
        return text;
    }
    return text.replace(/^(\p{M}+)([^\p{M}])/u, '$2$1');
}

function isSingleScalar(text: string) {
    return text.length > 0 && Array.from(text).length === 1 && !/\s/u.test(text);
}

function areAdjacentPdfjsGlyphs(
    previous: IPdfjsTextItemForAssembly,
    current: IPdfjsTextItemForAssembly,
) {
    if (
        previous.separatorAfter === 'line'
        || previous.fontName !== current.fontName
        || !previous.isGlyphRun
        || !current.isGlyphRun
        || previous.transform.length < 6
        || current.transform.length < 6
        || !Number.isFinite(previous.width)
        || !Number.isFinite(current.width)
    ) {
        return false;
    }

    const a = previous.transform[0];
    const b = previous.transform[1];
    const previousX = previous.transform[4];
    const previousY = previous.transform[5];
    const currentX = current.transform[4];
    const currentY = current.transform[5];
    const previousVerticalScale = previous.transform[3];
    if (
        a === undefined
        || b === undefined
        || previousX === undefined
        || previousY === undefined
        || currentX === undefined
        || currentY === undefined
        || previousVerticalScale === undefined
    ) {
        return false;
    }
    const scale = Math.hypot(a, b);
    if (!Number.isFinite(scale) || scale <= Number.EPSILON) {
        return false;
    }
    const directionX = a / scale;
    const directionY = b / scale;
    const expectedX = previousX + directionX * previous.width;
    const expectedY = previousY + directionY * previous.width;
    const markContinuation = /\p{M}$/u.test(previous.text);
    const tolerance = markContinuation
        ? Math.max(0.75, Math.abs(previousVerticalScale) * 0.75)
        : Math.max(0.75, previous.width * 0.2);
    return Math.hypot(
        currentX - expectedX,
        currentY - expectedY,
    ) <= tolerance;
}

function mergePositionedPdfjsGlyphItems(items: readonly IPdfjsTextItemForAssembly[]) {
    // The repaired RTL layer deliberately creates one PDF.js item per glyph.
    // Rejoin only items whose reported origins prove adjacency. This keeps
    // the existing search assembler's word separators from becoming spaces
    // between glyphs, without maintaining another copy of OCR text.
    const merged: IPdfjsTextItemForAssembly[] = [];
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item === undefined) {
            continue;
        }
        const previous = merged.at(-1);
        const next = items[index + 1];
        if (
            // PDF.js synthesizes this separator after a zero-width combining
            // mark when it closes a bidi item. The mark stays in the output;
            // only the consumer-generated separator is ignored.
            item.text === ' '
            && previous !== undefined
            && /\p{M}$/u.test(previous.text)
            && next !== undefined
            && isSingleScalar(next.text)
            && item.width <= Math.max(0.75, previous.width * 1.25)
        ) {
            continue;
        }
        if (previous !== undefined && areAdjacentPdfjsGlyphs(previous, item)) {
            previous.text += item.text;
            previous.separatorAfter = item.separatorAfter;
            previous.transform = item.transform;
            previous.width = item.width;
            previous.isGlyphRun = true;
            continue;
        }
        merged.push({...item});
    }
    return merged.map(({
        text,
        separatorAfter,
    }) => ({
        text,
        separatorAfter,
    }));
}

export interface IPageTextWithWordBoxes extends IPageText {
    words: IOcrWord[];
    pageWidth: number;
    pageHeight: number;
    rotation: TOcrIndexRotation;
    hasInvisibleText: boolean;
}

export interface IExtractPdfjsWordBoxOptions {
    signal?: AbortSignal;
    onPageText?: (page: IPageTextWithWordBoxes) => void;
    collectPages?: boolean;
    pages?: readonly number[];
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function* iteratePageNumbers(firstPage: number, lastPage: number) {
    for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
        yield pageNumber;
    }
}

function getPdfjsTextExtractionPages(
    requestedPages: readonly number[] | undefined,
    pageCount: number,
): Iterable<number> {
    if (!requestedPages || requestedPages.length === 0) {
        return iteratePageNumbers(1, pageCount);
    }

    return Array.from(new Set(
        requestedPages
            .map(page => Math.trunc(page))
            .filter(page => page >= 1 && page <= pageCount),
    )).sort((left, right) => left - right);
}

function createPdfjsPathDocumentOptions(pdfPath: string) {
    return {
        url: pdfPath,
        // A path-backed PDF must not be auto-fetched into one worker-side
        // document buffer. PDF.js asks Node for the ranges needed by each page.
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: PDFJS_RANGE_CHUNK_SIZE,
        ...createPdfjsNodeDocumentOptions({VerbosityLevel}),
    };
}

function createPdfjsLoadingTask(options: DocumentInitParameters): PDFDocumentLoadingTask {
    const typedGetDocument: (
        options: DocumentInitParameters,
    ) => PDFDocumentLoadingTask = getDocument;
    return typedGetDocument(options);
}

async function withAbortSignal<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    onAbort: () => void,
): Promise<T> {
    if (!signal) {
        return promise;
    }

    if (signal.aborted) {
        onAbort();
        throw abortErrorFromSignal(signal);
    }

    return new Promise<T>((resolve, reject) => {
        const handleAbort = () => {
            onAbort();
            reject(abortErrorFromSignal(signal));
        };

        signal.addEventListener('abort', handleAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', handleAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', handleAbort);
                reject(error);
            },
        );
    });
}

export async function extractTextWithPdfjsWordBoxes(
    pdfPath: string,
    options: IExtractPdfjsWordBoxOptions = {},
): Promise<IPageTextWithWordBoxes[]> {
    const {
        signal,
        onPageText,
        collectPages = !onPageText,
    } = options;
    log.debug(`Extracting pdfjs-dist text geometry: ${pdfPath}`);
    throwIfAborted(signal);

    const loadingTask = createPdfjsLoadingTask(createPdfjsPathDocumentOptions(pdfPath));
    const doc = await withAbortSignal(loadingTask.promise, signal, () => {
        void loadingTask.destroy();
    });

    try {
        const pages: IPageTextWithWordBoxes[] = [];
        let extractedPageCount = 0;

        const pagesToExtract = getPdfjsTextExtractionPages(options.pages, doc.numPages);
        for (const pageNumber of pagesToExtract) {
            throwIfAborted(signal);
            const page = await withAbortSignal(doc.getPage(pageNumber), signal, () => {
                void destroyPdfjsDocument(doc);
            });
            try {
                const pageBox = getPdfjsPageViewBox(page);
                const operatorList = await withAbortSignal(page.getOperatorList(), signal, () => {
                    void destroyPdfjsDocument(doc);
                });
                throwIfAborted(signal);

                const words = extractPdfjsWordBoxesFromOperatorList(
                    operatorList,
                    pageBox,
                    OPS,
                    {throwIfAborted: () => throwIfAborted(signal)},
                );
                const pageText = buildOcrTextLayerIndexText(words);
                const pageWithGeometry: IPageTextWithWordBoxes = {
                    pageNumber,
                    text: pageText,
                    words,
                    pageWidth: pageBox.pageWidth,
                    pageHeight: pageBox.pageHeight,
                    rotation: pageBox.rotation,
                    hasInvisibleText: operatorList.fnArray.some((operator, index) => (
                        operator === OPS.setTextRenderingMode
                        && isInvisibleTextRenderingMode(operatorList.argsArray[index])
                    )),
                };

                extractedPageCount += 1;
                if (collectPages) {
                    pages.push(pageWithGeometry);
                }
                onPageText?.(pageWithGeometry);
            } finally {
                page.cleanup();
            }
        }

        log.debug(`Extracted ${extractedPageCount} pages with pdfjs-dist geometry`);
        return pages;
    } finally {
        await destroyPdfjsDocument(doc);
        await loadingTask.destroy();
    }
}

export async function extractTextWithPdfjs(
    pdfPath: string,
    options: IExtractPdfjsTextOptions = {},
): Promise<IPageText[]> {
    const {
        signal,
        onPageText,
        collectPages = !onPageText,
        pages: requestedPages,
        forcePdfjs = false,
    } = options;
    log.debug(`Extracting desktop PDF text: ${pdfPath}`);
    throwIfAborted(signal);

    const fileStat = await stat(pdfPath);
    if (fileStat.size > PDFJS_COMPATIBILITY_MAX_INPUT_BYTES && !forcePdfjs) {
        return extractTextFromPdf(pdfPath, {
            ...(options.pageCount === undefined ? {} : {pageCount: options.pageCount}),
            ...(requestedPages === undefined ? {} : {pages: requestedPages}),
            ...(signal === undefined ? {} : {signal}),
            collectPages,
            ...(onPageText === undefined ? {} : {onPageText}),
        });
    }

    const loadingTask = createPdfjsLoadingTask(createPdfjsPathDocumentOptions(pdfPath));
    try {
        const doc = await withAbortSignal(loadingTask.promise, signal, () => {
            void loadingTask.destroy();
        });

        try {
            const pages: IPageText[] = [];
            let extractedPageCount = 0;
            const pagesToExtract = getPdfjsTextExtractionPages(requestedPages, doc.numPages);

            for (const pageNumber of pagesToExtract) {
                throwIfAborted(signal);
                const page = await withAbortSignal(doc.getPage(pageNumber), signal, () => {
                    void destroyPdfjsDocument(doc);
                });
                try {
                    const content = await withAbortSignal(
                        page.getTextContent({
                            includeMarkedContent: true,
                            disableNormalization: true,
                        }),
                        signal,
                        () => {
                            void destroyPdfjsDocument(doc);
                        },
                    );
                    throwIfAborted(signal);

                    const textItems: IPdfjsTextItemForAssembly[] = [];
                    for (const item of content.items) {
                        throwIfAborted(signal);
                        if ('str' in item) {
                            const textItem = item;
                            textItems.push({
                                separatorAfter: textItem.hasEOL ? 'line' : 'none',
                                transform: textItem.transform,
                                width: textItem.width,
                                fontName: textItem.fontName,
                                text: restorePdfjsCombiningMarkOrder(textItem.str, textItem.dir),
                                isGlyphRun: isSingleScalar(textItem.str)
                                    || (textItem.dir === 'rtl' && /^\p{M}+[^\p{M}]$/u.test(textItem.str)),
                                direction: textItem.dir,
                            });
                        }
                    }

                    const pageText = {
                        pageNumber,
                        text: assembleSearchablePageText(mergePositionedPdfjsGlyphItems(textItems)).text,
                    };
                    extractedPageCount += 1;
                    if (collectPages) {
                        pages.push(pageText);
                    }
                    onPageText?.(pageText);
                } finally {
                    page.cleanup();
                }
            }

            log.debug(`Extracted ${extractedPageCount} pages with pdfjs-dist path ranges`);
            return pages;
        } finally {
            await destroyPdfjsDocument(doc);
            await loadingTask.destroy();
        }
    } catch (error) {
        if (isPdfTextExtractionCapabilityError(error) || isAbortError(error)) {
            throw error;
        }
        // PDF.js remains a useful compatibility path for small desktop files,
        // but a failed read can still be retried through bounded Poppler text.
        log.debug(`PDF.js path text extraction failed; falling back to Poppler: ${getErrorMessage(error)}`);
        return extractTextFromPdf(pdfPath, {
            ...(options.pageCount === undefined ? {} : {pageCount: options.pageCount}),
            ...(requestedPages === undefined ? {} : {pages: requestedPages}),
            ...(signal === undefined ? {} : {signal}),
            collectPages,
            ...(onPageText === undefined ? {} : {onPageText}),
        });
    }
}
