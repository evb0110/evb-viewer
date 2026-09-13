import type { TDocumentRef } from '@contracts/documentRef';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { IDjvuPagePreviewOptions } from '@contracts/electronApiDjvu';
import {
    assertDocumentAllocationSize,
    type IDocumentsFileIoCapability,
} from '@contracts/electronApiDocuments';
import {
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import {
    loadDjvuJs,
    type IDjvuContentsItem,
    type IDjvuNormalizedTextZone,
    type IDjvuPageSize,
    type IDjvuWorker,
} from '@app/platform/browser-api/djvujsLoader';
import type { IPagePreviewOutlineItem } from '@app/modules/document-viewer/public';
import { getValidatedElectronPlatformApi } from '@app/utils/electronPlatformBridge';
import {
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
    type IPdfSearchProgress,
    type IPdfSearchResponse,
} from '@contracts/search';
import {
    assembleSearchablePageText,
    buildPdfSearchExcerpt,
    iteratePdfSearchMatches,
    PDF_SEARCH_PROGRESS_RESULT_BATCH_LIMIT,
    validateSearchQuery,
    type IResolvedSearchMatchOptions,
} from '@pdf-core/pdfSearchCore';
import {
    createRequestId,
    parseRequestId,
    type IOcrWord,
    type TRequestId,
} from '@contracts/shared';
import { createNativeDjvuTextSearchBridge } from '@app/platform/browser-api/createNativeDjvuTextSearchBridge';
import { resolveDjvuPreviewResolutionPlan } from '@app/utils/djvuPreviewResolution';
import { assertBrowserDjvuRasterDimensions } from '@app/platform/browser-api/assertBrowserDjvuRasterDimensions';
import {PdfCombineCapabilityError} from '@contracts/pdfCombineErrors';
import {
    BROWSER_DJVU_INTERACTIVE_MAX_PAGES,
    DJVU_OUTLINE_MAX_DEPTH,
    DJVU_OUTLINE_MAX_NODES,
    DJVU_OUTLINE_MAX_TITLE_CHARS,
    DJVU_SEARCH_MAX_PAGE_TEXT_CHARS,
    DJVU_SEARCH_MAX_PAGE_ZONES,
} from '@contracts/djvuResourceLimits';

const DJVU_READ_CHUNK_BYTES = 4 * 1024 * 1024;
const DJVU_BROWSER_WORKER_MAX_SOURCE_BYTES = 192 * 1024 * 1024;
const DJVU_DESKTOP_DJVUJS_PREVIEW_MAX_BYTES = 96 * 1024 * 1024;

interface IDjvuWorkerReadOptions {signal?: AbortSignal;}

type TBrowserDjvuWorker = Awaited<ReturnType<typeof createDjvuWorkerFromPath>>;

interface IDjvuWorkerTextSearchOptions {
    matchOptions: IResolvedSearchMatchOptions;
    onProgress?: ((progress: IPdfSearchProgress) => void) | undefined;
    pageCount: number;
    query: string;
    requestId: TRequestId;
    signal: AbortSignal;
}

interface ISharedBrowserDjvuWorker {
    refs: number;
    worker: Promise<TBrowserDjvuWorker>;
}

const sharedViewingWorkers = new Map<TDocumentRef, ISharedBrowserDjvuWorker>();

type TDjvuDocumentFileReader = Pick<IDocumentsFileIoCapability, 'statFile' | 'readFile' | 'readFileRange'>;

function nativeDjvuCapabilityError(operation: string, message: string, cause?: unknown) {
    return new PdfCombineCapabilityError('native-unavailable', message, {
        operation,
        ...(cause === undefined ? {} : {cause}),
    });
}

interface IDjvuRenderedPageObjectUrl {
    objectUrl: string;
    renderedPx: number;
}

function toOwnedArrayBuffer(bytes: Uint8Array) {
    if (
        bytes.buffer instanceof ArrayBuffer
        && bytes.byteOffset === 0
        && bytes.byteLength === bytes.buffer.byteLength
    ) {
        return bytes.buffer;
    }

    return bytes.slice().buffer;
}

async function readBrowserDocumentBytes(
    path: TDocumentRef,
    options: IDjvuWorkerReadOptions = {},
) {
    throwIfCanceled(options.signal);
    const { size } = await browserDocumentStore.stat(path);
    if (size > DJVU_BROWSER_WORKER_MAX_SOURCE_BYTES) {
        throw new Error('Browser DjVu processing is limited to 192MB source files. Use the Electron app for this archival job.');
    }
    throwIfCanceled(options.signal);
    if (size <= 0) {
        return new Uint8Array();
    }

    const output = new Uint8Array(assertDocumentAllocationSize(size));
    let offset = 0;
    while (offset < size) {
        throwIfCanceled(options.signal);
        const chunkLength = Math.min(DJVU_READ_CHUNK_BYTES, size - offset);
        const chunk = await browserDocumentStore.readRange(path, offset, chunkLength);
        throwIfCanceled(options.signal);
        if (chunk.byteLength !== chunkLength) {
            throw new Error(`Browser DjVu source returned ${chunk.byteLength} bytes for requested ${chunkLength} byte range`);
        }
        output.set(chunk, offset);
        offset += chunkLength;
    }

    return output;
}

function getDesktopDocumentsCapability(path: TDocumentRef) {
    const platform = getValidatedElectronPlatformApi();
    if (!platform) {
        throw nativeDjvuCapabilityError(
            'djvu-read',
            `Native DjVu document file capability is unavailable for desktop path: ${path}`,
        );
    }

    return platform.documentFiles satisfies TDjvuDocumentFileReader;
}

function getDesktopDjvuPreviewCapability(path: TDocumentRef) {
    if (isBrowserDocumentRef(path)) {
        return null;
    }

    const platform = getValidatedElectronPlatformApi();
    if (!platform) {
        throw nativeDjvuCapabilityError(
            'djvu-preview',
            `Native DjVu preview capability is unavailable for desktop path: ${path}`,
        );
    }
    const djvu = platform.djvu;
    if (
        typeof djvu.getInfo !== 'function'
        || typeof djvu.getPageSourceInfo !== 'function'
        || typeof djvu.getPageSizes !== 'function'
        || typeof djvu.renderPagePreview !== 'function'
        || typeof djvu.cancelPagePreview !== 'function'
    ) {
        throw nativeDjvuCapabilityError(
            'djvu-preview',
            `Native DjVu preview capability is unavailable for desktop path: ${path}`,
        );
    }
    return djvu;
}

async function shouldUseNativeDesktopDjvuPreview(path: TDocumentRef) {
    const nativeDjvu = getDesktopDjvuPreviewCapability(path);
    if (!nativeDjvu) {
        return null;
    }

    try {
        const documents = getDesktopDocumentsCapability(path);

        const { size } = await documents.statFile(path);
        if (size > DJVU_DESKTOP_DJVUJS_PREVIEW_MAX_BYTES) {
            return nativeDjvu;
        }

        // File size is not a safe proxy for DjVu complexity. A tiny bundled
        // document may still have more pages than the browser renderer can
        // represent, so obtain the scalar native page count before allowing
        // the compatibility decoder to load the source bytes.
        const info = await nativeDjvu.getInfo(path);
        return info.pageCount > BROWSER_DJVU_INTERACTIVE_MAX_PAGES ? nativeDjvu : null;
    } catch (error) {
        if (error instanceof PdfCombineCapabilityError) {
            throw error;
        }
        return nativeDjvu;
    }
}

async function readDesktopDocumentBytes(
    path: TDocumentRef,
    options: IDjvuWorkerReadOptions = {},
) {
    const documents = getDesktopDocumentsCapability(path);

    throwIfCanceled(options.signal);
    const { size } = await documents.statFile(path);
    throwIfCanceled(options.signal);
    if (size <= 0) {
        return new Uint8Array();
    }

    if (size <= DJVU_READ_CHUNK_BYTES) {
        const bytes = await documents.readFile(path);
        throwIfCanceled(options.signal);
        return bytes;
    }

    const output = new Uint8Array(assertDocumentAllocationSize(size));
    let offset = 0;
    while (offset < size) {
        throwIfCanceled(options.signal);
        const chunkLength = Math.min(DJVU_READ_CHUNK_BYTES, size - offset);
        const chunk = await documents.readFileRange(path, offset, chunkLength);
        throwIfCanceled(options.signal);
        output.set(chunk, offset);
        offset += chunk.byteLength;
        if (chunk.byteLength === 0) {
            break;
        }
    }

    return offset === size ? output : output.slice(0, offset);
}

function throwIfCanceled(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new Error('DjVu conversion canceled');
    }
}

async function getDjvuWorkerPageCount(worker: IDjvuWorker) {
    const getPagesQuantity = worker.doc.getPagesQuantity;
    if (typeof getPagesQuantity !== 'function') {
        return null;
    }
    const pageCount = await getPagesQuantity().run();
    if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
        throw new Error('DjVu worker returned an invalid page count');
    }
    return pageCount;
}

export async function getDjvuWorkerPageSizes(worker: IDjvuWorker) {
    const pageCount = await getDjvuWorkerPageCount(worker);
    if (pageCount === null) {
        const pageSizes = await worker.doc.getPagesSizes().run();
        if (pageSizes.length > BROWSER_DJVU_INTERACTIVE_MAX_PAGES) {
            throw new Error(`DjVu viewing is capped at ${BROWSER_DJVU_INTERACTIVE_MAX_PAGES} pages`);
        }
        return pageSizes;
    }
    if (pageCount > BROWSER_DJVU_INTERACTIVE_MAX_PAGES) {
        throw new Error(`DjVu viewing is capped at ${BROWSER_DJVU_INTERACTIVE_MAX_PAGES} pages`);
    }
    const pageSizes = await worker.doc.getPagesSizes().run();
    if (pageSizes.length !== pageCount) {
        throw new Error(`DjVu worker returned ${pageSizes.length} page sizes for ${pageCount} pages`);
    }
    return pageSizes;
}

function buildBrowserDjvuSearchPage(
    text: string,
    zones: IDjvuNormalizedTextZone[] | null,
) {
    if (text.length > DJVU_SEARCH_MAX_PAGE_TEXT_CHARS) {
        throw new Error(`DjVu page text exceeds the ${DJVU_SEARCH_MAX_PAGE_TEXT_CHARS}-character search limit`);
    }
    if (!zones || zones.length === 0) {
        return {
            text,
            offsets: [] as Array<{
                startOffset: number;
                endOffset: number
            }>,
            words: [] as IOcrWord[],
        };
    }
    if (zones.length > DJVU_SEARCH_MAX_PAGE_ZONES) {
        throw new Error(`DjVu page text zones exceed the ${DJVU_SEARCH_MAX_PAGE_ZONES}-zone search limit`);
    }
    let zoneTextChars = 0;
    for (const zone of zones) {
        zoneTextChars += zone.text.length;
        if (zoneTextChars > DJVU_SEARCH_MAX_PAGE_TEXT_CHARS) {
            throw new Error(`DjVu page text zones exceed the ${DJVU_SEARCH_MAX_PAGE_TEXT_CHARS}-character search limit`);
        }
    }
    const assembled = assembleSearchablePageText(zones.map(zone => ({
        text: zone.text,
        separatorAfter: 'space',
    })));
    return {
        text: assembled.text,
        offsets: assembled.itemOffsets.map(offset => ({
            startOffset: offset.startOffset,
            endOffset: offset.endOffset,
        })),
        words: zones.map(zone => ({
            text: zone.text,
            x: zone.x,
            y: zone.y,
            width: zone.width,
            height: zone.height,
        })),
    };
}

function getSearchMatchWords(
    searchable: ReturnType<typeof buildBrowserDjvuSearchPage>,
    startOffset: number,
    endOffset: number,
) {
    let low = 0;
    let high = searchable.offsets.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const offset = searchable.offsets[middle];
        if (offset && offset.endOffset <= startOffset) low = middle + 1;
        else high = middle;
    }
    const words: IOcrWord[] = [];
    for (let index = low; index < searchable.offsets.length && words.length < 256; index += 1) {
        const offset = searchable.offsets[index];
        if (!offset) break;
        if (offset.startOffset >= endOffset) break;
        const word = searchable.words[index];
        if (word) words.push(word);
    }
    return words;
}

export async function searchDjvuWorkerText(
    worker: TBrowserDjvuWorker,
    options: IDjvuWorkerTextSearchOptions,
): Promise<IPdfSearchResponse> {
    validateSearchQuery(options.query, options.matchOptions);
    const pageSizes = await getDjvuWorkerPageSizes(worker);
    const pageCount = Math.min(options.pageCount, pageSizes.length);
    const results: Array<IPdfSearchResponse['results'][number]> = [];
    let truncated = false;
    let progressResultsStartIndex = 0;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        options.signal.throwIfAborted();
        const page = worker.doc.getPage(pageNumber);
        const [
            text,
            zones,
        ] = await Promise.all([
            page.getText().run(),
            page.getNormalizedTextZones().run().catch(() => null),
        ]);
        options.signal.throwIfAborted();
        const searchable = buildBrowserDjvuSearchPage(text, zones);
        const progressResults: Array<IPdfSearchResponse['results'][number]> = [];
        let pageMatchIndex = 0;
        for (const match of iteratePdfSearchMatches(searchable.text, options.query, options.matchOptions)) {
            if (results.length >= SEARCH_RESULT_LIMIT) {
                truncated = true;
                break;
            }
            const words = getSearchMatchWords(searchable, match.startOffset, match.endOffset);
            const pageSize = pageSizes[pageNumber - 1];
            const result: IPdfSearchResponse['results'][number] = {
                pageNumber: pageNumber as IPdfSearchResponse['results'][number]['pageNumber'],
                pageMatchIndex,
                matchIndex: results.length,
                startOffset: match.startOffset,
                endOffset: match.endOffset,
                excerpt: buildPdfSearchExcerpt(
                    searchable.text,
                    match.startOffset,
                    match.endOffset,
                    SEARCH_EXCERPT_CONTEXT_CHARS,
                ),
                ...(words.length > 0 && pageSize ? {
                    words,
                    pageWidth: pageSize.width,
                    pageHeight: pageSize.height,
                    rotation: 0 as const,
                } : {}),
            };
            results.push(result);
            progressResults.push(result);
            pageMatchIndex += 1;
        }
        if (progressResults.length === 0) {
            options.onProgress?.({
                requestId: options.requestId,
                processed: pageNumber,
                total: pageCount,
                results: [],
                resultsStartIndex: progressResultsStartIndex,
                truncated,
                status: 'running',
            });
        } else {
            for (
                let resultOffset = 0;
                resultOffset < progressResults.length;
                resultOffset += PDF_SEARCH_PROGRESS_RESULT_BATCH_LIMIT
            ) {
                options.onProgress?.({
                    requestId: options.requestId,
                    processed: pageNumber,
                    total: pageCount,
                    results: progressResults.slice(
                        resultOffset,
                        resultOffset + PDF_SEARCH_PROGRESS_RESULT_BATCH_LIMIT,
                    ),
                    resultsStartIndex: progressResultsStartIndex + resultOffset,
                    truncated,
                    status: 'running',
                });
            }
        }
        progressResultsStartIndex = results.length;
        if (truncated) {
            break;
        }
        await new Promise<void>(resolve => setTimeout(resolve, 0));
    }

    return {
        results,
        truncated,
    };
}

export async function createDjvuWorkerFromPath(
    djvuPath: TDocumentRef,
    options: IDjvuWorkerReadOptions = {},
) {
    throwIfCanceled(options.signal);
    const isBrowserRef = isBrowserDocumentRef(djvuPath);
    // A native document ref must never reach the browser decoder when the
    // desktop file bridge is absent. Check the bridge before loading DjVu.js,
    // so the caller gets the typed capability error without creating a worker
    // or attempting a weaker source read.
    if (!isBrowserRef) {
        getDesktopDocumentsCapability(djvuPath);
    }
    const djvuGlobal = await loadDjvuJs();
    throwIfCanceled(options.signal);
    const worker = new djvuGlobal.Worker();
    let abortHandler: (() => void) | null = null;

    try {
        if (options.signal) {
            abortHandler = () => {
                worker.terminate();
            };
            options.signal.addEventListener('abort', abortHandler, { once: true });
        }
        throwIfCanceled(options.signal);
        const bytes = isBrowserRef
            ? await readBrowserDocumentBytes(djvuPath, options)
            : await readDesktopDocumentBytes(djvuPath, options);
        throwIfCanceled(options.signal);
        const buffer = toOwnedArrayBuffer(bytes);

        await worker.createDocument(buffer, {});
        throwIfCanceled(options.signal);
    } catch (error) {
        worker.terminate();
        throw error;
    } finally {
        if (options.signal && abortHandler) {
            options.signal.removeEventListener('abort', abortHandler);
        }
        if (isBrowserRef) {
            browserDocumentStore.unload(djvuPath);
        }
    }

    return worker;
}

export async function retainBrowserDjvuViewingWorker(path: TDocumentRef) {
    if (!isBrowserDocumentRef(path)) {
        throw new Error('Shared DjVu viewing workers are only available for browser documents');
    }
    let entry = sharedViewingWorkers.get(path);
    if (!entry) {
        entry = {
            refs: 0,
            worker: createDjvuWorkerFromPath(path),
        };
        sharedViewingWorkers.set(path, entry);
    }
    entry.refs += 1;
    try {
        return await entry.worker;
    } catch (error) {
        releaseBrowserDjvuViewingWorker(path);
        throw error;
    }
}

export function releaseBrowserDjvuViewingWorker(path: TDocumentRef) {
    const entry = sharedViewingWorkers.get(path);
    if (!entry) {
        return;
    }
    entry.refs -= 1;
    if (entry.refs > 0) {
        return;
    }
    sharedViewingWorkers.delete(path);
    void entry.worker.then(worker => worker.terminate()).catch(() => undefined);
}

function createPngObjectUrl(bytes: Uint8Array) {
    return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
}

function loadImageElement(url: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Failed to decode DjVu page preview'));
        image.src = url;
    });
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
                return;
            }
            reject(new Error('Failed to encode scaled DjVu page preview'));
        }, 'image/png');
    });
}

function resolveScaledDjvuTargetWidth(
    pageObject: {width: number;},
    subsample: number | undefined,
    targetWidthPx: number | undefined,
) {
    if (Number.isFinite(targetWidthPx) && targetWidthPx !== undefined && targetWidthPx > 0) {
        return resolveDjvuPreviewResolutionPlan({
            nativeWidth: pageObject.width,
            neededDevicePx: targetWidthPx,
            headroom: 1,
        }).targetPx;
    }
    const normalizedSubsample = Math.max(1, Math.trunc(subsample ?? 1));
    return Math.max(1, Math.round(pageObject.width / normalizedSubsample));
}

async function scaleDjvuPageObjectUrl(
    pageObject: {
        url: string;
        width: number;
        height: number;
    },
    subsample: number | undefined,
    targetWidthPx: number | undefined,
    revokeSourceUrl: (url: string) => void,
    registerWindowObjectUrl?: (url: string) => void,
): Promise<IDjvuRenderedPageObjectUrl> {
    const targetWidth = resolveScaledDjvuTargetWidth(pageObject, subsample, targetWidthPx);
    const targetHeight = Math.max(1, Math.round(targetWidth * pageObject.height / pageObject.width));
    if (
        targetWidth === pageObject.width
        || typeof document === 'undefined'
        || typeof Image === 'undefined'
        || typeof URL === 'undefined'
        || typeof URL.createObjectURL !== 'function'
    ) {
        return {
            objectUrl: pageObject.url,
            renderedPx: pageObject.width,
        };
    }

    try {
        const image = await loadImageElement(pageObject.url);
        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const context = canvas.getContext('2d');
        if (!context) {
            return {
                objectUrl: pageObject.url,
                renderedPx: pageObject.width,
            };
        }

        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, targetWidth, targetHeight);
        const blob = await canvasToPngBlob(canvas);
        const scaledUrl = URL.createObjectURL(blob);
        registerWindowObjectUrl?.(scaledUrl);
        revokeSourceUrl(pageObject.url);
        return {
            objectUrl: scaledUrl,
            renderedPx: targetWidth,
        };
    } catch {
        return {
            objectUrl: pageObject.url,
            renderedPx: pageObject.width,
        };
    }
}

export async function createDjvuPagePreviewSourceFromPath(djvuPath: TDocumentRef) {
    const nativeDjvu = await shouldUseNativeDesktopDjvuPreview(djvuPath);
    const nativeTextSearch = createNativeDjvuTextSearchBridge(djvuPath);
    if (nativeDjvu) {
        let terminated = false;
        let nextPreviewRequestId = 0;
        const activePreviewRequestIds = new Set<TRequestId>();
        const activePreviewRequestIdsByPage = new Map<number, Set<TRequestId>>();
        const canceledPreviewRequestIds = new Set<TRequestId>();
        const cancelPreviewRequest = (requestId: TRequestId) => {
            void nativeDjvu.cancelPagePreview(requestId).catch(() => undefined);
        };
        const createPreviewRequestId = (
            pageNumber: number,
            options: IDjvuPagePreviewOptions | undefined,
        ) => {
            const requestId = options?.previewRequestId;
            if (requestId) {
                return requestId;
            }
            nextPreviewRequestId += 1;
            return createRequestId(`native-preview-${pageNumber}-${nextPreviewRequestId}`);
        };
        return {
            cancelPagePreview(pageNumber: number, requestId?: string) {
                const pageRequestIds = activePreviewRequestIdsByPage.get(pageNumber);
                const parsedRequestId = requestId === undefined ? null : parseRequestId(requestId);
                const requestIds = parsedRequestId ? [parsedRequestId] : [...pageRequestIds ?? []];
                for (const activeRequestId of requestIds) {
                    if (!activePreviewRequestIds.has(activeRequestId)) continue;
                    canceledPreviewRequestIds.add(activeRequestId);
                    cancelPreviewRequest(activeRequestId);
                }
            },
            getPageSizes: () => nativeDjvu.getPageSizes(djvuPath),
            getPageSize: async (pageNumber: number) => (
                await nativeDjvu.getPageSourceInfo(djvuPath, requirePageNumber(pageNumber))
            ).pageSize,
            getPageSourceInfo: (pageNumber: number) => nativeDjvu.getPageSourceInfo(
                djvuPath,
                requirePageNumber(pageNumber),
            ),
            ...(nativeTextSearch ? {searchText: nativeTextSearch.searchText} : {}),
            async renderPageObjectUrl(
                pageNumber: number,
                options?: IDjvuPagePreviewOptions,
            ): Promise<IDjvuRenderedPageObjectUrl> {
                if (terminated) {
                    throw new Error('DjVu conversion canceled');
                }
                const previewRequestId = createPreviewRequestId(pageNumber, options);
                activePreviewRequestIds.add(previewRequestId);
                const pageRequestIds = activePreviewRequestIdsByPage.get(pageNumber) ?? new Set<TRequestId>();
                pageRequestIds.add(previewRequestId);
                activePreviewRequestIdsByPage.set(pageNumber, pageRequestIds);
                const renderOptions: IDjvuPagePreviewOptions = {
                    ...options,
                    previewRequestId,
                };
                let preview;
                try {
                    preview = await nativeDjvu.renderPagePreview(
                        djvuPath,
                        requirePageNumber(pageNumber),
                        renderOptions,
                    );
                    if (terminated.valueOf() || canceledPreviewRequestIds.has(previewRequestId)) {
                        throw new Error('DjVu conversion canceled');
                    }
                } finally {
                    activePreviewRequestIds.delete(previewRequestId);
                    canceledPreviewRequestIds.delete(previewRequestId);
                    pageRequestIds.delete(previewRequestId);
                    if (pageRequestIds.size === 0) {
                        activePreviewRequestIdsByPage.delete(pageNumber);
                    }
                }
                return {
                    objectUrl: createPngObjectUrl(preview.bytes),
                    renderedPx: preview.width,
                };
            },
            revokeObjectURL: (url: string) => URL.revokeObjectURL(url),
            terminate() {
                terminated = true;
                for (const requestId of activePreviewRequestIds) {
                    cancelPreviewRequest(requestId);
                }
                activePreviewRequestIds.clear();
                activePreviewRequestIdsByPage.clear();
                canceledPreviewRequestIds.clear();
                nativeTextSearch?.dispose();
            },
        };
    }

    const isSharedBrowserWorker = isBrowserDocumentRef(djvuPath);
    const worker = isSharedBrowserWorker
        ? await retainBrowserDjvuViewingWorker(djvuPath)
        : await createDjvuWorkerFromPath(djvuPath);
    let terminated = false;
    let nextPreviewRequestId = 0;
    let fallbackRenderQueue = Promise.resolve();
    const activePreviewRequestIds = new Set<TRequestId>();
    const activePreviewRequestIdsByPage = new Map<number, Set<TRequestId>>();
    const canceledPreviewRequestIds = new Set<TRequestId>();
    const fallbackWindowObjectUrls = new Set<string>();

    const registerFallbackWindowObjectUrl = (url: string) => {
        fallbackWindowObjectUrls.add(url);
    };

    const revokeFallbackObjectUrl = (url: string) => {
        if (fallbackWindowObjectUrls.delete(url)) {
            if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                URL.revokeObjectURL(url);
            }
            return;
        }

        worker.revokeObjectURL(url);
    };

    const createFallbackPreviewRequestId = (
        pageNumber: number,
        options: IDjvuPagePreviewOptions | undefined,
    ) => {
        const requestId = options?.previewRequestId;
        if (requestId) {
            return requestId;
        }
        nextPreviewRequestId += 1;
        return createRequestId(`browser-preview-${pageNumber}-${nextPreviewRequestId}`);
    };

    const enqueueFallbackRender = async <T>(render: () => Promise<T>) => {
        const previousRender = fallbackRenderQueue;
        let releaseRender: () => void = () => undefined;
        fallbackRenderQueue = new Promise<void>((resolve) => {
            releaseRender = () => resolve();
        });
        await previousRender.catch(() => undefined);
        try {
            return await render();
        } finally {
            releaseRender();
        }
    };

    const throwIfFallbackRenderCanceled = (pageNumber: number, previewRequestId: TRequestId) => {
        void pageNumber;
        if (terminated || canceledPreviewRequestIds.has(previewRequestId)) {
            throw new Error('DjVu conversion canceled');
        }
    };
    const mapOutline = async (items: IDjvuContentsItem[]): Promise<IPagePreviewOutlineItem[]> => {
        const result: IPagePreviewOutlineItem[] = [];
        const stack = items.toReversed().map(item => ({
            depth: 1,
            item,
            target: result,
        }));
        let nodeCount = 0;
        let titleChars = 0;
        while (stack.length > 0) {
            const entry = stack.pop();
            if (!entry) {
                break;
            }
            nodeCount += 1;
            titleChars += entry.item.description.length;
            if (
                entry.depth > DJVU_OUTLINE_MAX_DEPTH
                || nodeCount > DJVU_OUTLINE_MAX_NODES
                || titleChars > DJVU_OUTLINE_MAX_TITLE_CHARS
            ) {
                throw new Error('DjVu outline exceeds the interactive structure limit');
            }
            const mapped: IPagePreviewOutlineItem = {
                title: entry.item.description,
                pageNumber: await worker.doc.getPageNumberByUrl(entry.item.url).run(),
                children: [],
            };
            entry.target.push(mapped);
            const children = entry.item.children ?? [];
            for (let index = children.length - 1; index >= 0; index -= 1) {
                const child = children[index];
                if (!child) {
                    continue;
                }
                stack.push({
                    depth: entry.depth + 1,
                    item: child,
                    target: mapped.children,
                });
            }
            if (nodeCount % 64 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        return result;
    };

    const pageSizesPromise = getDjvuWorkerPageSizes(worker);
    // The load starts eagerly, so a stale transition can terminate the preview
    // before any accessor awaits it. Attach a detached handler to keep a
    // rejection from surfacing as an unhandled rejection; real consumers still
    // await pageSizesPromise and observe the error.
    pageSizesPromise.catch(() => undefined);

    return {
        fullResolutionDecodeBeforeScale: true,
        cancelPagePreview(pageNumber: number, requestId?: string) {
            const pageRequestIds = activePreviewRequestIdsByPage.get(pageNumber);
            const parsedRequestId = requestId === undefined ? null : parseRequestId(requestId);
            const requestIds = parsedRequestId ? [parsedRequestId] : [...pageRequestIds ?? []];
            for (const activeRequestId of requestIds) {
                if (activePreviewRequestIds.has(activeRequestId)) {
                    canceledPreviewRequestIds.add(activeRequestId);
                }
            }
        },
        getPageSizes: (): Promise<IDjvuPageSize[]> => pageSizesPromise,
        async getPageSize(pageNumber: number) {
            const sizes = await pageSizesPromise;
            const pageSize = sizes[pageNumber - 1];
            if (!pageSize) {
                throw new RangeError(`DjVu page ${pageNumber} is outside 1..${sizes.length}`);
            }
            return pageSize;
        },
        async getPageSourceInfo(pageNumber: number) {
            const sizes = await pageSizesPromise;
            const pageSize = sizes[pageNumber - 1];
            if (!pageSize) {
                throw new RangeError(`DjVu page ${pageNumber} is outside 1..${sizes.length}`);
            }
            return {
                pageCount: sizes.length,
                pageNumber,
                pageSize,
            };
        },
        getPageText: (pageNumber: number) => worker.doc.getPage(pageNumber).getText().run(),
        searchText: nativeTextSearch?.searchText
            ?? ((request: IDjvuWorkerTextSearchOptions) => searchDjvuWorkerText(worker, request)),
        async getOutline() {
            return mapOutline(await worker.doc.getContents().run() ?? []);
        },
        async renderPageObjectUrl(
            pageNumber: number,
            options?: IDjvuPagePreviewOptions,
        ): Promise<IDjvuRenderedPageObjectUrl> {
            if (terminated) {
                throw new Error('DjVu conversion canceled');
            }
            const pageSize = (await pageSizesPromise)[pageNumber - 1];
            if (!pageSize) {
                throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
            }
            assertBrowserDjvuRasterDimensions(pageSize.width, pageSize.height, `DjVu page ${pageNumber}`);
            const previewRequestId = createFallbackPreviewRequestId(pageNumber, options);
            activePreviewRequestIds.add(previewRequestId);
            const pageRequestIds = activePreviewRequestIdsByPage.get(pageNumber) ?? new Set<TRequestId>();
            pageRequestIds.add(previewRequestId);
            activePreviewRequestIdsByPage.set(pageNumber, pageRequestIds);
            try {
                const pageObject = await enqueueFallbackRender(async () => {
                    throwIfFallbackRenderCanceled(pageNumber, previewRequestId);
                    const renderedPageObject = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
                    try {
                        throwIfFallbackRenderCanceled(pageNumber, previewRequestId);
                        return renderedPageObject;
                    } catch (error) {
                        revokeFallbackObjectUrl(renderedPageObject.url);
                        throw error;
                    }
                });
                let renderedPageObjectUrl: IDjvuRenderedPageObjectUrl | null = null;

                try {
                    renderedPageObjectUrl = await scaleDjvuPageObjectUrl(
                        pageObject,
                        options?.subsample,
                        options?.targetWidthPx,
                        revokeFallbackObjectUrl,
                        registerFallbackWindowObjectUrl,
                    );
                    throwIfFallbackRenderCanceled(pageNumber, previewRequestId);
                    return renderedPageObjectUrl;
                } catch (error) {
                    revokeFallbackObjectUrl(renderedPageObjectUrl?.objectUrl ?? pageObject.url);
                    throw error;
                }
            } finally {
                activePreviewRequestIds.delete(previewRequestId);
                canceledPreviewRequestIds.delete(previewRequestId);
                pageRequestIds.delete(previewRequestId);
                if (pageRequestIds.size === 0) {
                    activePreviewRequestIdsByPage.delete(pageNumber);
                }
            }
        },
        revokeObjectURL: revokeFallbackObjectUrl,
        terminate() {
            terminated = true;
            nativeTextSearch?.dispose();
            activePreviewRequestIds.clear();
            activePreviewRequestIdsByPage.clear();
            canceledPreviewRequestIds.clear();
            for (const url of fallbackWindowObjectUrls) {
                if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                    URL.revokeObjectURL(url);
                }
            }
            fallbackWindowObjectUrls.clear();
            if (isSharedBrowserWorker) {
                releaseBrowserDjvuViewingWorker(djvuPath);
            } else {
                worker.terminate();
            }
        },
    };
}
