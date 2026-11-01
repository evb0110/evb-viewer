/// <reference lib="webworker" />

import {
    BROWSER_OCR_ENGINE_IMAGE_PATH,
    BROWSER_OCR_ENGINE_REVISION,
    BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS,
    BROWSER_OCR_ENGINE_TESSDATA_PATH,
    BROWSER_OCR_RENDER_TILE_PX,
    parseBrowserOcrEngineRequest,
    type IBrowserOcrEnginePass,
    type IBrowserOcrEngineResult,
    type IBrowserOcrPreprocessResult,
    type TBrowserOcrEngineRequest,
    type TBrowserOcrPreprocessRequest,
    type TBrowserOcrRecognizeRequest,
} from '@contracts/browserOcrEngine';
import {
    createPpmRaster, writePpmTile,
} from '@ocr-core/ppmRaster';
import {readCachedOcrModel} from '@app/platform/browser-api/browserOcrModels';
import {preprocessBrowserOcrPage} from '@app/platform/browser-api/browserScanCleanupWasm';
import type {IScanCleanupWasmPlane} from '@contracts/scan-cleanup/browserScanCleanupWasm';
import {getBrowserPageOpsWorkerRequestId} from '@contracts/browserPageOpsWorker';
import type {TOcrModelCode} from '@contracts/ocrLanguages';
import {getErrorMessage} from '@app/utils/error';

declare const self: DedicatedWorkerGlobalScope;

/** The part of the Emscripten module a pass uses (`scripts/build-tesseract-wasm.sh`). */
interface ITesseractModule {
    callMain(args: string[]): number;
    FS: {
        mkdirTree(path: string): void;
        writeFile(path: string, data: Uint8Array, options?: {canOwn: boolean}): void;
        readFile(path: string): Uint8Array;
        unlink(path: string): void;
    };
}

type TTesseractModuleFactory = (options: {
    instantiateWasm: (
        imports: WebAssembly.Imports,
        receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => object;
    print: (line: string) => void;
    printErr: (line: string) => void;
}) => Promise<ITesseractModule>;

interface IEngine {
    factory: TTesseractModuleFactory;
    module: WebAssembly.Module;
}

let enginePromise: Promise<IEngine> | null = null;
const models = new Map<TOcrModelCode, Promise<Uint8Array>>();
let activeInstance: {
    key: string;
    module: ITesseractModule;
    log: {stderr: string};
} | null = null;

function loadEngine() {
    enginePromise ??= (async () => {
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
    })();
    enginePromise.catch(() => {
        enginePromise = null;
    });
    return enginePromise;
}

function loadModel(code: TOcrModelCode) {
    let model = models.get(code);
    if (!model) {
        model = readCachedOcrModel(code);
        model.catch(() => models.delete(code));
        models.set(code, model);
    }
    return model;
}

/**
 * Retain model weights only for an identical command-line configuration.
 * The WASM CLI clears page results, adaptive state and the document dictionary
 * after each call. A changed recipe gets a fresh instance, just as on desktop.
 */
async function runPass(
    engine: IEngine,
    image: Uint8Array,
    modelBytes: ReadonlyMap<TOcrModelCode, Uint8Array>,
    pass: IBrowserOcrEnginePass,
) {
    const key = JSON.stringify([
        pass.args.slice(2),
        [...modelBytes.keys()],
    ]);
    if (activeInstance?.key !== key) {
        activeInstance = null;
        const log = {stderr: ''};
        const module = await engine.factory({
            instantiateWasm(imports, receive) {
                void WebAssembly.instantiate(engine.module, imports).then(created => receive(created, engine.module));
                return {};
            },
            print: () => {},
            printErr: (line) => {
                if (log.stderr.length < BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS) {
                    log.stderr = `${log.stderr}${line}\n`.slice(0, BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS);
                }
            },
        });
        module.FS.mkdirTree('/work');
        for (const [
            code,
            bytes,
        ] of modelBytes) {
            module.FS.writeFile(`${BROWSER_OCR_ENGINE_TESSDATA_PATH}/${code}.traineddata`, bytes, {canOwn: true});
        }
        activeInstance = {
            key,
            module,
            log,
        };
    }
    const {
        module: instance, log,
    } = activeInstance;
    log.stderr = '';
    // This input can serve several early-print passes, so MEMFS borrows it.
    instance.FS.writeFile(BROWSER_OCR_ENGINE_IMAGE_PATH, image, {canOwn: true});
    const exitCode = instance.callMain([...pass.args]);
    if (exitCode !== 0) {
        throw new Error(`Tesseract exited with code ${exitCode}: ${log.stderr.trim()}`);
    }
    const outputs = pass.outputs.map((path) => {
        try {
            return instance.FS.readFile(path);
        } catch {
            throw new Error(`Tesseract did not write ${path}: ${log.stderr.trim()}`);
        }
    });
    for (const path of [
        BROWSER_OCR_ENGINE_IMAGE_PATH,
        ...pass.outputs,
    ]) instance.FS.unlink(path);
    return {
        stderr: log.stderr,
        outputs,
    };
}

function readRaster(image: TBrowserOcrEngineRequest['payload']['image']) {
    if (image instanceof Uint8Array) return image;
    const ppm = createPpmRaster(image.width, image.height);
    const canvas = new OffscreenCanvas(1, 1);
    const columns = Math.ceil(image.width / BROWSER_OCR_RENDER_TILE_PX);
    try {
        image.tiles.forEach((tile, index) => {
            canvas.width = tile.width;
            canvas.height = tile.height;
            const context = canvas.getContext('2d', {willReadFrequently: true});
            if (!context) throw new Error('OCR canvas context is unavailable');
            context.drawImage(tile, 0, 0);
            writePpmTile(ppm, image.width, context.getImageData(0, 0, tile.width, tile.height).data,
                index % columns * BROWSER_OCR_RENDER_TILE_PX, Math.floor(index / columns) * BROWSER_OCR_RENDER_TILE_PX, tile.width, tile.height);
            tile.close();
        });
        return ppm.image;
    } finally {
        canvas.width = canvas.height = 0;
    }
}

/** The size `createPpmRaster` wrote into a page assembled on the UI thread. */
function readPpmSize(image: Uint8Array) {
    const match = /^P6\n(\d+) (\d+)\n255\n/u.exec(new TextDecoder().decode(image.subarray(0, 32)));
    if (!match) throw new Error('OCR page raster is not a binary PPM');
    return {
        width: Number(match[1]),
        height: Number(match[2]),
    };
}

/**
 * The cleaned page as PNM, which the engine reads without image codecs.
 * Desktop hands Tesseract the same pixels as an 8-bit gray or RGB PNG,
 * which Leptonica decodes to the same image as PGM or PPM.
 */
function encodePnm(plane: IScanCleanupWasmPlane) {
    if (plane.encoding !== 'raw') throw new Error('OCR preprocessing returned an encoded plane');
    const header = new TextEncoder().encode(`${plane.kind === 'gray8' ? 'P5' : 'P6'}\n${plane.width} ${plane.height}\n255\n`);
    const image = new Uint8Array(header.byteLength + plane.data.byteLength);
    image.set(header);
    image.set(plane.data, header.byteLength);
    return image;
}

/**
 * Runs desktop's OCR preprocessing on the rendered page: the shared pinned
 * options, an output of the input's size and a usable inverse transform, or
 * the rendered page itself with the reason it was not cleaned.
 */
async function preprocess(payload: TBrowserOcrPreprocessRequest['payload']): Promise<IBrowserOcrPreprocessResult> {
    const raster = readRaster(payload.image);
    const size = payload.image instanceof Uint8Array ? readPpmSize(raster) : payload.image;
    const outcome = await preprocessBrowserOcrPage(raster, size, payload.mode, payload.dpi);
    if (outcome.status === 'failed') {
        return {
            image: raster,
            width: size.width,
            height: size.height,
            failure: outcome.error.message,
        };
    }
    return {
        image: encodePnm(outcome.result.plane),
        width: size.width,
        height: size.height,
        ...(outcome.result.inverseTransform ? {inverseMatrix: outcome.result.inverseTransform.matrix} : {}),
    };
}

async function recognize(payload: TBrowserOcrRecognizeRequest['payload']): Promise<IBrowserOcrEngineResult> {
    const [
        engine,
        ...loaded
    ] = await Promise.all([
        loadEngine(),
        ...payload.models.map(loadModel),
    ]);
    const modelBytes = new Map(payload.models.map((code, index) => [
        code,
        loaded[index]!,
    ]));
    const image = readRaster(payload.image);
    const passes: IBrowserOcrEngineResult['passes'] = [];
    for (const pass of payload.passes) {
        passes.push(await runPass(engine, image, modelBytes, pass));
    }
    return {passes};
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
        if (request.type === 'recognize') activeInstance = null;
        self.postMessage({
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        });
    } finally {
        if (!(request.payload.image instanceof Uint8Array)) request.payload.image.tiles.forEach(tile => tile.close());
    }
});
