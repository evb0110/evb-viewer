import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parentPort, workerData} from 'node:worker_threads';
import {decode as decodePng} from 'fast-png';
import {encodePnm} from '@ocr-core/ppmRaster';
import {createTesseractEngine, type TTesseractModuleFactory} from '@ocr-core/tesseractEngine';
import type {IOcrEngineLaneReply, IOcrEngineLaneRequest} from '@electron/features/ocr/main/ocrEngineHostProtocol';

/** Where the engine and the installed models are; the pool passes it to each worker. */
export interface IOcrEngineWorkerData {
    engineDir: string;
    tessdataDir: string;
}

const {engineDir, tessdataDir} = workerData as IOcrEngineWorkerData;

async function readBytes(path: string) {
    const buffer = await readFile(path);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

async function readRasterAsPnm(path: string) {
    const bytes = await readBytes(path);
    if (bytes[0] === 0x50) {
        return bytes;
    }
    const png = decodePng(bytes);
    if (png.depth !== 8 || (png.channels !== 1 && png.channels !== 3)) {
        throw new Error(`OCR raster is an unsupported ${png.depth}-bit, ${png.channels}-channel PNG`);
    }
    return encodePnm(png.width, png.height, png.channels, png.data as Uint8Array);
}

/** Desktop's host for the browser's engine: the same module and models, read from disk. */
const recognize = createTesseractEngine({
    loadEngine: async () => {
        const [imported, module] = await Promise.all([
            import(pathToFileURL(join(engineDir, 'evb-tesseract.mjs')).href) as Promise<{default: TTesseractModuleFactory}>,
            readBytes(join(engineDir, 'evb-tesseract.wasm')).then((bytes) => WebAssembly.compile(bytes)),
        ]);
        return {
            factory: imported.default,
            module,
        };
    },
    loadModel: (code) => readBytes(join(tessdataDir, `${code}.traineddata`)),
});

parentPort!.on('message', async ({id, request}: IOcrEngineLaneRequest) => {
    try {
        const image = request.image instanceof Uint8Array ? request.image : await readRasterAsPnm(request.image.path);
        const result = await recognize({
            ...request,
            image,
        });
        parentPort!.postMessage(
            {
                id,
                ok: true,
                result,
                wasmMemoryBytes: recognize.getWasmMemoryBytes(),
            } satisfies IOcrEngineLaneReply,
            result.passes.flatMap((pass) => pass.outputs.map((output) => output.buffer as ArrayBuffer)),
        );
    } catch (error) {
        parentPort!.postMessage({
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            wasmMemoryBytes: recognize.getWasmMemoryBytes(),
        } satisfies IOcrEngineLaneReply);
    }
});
