import {SerializableError} from '@contracts/serializableError';
import type { TDocumentRef } from '@contracts/documentRef';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { IDjvuPagePreviewOptions } from '@contracts/electronApiDjvu';
import type { IDocumentsFileIoCapability } from '@contracts/electronApiDocuments';
import {
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import {
    createDjvuWorker,
    DJVU_COMPONENT_BASE_URL,
    loadDjvuJs,
    type IDjvuComponentDirectory,
    type IDjvuContentsItem,
    type IDjvuNormalizedTextZone,
    type IDjvuPageSize,
    type IDjvuWorker,
} from '@app/platform/browser-api/djvujsLoader';
import {
    getDjvuWorkerPageSizes,
    isIndirectDjvuHeader,
    parseDjvuPageHead,
    readBrowserDjvuSourceLayout,
    setDjvuWorkerPageSizes,
    type IBrowserDjvuSourceLayout,
    type TDjvuRangeReader,
} from '@app/platform/browser-api/browserDjvuSource';
import { getBrowserDjvuComponentFiles } from '@app/platform/browser-api/browserDjvuComponents';
import type { IPagePreviewOutlineItem } from '@app/modules/document-viewer/public';
import { getRawElectronPlatformApi } from '@app/utils/electronPlatformBridge';
import {
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_REGEX_MAX_EXECUTION_MS,
    SEARCH_RESULT_LIMIT,
    type IPdfSearchProgress,
    type IPdfSearchResponse,
    type TSearchResultOffset,
} from '@contracts/search';
import {
    assembleSearchablePageTextItems,
    buildPdfSearchExcerpt,
    PDF_SEARCH_PROGRESS_RESULT_BATCH_LIMIT,
    validateSearchQuery,
    type IResolvedSearchMatchOptions,
} from '@pdf-core/pdfSearchCore';
import {matchBrowserSearchPageWindow} from '@app/platform/browser-api/matchBrowserSearchPageWindow';
import {
    createRequestId,
    parseRequestId,
    type IOcrWord,
    type TRequestId,
} from '@contracts/shared';
import { createNativeDjvuTextSearchBridge } from '@app/platform/browser-api/createNativeDjvuTextSearchBridge';
import { resolveDjvuPreviewResolutionPlan } from '@app/utils/djvuPreviewResolution';
import { renderDjvuPagePreviewPng } from '@app/platform/browser-api/browserDjvuRasterizer';
import {PdfCombineCapabilityError} from '@contracts/pdfCombineErrors';
import {
    DESKTOP_DJVUJS_PREVIEW_MAX_PAGES,
    DJVU_PREVIEW_MAX_OUTPUT_PIXELS,
    DJVU_OUTLINE_MAX_DEPTH,
    DJVU_OUTLINE_MAX_NODES,
    DJVU_OUTLINE_MAX_TITLE_CHARS,
    DJVU_SEARCH_MAX_PAGE_TEXT_CHARS,
    DJVU_SEARCH_MAX_PAGE_ZONES,
} from '@contracts/djvuResourceLimits';

const DJVU_DESKTOP_DJVUJS_PREVIEW_MAX_BYTES = 96 * 1024 * 1024;
// DIRM component flags: the low six bits mark a page.
const DJVU_DIRM_PAGE_FLAG = 1;
const DJVU_DIRM_TYPE_MASK = 0x3f;
const DJVU_PAGE_TABLE_CACHE_ENTRIES = 8;

interface IDjvuWorkerReadOptions {signal?: AbortSignal;}

type TBrowserDjvuWorker = Awaited<ReturnType<typeof createDjvuWorkerFromPath>>;

interface IDjvuWorkerTextSearchOptions {
    resultOffset?: TSearchResultOffset;
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

interface IDjvuSourceReader {
    fileSize: number;
    /** Identifies this version of the file, so its page table can be reused. */
    versionKey: string;
    readRange: TDjvuRangeReader;
}

async function openBrowserDjvuSourceReader(path: TDocumentRef): Promise<IDjvuSourceReader> {
    const {
        size, modifiedAt,
    } = await browserDocumentStore.stat(path);
    return {
        fileSize: size,
        versionKey: `${path}\u0000${size}\u0000${modifiedAt}`,
        readRange: async (offset, length) => {
            const bytes = await browserDocumentStore.readRange(path, offset, length);
            if (bytes.byteLength !== length) {
                throw new Error(`Browser DjVu source returned ${bytes.byteLength} bytes for requested ${length} byte range`);
            }
            return bytes;
        },
    };
}

async function openDesktopDjvuSourceReader(path: TDocumentRef): Promise<IDjvuSourceReader> {
    const documents = getDesktopDocumentsCapability(path);
    const {size} = await documents.statFile(path);
    return {
        fileSize: size,
        // Desktop previews are short-lived; their page table is not reused.
        versionKey: '',
        readRange: async (offset, length) => {
            const bytes = await documents.readFileRange(path, offset, length);
            if (bytes.byteLength !== length) {
                throw new Error(`DjVu source returned ${bytes.byteLength} bytes for requested ${length} byte range`);
            }
            return bytes;
        },
    };
}

function getDesktopDocumentsCapability(path: TDocumentRef) {
    const platform = getRawElectronPlatformApi();
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

    const platform = getRawElectronPlatformApi();
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
        if (size > DJVU_DESKTOP_DJVUJS_PREVIEW_MAX_BYTES
            || (size >= 25 && isIndirectDjvuHeader(await documents.readFileRange(path, 0, 25)))) {
            return nativeDjvu;
        }

        // File size is not a safe proxy for DjVu complexity. A tiny bundled
        // document may still have more pages than the browser renderer can
        // represent, so obtain the scalar native page count before allowing
        // the compatibility decoder to load the source bytes.
        const info = await nativeDjvu.getInfo(path);
        return info.pageCount > DESKTOP_DJVUJS_PREVIEW_MAX_PAGES ? nativeDjvu : null;
    } catch (error) {
        if (error instanceof PdfCombineCapabilityError) {
            throw error;
        }
        return nativeDjvu;
    }
}

function throwIfCanceled(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new Error('DjVu conversion canceled');
    }
}

const pageTableCache = new Map<string, Promise<IDjvuPageSize[]>>();

export { getDjvuWorkerPageSizes };

/**
 * Reads every page size from the INFO chunk at the start of its component.
 * DjVu.js does not hold the sizes of pages it has not loaded, and reading a
 * few header bytes per page keeps the whole table cheap for any page count.
 */
async function readDjvuPageTable(
    layout: IBrowserDjvuSourceLayout,
    directory: IDjvuComponentDirectory | null,
    signal?: AbortSignal,
): Promise<IDjvuPageSize[]> {
    if (!directory) {
        return [parseDjvuPageHead(await layout.readComponentHead({
            index: 0,
            name: '',
        }), 1)];
    }
    const pageSizes: IDjvuPageSize[] = [];
    for (const [
        index,
        flags,
    ] of directory.flags.entries()) {
        if ((flags & DJVU_DIRM_TYPE_MASK) !== DJVU_DIRM_PAGE_FLAG) {
            continue;
        }
        throwIfCanceled(signal);
        pageSizes.push(parseDjvuPageHead(
            await layout.readComponentHead({
                index,
                name: directory.names[index] ?? '',
            }),
            pageSizes.length + 1,
        ));
    }
    return pageSizes;
}

async function readDjvuComponentDirectory(worker: IDjvuWorker) {
    const directory = await worker.doc.evbGetComponentDirectory().run();
    if (!directory) {
        throw new SerializableError({
            code: 'invalid-djvu',
            message: 'The DjVu document has no component directory',
        });
    }
    return directory;
}

function readCachedDjvuPageTable(
    versionKey: string,
    read: () => Promise<IDjvuPageSize[]>,
) {
    if (!versionKey) {
        return read();
    }
    const cached = pageTableCache.get(versionKey);
    if (cached) {
        pageTableCache.delete(versionKey);
        pageTableCache.set(versionKey, cached);
        return cached;
    }
    const pending = read();
    pageTableCache.set(versionKey, pending);
    pending.catch(() => {
        if (pageTableCache.get(versionKey) === pending) pageTableCache.delete(versionKey);
    });
    for (const key of pageTableCache.keys()) {
        if (pageTableCache.size <= DJVU_PAGE_TABLE_CACHE_ENTRIES) break;
        pageTableCache.delete(key);
    }
    return pending;
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
    const assembled = assembleSearchablePageTextItems(zones.map(zone => ({
        text: zone.text,
        separatorAfter: 'space',
        origin: zone,
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
    const resultOffset = options.resultOffset ?? 0;
    let matchIndex = 0;

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
        // Each page has its own regex budget, as the page-by-page scan did before
        // matching moved to the worker.
        const pageWindow = await matchBrowserSearchPageWindow(
            searchable.text,
            options.query,
            options.matchOptions,
            resultOffset === 'last' ? SEARCH_RESULT_LIMIT : SEARCH_RESULT_LIMIT - results.length + 1,
            resultOffset === 'last' ? 'last' : Math.max(0, resultOffset - matchIndex),
            {remainingMs: SEARCH_REGEX_MAX_EXECUTION_MS},
            options.signal,
        ).catch((error: unknown) => {
            // A search canceled during a regex match reports the abort, as its other steps do.
            options.signal.throwIfAborted();
            throw error;
        });
        options.signal.throwIfAborted();
        const progressResults: Array<IPdfSearchResponse['results'][number]> = [];
        for (const match of pageWindow.matches) {
            const currentMatchIndex = matchIndex + match.pageMatchIndex;
            if (resultOffset !== 'last' && results.length >= SEARCH_RESULT_LIMIT) {
                truncated = true;
                break;
            }
            const words = getSearchMatchWords(searchable, match.startOffset, match.endOffset);
            const pageSize = pageSizes[pageNumber - 1];
            const result: IPdfSearchResponse['results'][number] = {
                pageNumber: pageNumber as IPdfSearchResponse['results'][number]['pageNumber'],
                pageMatchIndex: match.pageMatchIndex,
                matchIndex: currentMatchIndex,
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
            if (resultOffset === 'last') results[currentMatchIndex % SEARCH_RESULT_LIMIT] = result;
            else {
                results.push(result);
                progressResults.push(result);
            }
        }
        matchIndex += pageWindow.matchCount;
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

    results.sort((first, second) => first.matchIndex - second.matchIndex);
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
    let worker: IDjvuWorker | null = null;
    let abortHandler: (() => void) | null = null;

    try {
        const source = isBrowserRef
            ? await openBrowserDjvuSourceReader(djvuPath)
            : await openDesktopDjvuSourceReader(djvuPath);
        throwIfCanceled(options.signal);
        const layout = await readBrowserDjvuSourceLayout({
            fileSize: source.fileSize,
            readRange: source.readRange,
            componentFiles: isBrowserRef ? getBrowserDjvuComponentFiles(djvuPath) : null,
            signal: options.signal,
        });
        throwIfCanceled(options.signal);
        // DjVu.js asks for components by name; the directory read after the
        // document opens gives each name its position, before any page loads.
        let componentIndexes: Map<string, number> | null = null;
        const readComponent = (name: string) => {
            const index = componentIndexes?.get(name);
            return index === undefined
                ? Promise.reject(new Error(`DjVu component ${name} is not in the document directory`))
                : layout.readComponent({
                    index,
                    name,
                });
        };
        const openedWorker = createDjvuWorker(djvuGlobal, layout.hasComponents ? readComponent : undefined);
        worker = openedWorker;
        if (options.signal) {
            abortHandler = () => {
                openedWorker.terminate();
            };
            options.signal.addEventListener('abort', abortHandler, { once: true });
        }
        await openedWorker.createDocument(
            toOwnedArrayBuffer(layout.documentBytes),
            layout.hasComponents ? {baseUrl: DJVU_COMPONENT_BASE_URL} : {},
        );
        throwIfCanceled(options.signal);
        const directory = layout.hasComponents ? await readDjvuComponentDirectory(openedWorker) : null;
        componentIndexes = directory
            ? new Map(directory.names.map((name, index) => [
                name,
                index,
            ] as const).toReversed())
            : null;
        throwIfCanceled(options.signal);
        const pageTable = await readCachedDjvuPageTable(
            source.versionKey,
            () => readDjvuPageTable(layout, directory, options.signal),
        );
        throwIfCanceled(options.signal);
        setDjvuWorkerPageSizes(openedWorker, pageTable);
        return openedWorker;
    } catch (error) {
        worker?.terminate();
        throw error;
    } finally {
        // The store entry stays loaded: it holds the file snapshot every later
        // component read must come from, so pages cannot mix file versions.
        if (options.signal && abortHandler) {
            options.signal.removeEventListener('abort', abortHandler);
        }
    }
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

/**
 * The width a preview renders at: the requested device width, or the native
 * width divided by the subsample, within the output budget desktop previews
 * also apply.
 */
export function resolveDjvuPreviewTargetWidth(
    pageSize: {
        width: number;
        height: number
    },
    options: Pick<IDjvuPagePreviewOptions, 'subsample' | 'targetWidthPx'> | undefined,
) {
    const targetWidthPx = options?.targetWidthPx;
    const requestedWidth = Number.isFinite(targetWidthPx) && targetWidthPx !== undefined && targetWidthPx > 0
        ? resolveDjvuPreviewResolutionPlan({
            nativeWidth: pageSize.width,
            neededDevicePx: targetWidthPx,
            headroom: 1,
        }).targetPx
        : Math.max(1, Math.round(pageSize.width / Math.max(1, Math.trunc(options?.subsample ?? 1))));
    const budgetWidth = Math.max(1, Math.floor(Math.sqrt(
        DJVU_PREVIEW_MAX_OUTPUT_PIXELS * pageSize.width / Math.max(1, pageSize.height),
    )));
    return Math.min(requestedWidth, budgetWidth);
}

export async function createDjvuPagePreviewSourceFromPath(djvuPath: TDocumentRef) {
    const nativeDjvu = await shouldUseNativeDesktopDjvuPreview(djvuPath);
    const nativeTextSearch = createNativeDjvuTextSearchBridge(djvuPath);
    if (nativeDjvu) {
        const {
            getOutline: getNativeOutline,
            getPageText: getNativePageText,
        } = nativeDjvu;
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
            // The sidebar's bookmarks and the text layer read these, as from djvu.js.
            ...(getNativeOutline ? {getOutline: () => getNativeOutline(djvuPath)} : {}),
            ...(getNativePageText ? {getPageText: (pageNumber: number) => getNativePageText(djvuPath, requirePageNumber(pageNumber))} : {}),
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
                } catch (error) {
                    if (error instanceof Error && error.message.endsWith('DjVu preview request superseded')) {
                        throw new DOMException(error.message, 'AbortError');
                    }
                    throw error;
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
            const previewRequestId = createFallbackPreviewRequestId(pageNumber, options);
            activePreviewRequestIds.add(previewRequestId);
            const pageRequestIds = activePreviewRequestIdsByPage.get(pageNumber) ?? new Set<TRequestId>();
            pageRequestIds.add(previewRequestId);
            activePreviewRequestIdsByPage.set(pageNumber, pageRequestIds);
            try {
                const preview = await enqueueFallbackRender(async () => {
                    throwIfFallbackRenderCanceled(pageNumber, previewRequestId);
                    return renderDjvuPagePreviewPng(
                        worker,
                        pageNumber,
                        resolveDjvuPreviewTargetWidth(pageSize, options),
                    );
                });
                throwIfFallbackRenderCanceled(pageNumber, previewRequestId);
                const objectUrl = createPngObjectUrl(preview.bytes);
                registerFallbackWindowObjectUrl(objectUrl);
                return {
                    objectUrl,
                    renderedPx: preview.width,
                };
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
