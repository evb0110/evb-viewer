import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    parentPort,
    workerData,
} from 'node:worker_threads';
import {
    createTesseractEngine,
    type IOcrEngineRequest,
    type TTesseractModuleFactory,
} from '@ocr-core/tesseractEngine';

/** Where the engine and the installed models are; the pool passes it to each worker. */
export interface IOcrEngineWorkerData {
    engineDir: string;
    tessdataDir: string;
}

const {
    engineDir, tessdataDir,
} = workerData as IOcrEngineWorkerData;

async function readBytes(path: string) {
    const buffer = await readFile(path);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** Desktop's host for the browser's engine: the same module and models, read from disk. */
const recognize = createTesseractEngine({
    loadEngine: async () => {
        const [
            imported,
            module,
        ] = await Promise.all([
            import(pathToFileURL(join(engineDir, 'evb-tesseract.mjs')).href) as Promise<{default: TTesseractModuleFactory}>,
            readBytes(join(engineDir, 'evb-tesseract.wasm')).then(bytes => WebAssembly.compile(bytes)),
        ]);
        return {
            factory: imported.default,
            module,
        };
    },
    loadModel: code => readBytes(join(tessdataDir, `${code}.traineddata`)),
});

parentPort!.on('message', async ({
    id, request,
}: {
    id: number;
    request: IOcrEngineRequest
}) => {
    try {
        const result = await recognize(request);
        parentPort!.postMessage({
            id,
            ok: true,
            result,
        }, result.passes.flatMap(pass => pass.outputs.map(output => output.buffer as ArrayBuffer)));
    } catch (error) {
        parentPort!.postMessage({
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});
