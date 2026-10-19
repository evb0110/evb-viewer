/// <reference lib="webworker" />

import {
    BROWSER_OCR_ENGINE_IMAGE_PATH,
    BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS,
    BROWSER_OCR_ENGINE_TESSDATA_PATH,
    parseBrowserOcrEngineRequest,
    type IBrowserOcrEnginePass,
    type IBrowserOcrEngineResult,
} from '@app/platform/browser-api/browserOcrEngine.types';
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
        writeFile(path: string, data: Uint8Array): void;
        readFile(path: string): Uint8Array;
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

function loadEngine() {
    enginePromise ??= (async () => {
        const moduleUrl = new URL('/wasm/evb-tesseract.mjs', self.location.href).href;
        const [
            imported,
            module,
        ] = await Promise.all([
            import(/* @vite-ignore */ moduleUrl) as Promise<{default: TTesseractModuleFactory}>,
            WebAssembly.compileStreaming(fetch(new URL('/wasm/evb-tesseract.wasm', self.location.href))),
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
 * One Tesseract run in a fresh instance of the compiled engine, as desktop
 * runs one process per pass: no setting or state carries over between passes.
 */
async function runPass(
    engine: IEngine,
    image: Uint8Array,
    modelBytes: ReadonlyMap<TOcrModelCode, Uint8Array>,
    pass: IBrowserOcrEnginePass,
) {
    let stderr = '';
    const instance = await engine.factory({
        instantiateWasm(imports, receive) {
            void WebAssembly.instantiate(engine.module, imports).then(created => receive(created, engine.module));
            return {};
        },
        print: () => {},
        printErr: (line) => {
            if (stderr.length < BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS) {
                stderr = `${stderr}${line}\n`.slice(0, BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS);
            }
        },
    });
    instance.FS.mkdirTree('/work');
    instance.FS.writeFile(BROWSER_OCR_ENGINE_IMAGE_PATH, image);
    for (const [
        code,
        bytes,
    ] of modelBytes) {
        instance.FS.writeFile(`${BROWSER_OCR_ENGINE_TESSDATA_PATH}/${code}.traineddata`, bytes);
    }
    const exitCode = instance.callMain([...pass.args]);
    if (exitCode !== 0) {
        throw new Error(`Tesseract exited with code ${exitCode}: ${stderr.trim()}`);
    }
    const outputs = pass.outputs.map((path) => {
        try {
            return instance.FS.readFile(path).slice();
        } catch {
            throw new Error(`Tesseract did not write ${path}: ${stderr.trim()}`);
        }
    });
    return {
        stderr,
        outputs,
    };
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
        const passes: IBrowserOcrEngineResult['passes'] = [];
        for (const pass of request.payload.passes) {
            passes.push(await runPass(engine, request.payload.image, modelBytes, pass));
        }
        self.postMessage({
            id: request.id,
            ok: true,
            type: 'recognize',
            data: {passes},
        }, passes.flatMap(pass => pass.outputs.map(output => output.buffer)));
    } catch (error) {
        self.postMessage({
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        });
    }
});
