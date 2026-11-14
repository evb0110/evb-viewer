/// <reference lib="webworker" />

import {
    BROWSER_OCR_ENGINE_REVISION,
    parseBrowserOcrEngineRequest,
    type IBrowserOcrEngineResult,
    type IBrowserOcrPreprocessResult,
    type TBrowserOcrEngineRequest,
    type TBrowserOcrPreprocessRequest,
    type TBrowserOcrRecognizeRequest,
} from '@contracts/browserOcrEngine';
import {assembleBrowserPdfRasterPpm} from '@app/platform/browser-api/assembleBrowserPdfRasterPpm';
import {readCachedOcrModel} from '@app/platform/browser-api/browserOcrModels';
import {preprocessBrowserOcrPage} from '@app/platform/browser-api/browserScanCleanupWasm';
import type {IScanCleanupWasmPlane} from '@contracts/scan-cleanup/browserScanCleanupWasm';
import {getBrowserPageOpsWorkerRequestId} from '@contracts/browserPageOpsWorker';
import {getErrorMessage} from '@app/utils/error';
import {
    encodePnm,
    readPnmSize,
} from '@ocr-core/ppmRaster';
import {
    createTesseractEngine,
    type TTesseractModuleFactory,
} from '@ocr-core/tesseractEngine';

declare const self: DedicatedWorkerGlobalScope;

const recognizeWithEngine = createTesseractEngine({
    loadEngine: async () => {
        const moduleUrl = new URL('/wasm/evb-tesseract.mjs', self.location.href).href;
        const [
            imported,
            module,
        ] = await Promise.all([
            import(/* @vite-ignore */ moduleUrl) as Promise<{default: TTesseractModuleFactory}>,
            WebAssembly.compileStreaming(fetch(new URL(`/wasm/evb-tesseract.wasm?revision=${BROWSER_OCR_ENGINE_REVISION}`, self.location.href))),
        ]);
        return {
            factory: imported.default,
            module,
        };
    },
    loadModel: readCachedOcrModel,
});

function readRaster(image: TBrowserOcrEngineRequest['payload']['image']) {
    return image instanceof Uint8Array ? image : assembleBrowserPdfRasterPpm(image);
}

/**
 * The cleaned page as PNM, which the engine reads without image codecs.
 * Desktop hands the engine the same pixels decoded from the cleanup's PNG.
 */
function encodePlane(plane: IScanCleanupWasmPlane) {
    if (plane.encoding !== 'raw') throw new Error('OCR preprocessing returned an encoded plane');
    return encodePnm(plane.width, plane.height, plane.kind === 'gray8' ? 1 : 3, plane.data);
}

/**
 * Runs desktop's OCR preprocessing on the rendered page: the shared pinned
 * options, an output of the input's size and a usable inverse transform, or
 * the rendered page itself with the reason it was not cleaned or the cleaned
 * page's other size.
 */
async function preprocess(payload: TBrowserOcrPreprocessRequest['payload']): Promise<IBrowserOcrPreprocessResult> {
    const raster = readRaster(payload.image);
    const size = payload.image instanceof Uint8Array ? readPnmSize(raster) : payload.image;
    const outcome = await preprocessBrowserOcrPage(raster, payload.mode, payload.dpi);
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

function recognize(payload: TBrowserOcrRecognizeRequest['payload']): Promise<IBrowserOcrEngineResult> {
    return recognizeWithEngine({
        ...payload,
        image: readRaster(payload.image),
    });
}

self.addEventListener('message', async (event: MessageEvent<unknown>) => {
    const request = parseBrowserOcrEngineRequest(event.data);
    if (request === null) {
        const id = getBrowserPageOpsWorkerRequestId(event.data);
        if (id !== null) {
            self.postMessage({
                id,
                ok: false,
                error: 'Invalid browser OCR engine request',
            });
        }
        return;
    }
    try {
        if (request.type === 'preprocess') {
            const data = await preprocess(request.payload);
            self.postMessage({
                id: request.id,
                ok: true,
                type: request.type,
                data,
            }, [data.image.buffer]);
            return;
        }
        const data = await recognize(request.payload);
        self.postMessage({
            id: request.id,
            ok: true,
            type: request.type,
            data,
        }, data.passes.flatMap(pass => pass.outputs.map(output => output.buffer)));
    } catch (error) {
        self.postMessage({
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        });
    } finally {
        if (!(request.payload.image instanceof Uint8Array)) request.payload.image.tiles.forEach(tile => tile.close());
    }
});
