import { getErrorMessage } from '@app/utils/error';
import {
    createNativeWasmToolLoader,
    type TNativeWasmCallResult,
} from '@app/platform/browser-api/nativeWasmTool';
import type {INativeErrorEnvelope} from '@contracts/nativeErrors';
import {
    BROWSER_SCAN_CLEANUP_WASM_PATH,
    decodeScanCleanupWasmAnalyzeResult,
    decodeScanCleanupWasmRenderPreviewResult,
    encodeScanCleanupWasmAnalyzeRequest,
    encodeScanCleanupWasmRenderPreviewRequest,
    type IScanCleanupWasmAnalyzeRequest,
    type IScanCleanupWasmPageResult,
    type IScanCleanupWasmPlane,
    type IScanCleanupWasmRenderPreviewRequest,
    type IScanCleanupWasmRenderPreviewResult,
    type TScanCleanupEncodedRaster,
    type TScanCleanupWasmPlaneEncoding,
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

export type TBrowserScanCleanupOutcome<TResult> =
    | {
        status: 'succeeded';
        result: TResult;
    }
    | {
        status: 'failed';
        error: INativeErrorEnvelope;
    };

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

/** Renders one page the way the desktop preview does. */
export function renderBrowserScanCleanupPreview(request: IScanCleanupWasmRenderPreviewRequest) {
    return run(
        () => encodeScanCleanupWasmRenderPreviewRequest(request),
        decodeScanCleanupWasmRenderPreviewResult,
    ) satisfies Promise<TBrowserScanCleanupOutcome<IScanCleanupWasmRenderPreviewResult>>;
}

/** Analyzes one page the way a desktop analyze manifest does. */
export function analyzeBrowserScanCleanupPage(request: IScanCleanupWasmAnalyzeRequest) {
    return run(
        () => encodeScanCleanupWasmAnalyzeRequest(request),
        decodeScanCleanupWasmAnalyzeResult,
    ) satisfies Promise<TBrowserScanCleanupOutcome<IScanCleanupWasmPageResult>>;
}

export interface IBrowserOcrScanCleanupResult extends IOcrScanCleanupGeometry {plane: IScanCleanupWasmPlane;}

/**
 * Preprocesses one rendered OCR page exactly as desktop OCR does: the shared
 * pinned options, page scope, one output of the input's size, and an inverse
 * transform OCR can map recognized words back through. A failure leaves the
 * fallback to the caller, which recognizes the raw render and reports it.
 */
export async function preprocessBrowserOcrPage(
    input: TScanCleanupEncodedRaster,
    inputSize: {
        width: number;
        height: number
    },
    mode: TOcrScanCleanupMode,
    dpi: number,
    planeEncoding: TScanCleanupWasmPlaneEncoding = 'raw',
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
    if (output.plane.width !== inputSize.width || output.plane.height !== inputSize.height) {
        return failed('invalid-request', 'OCR preprocessing changed image dimensions');
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
