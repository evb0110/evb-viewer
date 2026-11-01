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
    type TDjvuCompactFidelityPreset,
} from '@contracts/djvuConversionPolicy';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    createJobId,
    type TJobId,
} from '@contracts/shared';
import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import type { IBrowserPdfCombineWasmPageSpec } from '@app/platform/browser-api/browserPdfCombineWorker.types';
import {BROWSER_PDF_COMBINE_MAX_REQUEST_BYTES} from '@app/platform/browser-api/browserPdfCombineWorker.types';
import type {
    IDjvuContentsItem,
    IDjvuWorker,
} from '@app/platform/browser-api/djvujsLoader';
import {
    createDjvuWorkerFromPath,
    getDjvuWorkerPageSizes,
} from '@app/platform/browser-api/createDjvuWorkerFromPath';
import {
    StreamingImagePdfWriter,
    type IStreamingPdfSink,
} from '@app/platform/browser-api/streamingImagePdfWriter';
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
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import { toPdfDateString } from '@app/utils/pdfDate';
import { toOwnedArrayBuffer } from '@app/platform/browser-api/browserDjvuCanvas';
import {PdfCombineCapabilityError} from '@contracts/pdfCombineErrors';
import {isPdfCombineOutputTooLargeError} from '@contracts/pdfCombineOutputPolicy';
import {getRawElectronPlatformApi} from '@app/utils/electronPlatformBridge';
import {
    DjvuCanceledError,
    renderDjvuPage,
    throwIfDjvuCanceled as throwIfCanceled,
    type IDjvuPageMetrics,
    type IRenderedDjvuPage,
} from '@app/platform/browser-api/browserDjvuRasterizer';

const DJVU_DIRECT_PDF_JPEG_QUALITY = 0.92;
const DJVU_PDF_RENDER_WORKER_LIMIT = 3;
const DJVU_PDF_MEDIUM_PAGE_PIXEL_COUNT = 16_000_000;
const DJVU_PDF_LARGE_PAGE_PIXEL_COUNT = 32_000_000;
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
        || error instanceof DOMException && error.name === 'AbortError'
        || error instanceof Error && error.name === 'AbortError'
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

/**
 * A compact plan larger than one WASM request can hold. The request is built
 * in one WASM32 allocation, so past this boundary the export streams the
 * direct PDF instead.
 */
class BrowserDjvuCompactPlanTooLargeError extends Error {
    public constructor(public readonly plannedBytes: number) {
        super(`Browser compact DjVu export exceeds the WASM request boundary (${plannedBytes} bytes planned)`);
        this.name = 'BrowserDjvuCompactPlanTooLargeError';
    }
}

interface IFinalizablePdfSink extends IStreamingPdfSink {
    finish(): Promise<TDocumentRef>;
    abort(): Promise<void>;
}

class BrowserChunkedPdfSink implements IFinalizablePdfSink {
    private readonly buffer: Uint8Array;
    private chunkIndex = 0;
    private bufferedBytes = 0;
    private fileSize = 0;

    public constructor(
        private readonly outputPath: TDocumentRef,
        private readonly saveName: string,
        private readonly chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE,
    ) {
        this.buffer = new Uint8Array(chunkSize);
    }

    public async init() {
        await browserDocumentStore.prepareChunkedDocument(this.outputPath, { chunkSize: this.chunkSize });
    }

    public async write(bytes: Uint8Array) {
        let readOffset = 0;
        this.fileSize += bytes.byteLength;
        while (readOffset < bytes.byteLength) {
            const writeLength = Math.min(this.chunkSize - this.bufferedBytes, bytes.byteLength - readOffset);
            this.buffer.set(bytes.subarray(readOffset, readOffset + writeLength), this.bufferedBytes);
            this.bufferedBytes += writeLength;
            readOffset += writeLength;
            if (this.bufferedBytes === this.chunkSize) {
                await browserDocumentStore.writeChunk(this.outputPath, this.chunkIndex, this.buffer);
                this.chunkIndex += 1;
                this.bufferedBytes = 0;
            }
        }
    }

    public async finish() {
        if (this.bufferedBytes > 0) {
            await browserDocumentStore.writeChunk(
                this.outputPath,
                this.chunkIndex,
                this.buffer.slice(0, this.bufferedBytes),
            );
            this.chunkIndex += 1;
            this.bufferedBytes = 0;
        }
        await browserDocumentStore.finalizeChunkedDocument(this.outputPath, {
            fileSize: this.fileSize,
            chunkCount: this.chunkIndex,
            chunkSize: this.chunkSize,
            saveName: this.saveName,
        });
        await browserDocumentStore.setRetention(this.outputPath, 'durable');
        browserDocumentStore.unload(this.outputPath);
        return this.outputPath;
    }

    public async abort() {
        await browserDocumentStore.clearChunkedDocument(this.outputPath);
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
    const sink = new BrowserChunkedPdfSink(outputPath, saveTarget.saveName);
    throwIfCanceled(signal);
    try {
        await sink.init();
        throwIfCanceled(signal);
        return sink;
    } catch (error) {
        await sink.abort().catch(() => undefined);
        throw error;
    }
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

interface IBrowserDjvuRenderTaskSuccess {
    pageNumber: number;
    pageData: IRenderedDjvuPage;
    worker: IDjvuWorker;
}

interface IBrowserDjvuRenderTaskFailure {
    pageNumber: number;
    error: unknown;
    worker: IDjvuWorker;
}

type TBrowserDjvuRenderTaskResult =
    | IBrowserDjvuRenderTaskSuccess
    | IBrowserDjvuRenderTaskFailure;

interface IBrowserDjvuRenderTask {
    pageNumber: number;
    promise: Promise<TBrowserDjvuRenderTaskResult>;
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
    items: IDjvuContentsItem[] | null | undefined,
    pages: readonly IDjvuOutputPage[],
    signal?: AbortSignal,
): Promise<IPdfBookmarkEntry[]> {
    throwIfCanceled(signal);
    if (!items || items.length === 0) {
        return [];
    }

    const bookmarks: IPdfBookmarkEntry[] = [];

    for (const item of items) {
        throwIfCanceled(signal);
        const pageNumber = item.url
            ? await worker.doc.getPageNumberByUrl(item.url).run().catch(() => null)
            : null;
        const children = await mapDjvuContentsToPdfBookmarks(
            worker,
            item.children,
            pages,
            signal,
        );
        // A destination is the target page's position in the output; a page
        // left out of the output leaves its bookmark without a destination.
        const outputIndex = typeof pageNumber === 'number' && pageNumber > 0
            ? pages.findIndex(page => page.pageNumber === pageNumber)
            : -1;

        bookmarks.push({
            title: item.description,
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
}

/**
 * Adds the outline to a PDF written without one, through the page-ops
 * catalog writer desktop uses for the same job (save-mutations, appended).
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
    const result = await runBrowserPageOpsWorkerRequest('saveMutations', {
        data,
        mutations: {bookmarks: {
            totalPages: pageCount,
            untitledLabel: 'Untitled',
            items: bookmarks,
        }},
        modifiedAt: toPdfDateString(),
    }, signal ? {signal} : {});
    if (isBrowserPageOpsWasmFailure(result)) {
        throw new Error(`Browser DjVu bookmark embedding failed: ${result.error.message}`);
    }
    return result.data;
}

async function createPdfRenderWorkers(options: {
    worker: IDjvuWorker;
    renderConcurrency: number;
    createRenderWorker?: (() => Promise<IDjvuWorker>) | undefined;
    signal?: AbortSignal | undefined;
}) {
    const workers = [options.worker];
    const additionalWorkerCount = Math.max(
        0,
        Math.trunc(options.renderConcurrency) - 1,
    );

    for (let index = 0; index < additionalWorkerCount; index += 1) {
        throwIfCanceled(options.signal);
        if (!options.createRenderWorker) {
            break;
        }
        workers.push(await options.createRenderWorker());
    }

    return workers;
}

async function renderDjvuPagesIntoWriter(options: {
    writer: StreamingImagePdfWriter;
    workers: IDjvuWorker[];
    pages: readonly IDjvuOutputPage[];
    subsample: number;
    jpegQuality: number;
    signal?: AbortSignal | undefined;
    onPageProcessed?: ((processed: number, total: number) => void) | undefined;
}) {
    const total = options.pages.length;
    const activeTasks = new Map<number, IBrowserDjvuRenderTask>();
    // Tasks are keyed by output position; each renders its source page.
    let nextPageNumber = 1;

    const startTask = (worker: IDjvuWorker): IBrowserDjvuRenderTask | null => {
        const outputPage = options.pages[nextPageNumber - 1];
        if (!outputPage) {
            return null;
        }

        const pageNumber = nextPageNumber;
        nextPageNumber += 1;
        const promise = renderDjvuPage(
            worker,
            outputPage.pageNumber,
            outputPage.metrics.dpi,
            options.subsample,
            options.jpegQuality,
            options.signal,
        ).then(
            pageData => ({
                pageNumber,
                pageData,
                worker,
            } satisfies TBrowserDjvuRenderTaskResult),
            error => ({
                pageNumber,
                error,
                worker,
            } satisfies TBrowserDjvuRenderTaskResult),
        );

        return {
            pageNumber,
            promise,
        };
    };

    for (const worker of options.workers) {
        const task = startTask(worker);
        if (!task) {
            break;
        }
        activeTasks.set(task.pageNumber, task);
    }

    for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
        throwIfCanceled(options.signal);
        const task = activeTasks.get(pageNumber);
        if (!task) {
            throw new Error(`DjVu PDF render task for page ${pageNumber} was not scheduled`);
        }

        const result = await task.promise;
        activeTasks.delete(pageNumber);
        if ('error' in result) {
            throw result.error;
        }

        await options.writer.addPage(result.pageData);
        options.onPageProcessed?.(pageNumber, total);
        const nextTask = startTask(result.worker);
        if (nextTask) {
            activeTasks.set(nextTask.pageNumber, nextTask);
        }
        await yieldToBrowser();
    }
}

async function buildPdfWithOptionalBookmarks(options: {
    worker: IDjvuWorker;
    pages: readonly IDjvuOutputPage[];
    subsample: number;
    jpegQuality: number;
    renderConcurrency: number;
    createRenderWorker?: () => Promise<IDjvuWorker>;
    preserveBookmarks: boolean;
    outputPath: TDocumentRef;
    signal?: AbortSignal;
    onPageProcessed?: (processed: number, total: number) => void;
    onBookmarksStart?: () => void;
}) {
    const sink = await createBrowserDjvuPdfOutputSink(options.outputPath, options.signal);

    try {
        let bookmarks: IPdfBookmarkEntry[] = [];
        if (options.preserveBookmarks) {
            throwIfCanceled(options.signal);
            const contents = await options.worker.doc.getContents().run().catch(() => null);
            throwIfCanceled(options.signal);
            bookmarks = await mapDjvuContentsToPdfBookmarks(
                options.worker,
                contents,
                options.pages,
                options.signal,
            );
        }

        throwIfCanceled(options.signal);
        const writer = new StreamingImagePdfWriter({
            sink,
            pageCount: options.pages.length,
            bookmarks,
        });
        await writer.start();
        throwIfCanceled(options.signal);

        const renderWorkers = await createPdfRenderWorkers({
            worker: options.worker,
            renderConcurrency: options.renderConcurrency,
            createRenderWorker: options.createRenderWorker,
            signal: options.signal,
        });
        await renderDjvuPagesIntoWriter({
            writer,
            workers: renderWorkers,
            pages: options.pages,
            subsample: options.subsample,
            jpegQuality: options.jpegQuality,
            signal: options.signal,
            onPageProcessed: options.onPageProcessed,
        });

        throwIfCanceled(options.signal);
        if (options.preserveBookmarks) {
            options.onBookmarksStart?.();
        }
        await writer.finish();
        throwIfCanceled(options.signal);
        return await sink.finish();
    } catch (error) {
        await sink.abort().catch((abortError: unknown) => {
            BrowserLogger.warn('djvu-browser', 'Failed to abort browser PDF sink', abortError);
        });
        throw error;
    }
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
            BrowserLogger.warn('djvu-browser', 'Failed to abort browser compact PDF sink', abortError);
        });
        throw error;
    }
}

async function buildCompactDjvuPdfWithWasm(options: {
    worker: IDjvuWorker;
    pages: readonly IDjvuOutputPage[];
    preset: TDjvuCompactFidelityPreset;
    preserveBookmarks: boolean;
    outputPath: TDocumentRef;
    signal?: AbortSignal;
    onPageProcessed?: (processed: number, total: number) => void;
    onBookmarksStart?: () => void;
}) {
    // Each page keeps the DjVu layers desktop's compact export keeps: a JB2
    // mask the WASM writer encodes as a bilevel image, over the background at
    // its own resolution when the background is not flat, or the rendered
    // page as a photo where layers would lose its colors.
    const pageSpecs: IBrowserPdfCombineWasmPageSpec[] = [];
    const routes = new Map<string, number>();
    const pageCount = options.pages.length;
    let plannedBytes = 0;

    for (const [
        index,
        outputPage,
    ] of options.pages.entries()) {
        throwIfCanceled(options.signal);
        const pageNumber = index + 1;
        const page = await buildBrowserDjvuCompactPage(
            options.worker,
            outputPage.pageNumber,
            outputPage.metrics,
            options.preset,
            options.signal,
        );
        for (const input of [
            page.spec.image,
            page.spec.background,
            page.spec.mask,
        ]) {
            plannedBytes += input?.data.byteLength ?? 0;
        }
        if (plannedBytes > BROWSER_PDF_COMBINE_MAX_REQUEST_BYTES) {
            throw new BrowserDjvuCompactPlanTooLargeError(plannedBytes);
        }
        pageSpecs.push(page.spec);
        routes.set(page.route, (routes.get(page.route) ?? 0) + 1);
        options.onPageProcessed?.(pageNumber, pageCount);
        await yieldToBrowser();
    }
    BrowserLogger.info('djvu-browser', 'Browser compact DjVu pages planned', {
        pageCount,
        plannedBytes,
        routes: Object.fromEntries(routes),
    });

    throwIfCanceled(options.signal);
    try {
        const {data} = await runBrowserPdfCombineWorkerRequest('combinePdfs', {
            inputs: [],
            wasmImagePreprocessing: {pageSpecs},
        }, options.signal);
        throwIfCanceled(options.signal);
        let output = data;
        if (options.preserveBookmarks) {
            const contents = await options.worker.doc.getContents().run().catch(() => null);
            const bookmarks = await mapDjvuContentsToPdfBookmarks(options.worker, contents, options.pages, options.signal);
            if (bookmarks.length > 0) {
                options.onBookmarksStart?.();
                output = await embedBrowserPdfBookmarks(data, pageCount, bookmarks, options.signal);
                throwIfCanceled(options.signal);
            }
        }
        return await writePdfBytesToOutput(options.outputPath, output, options.signal);
    } catch (error) {
        const message = getErrorMessage(error);
        const isUnsupported = message === 'ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT';
        if (isUnsupported || message === 'ERR_BROWSER_PDF_COMBINE_WASM_UNAVAILABLE') {
            throw new BrowserDjvuExpectedOutcomeError(
                isUnsupported
                    ? 'Browser compact DjVu export does not support this page data'
                    : 'Browser compact DjVu export is temporarily unavailable',
                createBrowserDjvuExpectedOutcome(isUnsupported
                    ? 'unsupported-input'
                    : 'temporarily-unavailable'),
            );
        }
        throw error;
    }
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
    for (let pageNumber = 1; pageNumber <= pageCount && !hasText; pageNumber += 1) {
        const text = await worker.doc.getPage(pageNumber).getText().run().catch(() => '');
        hasText = text.trim().length > 0;
        if (pageNumber % DJVU_TEXT_SCAN_YIELD_PAGES === 0) {
            await yieldToBrowser();
        }
    }
    textScanResults.set(versionKey, hasText);
    for (const key of textScanResults.keys()) {
        if (textScanResults.size <= DJVU_TEXT_SCAN_CACHE_ENTRIES) break;
        textScanResults.delete(key);
    }
    return hasText;
}

export async function getBrowserDjvuInfo(djvuPath: TDocumentRef): Promise<IDjvuInfo> {
    return withBrowserDjvuWorker(djvuPath, async (worker) => {
        const pageSizes = await getDjvuWorkerPageSizes(worker);
        const contents = await worker.doc.getContents().run().catch(() => null);
        return {
            pageCount: pageSizes.length,
            sourceDpi: pageSizes[0]?.dpi ?? 300,
            hasBookmarks: Boolean(contents && contents.length > 0),
            hasText: await detectBrowserDjvuHasText(djvuPath, worker, pageSizes.length),
            metadata: {},
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

        emitProgress({
            jobId,
            phase: 'loading',
            percent: 0,
        });
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

        emitProgress({
            jobId,
            phase: 'converting',
            percent: 0,
        });
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
            emitProgress({
                jobId,
                phase: 'converting',
                percent: Math.round((processed / total) * 90),
            });
        };
        const reportBookmarksStart = () => {
            emitProgress({
                jobId,
                phase: 'bookmarks',
                percent: 95,
            });
        };
        const buildDirectPdf = () => buildPdfWithOptionalBookmarks({
            worker,
            pages,
            subsample: renderSettings.subsample,
            jpegQuality: DJVU_DIRECT_PDF_JPEG_QUALITY,
            renderConcurrency,
            createRenderWorker: async () => {
                const renderWorker = await createDjvuWorkerFromPath(djvuPath, { signal: abortController.signal });
                attachDjvuJobWorker(jobId, renderWorker);
                return renderWorker;
            },
            preserveBookmarks,
            outputPath,
            signal: abortController.signal,
            onPageProcessed: reportPageProcessed,
            onBookmarksStart: reportBookmarksStart,
        });
        let pdfPath: TDocumentRef;
        if (renderSettings.strategy === 'compact-djvu-aware') {
            try {
                pdfPath = await buildCompactDjvuPdfWithWasm({
                    worker,
                    pages,
                    preset: resolveDjvuCompactFidelityPreset(renderSettings.subsample),
                    preserveBookmarks,
                    outputPath,
                    signal: abortController.signal,
                    onPageProcessed: reportPageProcessed,
                    onBookmarksStart: reportBookmarksStart,
                });
            } catch (error) {
                if (!(error instanceof BrowserDjvuCompactPlanTooLargeError) && !isPdfCombineOutputTooLargeError(error)) {
                    throw error;
                }
                BrowserLogger.info('djvu-browser', 'Browser compact DjVu export exceeds the WASM boundary; using streaming direct export', {
                    jobId,
                    error: getErrorMessage(error),
                });
                pdfPath = await buildDirectPdf();
            }
        } else {
            pdfPath = await buildDirectPdf();
        }

        emitProgress({
            jobId,
            phase: 'bookmarks',
            percent: 100,
        });

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
