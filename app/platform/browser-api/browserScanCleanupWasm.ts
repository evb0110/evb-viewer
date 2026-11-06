import { getErrorMessage } from '@app/utils/error';
import {
    createNativeWasmToolLoader,
    type TNativeWasmCallResult,
} from '@app/platform/browser-api/nativeWasmTool';
import type {INativeErrorEnvelope} from '@contracts/nativeErrors';
import type {TScanCleanupWasmOutcome} from '@contracts/scan-cleanup/browserScanCleanupWorker';
import {
    BROWSER_SCAN_CLEANUP_WASM_PATH,
    decodeScanCleanupWasmAnalyzeResult,
    decodeScanCleanupWasmDeriveInkContextsResult,
    decodeScanCleanupWasmFinishPageAnalysisResult,
    decodeScanCleanupWasmReconcileDocumentResult,
    decodeScanCleanupWasmRenderPageResult,
    decodeScanCleanupWasmRenderPreviewResult,
    decodeScanCleanupWasmSamplePageInkResult,
    encodeScanCleanupWasmAnalyzeRequest,
    encodeScanCleanupWasmDeriveInkContextsRequest,
    encodeScanCleanupWasmFinishPageAnalysisRequest,
    encodeScanCleanupWasmReconcileDocumentRequest,
    encodeScanCleanupWasmRenderPageRequest,
    encodeScanCleanupWasmRenderPreviewRequest,
    encodeScanCleanupWasmSamplePageInkRequest,
    type IScanCleanupWasmAnalyzeRequest,
    type IScanCleanupWasmAnalyzeResult,
    type IScanCleanupWasmDeriveInkContextsResult,
    type IScanCleanupWasmFinishPageAnalysisRequest,
    type IScanCleanupWasmPageResult,
    type IScanCleanupWasmPlane,
    type IScanCleanupWasmReconcileDocumentResult,
    type IScanCleanupWasmRenderPageRequest,
    type IScanCleanupWasmRenderPageResult,
    type IScanCleanupWasmRenderPreviewRequest,
    type IScanCleanupWasmRenderPreviewResult,
    type IScanCleanupWasmSamplePageInkRequest,
    type IScanCleanupWasmSamplePageInkResult,
    type TScanCleanupEncodedRaster,
    type TScanCleanupWasmDeriveInkContextsRequest,
    type TScanCleanupWasmPreviewEncoding,
    type TScanCleanupWasmReconcileDocumentRequest,
} from '@contracts/scan-cleanup/browserScanCleanupWasm';
import {
    SCAN_CLEANUP_WASM_MAX_OUTPUT_BYTES,
    SCAN_CLEANUP_WASM_MAX_REQUEST_BYTES,
} from '@contracts/scan-cleanup/browserScanCleanupWasm.generated';
import {
    createOcrScanCleanupOptions,
    readOcrScanCleanupGeometry,
    type IOcrScanCleanupGeometry,
    type TOcrScanCleanupMode,
} from '@contracts/scan-cleanup/ocrPreprocessing';

/**
 * The browser scan-cleanup engine for this thread. It is synchronous WASM, so
 * call it from a worker: the OCR engine worker or a dedicated cleanup worker.
 * A request cannot be cancelled once it runs; terminate the worker instead.
 */
const engine = createNativeWasmToolLoader({
    path: BROWSER_SCAN_CLEANUP_WASM_PATH,
    prefix: 'evb_scan_cleanup',
    runExport: 'run',
    label: 'browser cleanup engine',
    maxRequestBytes: SCAN_CLEANUP_WASM_MAX_REQUEST_BYTES,
    maxOutputBytes: SCAN_CLEANUP_WASM_MAX_OUTPUT_BYTES,
    // Rust's clock traps on wasm32-unknown-unknown; stage timings read this one.
    imports: () => ({env: {evb_now_ms: () => performance.now()}}),
});

export type TBrowserScanCleanupOutcome<TResult> = TScanCleanupWasmOutcome<TResult>;

function failed(code: INativeErrorEnvelope['code'], message: string) {
    return {
        status: 'failed' as const,
        error: {
            code,
            message,
        },
    };
}

async function run<TResult>(
    encode: () => Uint8Array,
    decode: (output: Uint8Array) => TResult,
): Promise<TBrowserScanCleanupOutcome<TResult>> {
    let called: TNativeWasmCallResult;
    try {
        called = await engine.call(encode());
    } catch (error) {
        return failed('invalid-request', getErrorMessage(error));
    }
    if (called.status === 'failed') return called;
    try {
        return {
            status: 'succeeded',
            result: decode(called.output),
        };
    } catch (error) {
        return failed('invalid-request', getErrorMessage(error));
    }
}

/** Loads the engine ahead of the first page, so its download overlaps other work. */
export function preloadBrowserScanCleanupEngine() {
    return engine.load().then(() => undefined);
}

/** Renders one page the way the desktop preview does: each output's composite. */
export function renderBrowserScanCleanupPreview(request: IScanCleanupWasmRenderPreviewRequest) {
    return run(
        () => encodeScanCleanupWasmRenderPreviewRequest(request),
        decodeScanCleanupWasmRenderPreviewResult,
    ) satisfies Promise<TBrowserScanCleanupOutcome<IScanCleanupWasmRenderPreviewResult>>;
}

/**
 * Renders one page the way a one-page desktop render manifest does, preview
 * or final: matched canvas, separable layers, bilevel, picture and tone planes
 * for the destinations `page.outputs` lists, and the metadata the manifest run
 * leaves beside them.
 */
export function renderBrowserScanCleanupPage(request: IScanCleanupWasmRenderPageRequest) {
    return run(
        () => encodeScanCleanupWasmRenderPageRequest(request),
        decodeScanCleanupWasmRenderPageResult,
    ) satisfies Promise<TBrowserScanCleanupOutcome<IScanCleanupWasmRenderPageResult>>;
}

/**
 * Analyzes one page the way a desktop analyze manifest's first pass does, or
 * its rerun under a document prior, with what reconciliation reads from it.
 */
export function analyzeBrowserScanCleanupPage(request: IScanCleanupWasmAnalyzeRequest) {
    return run(
        () => encodeScanCleanupWasmAnalyzeRequest(request),
        decodeScanCleanupWasmAnalyzeResult,
    ) satisfies Promise<TBrowserScanCleanupOutcome<IScanCleanupWasmAnalyzeResult>>;
}

/**
 * Reconciles one manifest batch of analyzed pages the way a desktop analyze
 * manifest does once its first pass ends. A rerun decision asks for the page
 * to be analyzed again under its prior; every page then goes through
 * {@link finishBrowserScanCleanupPageAnalysis}.
 */
export function reconcileBrowserScanCleanupDocument(request: TScanCleanupWasmReconcileDocumentRequest) {
    return run(
        () => encodeScanCleanupWasmReconcileDocumentRequest(request),
        decodeScanCleanupWasmReconcileDocumentResult,
    ) satisfies Promise<TBrowserScanCleanupOutcome<IScanCleanupWasmReconcileDocumentResult>>;
}

/** The page metadata a desktop analyze manifest finally writes for one page. */
export function finishBrowserScanCleanupPageAnalysis(request: IScanCleanupWasmFinishPageAnalysisRequest) {
    return run(
        () => encodeScanCleanupWasmFinishPageAnalysisRequest(request),
        decodeScanCleanupWasmFinishPageAnalysisResult,
    ) satisfies Promise<TBrowserScanCleanupOutcome<IScanCleanupWasmPageResult>>;
}

/** Measures one producer MRC page's ink for its render batch's document prior. */
export function sampleBrowserScanCleanupPageInk(request: IScanCleanupWasmSamplePageInkRequest) {
    return run(
        () => encodeScanCleanupWasmSamplePageInkRequest(request),
        decodeScanCleanupWasmSamplePageInkResult,
    ) satisfies Promise<TBrowserScanCleanupOutcome<IScanCleanupWasmSamplePageInkResult>>;
}

/**
 * Each page's `pageInkConsistency` for its render, from its render batch's
 * samples, as a desktop render manifest derives them before its pages.
 */
export function deriveBrowserScanCleanupInkContexts(request: TScanCleanupWasmDeriveInkContextsRequest) {
    return run(
        () => encodeScanCleanupWasmDeriveInkContextsRequest(request),
        decodeScanCleanupWasmDeriveInkContextsResult,
    ) satisfies Promise<TBrowserScanCleanupOutcome<IScanCleanupWasmDeriveInkContextsResult>>;
}

export interface IBrowserOcrScanCleanupResult extends IOcrScanCleanupGeometry {plane: IScanCleanupWasmPlane;}

/**
 * Preprocesses one rendered OCR page exactly as desktop OCR does: the shared
 * pinned options, page scope, one output, and an inverse transform OCR can map
 * recognized words back through. A failure, or an output of another size than
 * the input, leaves the fallback to the caller, which recognizes the raw
 * render and reports it.
 */
export async function preprocessBrowserOcrPage(
    input: TScanCleanupEncodedRaster,
    mode: TOcrScanCleanupMode,
    dpi: number,
    planeEncoding: TScanCleanupWasmPreviewEncoding = 'raw',
): Promise<TBrowserScanCleanupOutcome<IBrowserOcrScanCleanupResult>> {
    const rendered = await renderBrowserScanCleanupPreview({
        input,
        page: {
            options: createOcrScanCleanupOptions(mode, dpi),
            sourcePageIndex: 0,
            canvasScope: 'page',
        },
        planeEncoding,
    });
    if (rendered.status === 'failed') return rendered;
    const [
        output,
        ...extra
    ] = rendered.result.outputs;
    if (!output || extra.length > 0) {
        return failed('invalid-request', 'OCR preprocessing produced no single page');
    }
    try {
        return {
            status: 'succeeded',
            result: {
                plane: output.plane,
                ...readOcrScanCleanupGeometry(output.metadata),
            },
        };
    } catch (error) {
        return failed('invalid-request', `OCR preprocessing metadata is unusable: ${getErrorMessage(error)}`);
    }
}
