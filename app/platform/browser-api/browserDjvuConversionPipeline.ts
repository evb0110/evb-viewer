import { isAbortError } from '@contracts/isAbortError';
import { getErrorMessage } from '@app/utils/error';
import { uniq } from 'es-toolkit/array';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import {
    pageNumberToPageIndex,
    requirePageNumber,
} from '@contracts/pageNumbers';
import type {
    IDjvuConvertOptions,
    IDjvuInfo,
    IDjvuPageSize,
    IDjvuProgress,
    IDjvuSizeEstimate,
} from '@contracts/electronApiDjvu';
import type { THostResourceTier } from '@contracts/hostResourceProfile';
import {
    getDjvuCompactFidelity,
    normalizeDjvuPdfSubsample,
    resolveDjvuCompactFidelityPreset,
    resolveDjvuPdfExportStrategy,
} from '@contracts/djvuConversionPolicy';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    createJobId,
    type TJobId,
} from '@contracts/shared';
import {
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import type {
    IDjvuOutlineRawItem,
    IDjvuWorker,
} from '@app/platform/browser-api/browserDjvuWorkerClient';
import {
    createDjvuWorkerFromPath,
    getDjvuWorkerPageSizes,
} from '@app/platform/browser-api/createDjvuWorkerFromPath';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { buildBrowserDjvuCompactPage } from '@app/platform/browser-api/buildBrowserDjvuCompactPage';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    decodeFailureReceipt,
    type ExpectedOutcome,
    type ExpectedOutcomeCode,
    type FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import {runBrowserPdfCombineWorkerRequest} from '@app/platform/browser-api/browserPdfCombineWorkerClient';
import {resolveBrowserPageLanes} from '@app/platform/browser-api/browserWorkerClient';
import {createOrderedPdfMerge} from '@app/platform/browser-api/browserPageOpsCore';
import {runBoundedRasterProducerConsumer} from '@evb/scan-cleanup/core/streamingRasterHandoff';
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import { toPdfDateString } from '@app/utils/pdfDate';
import { toOwnedArrayBuffer } from '@app/platform/browser-api/browserDjvuCanvas';
import {PdfCombineCapabilityError} from '@contracts/pdfCombineErrors';
import {
    createPdfCombineOutputTooLargeError,
    isPdfCombineOutputTooLargeError,
    PDF_COMBINE_OUTPUT_POLICY,
} from '@contracts/pdfCombineOutputPolicy';
import {BROWSER_PAGE_OPS_MAX_REQUEST_BYTES} from '@contracts/browserPageOpsLimits';
import {getRawElectronPlatformApi} from '@app/utils/electronPlatformBridge';
import type { IBrowserPdfCombineWasmPageSpec } from '@contracts/browserPdfCombineWorker';
import {
    DjvuCanceledError,
    renderDjvuPage,
    throwIfDjvuCanceled as throwIfCanceled,
    type IDjvuPageMetrics,
} from '@app/platform/browser-api/browserDjvuRasterizer';

const DJVU_DIRECT_PDF_JPEG_QUALITY = 0.92;
const DJVU_PDF_RENDER_WORKER_LIMIT = 3;
const DJVU_PDF_MEDIUM_PAGE_PIXEL_COUNT = 16_000_000;
const DJVU_PDF_LARGE_PAGE_PIXEL_COUNT = 32_000_000;
const DJVU_COMPACT_PAGE_BASE_BYTES = 32 * 1024 * 1024;
const DJVU_COMPACT_PAGE_BYTES_PER_PIXEL = 32;
const DJVU_ESTIMATE_PRESETS = [
    1,
    2,
    4,
] as const;
const DJVU_ESTIMATE_SAMPLE_PAGES = 3;
const DJVU_TEXT_SCAN_YIELD_PAGES = 16;
const DJVU_TEXT_SCAN_CACHE_ENTRIES = 16;

type TBrowserDjvuBoundaryOperation =
    | 'bookmarks'
    | 'convert'
    | 'estimate'
    | 'info'
    | 'open'
    | 'page-source-info'
    | 'page-sizes'
    | 'preview'
    | 'text-search'
    | 'worker';

interface IBrowserDjvuFailure extends Error {failure?: FailureReceipt;}

class BrowserDjvuExpectedOutcomeError extends Error {
    public constructor(
        message: string,
        public readonly expected: ExpectedOutcome,
    ) {
        super(message);
        this.name = 'BrowserDjvuExpectedOutcomeError';
    }
}

function createBrowserDjvuExpectedOutcome(code: ExpectedOutcomeCode): ExpectedOutcome {
    return {
        kind: 'expected',
        code,
    };
}

function getBrowserDjvuFailureReceipt(error: unknown) {
    if (!(error instanceof Error)) {
        return undefined;
    }
    return decodeFailureReceipt((error as IBrowserDjvuFailure).failure) ?? undefined;
}

function classifyBrowserDjvuExpectedOutcome(error: unknown): ExpectedOutcome | undefined {
    if (error instanceof BrowserDjvuExpectedOutcomeError) {
        return error.expected;
    }

    if (
        error instanceof DjvuCanceledError
        || isAbortError(error)
    ) {
        return createBrowserDjvuExpectedOutcome('canceled');
    }

    if (error instanceof PdfCombineCapabilityError && error.code === 'native-unavailable') {
        return createBrowserDjvuExpectedOutcome('temporarily-unavailable');
    }

    if (isPdfCombineOutputTooLargeError(error)) {
        return createBrowserDjvuExpectedOutcome('validation-rejected');
    }

    if (error instanceof Error && getErrorMessage(error).trim().toLowerCase() === 'djvu conversion canceled') {
        return createBrowserDjvuExpectedOutcome('canceled');
    }
    return undefined;
}

function hasNativeDjvuBridge() {
    const electronApi = getRawElectronPlatformApi() as {djvu?: unknown} | undefined;
    const djvu = electronApi?.djvu;
    if (!djvu || typeof djvu !== 'object') {
        return false;
    }

    const bridge = djvu as Record<string, unknown>;
    return [
        'getInfo',
        'getPageSizes',
        'estimateSizes',
        'renderPagePreview',
        'searchText',
    ].every(method => typeof bridge[method] === 'function');
}

export function assertBrowserDjvuSource(
    path: TDocumentRef,
    operation: TBrowserDjvuBoundaryOperation,
) {
    if (isBrowserDocumentRef(path)) {
        return;
    }

    // Conversion and bookmark extraction are browser-only combine operations.
    // Other browser DjVu capabilities may retain their desktop compatibility
    // worker when a native bridge exists, but they must refuse the path before
    // any file read when that bridge is absent.
    if (operation === 'convert' || operation === 'bookmarks' || !hasNativeDjvuBridge()) {
        const operationDescription = operation === 'bookmarks'
            ? 'bookmark extraction'
            : operation === 'convert'
                ? 'conversion'
                : `${operation} worker access`;
        throw new PdfCombineCapabilityError(
            'native-unavailable',
            `Native DjVu ${operationDescription} capability is unavailable for desktop path: ${path}`,
            {operation: `djvu-${operation}`},
        );
    }
}

export interface IBrowserDjvuPdfRenderSettings {
    strategy: 'direct' | 'compact-djvu-aware';
    subsample: number;
    jpegQuality: number;
}

export function resolveBrowserDjvuPdfRenderSettings(
    options: Pick<IDjvuConvertOptions, 'pdfStrategy' | 'subsample'>,
): IBrowserDjvuPdfRenderSettings {
    const strategy = resolveDjvuPdfExportStrategy(options.pdfStrategy);
    const requestedSubsample = normalizeDjvuPdfSubsample(options.subsample);
    return {
        strategy,
        subsample: requestedSubsample,
        jpegQuality: strategy === 'compact-djvu-aware'
            ? getDjvuCompactFidelity(resolveDjvuCompactFidelityPreset(requestedSubsample)).photoQuality
            : DJVU_DIRECT_PDF_JPEG_QUALITY,
    };
}

export function resolveBrowserDjvuPdfRenderConcurrency(
    pageSizes: ReadonlyArray<Pick<IDjvuPageMetrics, 'width' | 'height'>>,
    hardwareConcurrency = typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency,
    tier: THostResourceTier = 'medium',
) {
    const pageCount = Math.max(1, pageSizes.length);
    const normalizedHardwareConcurrency = typeof hardwareConcurrency === 'number'
        && Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0
        ? Math.trunc(hardwareConcurrency)
        : 2;
    const hardwareWorkerCount = Math.max(1, Math.floor(normalizedHardwareConcurrency / 2));
    const maxPagePixels = pageSizes.reduce((maxPixels, size) => {
        const width = typeof size.width === 'number' && Number.isFinite(size.width)
            ? Math.max(0, Math.trunc(size.width))
            : 0;
        const height = typeof size.height === 'number' && Number.isFinite(size.height)
            ? Math.max(0, Math.trunc(size.height))
            : 0;
        return Math.max(maxPixels, width * height);
    }, 0);
    const pixelWorkerLimit = maxPagePixels >= DJVU_PDF_LARGE_PAGE_PIXEL_COUNT
        ? 1
        : maxPagePixels >= DJVU_PDF_MEDIUM_PAGE_PIXEL_COUNT
            ? 2
            : DJVU_PDF_RENDER_WORKER_LIMIT;
    const tierWorkerLimit = tier === 'low' ? 1 : DJVU_PDF_RENDER_WORKER_LIMIT;
    return Math.min(
        pageCount,
        tierWorkerLimit,
        pixelWorkerLimit,
        hardwareWorkerCount,
    );
}

interface IFinalizablePdfSink {
    write(bytes: Uint8Array): Promise<void>;
    finish(): Promise<TDocumentRef>;
    abort(): Promise<void>;
}

/** The PDF stored in the browser as it is written; finished, it is a clean document of its own, not unsaved work. */
class BrowserStoredPdfSink implements IFinalizablePdfSink {
    private constructor(
        private readonly outputPath: TDocumentRef,
        private readonly stream: Awaited<ReturnType<typeof browserDocumentStore.writeStream>>,
    ) {}

    public static async create(outputPath: TDocumentRef) {
        return new BrowserStoredPdfSink(outputPath, await browserDocumentStore.writeStream(outputPath));
    }

    public write(bytes: Uint8Array) {
        return this.stream.write(bytes);
    }

    public async finish() {
        await this.stream.close();
        await browserDocumentStore.setRetention(this.outputPath, 'durable');
        browserDocumentStore.unload(this.outputPath);
        return this.outputPath;
    }

    public abort() {
        return this.stream.abort();
    }
}

class BrowserHandlePdfSink implements IFinalizablePdfSink {
    private fileSize = 0;

    private constructor(
        private readonly outputPath: TDocumentRef,
        private readonly saveHandle: FileSystemFileHandle,
        private readonly saveName: string,
        private readonly writable: FileSystemWritableFileStream,
    ) {}

    public static async create(
        outputPath: TDocumentRef,
        saveHandle: FileSystemFileHandle,
        saveName: string,
        signal?: AbortSignal,
    ) {
        throwIfCanceled(signal);
        const writable = await saveHandle.createWritable();
        try {
            throwIfCanceled(signal);
            return new BrowserHandlePdfSink(outputPath, saveHandle, saveName, writable);
        } catch (error) {
            await writable.abort().catch(() => undefined);
            throw error;
        }
    }

    public async write(bytes: Uint8Array) {
        this.fileSize += bytes.byteLength;
        await this.writable.write(toOwnedArrayBuffer(bytes));
    }

    public async finish() {
        await this.writable.close();
        await browserDocumentStore.replaceWithHandleBackedDocument(this.outputPath, {
            fileSize: this.fileSize,
            saveHandle: this.saveHandle,
            saveName: this.saveName,
        });
        await browserDocumentStore.setRetention(this.outputPath, 'durable');
        browserDocumentStore.unload(this.outputPath);
        return this.outputPath;
    }

    public async abort() {
        if (typeof this.writable.abort === 'function') {
            await this.writable.abort();
        }
    }
}

async function createBrowserDjvuPdfOutputSink(
    outputPath: TDocumentRef,
    signal?: AbortSignal,
) {
    throwIfCanceled(signal);
    const saveTarget = await browserDocumentStore.getSaveTarget(outputPath);
    throwIfCanceled(signal);
    if (saveTarget.saveHandle) {
        return BrowserHandlePdfSink.create(outputPath, saveTarget.saveHandle, saveTarget.saveName, signal);
    }
    const sink = await BrowserStoredPdfSink.create(outputPath);
    if (signal?.aborted) {await sink.abort();}
    throwIfCanceled(signal);
    return sink;
}

/** A source page written to the output PDF, in output order. */
interface IDjvuOutputPage {
    pageNumber: number;
    metrics: IDjvuPageSize;
}

interface IDjvuJobRecord {
    workers: Set<IDjvuWorker>;
    abortController: AbortController;
}

const progressListeners = new Set<(progress: IDjvuProgress) => void>();
const activeJobs = new Map<string, IDjvuJobRecord>();

function emitProgress(progress: IDjvuProgress) {
    progressListeners.forEach((listener) => {
        listener(progress);
    });
}

function createDjvuJob(jobId: string, worker: IDjvuWorker | null = null) {
    const abortController = new AbortController();
    activeJobs.set(jobId, {
        workers: worker ? new Set([worker]) : new Set(),
        abortController,
    });
    return abortController;
}

function attachDjvuJobWorker(jobId: string, worker: IDjvuWorker) {
    const job = activeJobs.get(jobId);
    if (!job) {
        worker.terminate();
        throw new DjvuCanceledError();
    }
    if (job.abortController.signal.aborted) {
        worker.terminate();
        throw new DjvuCanceledError();
    }
    job.workers.add(worker);
}

function cleanupDjvuJob(jobId: string) {
    const job = activeJobs.get(jobId);
    if (!job) {
        return;
    }

    activeJobs.delete(jobId);
    for (const worker of job.workers) {
        try {
            worker.terminate();
        } catch (error) {
            BrowserLogger.warn('djvu-browser', 'Failed to terminate DjVu worker', {
                jobId,
                error,
            });
        }
    }
}

export async function withBrowserDjvuWorker<T>(
    djvuPath: TDocumentRef,
    run: (worker: IDjvuWorker) => Promise<T>,
    operation: TBrowserDjvuBoundaryOperation = 'worker',
) {
    assertBrowserDjvuSource(djvuPath, operation);
    const worker = await createDjvuWorkerFromPath(djvuPath);
    try {
        return await run(worker);
    } finally {
        worker.terminate();
    }
}

async function mapDjvuContentsToPdfBookmarks(
    worker: IDjvuWorker,
    items: IDjvuOutlineRawItem[] | null | undefined,
    pages: readonly IDjvuOutputPage[],
    signal?: AbortSignal,
): Promise<IPdfBookmarkEntry[]> {
    throwIfCanceled(signal);
    if (!items || items.length === 0) {
        return [];
    }

    const outputIndexByPageNumber = new Map<number, number>();
    for (let index = 0; index < pages.length; index += 1) {
        const pageNumber = pages[index]!.pageNumber;
        if (!outputIndexByPageNumber.has(pageNumber)) {
            outputIndexByPageNumber.set(pageNumber, index);
        }
    }

    const mapItems = async (
        entries: IDjvuOutlineRawItem[] | null | undefined,
    ): Promise<IPdfBookmarkEntry[]> => {
        throwIfCanceled(signal);
        if (!entries || entries.length === 0) {
            return [];
        }

        const bookmarks: IPdfBookmarkEntry[] = [];

        for (const item of entries) {
            throwIfCanceled(signal);
            const pageNumber = item.url
                ? await worker.getPageNumberByUrl(item.url)
                : null;
            const children = await mapItems(item.children);
            // A destination is the target page's position in the output; a page
            // left out of the output leaves its bookmark without a destination.
            const outputIndex = typeof pageNumber === 'number' && pageNumber > 0
                ? (outputIndexByPageNumber.get(pageNumber) ?? -1)
                : -1;

            bookmarks.push({
                title: item.title,
                pageIndex: outputIndex >= 0
                    ? pageNumberToPageIndex(requirePageNumber(outputIndex + 1))
                    : null,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: children,
            });
        }

        return bookmarks;
    };

    return mapItems(items);
}

/**
 * Adds the outline to a PDF written without one, through the page-ops
 * catalog writer desktop uses for the same job (a native edit, appended).
 */
async function embedBrowserPdfBookmarks(
    data: Uint8Array,
    pageCount: number,
    bookmarks: IPdfBookmarkEntry[],
    signal?: AbortSignal,
) {
    if (bookmarks.length === 0) {
        return data;
    }
    signal?.throwIfAborted();
    const {appendPdfMutationsToBytes} = await import('@app/platform/browser/pdfPageEngine');
    const result = await appendPdfMutationsToBytes(data, {
        mutations: {bookmarks: {
            totalPages: pageCount,
            untitledLabel: 'Untitled',
            items: bookmarks,
        }},
        modifiedAt: toPdfDateString(),
    });
    if (isBrowserPageOpsWasmFailure(result)) {
        throw new Error(`Browser DjVu bookmark embedding failed: ${result.error.message}`);
    }
    return result.data;
}

async function writePdfBytesToOutput(
    outputPath: TDocumentRef,
    bytes: Uint8Array,
    signal?: AbortSignal,
) {
    const sink = await createBrowserDjvuPdfOutputSink(outputPath, signal);
    try {
        throwIfCanceled(signal);
        await sink.write(bytes);
        throwIfCanceled(signal);
        return await sink.finish();
    } catch (error) {
        await sink.abort().catch((abortError: unknown) => {
            BrowserLogger.warn('djvu-browser', 'Failed to abort browser PDF sink', abortError);
        });
        throw error;
    }
}

/**
 * The memory one page holds while it is in flight, from its pixel count: its
 * lane's DjVu and combine workers, the decoded page on both sides of the
 * worker boundary, the canvas and raster of a photo page, and the combine
 * engine's linear memory. A photo page costs the most; on 4406x3200 color
 * pages each lane held 27 bytes a pixel, a layered page 5. The photo figure is
 * padded by a fifth.
 */
function estimateBrowserDjvuPageBytes(metrics: IDjvuPageSize) {
    return DJVU_COMPACT_PAGE_BASE_BYTES + (metrics.width ?? 0) * (metrics.height ?? 0) * DJVU_COMPACT_PAGE_BYTES_PER_PIXEL;
}

async function buildDjvuPdfWithWasm(options: {
    mode: 'compact' | 'direct';
    worker: IDjvuWorker;
    createRenderWorker: () => Promise<IDjvuWorker>;
    pages: readonly IDjvuOutputPage[];
    buildPageSpec: (
        worker: IDjvuWorker,
        outputPage: IDjvuOutputPage,
        pageSignal: AbortSignal,
    ) => Promise<{
        route: string;
        spec: IBrowserPdfCombineWasmPageSpec;
    }>;
    preserveBookmarks: boolean;
    outputPath: TDocumentRef;
    signal: AbortSignal;
    onPageProcessed?: (processed: number, total: number) => void;
    /** The pages' PDFs are joined into one, a step with no page count. */
    onAssembleStart?: () => void;
    onBookmarksStart?: () => void;
}) {
    const modeLabel = options.mode === 'compact' ? 'Browser compact DjVu' : 'Browser direct DjVu';
    const routes = new Map<string, number>();
    const pageCount = options.pages.length;
    // A lane takes an idle DjVu worker, or starts one: there are never more
    // workers than lanes.
    const idleWorkers = [options.worker];
    const output = createOrderedPdfMerge({
        signal: options.signal,
        createError: (reason, code) => (code === PDF_COMBINE_OUTPUT_POLICY.tooLargeCode
            ? createPdfCombineOutputTooLargeError(`${modeLabel} pages are too large to join: ${reason}`)
            : new Error(`${modeLabel} export could not join its pages: ${reason}`)),
    });
    let processed = 0;
    let outputBytes = 0;
    try {
        await runBoundedRasterProducerConsumer<IDjvuOutputPage, Uint8Array>({
            items: options.pages,
            budget: resolveBrowserPageLanes(),
            signal: options.signal,
            estimateItemBytes: outputPage => estimateBrowserDjvuPageBytes(outputPage.metrics),
            produce: async (outputPage, _index, pageSignal) => {
                let worker: IDjvuWorker | undefined;
                try {
                    worker = idleWorkers.pop() ?? await options.createRenderWorker();
                    const page = await options.buildPageSpec(worker, outputPage, pageSignal);
                    routes.set(page.route, (routes.get(page.route) ?? 0) + 1);
                    const {data} = await runBrowserPdfCombineWorkerRequest('combinePdfs', {
                        inputs: [],
                        wasmImagePreprocessing: {pageSpecs: [page.spec]},
                    }, pageSignal);
                    return {
                        staged: data,
                        actualBytes: data.byteLength,
                    };
                } catch (error) {
                    // A page stopped by another page's failure, or by the
                    // caller, reports that reason rather than its own stop.
                    throw pageSignal.aborted ? pageSignal.reason : error;
                } finally {
                    if (worker) {idleWorkers.push(worker);}
                }
            },
            consumeChunk: async (chunk) => {
                for (const pagePdf of chunk) {
                    outputBytes += pagePdf.byteLength;
                    if (outputBytes > BROWSER_PAGE_OPS_MAX_REQUEST_BYTES) {
                        throw createPdfCombineOutputTooLargeError(
                            `${modeLabel} pages exceed the WASM request boundary (${outputBytes} bytes encoded)`,
                        );
                    }
                    output.append(pagePdf);
                    processed += 1;
                    options.onPageProcessed?.(processed, pageCount);
                }
            },
            // Nothing is staged outside memory.
            cleanupStaged: () => Promise.resolve(),
        });
        BrowserLogger.info('djvu-browser', `${modeLabel} pages encoded`, {
            pageCount,
            routes: Object.fromEntries(routes),
        });

        options.onAssembleStart?.();
        const data = await output.merge();
        throwIfCanceled(options.signal);
        if (data === null) {
            throw new Error(`${modeLabel} export produced no pages`);
        }
        let pdf = data;
        if (options.preserveBookmarks) {
            const contents = await options.worker.getOutline();
            const bookmarks = await mapDjvuContentsToPdfBookmarks(options.worker, contents, options.pages, options.signal);
            if (bookmarks.length > 0) {
                options.onBookmarksStart?.();
                pdf = await embedBrowserPdfBookmarks(data, pageCount, bookmarks, options.signal);
                throwIfCanceled(options.signal);
            }
        }
        return await writePdfBytesToOutput(options.outputPath, pdf, options.signal);
    } catch (error) {
        const message = getErrorMessage(error);
        const isUnsupported = message === 'ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT';
        if (isUnsupported || message === 'ERR_BROWSER_PDF_COMBINE_WASM_UNAVAILABLE') {
            throw new BrowserDjvuExpectedOutcomeError(
                isUnsupported
                    ? `${modeLabel} export does not support this page data`
                    : `${modeLabel} export is temporarily unavailable`,
                createBrowserDjvuExpectedOutcome(isUnsupported
                    ? 'unsupported-input'
                    : 'temporarily-unavailable'),
            );
        }
        throw error;
    }
}

async function buildDirectDjvuPageSpec(
    worker: IDjvuWorker,
    outputPage: IDjvuOutputPage,
    subsample: number,
    jpegQuality: number,
    pageSignal: AbortSignal,
): Promise<{
    route: string;
    spec: IBrowserPdfCombineWasmPageSpec;
}> {
    const pageData = await renderDjvuPage(
        worker,
        outputPage.pageNumber,
        outputPage.metrics.dpi,
        subsample,
        jpegQuality,
        pageSignal,
    );
    const dpi = Math.max(1, pageData.dpi);
    return {
        route: 'direct-jpeg',
        spec: {
            kind: 'image',
            pageSize: {
                widthPoints: (Math.max(1, pageData.width) / dpi) * 72,
                heightPoints: (Math.max(1, pageData.height) / dpi) * 72,
            },
            image: {
                fileName: `page-${String(outputPage.pageNumber).padStart(5, '0')}.jpg`,
                data: pageData.bytes,
            },
        },
    };
}

function pickSamplePageNumbers(pageCount: number, maxSamples: number) {
    if (pageCount <= 0) {
        return [];
    }

    const candidates = [
        1,
        Math.ceil(pageCount / 2),
        pageCount,
    ];

    return uniq(candidates).slice(0, maxSamples);
}

const textScanResults = new Map<string, boolean>();

/**
 * Whether any page carries a text layer. Pages are read in order until one
 * has text, as the desktop scan does, so a document whose only text is on an
 * unsampled page is still reported correctly. The answer is kept per file
 * version.
 */
async function detectBrowserDjvuHasText(djvuPath: TDocumentRef, worker: IDjvuWorker, pageCount: number) {
    const {
        size, modifiedAt,
    } = isBrowserDocumentRef(djvuPath)
        ? await browserDocumentStore.stat(djvuPath)
        : {
            size: -1,
            modifiedAt: -1,
        };
    const versionKey = `${djvuPath}\u0000${size}\u0000${modifiedAt}`;
    const cached = textScanResults.get(versionKey);
    if (cached !== undefined) {
        return cached;
    }
    let hasText = false;
    let scanComplete = true;
    for (let pageNumber = 1; pageNumber <= pageCount && !hasText; pageNumber += 1) {
        try {
            hasText = await worker.pageHasText(pageNumber);
        } catch {
            scanComplete = false;
        }
        if (pageNumber % DJVU_TEXT_SCAN_YIELD_PAGES === 0) {
            await yieldToBrowser();
        }
    }
    if (hasText || scanComplete) {
        textScanResults.set(versionKey, hasText);
        for (const key of textScanResults.keys()) {
            if (textScanResults.size <= DJVU_TEXT_SCAN_CACHE_ENTRIES) {break;}
            textScanResults.delete(key);
        }
    }
    return hasText;
}

export async function getBrowserDjvuInfo(djvuPath: TDocumentRef): Promise<IDjvuInfo> {
    return withBrowserDjvuWorker(djvuPath, async (worker) => {
        const pageSizes = await getDjvuWorkerPageSizes(worker);
        const [
            contents,
            metadata,
        ] = await Promise.all([
            worker.getOutline().catch(() => null),
            worker.getMetadata().catch(() => ({})),
        ]);
        return {
            pageCount: pageSizes.length,
            sourceDpi: pageSizes[0]?.dpi ?? 300,
            hasBookmarks: Boolean(contents && contents.length > 0),
            hasText: await detectBrowserDjvuHasText(djvuPath, worker, pageSizes.length),
            metadata,
        };
    }, 'info');
}

export async function estimateBrowserDjvuSizes(
    djvuPath: TDocumentRef,
): Promise<IDjvuSizeEstimate[]> {
    return withBrowserDjvuWorker(djvuPath, async (worker) => {
        const pageSizes = await getDjvuWorkerPageSizes(worker);
        const pageCount = pageSizes.length;
        const sourceDpi = pageSizes[0]?.dpi ?? 300;
        const samplePages = pickSamplePageNumbers(
            pageCount,
            DJVU_ESTIMATE_SAMPLE_PAGES,
        );

        return Promise.all(
            DJVU_ESTIMATE_PRESETS.map(async (subsample) => {
                let estimatedBytes = 0;

                if (samplePages.length > 0) {
                    let sampleBytes = 0;
                    for (const pageNumber of samplePages) {
                        const renderedPage = await renderDjvuPage(
                            worker,
                            pageNumber,
                            pageSizes[pageNumber - 1]?.dpi ?? sourceDpi,
                            subsample,
                            DJVU_DIRECT_PDF_JPEG_QUALITY,
                        );
                        sampleBytes += renderedPage.bytes.byteLength;
                        await yieldToBrowser();
                    }

                    estimatedBytes = Math.round(
                        (sampleBytes / samplePages.length) * pageCount,
                    );
                }

                await yieldToBrowser();

                return {
                    subsample,
                    label: '',
                    description: '',
                    resultingDpi: Math.max(
                        1,
                        Math.round(sourceDpi / subsample),
                    ),
                    estimatedBytes,
                } satisfies IDjvuSizeEstimate;
            }),
        );
    }, 'estimate');
}

/**
 * Converts a DjVu to PDF. `pageNumbers` writes only those source pages, in
 * that order, as printing a selection does; without it every page is written.
 */
export async function runBrowserDjvuConversion(
    djvuPath: TDocumentRef,
    outputPath: TDocumentRef,
    options: IDjvuConvertOptions,
    pageNumbers?: readonly number[],
) {
    const jobId: TJobId = options.jobId ?? createJobId('djvu-convert');
    const abortController = createDjvuJob(jobId);
    // The caller's job runner keeps only progress that names its request.
    const reportProgress = (phase: IDjvuProgress['phase'], percent: number) => emitProgress({
        jobId,
        ...(options.requestId ? {requestId: options.requestId} : {}),
        documentRef: djvuPath,
        phase,
        percent,
    });

    try {
        assertBrowserDjvuSource(djvuPath, 'convert');
        if (!isBrowserDocumentRef(outputPath)) {
            return {
                success: false as const,
                jobId,
                error: 'Invalid browser DjVu output target',
                expected: createBrowserDjvuExpectedOutcome('validation-rejected'),
            };
        }

        reportProgress('loading', 0);
        const worker = await createDjvuWorkerFromPath(djvuPath, { signal: abortController.signal });
        attachDjvuJobWorker(jobId, worker);
        throwIfCanceled(abortController.signal);
        const pageSizes = await getDjvuWorkerPageSizes(worker);
        throwIfCanceled(abortController.signal);
        const pageCount = pageSizes.length;

        if (pageCount <= 0) {
            return {
                success: false as const,
                jobId,
                error: 'DjVu document has no pages',
                expected: createBrowserDjvuExpectedOutcome('validation-rejected'),
            };
        }
        const selectedPageNumbers = pageNumbers === undefined
            ? pageSizes.map((_, index) => index + 1)
            : uniq(pageNumbers.filter(pageNumber => Number.isSafeInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pageCount));
        if (selectedPageNumbers.length === 0) {
            return {
                success: false as const,
                jobId,
                error: 'No DjVu pages are selected',
                expected: createBrowserDjvuExpectedOutcome('validation-rejected'),
            };
        }
        const pages: IDjvuOutputPage[] = selectedPageNumbers.map(pageNumber => ({
            pageNumber,
            metrics: pageSizes[pageNumber - 1]!,
        }));

        reportProgress('converting', 0);
        let renderSettings: IBrowserDjvuPdfRenderSettings;
        try {
            renderSettings = resolveBrowserDjvuPdfRenderSettings(options);
        } catch (error) {
            return {
                success: false as const,
                jobId,
                error: error instanceof Error && getErrorMessage(error).trim().length > 0
                    ? getErrorMessage(error)
                    : 'Invalid DjVu PDF conversion settings',
                expected: createBrowserDjvuExpectedOutcome('validation-rejected'),
            };
        }
        const renderConcurrency = resolveBrowserDjvuPdfRenderConcurrency(pages.map(page => page.metrics), undefined, options.hostTier ?? 'medium');
        BrowserLogger.info('djvu-browser', 'Starting browser DjVu PDF conversion', {
            jobId,
            pageCount,
            strategy: renderSettings.strategy,
            subsample: renderSettings.subsample,
            jpegQuality: renderSettings.jpegQuality,
            renderConcurrency,
        });
        const preserveBookmarks = options.preserveBookmarks !== false;
        const reportPageProcessed = (processed: number, total: number) => {
            reportProgress('converting', Math.round((processed / total) * 90));
        };
        const reportBookmarksStart = () => {
            reportProgress('bookmarks', 95);
        };
        const createRenderWorker = async () => {
            const renderWorker = await createDjvuWorkerFromPath(djvuPath, { signal: abortController.signal });
            attachDjvuJobWorker(jobId, renderWorker);
            return renderWorker;
        };
        const buildDirectPdf = () => buildDjvuPdfWithWasm({
            mode: 'direct',
            worker,
            createRenderWorker,
            pages,
            buildPageSpec: (pageWorker, outputPage, pageSignal) => buildDirectDjvuPageSpec(
                pageWorker,
                outputPage,
                renderSettings.subsample,
                DJVU_DIRECT_PDF_JPEG_QUALITY,
                pageSignal,
            ),
            preserveBookmarks,
            outputPath,
            signal: abortController.signal,
            onPageProcessed: reportPageProcessed,
            onAssembleStart: () => reportProgress('assembling', 90),
            onBookmarksStart: reportBookmarksStart,
        });
        let pdfPath: TDocumentRef;
        if (renderSettings.strategy === 'compact-djvu-aware') {
            const preset = resolveDjvuCompactFidelityPreset(renderSettings.subsample);
            try {
                pdfPath = await buildDjvuPdfWithWasm({
                    mode: 'compact',
                    worker,
                    createRenderWorker,
                    pages,
                    buildPageSpec: (pageWorker, outputPage, pageSignal) => buildBrowserDjvuCompactPage(
                        pageWorker,
                        outputPage.pageNumber,
                        outputPage.metrics,
                        preset,
                        pageSignal,
                    ),
                    preserveBookmarks,
                    outputPath,
                    signal: abortController.signal,
                    onPageProcessed: reportPageProcessed,
                    onAssembleStart: () => reportProgress('assembling', 90),
                    onBookmarksStart: reportBookmarksStart,
                });
            } catch (error) {
                // A compact page the combine engine cannot hold falls back to
                // the smaller JPEG direct export through pdf-image-combine WASM.
                if (!isPdfCombineOutputTooLargeError(error)) {
                    throw error;
                }
                BrowserLogger.info('djvu-browser', 'Browser compact DjVu export exceeds the WASM boundary; falling back to direct JPEG combine', {
                    jobId,
                    error: getErrorMessage(error),
                });
                pdfPath = await buildDirectPdf();
            }
        } else {
            pdfPath = await buildDirectPdf();
        }

        reportProgress('bookmarks', 100);

        return {
            success: true as const,
            pdfPath,
            jobId,
            pageSizes: pages.map(page => page.metrics),
        };
    } catch (error) {
        const expected = classifyBrowserDjvuExpectedOutcome(error);
        if (expected !== undefined) {
            return {
                success: false as const,
                jobId,
                error: error instanceof Error ? getErrorMessage(error) : 'DjVu conversion failed',
                expected,
            };
        }

        const failure = getBrowserDjvuFailureReceipt(error)
            ?? BrowserLogger.error('djvu-browser', 'DjVu conversion failed', error, {code: 'RENDERER_DJVU_OPERATION_FAILED'});
        return {
            success: false as const,
            jobId,
            error:
                error instanceof Error ? getErrorMessage(error) : 'DjVu conversion failed',
            failure,
        };
    } finally {
        cleanupDjvuJob(jobId);
    }
}

export function cancelBrowserDjvuConversion(jobId: string) {
    const job = activeJobs.get(jobId);
    if (!job) {
        return { canceled: false };
    }

    job.abortController.abort();
    cleanupDjvuJob(jobId);
    return { canceled: true };
}

export function onBrowserDjvuConversionProgress(callback: (progress: IDjvuProgress) => void) {
    progressListeners.add(callback);
    return () => {
        progressListeners.delete(callback);
    };
}
