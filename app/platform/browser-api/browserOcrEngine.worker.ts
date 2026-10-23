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
    type TBrowserOcrEngineRequest,
} from '@contracts/browserOcrEngine';
import {
    createPpmRaster, writePpmTile,
} from '@ocr-core/ppmRaster';
import {readCachedOcrModel} from '@app/platform/browser-api/browserOcrModels';
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
        const [
            engine,
            ...loaded
        ] = await Promise.all([
            loadEngine(),
            ...request.payload.models.map(loadModel),
        ]);
        const modelBytes = new Map(request.payload.models.map((code, index) => [
            code,
            loaded[index]!,
        ]));
        const image = readRaster(request.payload.image);
        const passes: IBrowserOcrEngineResult['passes'] = [];
        for (const pass of request.payload.passes) {
            passes.push(await runPass(engine, image, modelBytes, pass));
        }
        self.postMessage({
            id: request.id,
            ok: true,
            type: 'recognize',
            data: {passes},
        }, passes.flatMap(pass => pass.outputs.map(output => output.buffer)));
    } catch (error) {
        activeInstance = null;
        self.postMessage({
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        });
    } finally {
        if (!(request.payload.image instanceof Uint8Array)) request.payload.image.tiles.forEach(tile => tile.close());
    }
});
