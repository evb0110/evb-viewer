import {
    BROWSER_OCR_ENGINE_IMAGE_PATH,
    BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS,
    BROWSER_OCR_ENGINE_TESSDATA_PATH,
    type IBrowserOcrEnginePass,
    type IBrowserOcrEngineResult,
} from '@contracts/browserOcrEngine';
import {
    type TOcrModelCode,
    withOcrModelSublanguages,
} from '@contracts/ocrLanguages';

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

export type TTesseractModuleFactory = (options: {
    instantiateWasm: (
        imports: WebAssembly.Imports,
        receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => object;
    print: (line: string) => void;
    printErr: (line: string) => void;
}) => Promise<ITesseractModule>;

/** One page's Tesseract passes over a PNM raster, with the models they read. */
export interface IOcrEngineRequest<TImage = Uint8Array> {
    image: TImage;
    models: TOcrModelCode[];
    passes: IBrowserOcrEnginePass[];
}

export type IOcrEngineResult = IBrowserOcrEngineResult;

/** How a host supplies the engine and the pinned models to the worker that runs them. */
export interface ITesseractEngineSource {
    loadEngine: () => Promise<{
        factory: TTesseractModuleFactory;
        module: WebAssembly.Module;
    }>;
    loadModel: (code: TOcrModelCode) => Promise<Uint8Array>;
}

/**
 * The OCR engine as each worker runs it, in the browser and on desktop: the
 * pinned Tesseract compiled to WebAssembly, run as its command-line program
 * with the arguments `tesseractRecipe` builds. A worker keeps one warm
 * instance; the host only decides where the engine and models come from.
 */
export function createTesseractEngine(source: ITesseractEngineSource) {
    let enginePromise: ReturnType<ITesseractEngineSource['loadEngine']> | null = null;
    const models = new Map<TOcrModelCode, Promise<Uint8Array>>();
    let activeInstance: {
        key: string;
        module: ITesseractModule;
        log: {stderr: string};
    } | null = null;

    const loadEngine = () => {
        if (!enginePromise) {
            const loading = source.loadEngine();
            loading.catch(() => {
                enginePromise = null;
            });
            enginePromise = loading;
        }
        return enginePromise;
    };

    const loadModel = (code: TOcrModelCode) => {
        let model = models.get(code);
        if (!model) {
            model = source.loadModel(code);
            model.catch(() => models.delete(code));
            models.set(code, model);
        }
        return model;
    };

    /**
     * Retain model weights only for an identical command-line configuration.
     * The WASM CLI clears page results, adaptive state and the document dictionary
     * after each call. A changed recipe gets a fresh instance.
     */
    const runPass = async (
        engine: Awaited<ReturnType<typeof loadEngine>>,
        image: Uint8Array,
        modelBytes: ReadonlyMap<TOcrModelCode, Uint8Array>,
        pass: IBrowserOcrEnginePass,
    ) => {
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
    };

    /** Runs one page's passes in order; a failed page drops the instance it may have left in a bad state. */
    return async function recognize(request: IOcrEngineRequest): Promise<IOcrEngineResult> {
        try {
            // Tesseract finds the sub-languages a model's config loads beside it.
            const codes = withOcrModelSublanguages(request.models);
            const [
                engine,
                ...loaded
            ] = await Promise.all([
                loadEngine(),
                ...codes.map(loadModel),
            ]);
            const modelBytes = new Map(codes.map((code, index) => [
                code,
                loaded[index]!,
            ]));
            const passes: IOcrEngineResult['passes'] = [];
            for (const pass of request.passes) {
                passes.push(await runPass(engine, request.image, modelBytes, pass));
            }
            return {passes};
        } catch (error) {
            activeInstance = null;
            throw error;
        }
    };
}
