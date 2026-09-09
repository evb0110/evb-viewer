import { statfs } from 'fs/promises';
import type {TScanCleanupLog} from '@evb/scan-cleanup/core/types';

// PPM removes the costly PNG encode/decode step on both sides of the native
// handoff: pdftoppm writes a JPEG 2000 scan page in about a second where the
// same page spends five more seconds in deflate. The cost is scratch space.
// Retained handoffs budget the whole manifest. FIFO handoffs budget the
// concurrent producer window plus the native consumer's bounded materialized
// copies; draining a FIFO moves bytes between those two scratch files rather
// than making the producer's file disappear instantaneously.
const RAW_RASTER_BUDGET_FLOOR_BYTES = 512 * 1024 * 1024;
const RAW_RASTER_FREE_SPACE_SHARE = 0.25;
const RAW_RASTER_FREE_SPACE_RESERVE_BYTES = 512 * 1024 * 1024;
// The non-stream fallback writes PNG even though raw RGB is the useful common
// footprint estimate. PNG scanline filters, deflate framing, chunks and file
// allocation can make an incompressible image slightly larger than its RGB
// payload. One percent comfortably covers that bounded overhead for large
// rasters; the floor covers headers and allocation slack for small files.
const RAW_RASTER_FILE_OVERHEAD_SHARE = 0.01;
const RAW_RASTER_FILE_OVERHEAD_FLOOR_BYTES = 64 * 1024;
const COMBINE_OUTPUT_BYTES_PER_PAGE = 8 * 1024 * 1024;
const COMBINE_OUTPUT_BYTES_FLOOR = 512 * 1024 * 1024;

export interface IScanCleanupRasterHandoffPlan {
    renderDpi: number;
    /** Additional fixed-grid rasters retained alongside this page. */
    additionalRenderDpis?: readonly number[];
    /** Simultaneous raw copies of the primary render (producer/native). */
    renderCopies?: number;
    raster: {
        dpi: number;
        width: number;
        height: number
    } | undefined;
}

export async function readAvailableScratchBytes(directory: string) {
    try {
        const filesystem = await statfs(directory);
        const available = Number(filesystem.bavail) * Number(filesystem.bsize);
        return Number.isFinite(available) && available >= 0 ? available : null;
    } catch {
        return null;
    }
}

function estimateRawRasterBytes(
    plans: readonly IScanCleanupRasterHandoffPlan[],
    residentScratchRasterCount: number,
) {
    const pageEstimates: number[] = [];
    for (const plan of plans) {
        const raster = plan.raster;
        if (
            raster === undefined
            || !Number.isFinite(plan.renderDpi)
            || plan.renderDpi <= 0
            || !Number.isFinite(raster.dpi)
            || raster.dpi <= 0
            || !Number.isFinite(raster.width)
            || raster.width <= 0
            || !Number.isFinite(raster.height)
            || raster.height <= 0
        ) {
            return null;
        }
        const rasterBytesAtDpi = (dpi: number) => {
            if (!Number.isFinite(dpi) || dpi <= 0) {
                return null;
            }
            const width = Math.max(1, Math.ceil(raster.width * dpi / raster.dpi));
            const height = Math.max(1, Math.ceil(raster.height * dpi / raster.dpi));
            const pixelBytes = width * height * 3;
            if (!Number.isSafeInteger(pixelBytes)) {
                return null;
            }
            const fileOverheadBytes = Math.max(
                RAW_RASTER_FILE_OVERHEAD_FLOOR_BYTES,
                Math.ceil(pixelBytes * RAW_RASTER_FILE_OVERHEAD_SHARE),
            );
            const bytes = pixelBytes + fileOverheadBytes;
            return Number.isSafeInteger(bytes) ? bytes : null;
        };
        const primaryBytes = rasterBytesAtDpi(plan.renderDpi);
        const renderCopies = plan.renderCopies ?? 1;
        if (
            primaryBytes === null
            || !Number.isSafeInteger(renderCopies)
            || renderCopies < 1
        ) {
            return null;
        }
        let pageBytes = primaryBytes * renderCopies;
        for (const dpi of plan.additionalRenderDpis ?? []) {
            const additionalBytes = rasterBytesAtDpi(dpi);
            if (additionalBytes === null) {
                return null;
            }
            pageBytes += additionalBytes;
        }
        if (!Number.isSafeInteger(pageBytes)) {
            return null;
        }
        pageEstimates.push(pageBytes);
    }
    pageEstimates.sort((left, right) => right - left);
    const estimatedBytes = pageEstimates
        .slice(0, Math.max(1, residentScratchRasterCount))
        .reduce((sum, pageBytes) => sum + pageBytes, 0);
    return Number.isSafeInteger(estimatedBytes) ? estimatedBytes : null;
}

function resolveRasterBudgetBytes(availableBytes: number | null) {
    return availableBytes === null
        ? RAW_RASTER_BUDGET_FLOOR_BYTES
        : Math.min(
            Math.max(
                RAW_RASTER_BUDGET_FLOOR_BYTES,
                Math.floor(availableBytes * RAW_RASTER_FREE_SPACE_SHARE),
            ),
            Math.max(0, availableBytes - RAW_RASTER_FREE_SPACE_RESERVE_BYTES),
        );
}

/**
 * Free scratch space that would admit `windowBytes`.
 *
 * The budget keeps a fixed reserve off the filesystem and, above the floor,
 * never spends more than a quarter of what is free. Inverting it turns a
 * refusal into the one number a user can act on: how much space to make
 * available.
 */
export function resolveRequiredScratchBytes(windowBytes: number) {
    return windowBytes <= RAW_RASTER_BUDGET_FLOOR_BYTES
        ? windowBytes + RAW_RASTER_FREE_SPACE_RESERVE_BYTES
        : Math.ceil(windowBytes / RAW_RASTER_FREE_SPACE_SHARE);
}

export interface IScanCleanupStagedWindowAdmission {
    admitted: boolean;
    /** Pages that may be staged at once. Zero only when nothing must be staged. */
    windowPages: number;
    /**
     * Scratch the selected window occupies, or the smallest window when
     * refused. Null when the pages cannot be measured at all.
     */
    windowBytes: number | null;
    budgetBytes: number;
    availableBytes: number | null;
    /** What whole-document staging would have cost. Diagnostics only. */
    wholeDocumentBytes: number | null;
    /** Free scratch that would admit the smallest safe window. */
    requiredBytes: number | null;
}

/**
 * Choose how many page rasters may be staged at once.
 *
 * Admission is a question about one bounded window, never about the document:
 * a long document is processed by replaying that window, so its length changes
 * how long detection runs and not whether it may run. Scratch pressure narrows
 * the window — and with it the producer's concurrency — until only one page
 * fits; below that the run is genuinely out of space and says so.
 */
export async function resolveStagedRasterWindow(
    plans: readonly IScanCleanupRasterHandoffPlan[],
    requestedWindowPages: number,
    scratch: string,
    getAvailableScratchBytes: typeof readAvailableScratchBytes,
): Promise<IScanCleanupStagedWindowAdmission> {
    const availableBytes = await getAvailableScratchBytes(scratch);
    const budgetBytes = resolveRasterBudgetBytes(availableBytes);
    const wholeDocumentBytes = estimateRawRasterBytes(plans, plans.length);
    if (plans.length === 0) {
        return {
            admitted: true,
            windowPages: 0,
            windowBytes: 0,
            budgetBytes,
            availableBytes,
            wholeDocumentBytes,
            requiredBytes: null,
        };
    }
    const ceiling = Math.max(1, Math.min(Math.floor(requestedWindowPages), plans.length));
    for (let windowPages = ceiling; windowPages >= 1; windowPages -= 1) {
        const windowBytes = estimateRawRasterBytes(plans, windowPages);
        if (windowBytes !== null && windowBytes <= budgetBytes) {
            return {
                admitted: true,
                windowPages,
                windowBytes,
                budgetBytes,
                availableBytes,
                wholeDocumentBytes,
                requiredBytes: null,
            };
        }
    }
    const smallestWindowBytes = estimateRawRasterBytes(plans, 1);
    if (smallestWindowBytes === null) {
        // Nothing here says the space is short: the geometry of at least one
        // page could not be measured, so no window has a cost to compare. A
        // refusal would be a storage figure the caller invented, and the run
        // would be blocked over an unknown. The narrowest window is admitted
        // instead, which is the same single-page footprint an unmeasurable
        // handoff already falls back to.
        return {
            admitted: true,
            windowPages: 1,
            windowBytes: null,
            budgetBytes,
            availableBytes,
            wholeDocumentBytes,
            requiredBytes: null,
        };
    }
    return {
        admitted: false,
        windowPages: 1,
        windowBytes: smallestWindowBytes,
        budgetBytes,
        availableBytes,
        wholeDocumentBytes,
        requiredBytes: resolveRequiredScratchBytes(smallestWindowBytes),
    };
}

export async function resolveRasterHandoff(
    plans: readonly IScanCleanupRasterHandoffPlan[],
    scratch: string,
    getAvailableScratchBytes: typeof readAvailableScratchBytes,
    residentScratchRasterCount = plans.length,
) {
    const estimatedBytes = estimateRawRasterBytes(plans, residentScratchRasterCount);
    if (estimatedBytes === null) {
        return {
            format: 'png' as const,
            estimatedBytes: null,
            budgetBytes: null,
        };
    }
    const availableBytes = await getAvailableScratchBytes(scratch);
    const budgetBytes = resolveRasterBudgetBytes(availableBytes);
    return {
        format: estimatedBytes > budgetBytes ? 'png' as const : 'ppm' as const,
        estimatedBytes,
        budgetBytes,
    };
}

export function resolveCombineOutputByteCap(outputPageCount: number) {
    return Math.max(COMBINE_OUTPUT_BYTES_FLOOR, outputPageCount * COMBINE_OUTPUT_BYTES_PER_PAGE);
}

export async function runRasterProducerConsumer<TResult = void>({
    signal,
    stream,
    createStreams,
    produce,
    consume,
    onProducerComplete,
}: {
    signal: AbortSignal;
    stream: boolean;
    createStreams?: () => Promise<void>;
    produce: (signal: AbortSignal) => Promise<void>;
    consume: (signal: AbortSignal) => Promise<TResult> | Promise<void>;
    onProducerComplete: () => void;
}) {
    if (!stream) {
        await produce(signal);
        onProducerComplete();
        return consume(signal) as Promise<TResult | undefined>;
    }

    if (createStreams === undefined) {
        throw new Error('Raster streaming requires a stream factory');
    }
    await createStreams();
    const abort = new AbortController();
    const operationSignal = AbortSignal.any([
        signal,
        abort.signal,
    ]);
    const run = <T>(operation: (signal: AbortSignal) => Promise<T> | Promise<void>) => Promise.resolve(operation(operationSignal))
        .catch((error: unknown) => {
            abort.abort(error);
            throw error;
        });
    // The consumer opens every FIFO for reading before the producer writes.
    // Starting it first prevents a producer open from blocking the event loop.
    const consumer = run(consume);
    const producer = run(produce);
    const combined = Promise.all([
        producer,
        consumer,
    ]);
    void combined.catch(() => undefined);
    try {
        await producer;
        onProducerComplete();
        const [
            , result,
        ] = await combined;
        return result as TResult | undefined;
    } catch (error) {
        abort.abort(error);
        await Promise.allSettled([
            producer,
            consumer,
        ]);
        throw error;
    }
}

// Rasterizing a page is the pipeline's dominant cost and each one holds a full
// page bitmap, so the pages move through a fixed number of workers the runtime
// policy sizes rather than all at once.
export async function mapScanCleanupRasterPages<T, R>(
    values: readonly T[],
    concurrency: number,
    task: (value: T, index: number) => Promise<R>,
) {
    const results = new Array<R>(values.length);
    let nextIndex = 0;
    const workers = Array.from({length: Math.min(Math.max(1, concurrency), values.length)}, async () => {
        while (nextIndex < values.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await task(values[index]!, index);
        }
    });
    const settled = await Promise.allSettled(workers);
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    return results;
}

export function logRasterHandoff(
    log: TScanCleanupLog,
    scope: string,
    handoff: Awaited<ReturnType<typeof resolveRasterHandoff>>,
) {
    const mib = (bytes: number) => `${Math.ceil(bytes / (1024 * 1024))} MiB`;
    const footprint = handoff.estimatedBytes === null
        ? 'unknown footprint'
        : `${mib(handoff.estimatedBytes)} estimated simultaneous scratch footprint`;
    const budget = handoff.budgetBytes === null ? '' : ` against a ${mib(handoff.budgetBytes)} scratch budget`;
    log('debug', `Scan cleanup ${scope} raster handoff uses ${handoff.format.toUpperCase()} (${footprint}${budget})`);
}
