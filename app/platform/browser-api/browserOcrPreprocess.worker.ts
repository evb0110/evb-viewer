/// <reference lib="webworker" />

import {
    parseBrowserOcrEngineRequest,
    type IBrowserOcrPreprocessResult,
    type TBrowserOcrPreprocessRequest,
} from '@contracts/browserOcrEngine';
import {getBrowserPageOpsWorkerRequestId} from '@contracts/browserPageOpsWorker';
import type {IScanCleanupWasmPlane} from '@contracts/scan-cleanup/browserScanCleanupWasm';
import {assembleBrowserPdfRasterPpm} from '@app/platform/browser-api/assembleBrowserPdfRasterPpm';
import {preprocessBrowserOcrPage} from '@app/platform/browser-api/browserScanCleanupWasm';
import {NativeWasmThreadStartError} from '@app/platform/browser/nativeWasmThreadedTool';
import {handlePrecompiledWasmModuleMessage} from '@app/platform/browser/loadWasmWithDeadline';
import {SCAN_CLEANUP_THREADED_ENGINE_UNAVAILABLE} from '@app/platform/browser-api/scanCleanupEngineWorkerName';
import {getErrorMessage} from '@app/utils/error';
import {encodePnm, readPnmSize} from '@ocr-core/ppmRaster';

declare const self: DedicatedWorkerGlobalScope;

/** The threaded engine did not start; the page gets the page back, as the raster this worker assembled. */
class ThreadedEngineUnavailable extends Error {
    public constructor(
        cause: Error,
        public readonly payload: TBrowserOcrPreprocessRequest['payload'] & {image: Uint8Array},
    ) {
        super(cause.message, {cause});
    }
}

function readRaster(image: TBrowserOcrPreprocessRequest['payload']['image']) {
    return image instanceof Uint8Array ? image : assembleBrowserPdfRasterPpm(image);
}

/**
 * The cleaned page as PNM, which the OCR engine reads without image codecs.
 * Desktop hands the engine the same pixels decoded from the cleanup's PNG.
 */
function encodePlane(plane: IScanCleanupWasmPlane) {
    if (plane.encoding !== 'raw') {
        throw new Error('OCR preprocessing returned an encoded plane');
    }
    return encodePnm(plane.width, plane.height, plane.kind === 'gray8' ? 1 : 3, plane.data);
}

/**
 * Runs desktop's OCR preprocessing on the rendered page in a dedicated worker
 * separate from Tesseract workers, so scan-cleanup WASM memory is held once
 * rather than duplicated across every OCR recognition worker.
 */
async function preprocess(payload: TBrowserOcrPreprocessRequest['payload']): Promise<IBrowserOcrPreprocessResult> {
    const raster = readRaster(payload.image);
    const size = payload.image instanceof Uint8Array ? readPnmSize(raster) : payload.image;
    let outcome: Awaited<ReturnType<typeof preprocessBrowserOcrPage>>;
    try {
        outcome = await preprocessBrowserOcrPage(raster, payload.mode, payload.dpi);
    } catch (error) {
        if (error instanceof NativeWasmThreadStartError) {
            throw new ThreadedEngineUnavailable(error, {
                ...payload,
                image: raster,
            });
        }
        throw error;
    }
    if (outcome.status === 'failed') {
        return {
            image: raster,
            width: size.width,
            height: size.height,
            failure: outcome.error.message,
        };
    }
    const {plane} = outcome.result;
    if (plane.width !== size.width || plane.height !== size.height) {
        return {
            image: raster,
            width: size.width,
            height: size.height,
            preprocessedSize: {
                width: plane.width,
                height: plane.height,
            },
        };
    }
    return {
        image: encodePlane(plane),
        width: size.width,
        height: size.height,
        ...(outcome.result.inverseTransform ? {inverseMatrix: outcome.result.inverseTransform.matrix} : {}),
    };
}

self.addEventListener('message', async (event: MessageEvent<unknown>) => {
    if (handlePrecompiledWasmModuleMessage(event.data)) {
        return;
    }
    const request = parseBrowserOcrEngineRequest(event.data);
    if (request === null || request.type !== 'preprocess') {
        const id = getBrowserPageOpsWorkerRequestId(event.data);
        if (id !== null) {
            self.postMessage({
                id,
                ok: false,
                error: 'Invalid browser OCR preprocess request',
            });
        }
        return;
    }
    try {
        const data = await preprocess(request.payload);
        self.postMessage(
            {
                id: request.id,
                ok: true,
                type: request.type,
                data,
            },
            [data.image.buffer],
        );
    } catch (error) {
        if (error instanceof ThreadedEngineUnavailable) {
            self.postMessage(
                {
                    id: request.id,
                    ok: false,
                    error: error.message,
                    errorEnvelope: {
                        code: SCAN_CLEANUP_THREADED_ENGINE_UNAVAILABLE,
                        message: error.message,
                        details: {payload: error.payload},
                    },
                },
                [error.payload.image.buffer],
            );
            return;
        }
        self.postMessage({
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        });
    } finally {
        if (!(request.payload.image instanceof Uint8Array)) {
            request.payload.image.tiles.forEach((tile) => tile.close());
        }
    }
});
