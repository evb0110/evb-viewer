import { getErrorMessage } from '@app/utils/error';
import {
    createNativeWasmToolLoader,
    type TNativeWasmCallResult,
} from '@app/platform/browser/nativeWasmTool';
import {NativeWasmThreadStartError} from '@app/platform/browser/nativeWasmThreadedTool';
import {
    readScanCleanupEngineWorkerThreads,
    SCAN_CLEANUP_ENGINE_MAXIMUM_MEMORY_PAGES,
} from '@app/platform/browser-api/scanCleanupEngineWorkerName';
import type {INativeErrorEnvelope} from '@contracts/nativeErrors';
import type {TScanCleanupWasmOutcome} from '@contracts/scan-cleanup/browserScanCleanupWorker';
import {
    BROWSER_SCAN_CLEANUP_THREADS_WASM_PATH,
    BROWSER_SCAN_CLEANUP_WASM_PATH,
    decodeScanCleanupWasmAnalyzeResult,
    decodeScanCleanupWasmPlanAnalysisResult,
    decodeScanCleanupWasmRenderPageResult,
    decodeScanCleanupWasmRenderPreviewResult,
    decodeScanCleanupWasmSubPageStage,
    encodeScanCleanupWasmAnalyzeRequest,
    encodeScanCleanupWasmPlanAnalysisRequest,
    encodeScanCleanupWasmRenderPageRequest,
    encodeScanCleanupWasmRenderPreviewRequest,
    type IScanCleanupWasmAnalyzeRequest,
    type IScanCleanupWasmAnalyzeResult,
    type IScanCleanupWasmPlane,
    type IScanCleanupWasmRenderPageRequest,
    type IScanCleanupWasmRenderPageResult,
    type IScanCleanupWasmRenderPreviewRequest,
    type IScanCleanupWasmRenderPreviewResult,
    type IScanCleanupWasmSubPageProgress,
    type TScanCleanupEncodedRaster,
    type TScanCleanupWasmPlanAnalysisRequest,
    type TScanCleanupWasmPlanAnalysisResult,
    type TScanCleanupWasmPreviewEncoding,
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
 * call it from a worker: the OCR preprocessing worker or a dedicated cleanup
 * worker. A request cannot be cancelled once it runs; terminate the worker
 * instead. The worker's name, read once here, says whether it runs the
 * threaded build and on how many threads.
 */
const workerName: unknown = Reflect.get(globalThis, 'name');
const engineThreads = readScanCleanupEngineWorkerThreads(typeof workerName === 'string' ? workerName : undefined);
let activeProgressListener: ((progress: IScanCleanupWasmSubPageProgress) => void) | null = null;
const handleWasmProgress = (stageCode: number, completed: number, total: number) => {
    const listener = activeProgressListener;
    if (listener === null) return;
    const stage = decodeScanCleanupWasmSubPageStage(stageCode >>> 0);
    if (stage === null) return;
    listener({
        stage,
        completed: completed >>> 0,
        total: total >>> 0,
    });
};
const engine = createNativeWasmToolLoader({
    path: BROWSER_SCAN_CLEANUP_WASM_PATH,
    prefix: 'evb_scan_cleanup',
    runExport: 'run',
    label: 'browser cleanup engine',
    maxRequestBytes: SCAN_CLEANUP_WASM_MAX_REQUEST_BYTES,
    maxOutputBytes: SCAN_CLEANUP_WASM_MAX_OUTPUT_BYTES,
    // Rust's clock traps on wasm32-unknown-unknown; stage timings read this one.
    imports: () => ({env: {
        evb_now_ms: () => performance.now(),
        evb_progress: handleWasmProgress,
    }}),
    ...(engineThreads === null
        ? {}
        : {threads: {
            path: BROWSER_SCAN_CLEANUP_THREADS_WASM_PATH,
            count: engineThreads,
            maximumMemoryPages: SCAN_CLEANUP_ENGINE_MAXIMUM_MEMORY_PAGES,
            onProgress: handleWasmProgress,
        }}),
});

/** The SHA-256 of the engine module this worker runs, once it has compiled it. */
export const readBrowserScanCleanupEngineDigest = () => engine.readDigest();

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
    onProgress?: (progress: IScanCleanupWasmSubPageProgress) => void,
): Promise<TBrowserScanCleanupOutcome<TResult>> {
    let called: TNativeWasmCallResult;
    const previousListener = activeProgressListener;
    activeProgressListener = onProgress ?? null;
    try {
        called = await engine.call(encode());
    } catch (error) {
        // The worker hands the request back so the page can run it on today's engine.
        if (error instanceof NativeWasmThreadStartError) throw error;
        return failed('invalid-request', getErrorMessage(error));
    } finally {
        activeProgressListener = previousListener;
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

/** Renders one page the way the desktop preview does: each output's composite. */
export function renderBrowserScanCleanupPreview(
    request: IScanCleanupWasmRenderPreviewRequest,
    onProgress?: (progress: IScanCleanupWasmSubPageProgress) => void,
) {
    return run(
        () => encodeScanCleanupWasmRenderPreviewRequest(request),
        decodeScanCleanupWasmRenderPreviewResult,
        onProgress,
    ) satisfies Promise<TBrowserScanCleanupOutcome<IScanCleanupWasmRenderPreviewResult>>;
}

/**
 * Renders one page the way a one-page desktop render manifest does, preview
 * or final: matched canvas, separable layers, bilevel, picture and tone planes
 * for the destinations `page.outputs` lists, and the metadata the manifest run
 * leaves beside them.
 */
export function renderBrowserScanCleanupPage(
    request: IScanCleanupWasmRenderPageRequest,
    onProgress?: (progress: IScanCleanupWasmSubPageProgress) => void,
) {
    return run(
        () => encodeScanCleanupWasmRenderPageRequest(request),
        decodeScanCleanupWasmRenderPageResult,
        onProgress,
    ) satisfies Promise<TBrowserScanCleanupOutcome<IScanCleanupWasmRenderPageResult>>;
}

/** Runs one page analysis an analysis plan asked for. */
export function analyzeBrowserScanCleanupPage(
    request: IScanCleanupWasmAnalyzeRequest,
    onProgress?: (progress: IScanCleanupWasmSubPageProgress) => void,
) {
    return run(
        () => encodeScanCleanupWasmAnalyzeRequest(request),
        decodeScanCleanupWasmAnalyzeResult,
        onProgress,
    ) satisfies Promise<TBrowserScanCleanupOutcome<IScanCleanupWasmAnalyzeResult>>;
}

/**
 * Plans an analyze manifest's document sequence from the analyses so far, as
 * the desktop CLI does between its pages: the next analyses, or every page's
 * finished metadata.
 */
export function planBrowserScanCleanupAnalysis(request: TScanCleanupWasmPlanAnalysisRequest) {
    return run(
        () => encodeScanCleanupWasmPlanAnalysisRequest(request),
        decodeScanCleanupWasmPlanAnalysisResult,
    ) satisfies Promise<TBrowserScanCleanupOutcome<TScanCleanupWasmPlanAnalysisResult>>;
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
