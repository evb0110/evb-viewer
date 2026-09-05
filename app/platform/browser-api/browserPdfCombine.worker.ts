import {
    DEFAULT_TIFF_DECODE_LIMITS,
    iterateDecodedTiffFrames,
} from '@pdf-core/iterateDecodedTiffFrames';
import type {
    IBrowserPdfCombineInput,
    IBrowserPdfCombineWasmImagePreprocessing,
    IBrowserPdfCombineWasmPageSpec,
    TBrowserPdfCombineWorkerResponse,
} from '@app/platform/browser-api/browserPdfCombineWorker.types';
import {
    getBrowserPdfCombineWorkerRequestId,
    parseBrowserPdfCombineWorkerRequest,
} from '@app/platform/browser-api/browserPdfCombineWorker.types';
import {
    BROWSER_COMBINE_IMAGE_EXTENSIONS,
    getBrowserFileExtension,
} from '@app/platform/browser-api/browserPlatformHelpers';
import { tryCombineImageInputsWithWasm } from '@app/platform/browser-api/tryCombineImageInputsWithWasm';
import {
    isBrowserPageOpsWasmFailure,
    tryRunBrowserPageOpsWithWasm,
} from '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm';
import { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
import { getErrorMessage } from '@app/utils/error';
import { readBrowserRasterImageMetadata } from '@app/platform/browser-api/browserRasterImageMetadata';
import {
    findSerializableErrorEnvelope,
    SerializableError,
} from '@contracts/serializableError';
import { isNativeErrorEnvelope } from '@contracts/nativeErrors';
import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';
import { createBrowserPdfCombineOutputError } from '@app/platform/browser-api/browserPdfCombineLimits';

const MAX_COMBINE_PAGES = 500;
const MAX_IMAGE_PIXELS = 80_000_000;
const MAX_INPUT_BYTES = BROWSER_MAX_FULL_READ_BYTES;
const MAX_OUTPUT_BYTES = BROWSER_MAX_FULL_READ_BYTES;
const MAX_DECODED_WORKING_BYTES = 256 * 1024 * 1024;

interface IDecodedWorkingSetBudget { usedBytes: number; }

function consumeDecodedWorkingSet(
    budget: IDecodedWorkingSetBudget,
    width: number,
    height: number,
    fileName: string,
) {
    const decodedBytes = width * height * 4;
    if (
        !Number.isSafeInteger(decodedBytes)
        || decodedBytes < 0
        || budget.usedBytes > MAX_DECODED_WORKING_BYTES - decodedBytes
    ) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_DECODED_WORKING_SET_TOO_LARGE:${fileName}`);
    }
    budget.usedBytes += decodedBytes;
}

function assertImageDimensions(width: number, height: number, fileName: string) {
    if (width < 1 || height < 1 || width > MAX_IMAGE_PIXELS / height) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_IMAGE_TOO_LARGE:${fileName}`);
    }
}

function isNetpbmExtension(extension: string) {
    return extension === '.pgm' || extension === '.ppm';
}

async function convertWorkerImageBytesToPng(fileName: string, bytes: Uint8Array) {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
        throw new Error('ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_IMAGE_RUNTIME');
    }

    const extension = getBrowserFileExtension(fileName);
    const metadata = readBrowserRasterImageMetadata(bytes, extension);
    if (!metadata) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_UNREADABLE_IMAGE_HEADER:${fileName}`);
    }
    assertImageDimensions(metadata.width, metadata.height, fileName);
    const blob = new Blob([bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : Uint8Array.from(bytes)]);
    const bitmap = await createImageBitmap(blob);

    try {
        assertImageDimensions(bitmap.width, bitmap.height, fileName);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_IMAGE_RUNTIME');
        }
        context.drawImage(bitmap, 0, 0);
        const pngBlob = await canvas.convertToBlob({type: 'image/png'});
        return new Uint8Array(await pngBlob.arrayBuffer());
    } finally {
        bitmap.close();
    }
}

function validateWorkerInput(
    input: IBrowserPdfCombineInput,
    budget: IDecodedWorkingSetBudget,
) {
    const extension = getBrowserFileExtension(input.fileName);
    if (extension === '.pdf') {
        return;
    }
    if (isNetpbmExtension(extension)) {
        return;
    }
    if (extension === '.tif' || extension === '.tiff') {
        let frameCount = 0;
        for (const {
            width,
            height,
        } of iterateDecodedTiffFrames(input.data, {
                ...DEFAULT_TIFF_DECODE_LIMITS,
                sourceLabel: input.fileName,
            })) {
            assertImageDimensions(width, height, input.fileName);
            consumeDecodedWorkingSet(budget, width, height, input.fileName);
            frameCount += 1;
        }
        if (frameCount === 0) {
            throw new Error(`ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT:${input.fileName}`);
        }
        return;
    }

    if (!BROWSER_COMBINE_IMAGE_EXTENSIONS.has(extension)) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT:${input.fileName}`);
    }
    const metadata = readBrowserRasterImageMetadata(input.data, extension);
    if (!metadata) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_UNREADABLE_IMAGE_HEADER:${input.fileName}`);
    }
    assertImageDimensions(metadata.width, metadata.height, input.fileName);
    consumeDecodedWorkingSet(budget, metadata.width, metadata.height, input.fileName);
}

function getExifRotationDegrees(input: IBrowserPdfCombineInput): 0 | 90 | 180 | 270 {
    const metadata = readBrowserRasterImageMetadata(input.data, getBrowserFileExtension(input.fileName));
    if (!metadata) {
        return 0;
    }
    return metadata.orientation === 3 ? 180 : metadata.orientation === 6 ? 90 : metadata.orientation === 8 ? 270 : 0;
}

function buildExifRotationPreprocessing(inputs: IBrowserPdfCombineInput[]): IBrowserPdfCombineWasmImagePreprocessing | undefined {
    if (!inputs.some(input => getExifRotationDegrees(input) !== 0)) {
        return undefined;
    }
    const pageSizes = inputs.map(input => {
        const metadata = readBrowserRasterImageMetadata(input.data, getBrowserFileExtension(input.fileName));
        if (!metadata) throw new Error(`ERR_BROWSER_PDF_COMBINE_UNREADABLE_IMAGE_HEADER:${input.fileName}`);
        const dpi = metadata.dpi > 0 ? metadata.dpi : 72;
        return {
            widthPoints: metadata.width * 72 / dpi,
            heightPoints: metadata.height * 72 / dpi,
        };
    });
    return {
        pageSizes,
        pageSpecs: inputs.map((input, index) => ({
            kind: 'image' as const,
            pageSize: pageSizes[index]!,
            rotationDegrees: getExifRotationDegrees(input),
            image: input,
        })),
    };
}

async function prepareWorkerInput(
    input: IBrowserPdfCombineInput,
    budget: IDecodedWorkingSetBudget,
): Promise<IBrowserPdfCombineInput> {
    validateWorkerInput(input, budget);
    const extension = getBrowserFileExtension(input.fileName);
    if (
        extension !== '.bmp'
        && extension !== '.gif'
        && extension !== '.webp'
    ) {
        return input;
    }

    return {
        fileName: `${input.fileName.slice(0, -extension.length)}.png`,
        data: await convertWorkerImageBytesToPng(input.fileName, input.data),
    };
}

async function preparePageSpec(
    spec: IBrowserPdfCombineWasmPageSpec,
    budget: IDecodedWorkingSetBudget,
): Promise<IBrowserPdfCombineWasmPageSpec> {
    const prepared: IBrowserPdfCombineWasmPageSpec = {...spec};
    if (spec.image) {
        prepared.image = await prepareWorkerInput(spec.image, budget);
    }
    if (spec.background) {
        prepared.background = await prepareWorkerInput(spec.background, budget);
    }
    if (spec.mask) {
        prepared.mask = await prepareWorkerInput(spec.mask, budget);
    }
    return prepared;
}

function addInputBytes(total: number, input: IBrowserPdfCombineInput) {
    if (input.data.byteLength > MAX_INPUT_BYTES || total > MAX_INPUT_BYTES - input.data.byteLength) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_INPUT_TOO_LARGE');
    }
    return total + input.data.byteLength;
}

async function handleCombinePdfsRequest(request: {payload: {
    inputs: IBrowserPdfCombineInput[];
    wasmImagePreprocessing?: IBrowserPdfCombineWasmImagePreprocessing;
};}) {
    if (request.payload.inputs.length === 0) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_NO_INPUTS');
    }
    if (request.payload.inputs.length > MAX_COMBINE_PAGES) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_TOO_MANY_PAGES');
    }

    const decodedBudget: IDecodedWorkingSetBudget = {usedBytes: 0};
    let totalInputBytes = 0;
    for (const input of request.payload.inputs) {
        totalInputBytes = addInputBytes(totalInputBytes, input);
    }

    const inputs = await Promise.all(
        request.payload.inputs.map(input => prepareWorkerInput(input, decodedBudget)),
    );
    let wasmImagePreprocessing = request.payload.wasmImagePreprocessing;
    if (wasmImagePreprocessing?.pageSpecs) {
        const pageSpecs = [];
        for (const pageSpec of wasmImagePreprocessing.pageSpecs) {
            pageSpecs.push(await preparePageSpec(pageSpec, decodedBudget));
        }
        wasmImagePreprocessing = {
            ...wasmImagePreprocessing,
            pageSpecs,
        };
        for (const pageSpec of pageSpecs) {
            for (const input of [
                pageSpec.image,
                pageSpec.background,
                pageSpec.mask,
            ]) {
                if (input) {
                    totalInputBytes = addInputBytes(totalInputBytes, input);
                }
            }
        }
    }

    const hasPdfInput = inputs.some(input => getBrowserFileExtension(input.fileName) === '.pdf');
    if (hasPdfInput) {
        if (wasmImagePreprocessing !== undefined) {
            throw new Error('ERR_BROWSER_PDF_COMBINE_WORKER_MIXED_WASM_PREPROCESSING_UNSUPPORTED');
        }
        const documents: Uint8Array[] = [];
        let imageInputs: IBrowserPdfCombineInput[] = [];
        const flushImages = async () => {
            if (imageInputs.length === 0) {
                return;
            }
            const imageResult = await tryCombineImageInputsWithWasm(
                imageInputs,
                buildExifRotationPreprocessing(imageInputs),
            );
            if (imageResult.status === 'fatal') {
                throw new SerializableError(imageResult.error);
            }
            if (imageResult.status === 'unavailable') {
                throw new Error('ERR_BROWSER_PDF_COMBINE_WASM_UNAVAILABLE');
            }
            if (imageResult.status !== 'success') {
                throw new Error('ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT');
            }
            documents.push(imageResult.data);
            imageInputs = [];
        };
        for (const input of inputs) {
            if (getBrowserFileExtension(input.fileName) === '.pdf') {
                await flushImages();
                documents.push(input.data);
            } else {
                imageInputs.push(input);
            }
        }
        await flushImages();
        const merged = await tryRunBrowserPageOpsWithWasm('mergePages', {documents});
        if (merged === null) {
            throw new Error('ERR_BROWSER_PDF_COMBINE_WASM_UNAVAILABLE');
        }
        if (isBrowserPageOpsWasmFailure(merged)) {
            throw new SerializableError(merged.error);
        }
        if (merged.data.byteLength === 0 || merged.data.byteLength > MAX_OUTPUT_BYTES) {
            throw createBrowserPdfCombineOutputError(merged.data.byteLength);
        }
        return {data: toTransferableUint8Array(merged.data)};
    }

    let flatWasmPreprocessing = wasmImagePreprocessing;
    if (!flatWasmPreprocessing?.pageSpecs) {
        flatWasmPreprocessing = buildExifRotationPreprocessing(inputs);
    }
    const wasmResult = await tryCombineImageInputsWithWasm(inputs, flatWasmPreprocessing);
    if (wasmResult.status === 'success') {
        if (wasmResult.data.byteLength === 0 || wasmResult.data.byteLength > MAX_OUTPUT_BYTES) {
            throw createBrowserPdfCombineOutputError(wasmResult.data.byteLength);
        }
        return {data: toTransferableUint8Array(wasmResult.data)};
    }
    if (wasmResult.status === 'fatal') {
        throw new SerializableError(wasmResult.error);
    }
    if (wasmResult.status === 'unavailable') {
        throw new Error('ERR_BROWSER_PDF_COMBINE_WASM_UNAVAILABLE');
    }
    throw new Error('ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT');
}

self.addEventListener('message', async (event: MessageEvent<unknown>) => {
    const request = parseBrowserPdfCombineWorkerRequest(event.data);
    if (request === null) {
        const id = getBrowserPdfCombineWorkerRequestId(event.data);
        if (id !== null) {
            self.postMessage({
                id,
                ok: false,
                error: 'Invalid browser PDF combine worker request',
            } satisfies TBrowserPdfCombineWorkerResponse);
        }
        return;
    }

    try {
        const data = await handleCombinePdfsRequest(request);
        const response = {
            id: request.id,
            type: request.type,
            ok: true,
            data,
        } satisfies TBrowserPdfCombineWorkerResponse;
        self.postMessage(response, [data.data.buffer]);
    } catch (error) {
        const errorEnvelope = findSerializableErrorEnvelope(error, isNativeErrorEnvelope);
        const response = {
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
            ...(errorEnvelope === null ? {} : {errorEnvelope}),
        } satisfies TBrowserPdfCombineWorkerResponse;
        self.postMessage(response);
    }
});
