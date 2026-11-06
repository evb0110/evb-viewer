import * as v from 'valibot';
import {
    isRecord,
    isSafeWorkerRequestId,
} from '@contracts/runtimeGuards';
import {
    NATIVE_ERROR_ENVELOPE_SCHEMA,
    type INativeErrorEnvelope,
} from '@contracts/nativeErrors';
import {
    createBrowserPdfRasterTilesSchema,
    type IBrowserPdfRasterTiles,
} from '@contracts/browserPdfRaster';
import {
    SCAN_CLEANUP_MAX_BILEVEL_PIXELS,
    SCAN_CLEANUP_MAX_DIMENSION_PX,
} from '@contracts/scan-cleanup/inputLimits';
import type {
    IScanCleanupWasmAnalyzeRequest,
    IScanCleanupWasmAnalyzeResult,
    IScanCleanupWasmDeriveInkContextsResult,
    IScanCleanupWasmFinishPageAnalysisRequest,
    IScanCleanupWasmPageResult,
    IScanCleanupWasmReconcileDocumentResult,
    IScanCleanupWasmRenderPageRequest,
    IScanCleanupWasmRenderPageResult,
    IScanCleanupWasmRenderPreviewRequest,
    IScanCleanupWasmRenderPreviewResult,
    IScanCleanupWasmSamplePageInkRequest,
    IScanCleanupWasmSamplePageInkResult,
    TScanCleanupWasmDeriveInkContextsRequest,
    TScanCleanupWasmReconcileDocumentRequest,
} from '@contracts/scan-cleanup/browserScanCleanupWasm';

/**
 * The browser cleanup worker: one synchronous engine call per request, run
 * off the UI thread so cancellation can terminate it. Engine requests and
 * results are the browser engine's own types; the worker adds only reading
 * painted page tiles back into the raster the engine reads, and the PNG copy
 * of an original page the workspace displays.
 */

/** An engine call's outcome: its result, or the engine's native error envelope. */
export type TScanCleanupWasmOutcome<TResult> =
    | {
        status: 'succeeded';
        result: TResult;
    }
    | {
        status: 'failed';
        error: INativeErrorEnvelope;
    };

export interface IBrowserScanCleanupWorkerRequestMap {
    /** Reads painted tiles back into one binary PPM. */
    'assemble-raster': {image: IBrowserPdfRasterTiles};
    /** Encodes a binary PPM as the PNG the workspace shows as the original. */
    'encode-png': {ppm: Uint8Array};
    'render-preview': IScanCleanupWasmRenderPreviewRequest;
    'render-page': IScanCleanupWasmRenderPageRequest;
    'analyze-page': IScanCleanupWasmAnalyzeRequest;
    'reconcile-document': TScanCleanupWasmReconcileDocumentRequest;
    'finish-page-analysis': IScanCleanupWasmFinishPageAnalysisRequest;
    'sample-page-ink': IScanCleanupWasmSamplePageInkRequest;
    'derive-ink-contexts': TScanCleanupWasmDeriveInkContextsRequest;
}

export interface IBrowserScanCleanupWorkerResultMap {
    'assemble-raster': {ppm: Uint8Array<ArrayBuffer>};
    'encode-png': {png: Uint8Array<ArrayBuffer>};
    'render-preview': TScanCleanupWasmOutcome<IScanCleanupWasmRenderPreviewResult>;
    'render-page': TScanCleanupWasmOutcome<IScanCleanupWasmRenderPageResult>;
    'analyze-page': TScanCleanupWasmOutcome<IScanCleanupWasmAnalyzeResult>;
    'reconcile-document': TScanCleanupWasmOutcome<IScanCleanupWasmReconcileDocumentResult>;
    'finish-page-analysis': TScanCleanupWasmOutcome<IScanCleanupWasmPageResult>;
    'sample-page-ink': TScanCleanupWasmOutcome<IScanCleanupWasmSamplePageInkResult>;
    'derive-ink-contexts': TScanCleanupWasmOutcome<IScanCleanupWasmDeriveInkContextsResult>;
}

export type TBrowserScanCleanupWorkerRequestType = keyof IBrowserScanCleanupWorkerRequestMap;

export const BROWSER_SCAN_CLEANUP_WORKER_REQUEST_TYPES = [
    'assemble-raster',
    'encode-png',
    'render-preview',
    'render-page',
    'analyze-page',
    'reconcile-document',
    'finish-page-analysis',
    'sample-page-ink',
    'derive-ink-contexts',
] as const satisfies readonly TBrowserScanCleanupWorkerRequestType[];

export type TBrowserScanCleanupWorkerRequest = {
    [K in TBrowserScanCleanupWorkerRequestType]: {
        id: number;
        type: K;
        payload: IBrowserScanCleanupWorkerRequestMap[K];
    }
}[TBrowserScanCleanupWorkerRequestType];

/** Tiles of a page the engine can take: the bilevel pipeline's pixel ceiling. */
const rasterTilesSchema = createBrowserPdfRasterTilesSchema(SCAN_CLEANUP_MAX_BILEVEL_PIXELS, SCAN_CLEANUP_MAX_DIMENSION_PX);
const bytesSchema = v.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength > 0);

/**
 * The worker's request envelope. The raster requests are checked here; an
 * engine request's JSON and attachments are validated by the engine itself,
 * which refuses a malformed frame with its native error envelope.
 */
export function parseBrowserScanCleanupWorkerRequest(value: unknown): TBrowserScanCleanupWorkerRequest | null {
    if (!isRecord(value) || !isSafeWorkerRequestId(value.id) || !isRecord(value.payload)
        || !(BROWSER_SCAN_CLEANUP_WORKER_REQUEST_TYPES as readonly unknown[]).includes(value.type)) {
        return null;
    }
    if (value.type === 'assemble-raster') {
        return v.safeParse(rasterTilesSchema, value.payload.image, {abortEarly: true}).success
            ? value as TBrowserScanCleanupWorkerRequest
            : null;
    }
    if (value.type === 'encode-png') {
        return v.safeParse(bytesSchema, value.payload.ppm, {abortEarly: true}).success
            ? value as TBrowserScanCleanupWorkerRequest
            : null;
    }
    return value as TBrowserScanCleanupWorkerRequest;
}

export function getBrowserScanCleanupWorkerRequestId(value: unknown) {
    return isRecord(value) && isSafeWorkerRequestId(value.id) ? value.id : null;
}

const outcomeSchema = v.variant('status', [
    v.object({
        status: v.literal('succeeded'),
        result: v.custom<unknown>(isRecord),
    }),
    v.object({
        status: v.literal('failed'),
        error: NATIVE_ERROR_ENVELOPE_SCHEMA,
    }),
]);

/**
 * A worker result's envelope. An engine result was decoded by the browser
 * engine's codecs inside the worker, where the engine's bytes arrive; the
 * structured clone carries that decoded value unchanged.
 */
export function isBrowserScanCleanupWorkerResult<K extends TBrowserScanCleanupWorkerRequestType>(
    type: K,
    value: unknown,
): value is IBrowserScanCleanupWorkerResultMap[K] {
    if (type === 'assemble-raster') return isRecord(value) && value.ppm instanceof Uint8Array;
    if (type === 'encode-png') return isRecord(value) && value.png instanceof Uint8Array;
    return v.safeParse(outcomeSchema, value, {abortEarly: true}).success;
}
