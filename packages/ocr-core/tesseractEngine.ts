import {
    BROWSER_OCR_ENGINE_IMAGE_PATH,
    BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS,
    BROWSER_OCR_ENGINE_TESSDATA_PATH,
    type IBrowserOcrEnginePass,
    type IBrowserOcrEngineResult,
} from '@contracts/browserOcrEngine';
import {OCR_LANGUAGE_MODEL_SHA256, type TOcrModelCode, withOcrModelSublanguages} from '@contracts/ocrLanguages';

const TESSERACT_VALUE_FLAGS = new Set(['--tessdata-dir', '--dpi', '-c', '--psm', '--oem', '--user-words', '--user-patterns']);

function parsePassArgLanguages(args: readonly string[]): TOcrModelCode[] | null {
    let lastLangArg: string | null = null;
    for (let index = 2; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === '-l' && index + 1 < args.length) {
            // Tesseract 5.5.3 overwrites `lang` on repeated `-l` flags (last flag wins).
            lastLangArg = args[index + 1]!;
            index += 1;
            continue;
        }
        if (TESSERACT_VALUE_FLAGS.has(arg)) {
            index += 1;
        }
    }
    if (lastLangArg === null) {
        return null;
    }
    const tokens = lastLangArg.split('+').filter((token) => token.length > 0 && !token.startsWith('~'));
    if (tokens.length === 0 || !tokens.every((token) => Object.hasOwn(OCR_LANGUAGE_MODEL_SHA256, token))) {
        return null;
    }
    return tokens as TOcrModelCode[];
}

/**
 * Computes the exact sorted model set a single Tesseract pass needs mounted in
 * MEMFS, always expanding sub-language dependencies through `withOcrModelSublanguages`.
 */
export function resolveTesseractPassModels(
    pass: Pick<IBrowserOcrEnginePass, 'args' | 'models'>,
    fallbackModels: readonly TOcrModelCode[],
): TOcrModelCode[] {
    const passLanguages = pass.models && pass.models.length > 0 ? pass.models : (parsePassArgLanguages(pass.args) ?? fallbackModels);
    return [...withOcrModelSublanguages(passLanguages)].sort();
}

/**
 * Computes the exact sorted union of models a request's passes will load and
 * mount, keeping worker loading and desktop pool admission on one source of truth.
 */
export function resolveTesseractRequestModels(request: Pick<IOcrEngineRequest<unknown>, 'models' | 'passes'>): TOcrModelCode[] {
    if (request.passes.length === 0) {
        return [...withOcrModelSublanguages(request.models)].sort();
    }
    return [...new Set(request.passes.flatMap((pass) => resolveTesseractPassModels(pass, request.models)))].sort();
}

/** The part of the Emscripten module a pass uses (`scripts/build-tesseract-wasm.sh`). */
interface ITesseractModule {
    callMain(args: string[]): number;
    FS: {
        mkdirTree(path: string): void;
        writeFile(path: string, data: Uint8Array, options?: {canOwn: boolean}): void;
        readFile(path: string): Uint8Array;
        unlink(path: string): void;
    };
    wasmMemory?: WebAssembly.Memory;
    HEAPU8?: Uint8Array;
}

export interface ITesseractEngine {
    (request: IOcrEngineRequest): Promise<IOcrEngineResult>;
    /** Retained WebAssembly linear-memory size in bytes for the warm instance, or 0 when none is live. */
    getWasmMemoryBytes: () => number;
}

function findWasmMemory(instance: WebAssembly.Instance | null, imports?: WebAssembly.Imports): WebAssembly.Memory | null {
    if (instance) {
        for (const value of Object.values(instance.exports)) {
            if (value instanceof WebAssembly.Memory) {
                return value;
            }
        }
    }
    if (imports) {
        for (const namespace of Object.values(imports)) {
            if (typeof namespace === 'object' && namespace !== null) {
                for (const value of Object.values(namespace)) {
                    if (value instanceof WebAssembly.Memory) {
                        return value;
                    }
                }
            }
        }
    }
    return null;
}

function readWasmMemoryBytes(memory: WebAssembly.Memory | null, module: ITesseractModule | null): number {
    if (memory) {
        return memory.buffer.byteLength;
    }
    if (module?.wasmMemory instanceof WebAssembly.Memory) {
        return module.wasmMemory.buffer.byteLength;
    }
    if (module?.HEAPU8 instanceof Uint8Array) {
        return module.HEAPU8.buffer.byteLength;
    }
    return 0;
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
export function createTesseractEngine(source: ITesseractEngineSource): ITesseractEngine {
    let enginePromise: ReturnType<ITesseractEngineSource['loadEngine']> | null = null;
    const models = new Map<TOcrModelCode, Promise<Uint8Array>>();
    let activeInstance: {
        key: string;
        module: ITesseractModule;
        memory: WebAssembly.Memory | null;
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
        mountedModels: readonly TOcrModelCode[],
    ) => {
        const key = JSON.stringify([pass.args.slice(2), mountedModels]);
        if (activeInstance?.key !== key) {
            activeInstance = null;
            const log = {stderr: ''};
            let memory: WebAssembly.Memory | null = null;
            const module = await engine.factory({
                instantiateWasm(imports, receive) {
                    void WebAssembly.instantiate(engine.module, imports).then((created) => {
                        memory = findWasmMemory(created, imports);
                        receive(created, engine.module);
                    });
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
            for (const code of mountedModels) {
                module.FS.writeFile(`${BROWSER_OCR_ENGINE_TESSDATA_PATH}/${code}.traineddata`, modelBytes.get(code)!, {canOwn: true});
            }
            activeInstance = {
                key,
                module,
                memory,
                log,
            };
        }
        const {module: instance, log} = activeInstance;
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
        for (const path of [BROWSER_OCR_ENGINE_IMAGE_PATH, ...pass.outputs]) {
            instance.FS.unlink(path);
        }
        return {
            stderr: log.stderr,
            outputs,
        };
    };

    /** Runs one page's passes in order; a failed page drops the instance it may have left in a bad state. */
    const recognize: ITesseractEngine = Object.assign(
        async function recognize(request: IOcrEngineRequest): Promise<IOcrEngineResult> {
            try {
                // Scope each pass's MEMFS mounts to its own sub-language closure so
                // e.g. early-print ita_old/fra passes do not mount unrelated 100+ MiB models.
                const passPlans = request.passes.map((pass) => ({
                    pass,
                    mountedModels: resolveTesseractPassModels(pass, request.models),
                }));
                const codes = [...new Set(passPlans.flatMap((plan) => plan.mountedModels))];
                const [engine, ...loaded] = await Promise.all([loadEngine(), ...codes.map(loadModel)]);
                const modelBytes = new Map(codes.map((code, index) => [code, loaded[index]!]));
                const passes: IOcrEngineResult['passes'] = [];
                for (const {pass, mountedModels} of passPlans) {
                    passes.push(await runPass(engine, request.image, modelBytes, pass, mountedModels));
                }
                return {passes};
            } catch (error) {
                activeInstance = null;
                throw error;
            }
        },
        {
            getWasmMemoryBytes: () => (activeInstance ? readWasmMemoryBytes(activeInstance.memory, activeInstance.module) : 0),
        },
    );
    return recognize;
}
