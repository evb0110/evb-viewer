/// <reference lib="webworker" />

import {
    BROWSER_OCR_ENGINE_REVISION,
    parseBrowserOcrEngineRequest,
    type IBrowserOcrEngineResult,
    type TBrowserOcrRecognizeRequest,
} from '@contracts/browserOcrEngine';
import {assembleBrowserPdfRasterPpm} from '@app/platform/browser-api/assembleBrowserPdfRasterPpm';
import {readCachedOcrModel} from '@app/platform/browser-api/browserOcrModels';
import {getBrowserPageOpsWorkerRequestId} from '@contracts/browserPageOpsWorker';
import {getErrorMessage} from '@app/utils/error';
import {createTesseractEngine, type TTesseractModuleFactory} from '@ocr-core/tesseractEngine';

declare const self: DedicatedWorkerGlobalScope;

const recognizeWithEngine = createTesseractEngine({
    loadEngine: async () => {
        const moduleUrl = new URL('/wasm/evb-tesseract.mjs', self.location.href).href;
        const [imported, module] = await Promise.all([
            import(/* @vite-ignore */ moduleUrl) as Promise<{default: TTesseractModuleFactory}>,
            WebAssembly.compileStreaming(
                fetch(new URL(`/wasm/evb-tesseract.wasm?revision=${BROWSER_OCR_ENGINE_REVISION}`, self.location.href)),
            ),
        ]);
        return {
            factory: imported.default,
            module,
        };
    },
    loadModel: readCachedOcrModel,
});

function readRaster(image: TBrowserOcrRecognizeRequest['payload']['image']) {
    return image instanceof Uint8Array ? image : assembleBrowserPdfRasterPpm(image);
}

function recognize(payload: TBrowserOcrRecognizeRequest['payload']): Promise<IBrowserOcrEngineResult> {
    return recognizeWithEngine({
        ...payload,
        image: readRaster(payload.image),
    });
}

self.addEventListener('message', async (event: MessageEvent<unknown>) => {
    const request = parseBrowserOcrEngineRequest(event.data);
    if (request === null || request.type !== 'recognize') {
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
        const data = await recognize(request.payload);
        self.postMessage(
            {
                id: request.id,
                ok: true,
                type: request.type,
                data,
                wasmMemoryBytes: recognizeWithEngine.getWasmMemoryBytes(),
            },
            data.passes.flatMap((pass) => pass.outputs.map((output) => output.buffer)),
        );
    } catch (error) {
        self.postMessage({
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
            wasmMemoryBytes: recognizeWithEngine.getWasmMemoryBytes(),
        });
    } finally {
        if (!(request.payload.image instanceof Uint8Array)) {
            request.payload.image.tiles.forEach((tile) => tile.close());
        }
    }
});
