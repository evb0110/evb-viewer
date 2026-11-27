import {getInputFileExtension, isImagePath, isDjvuPath} from '@electron/utils/documentFileTypes';
import {open, stat} from 'fs/promises';
import {readTiffFrameDimensions} from '@pdf-core/iterateDecodedTiffFrames';
export {isImagePath, PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS} from '@electron/utils/documentFileTypes';

interface IPdfCombineResourceLimits {
    maxInputBytes: number;
    maxTiffFrames: number;
    maxImagePixels: number;
}

const RESOURCE_LIMITS: IPdfCombineResourceLimits = {
    maxInputBytes: 512 * 1024 * 1024,
    maxTiffFrames: 250,
    maxImagePixels: 80_000_000,
};

function assertPixelLimit(width: number, height: number, sourcePath: string, limits: IPdfCombineResourceLimits) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
        throw new Error(`Image has invalid dimensions: ${sourcePath}`);
    }
    if (width > limits.maxImagePixels / height) {
        throw new Error(`Image dimensions are too large to combine safely: ${sourcePath}`);
    }
}

async function assertInputByteLimit(sourcePath: string, limits: IPdfCombineResourceLimits) {
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) {
        throw new Error(`Input path is not a regular file: ${sourcePath}`);
    }
    if (fileStat.size > limits.maxInputBytes) {
        throw new Error(`Input file is too large to combine safely: ${sourcePath}`);
    }
}

function throwIfAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new DOMException('PDF combine was canceled.', 'AbortError');
    }
}

async function preflightImageInput(sourcePath: string, limits: IPdfCombineResourceLimits, signal?: AbortSignal) {
    const extension = getInputFileExtension(sourcePath);
    await assertInputByteLimit(sourcePath, limits);
    throwIfAborted(signal);

    if (extension === '.tif' || extension === '.tiff') {
        // Only the page directories are read; the native combiner decodes the pixels once.
        const file = await open(sourcePath, 'r');
        let frames;
        try {
            frames = await readTiffFrameDimensions(
                async (offset, length) => {
                    throwIfAborted(signal);
                    const bytes = new Uint8Array(length);
                    const {bytesRead} = await file.read(bytes, 0, length, offset);
                    return bytes.subarray(0, bytesRead);
                },
                {
                    maxFrames: limits.maxTiffFrames,
                    maxPixels: limits.maxImagePixels,
                    sourceLabel: sourcePath,
                },
            );
        } finally {
            await file.close();
        }
        frames.forEach(({width, height}) => {
            assertPixelLimit(width, height, sourcePath, limits);
        });
        if (frames.length === 0) {
            throw new Error(`No decodable TIFF pages found in ${sourcePath}`);
        }
    }
}

async function preflightCombineInputs(inputPaths: string[], limits: IPdfCombineResourceLimits, signal?: AbortSignal) {
    for (const sourcePath of inputPaths) {
        throwIfAborted(signal);
        const extension = getInputFileExtension(sourcePath);
        if (extension === '.pdf' || isDjvuPath(sourcePath)) {
            await assertInputByteLimit(sourcePath, limits);
            continue;
        }
        if (!isImagePath(sourcePath)) {
            throw new Error(`Unsupported file type: ${sourcePath}`);
        }
        await preflightImageInput(sourcePath, limits, signal);
    }
}

export async function stageNativeCombineInputs(inputPaths: string[], signal?: AbortSignal) {
    await preflightCombineInputs(inputPaths, RESOURCE_LIMITS, signal);
    return {
        inputPaths,
        cleanup: () => Promise.resolve(),
    };
}
