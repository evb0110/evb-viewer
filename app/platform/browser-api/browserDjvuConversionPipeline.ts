import { uniq } from 'es-toolkit/array';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type {
    IDjvuConvertOptions,
    IDjvuInfo,
    IDjvuProgress,
    IDjvuSizeEstimate,
} from '@contracts/electronApiDjvu';
import type { THostResourceTier } from '@contracts/hostResourceProfile';
import {
    normalizeDjvuPdfSubsample,
    resolveBrowserDjvuConversionPreflight,
    resolveDjvuPdfExportStrategy,
} from '@contracts/djvuConversionPolicy';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import type { IBrowserPdfCombineWasmPageSpec } from '@app/platform/browser-api/browserPdfCombineWorker.types';
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
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    decodeFailureReceipt,
    type ExpectedOutcome,
    type ExpectedOutcomeCode,
    type FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import { tryCombineImageInputsWithWasm } from '@app/platform/browser-api/tryCombineImageInputsWithWasm';
import { toOwnedArrayBuffer } from '@app/platform/browser-api/browserDjvuCanvas';
import {PdfCombineCapabilityError} from '@contracts/pdfCombineErrors';
import {isPdfCombineOutputTooLargeError} from '@contracts/pdfCombineOutputPolicy';
import {SerializableError} from '@contracts/serializableError';
import {getRawElectronPlatformApi} from '@app/utils/electronPlatformBridge';
import {
    DjvuCanceledError,
    DJVU_COMPACT_PHOTO_PPI_CAP,
    positiveInteger,
    renderDjvuPage,
    renderDjvuPageAsPpm,
    throwIfDjvuCanceled as throwIfCanceled,
    type IDjvuPageMetrics,
    type IRenderedDjvuPage,
} from '@app/platform/browser-api/browserDjvuRasterizer';

const DJVU_COMPACT_PHOTO_PAGE_SPEC_MAX_BYTES = 192 * 1024 * 1024;
const DJVU_PAGE_SPEC_OVERHEAD_BYTES = 256;
const DJVU_DIRECT_PDF_JPEG_QUALITY = 0.92;
const DJVU_COMPACT_PHOTO_JPEG_QUALITY = 85;
const DJVU_BROWSER_WORKER_SOURCE_MAX_BYTES = 192 * 1024 * 1024;
const DJVU_WORKER_COPY_BUDGET_BYTES = 192 * 1024 * 1024;
const DJVU_PDF_RENDER_WORKER_LIMIT = 3;
const DJVU_PDF_MEDIUM_PAGE_PIXEL_COUNT = 16_000_000;
const DJVU_PDF_LARGE_PAGE_PIXEL_COUNT = 32_000_000;
const DJVU_ESTIMATE_PRESETS = [
    1,
    2,
    4,
] as const;
const DJVU_INFO_TEXT_SAMPLE_PAGES = 3;
const DJVU_ESTIMATE_SAMPLE_PAGES = 3;

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

    if (error instanceof Error && error.message.trim().toLowerCase() === 'djvu conversion canceled') {
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
            ? DJVU_COMPACT_PHOTO_JPEG_QUALITY
            : DJVU_DIRECT_PDF_JPEG_QUALITY,
    };
}

export function resolveBrowserDjvuPdfRenderConcurrency(
    pageSizes: ReadonlyArray<Pick<IDjvuPageMetrics, 'width' | 'height'>>,
    hardwareConcurrency = typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency,
    sourceBytes = 0,
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
    const sourceCopyLimit = sourceBytes > 0
        ? Math.max(1, Math.floor(DJVU_WORKER_COPY_BUDGET_BYTES / sourceBytes))
        : DJVU_PDF_RENDER_WORKER_LIMIT;
    const tierWorkerLimit = tier === 'low' ? 1 : DJVU_PDF_RENDER_WORKER_LIMIT;
    return Math.min(
        pageCount,
        tierWorkerLimit,
        pixelWorkerLimit,
        sourceCopyLimit,
        hardwareWorkerCount,
    );
}

export { resolveBrowserDjvuConversionPreflight } from '@contracts/djvuConversionPolicy';

export interface IBrowserDjvuCompactExportPlan {
    strategy: 'compact-djvu-aware' | 'direct-fallback';
    estimatedPageSpecBytes: number;
    maxPageSpecBytes: number;
    fallbackReason?: 'bookmarks' | 'memory-budget';
}

function estimatePageSpecBytes(pageSizes: readonly IDjvuPageMetrics[]) {
    return pageSizes.reduce((totalBytes, page) => {
        const width = positiveInteger(page.width) ?? 1;
        const height = positiveInteger(page.height) ?? 1;
        const dpi = positiveInteger(page.dpi) ?? DJVU_COMPACT_PHOTO_PPI_CAP;
        const scale = Math.max(1, dpi / DJVU_COMPACT_PHOTO_PPI_CAP);
        return totalBytes + DJVU_PAGE_SPEC_OVERHEAD_BYTES
            + Math.max(1, Math.round(width / scale)) * Math.max(1, Math.round(height / scale)) * 3;
    }, 0);
}

export function resolveBrowserDjvuCompactExportPlan(
    pageSizes: readonly IDjvuPageMetrics[],
    maxPageSpecBytes = DJVU_COMPACT_PHOTO_PAGE_SPEC_MAX_BYTES,
    preserveBookmarks = false,
): IBrowserDjvuCompactExportPlan {
    const estimatedPageSpecBytes = estimatePageSpecBytes(pageSizes);
    const fallbackReason = preserveBookmarks
        ? 'bookmarks'
        : estimatedPageSpecBytes > maxPageSpecBytes
            ? 'memory-budget'
            : undefined;
    return {
        strategy: fallbackReason ? 'direct-fallback' : 'compact-djvu-aware',
        estimatedPageSpecBytes,
        maxPageSpecBytes,
        ...(fallbackReason ? {fallbackReason} : {}),
    };
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
    ) {
        return new BrowserHandlePdfSink(outputPath, saveHandle, saveName, await saveHandle.createWritable());
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

async function createBrowserDjvuPdfOutputSink(outputPath: TDocumentRef) {
    const saveTarget = await browserDocumentStore.getSaveTarget(outputPath);
    if (saveTarget.saveHandle) {
        return BrowserHandlePdfSink.create(outputPath, saveTarget.saveHandle, saveTarget.saveName);
    }
    const sink = new BrowserChunkedPdfSink(outputPath, saveTarget.saveName);
    await sink.init();
    return sink;
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
            signal,
        );

        bookmarks.push({
            title: item.description,
            pageIndex:
                typeof pageNumber === 'number' && pageNumber > 0
                    ? pageNumber - 1
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
    pageSizes: IDjvuPageMetrics[];
    subsample: number;
    jpegQuality: number;
    signal?: AbortSignal | undefined;
    onPageProcessed?: ((processed: number, total: number) => void) | undefined;
}) {
    const total = options.pageSizes.length;
    const activeTasks = new Map<number, IBrowserDjvuRenderTask>();
    let nextPageNumber = 1;

    const startTask = (worker: IDjvuWorker): IBrowserDjvuRenderTask | null => {
        if (nextPageNumber > total) {
            return null;
        }

        const pageNumber = nextPageNumber;
        nextPageNumber += 1;
        const promise = renderDjvuPage(
            worker,
            pageNumber,
            options.pageSizes[pageNumber - 1]?.dpi ?? 300,
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
    pageSizes: IDjvuPageMetrics[];
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
    const sink = await createBrowserDjvuPdfOutputSink(options.outputPath);

    try {
        let bookmarks: IPdfBookmarkEntry[] = [];
        if (options.preserveBookmarks) {
            throwIfCanceled(options.signal);
            const contents = await options.worker.doc.getContents().run().catch(() => null);
            throwIfCanceled(options.signal);
            bookmarks = await mapDjvuContentsToPdfBookmarks(
                options.worker,
                contents,
                options.signal,
            );
        }

        throwIfCanceled(options.signal);
        const writer = new StreamingImagePdfWriter({
            sink,
            pageCount: options.pageSizes.length,
            bookmarks,
        });
        await writer.start();

        const renderWorkers = await createPdfRenderWorkers({
            worker: options.worker,
            renderConcurrency: options.renderConcurrency,
            createRenderWorker: options.createRenderWorker,
            signal: options.signal,
        });
        await renderDjvuPagesIntoWriter({
            writer,
            workers: renderWorkers,
            pageSizes: options.pageSizes,
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
) {
    const sink = await createBrowserDjvuPdfOutputSink(outputPath);
    try {
        await sink.write(bytes);
        return await sink.finish();
    } catch (error) {
        await sink.abort().catch((abortError: unknown) => {
            BrowserLogger.warn('djvu-browser', 'Failed to abort browser compact PDF sink', abortError);
        });
        throw error;
    }
}

async function buildCompactPhotoPdfWithWasm(options: {
    worker: IDjvuWorker;
    pageSizes: IDjvuPageMetrics[];
    outputPath: TDocumentRef;
    signal?: AbortSignal;
    onPageProcessed?: (processed: number, total: number) => void;
}) {
    // The bundled djvu.js wrapper does not expose stable raw Sjbz/BG44/FG44 layer buffers.
    // Keep web compact export bounded by rendering capped photo-style PPM pages and letting
    // the Rust WASM encoder own JPEG quality, grayscale detection, and PDF image embedding.
    const pageSpecs: IBrowserPdfCombineWasmPageSpec[] = [];
    const pageCount = options.pageSizes.length;

    for (const [
        index,
        pageSize,
    ] of options.pageSizes.entries()) {
        throwIfCanceled(options.signal);
        const pageNumber = index + 1;
        const renderedPage = await renderDjvuPageAsPpm(
            options.worker,
            pageNumber,
            pageSize,
            options.signal,
        );
        pageSpecs.push({
            kind: 'image',
            pageSize: renderedPage.pageSize,
            jpegQuality: DJVU_COMPACT_PHOTO_JPEG_QUALITY,
            ppiCap: DJVU_COMPACT_PHOTO_PPI_CAP,
            image: renderedPage.input,
        });
        options.onPageProcessed?.(pageNumber, pageCount);
        await yieldToBrowser();
    }

    throwIfCanceled(options.signal);
    const outcome = await tryCombineImageInputsWithWasm([], {pageSpecs});
    if (outcome.status === 'fatal') {
        // Compact DjVu export returns one complete PDF byte value from WASM.
        // Preserve the shared browser output-cap envelope instead of turning
        // an over-cap result into the generic "WASM unavailable" error.
        throw new SerializableError(outcome.error);
    }
    if (outcome.status !== 'success') {
        const isUnsupported = outcome.status === 'unsupported';
        throw new BrowserDjvuExpectedOutcomeError(
            isUnsupported
                ? 'Browser compact DjVu export does not support this page data'
                : 'Browser compact DjVu export is temporarily unavailable',
            createBrowserDjvuExpectedOutcome(isUnsupported
                ? 'unsupported-input'
                : 'temporarily-unavailable'),
        );
    }
    return writePdfBytesToOutput(options.outputPath, outcome.data);
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

export async function getBrowserDjvuInfo(djvuPath: TDocumentRef): Promise<IDjvuInfo> {
    return withBrowserDjvuWorker(djvuPath, async (worker) => {
        const pageSizes = await getDjvuWorkerPageSizes(worker);
        const contents = await worker.doc.getContents().run().catch(() => null);
        const samplePages = pickSamplePageNumbers(
            pageSizes.length,
            DJVU_INFO_TEXT_SAMPLE_PAGES,
        );

        let hasText = false;
        for (const pageNumber of samplePages) {
            const text = await worker.doc.getPage(pageNumber).getText().run().catch(() => '');
            if (text.trim().length > 0) {
                hasText = true;
                break;
            }
            await yieldToBrowser();
        }

        return {
            pageCount: pageSizes.length,
            sourceDpi: pageSizes[0]?.dpi ?? 300,
            hasBookmarks: Boolean(contents && contents.length > 0),
            hasText,
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

export async function runBrowserDjvuConversion(
    djvuPath: TDocumentRef,
    outputPath: TDocumentRef,
    options: IDjvuConvertOptions,
) {
    const jobId = options.jobId ?? `djvu-convert-${crypto.randomUUID()}`;
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

        const sourceBytes = isBrowserDocumentRef(djvuPath)
            ? (await browserDocumentStore.stat(djvuPath)).size
            : 0;
        if (sourceBytes > DJVU_BROWSER_WORKER_SOURCE_MAX_BYTES) {
            return {
                success: false as const,
                jobId,
                error: 'Browser DjVu processing is limited to 192MB source files. Use the Electron app for this archival job.',
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
        const preflight = resolveBrowserDjvuConversionPreflight(pageSizes);
        if (!preflight.allowed) {
            const limitDescription = preflight.reason === 'page-count'
                ? `has ${preflight.pageCount} pages, but converting in the browser supports up to ${preflight.maxPages}`
                : 'has pages too large to convert in the browser';
            return {
                success: false as const,
                jobId,
                error: `This document ${limitDescription}. Use the desktop app to convert it.`,
                expected: createBrowserDjvuExpectedOutcome('validation-rejected'),
            };
        }

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
                error: error instanceof Error && error.message.trim().length > 0
                    ? error.message
                    : 'Invalid DjVu PDF conversion settings',
                expected: createBrowserDjvuExpectedOutcome('validation-rejected'),
            };
        }
        const renderConcurrency = resolveBrowserDjvuPdfRenderConcurrency(pageSizes, undefined, sourceBytes, options.hostTier ?? 'medium');
        BrowserLogger.info('djvu-browser', 'Starting browser DjVu PDF conversion', {
            jobId,
            pageCount,
            strategy: renderSettings.strategy,
            subsample: renderSettings.subsample,
            jpegQuality: renderSettings.jpegQuality,
            renderConcurrency,
        });
        const compactExportPlan = renderSettings.strategy === 'compact-djvu-aware'
            ? resolveBrowserDjvuCompactExportPlan(
                pageSizes,
                DJVU_COMPACT_PHOTO_PAGE_SPEC_MAX_BYTES,
                options.preserveBookmarks !== false,
            )
            : null;
        if (compactExportPlan?.strategy === 'direct-fallback') {
            BrowserLogger.info('djvu-browser', compactExportPlan.fallbackReason === 'bookmarks'
                ? 'Browser compact DjVu export cannot preserve bookmarks; using streaming direct export'
                : 'Browser compact DjVu export exceeds in-memory WASM budget; using streaming direct export', {
                jobId,
                fallbackReason: compactExportPlan.fallbackReason,
                estimatedPageSpecBytes: compactExportPlan.estimatedPageSpecBytes,
                maxPageSpecBytes: compactExportPlan.maxPageSpecBytes,
            });
        }
        const useCompactWasm = compactExportPlan?.strategy === 'compact-djvu-aware';
        const streamingRenderSettings = useCompactWasm
            ? renderSettings
            : {
                strategy: 'direct' as const,
                subsample: renderSettings.subsample,
                jpegQuality: DJVU_DIRECT_PDF_JPEG_QUALITY,
            };

        const pdfPath = useCompactWasm
            ? await buildCompactPhotoPdfWithWasm({
                worker,
                pageSizes,
                outputPath,
                signal: abortController.signal,
                onPageProcessed: (processed, total) => {
                    emitProgress({
                        jobId,
                        phase: 'converting',
                        percent: Math.round((processed / total) * 90),
                    });
                },
            })
            : await buildPdfWithOptionalBookmarks({
                worker,
                pageSizes,
                subsample: streamingRenderSettings.subsample,
                jpegQuality: streamingRenderSettings.jpegQuality,
                renderConcurrency,
                createRenderWorker: async () => {
                    const renderWorker = await createDjvuWorkerFromPath(djvuPath, { signal: abortController.signal });
                    attachDjvuJobWorker(jobId, renderWorker);
                    return renderWorker;
                },
                preserveBookmarks: options.preserveBookmarks !== false,
                outputPath,
                signal: abortController.signal,
                onPageProcessed: (processed, total) => {
                    emitProgress({
                        jobId,
                        phase: 'converting',
                        percent: Math.round((processed / total) * 90),
                    });
                },
                onBookmarksStart: () => {
                    emitProgress({
                        jobId,
                        phase: 'bookmarks',
                        percent: 95,
                    });
                },
            });

        emitProgress({
            jobId,
            phase: 'bookmarks',
            percent: 100,
        });

        return {
            success: true as const,
            pdfPath,
            jobId,
        };
    } catch (error) {
        const expected = classifyBrowserDjvuExpectedOutcome(error);
        if (expected !== undefined) {
            return {
                success: false as const,
                jobId,
                error: error instanceof Error
                    ? error.message
                    : 'DjVu conversion failed',
                expected,
            };
        }

        const failure = getBrowserDjvuFailureReceipt(error)
            ?? BrowserLogger.error('djvu-browser', 'DjVu conversion failed', error, {
                code: 'RENDERER_DJVU_OPERATION_FAILED',
                context: {},
            });
        return {
            success: false as const,
            jobId,
            error:
                error instanceof Error
                    ? error.message
                    : 'DjVu conversion failed',
            ...(failure === undefined ? {} : {failure}),
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
