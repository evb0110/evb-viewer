import { readFile } from 'fs/promises';
import { extname } from 'path';
import {
    parentPort,
    workerData,
} from 'worker_threads';
import { encode } from 'fast-png';
import { PDFDocument } from 'pdf-lib';
import * as utifModule from 'utif';
import {
    pixelsToPdfPoints,
    readImageDpi,
    readTiffFrameDpi,
} from '@electron/image/image-dpi';

interface IUtifFrame {
    width?: number;
    height?: number;
    [key: string]: unknown;
}

interface IUtifModule {
    decode(input: Uint8Array | ArrayBuffer): IUtifFrame[];
    decodeImage(input: Uint8Array | ArrayBuffer, frame: IUtifFrame): void;
    toRGBA8(frame: IUtifFrame): Uint8Array;
}

interface ICombineWorkerData {inputPaths?: unknown;}
interface ICombineWorkerProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface ICombineWorkerProgressPayload extends ICombineWorkerProgress {type: 'progress';}

interface ICombineWorkerResultPayload {
    type: 'result';
    ok: boolean;
    error?: string;
    data?: Uint8Array;
}

const UTIF = utifModule as IUtifModule;

async function appendPdfPages(
    targetPdf: PDFDocument,
    sourcePath: string,
): Promise<number> {
    const sourceBytes = await readFile(sourcePath);
    const sourcePdf = await PDFDocument.load(sourceBytes);
    const pageIndices = sourcePdf.getPageIndices();

    if (pageIndices.length === 0) {
        return 0;
    }

    const copiedPages = await targetPdf.copyPages(sourcePdf, pageIndices);
    for (const page of copiedPages) {
        targetPdf.addPage(page);
    }

    return copiedPages.length;
}

async function appendPngOrJpegPage(
    targetPdf: PDFDocument,
    sourcePath: string,
    extension: string,
): Promise<number> {
    const imageBytes = await readFile(sourcePath);
    const dpi = readImageDpi(imageBytes, extension);
    const embeddedImage = extension === '.jpg' || extension === '.jpeg'
        ? await targetPdf.embedJpg(imageBytes)
        : await targetPdf.embedPng(imageBytes);

    const pageWidth = pixelsToPdfPoints(embeddedImage.width, dpi);
    const pageHeight = pixelsToPdfPoints(embeddedImage.height, dpi);

    const page = targetPdf.addPage([
        pageWidth,
        pageHeight,
    ]);
    page.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width: pageWidth,
        height: pageHeight,
    });

    return 1;
}

async function appendTiffPages(
    targetPdf: PDFDocument,
    sourcePath: string,
): Promise<number> {
    const tiffBytes = await readFile(sourcePath);
    const ifds = UTIF.decode(tiffBytes);
    let addedPages = 0;

    for (const ifd of ifds) {
        UTIF.decodeImage(tiffBytes, ifd);

        const width = typeof ifd.width === 'number' ? ifd.width : 0;
        const height = typeof ifd.height === 'number' ? ifd.height : 0;
        if (width <= 0 || height <= 0) {
            continue;
        }

        const rgba = UTIF.toRGBA8(ifd);
        if (!rgba || rgba.length === 0) {
            continue;
        }

        const dpi = readTiffFrameDpi(ifd as Record<string, unknown>) ?? 72;

        const pngBytes = encode({
            width,
            height,
            data: rgba,
            channels: 4,
        });

        const embeddedImage = await targetPdf.embedPng(pngBytes);
        const pageWidth = pixelsToPdfPoints(embeddedImage.width, dpi);
        const pageHeight = pixelsToPdfPoints(embeddedImage.height, dpi);

        const page = targetPdf.addPage([
            pageWidth,
            pageHeight,
        ]);
        page.drawImage(embeddedImage, {
            x: 0,
            y: 0,
            width: pageWidth,
            height: pageHeight,
        });

        addedPages += 1;
    }

    if (addedPages === 0) {
        throw new Error(`No decodable TIFF pages found in ${sourcePath}`);
    }

    return addedPages;
}

function estimateRemainingMs(elapsedMs: number, processed: number, total: number) {
    if (processed <= 0 || total <= processed) {
        return 0;
    }
    const averagePerItem = elapsedMs / processed;
    const remainingItems = total - processed;
    return Math.max(0, Math.round(averagePerItem * remainingItems));
}

async function createCombinedPdf(
    inputPaths: string[],
    onProgress?: (progress: ICombineWorkerProgress) => void,
): Promise<Uint8Array> {
    const normalizedPaths = inputPaths
        .map((path) => path.trim())
        .filter((path) => path.length > 0);

    if (normalizedPaths.length === 0) {
        throw new Error('No input files were provided');
    }

    const targetPdf = await PDFDocument.create();
    let pageCount = 0;
    const startedAt = Date.now();

    for (let index = 0; index < normalizedPaths.length; index++) {
        const sourcePath = normalizedPaths[index]!;
        const extension = extname(sourcePath).toLowerCase();

        if (extension === '.pdf') {
            pageCount += await appendPdfPages(targetPdf, sourcePath);
        } else if (extension === '.png' || extension === '.jpg' || extension === '.jpeg') {
            pageCount += await appendPngOrJpegPage(targetPdf, sourcePath, extension);
        } else if (extension === '.tif' || extension === '.tiff') {
            pageCount += await appendTiffPages(targetPdf, sourcePath);
        } else {
            throw new Error(`Unsupported file type for worker combine: ${sourcePath}`);
        }

        if (onProgress) {
            const processed = index + 1;
            const total = normalizedPaths.length;
            const elapsedMs = Math.max(0, Date.now() - startedAt);
            onProgress({
                processed,
                total,
                percent: Math.round((processed / total) * 100),
                elapsedMs,
                estimatedRemainingMs: estimateRemainingMs(elapsedMs, processed, total),
            });
        }
    }

    if (pageCount === 0) {
        throw new Error('No pages were generated from the input files');
    }

    return targetPdf.save();
}

function resolveWorkerInputPaths(): string[] {
    const currentWorkerData = workerData as ICombineWorkerData | undefined;
    if (!Array.isArray(currentWorkerData?.inputPaths)) {
        return [];
    }
    return currentWorkerData.inputPaths
        .filter((path): path is string => typeof path === 'string');
}

async function runCombineWorker() {
    if (!parentPort) {
        throw new Error('Image combine worker started without a parentPort');
    }
    const port = parentPort;

    try {
        const inputPaths = resolveWorkerInputPaths();
        const output = await createCombinedPdf(inputPaths, (progress) => {
            const progressPayload: ICombineWorkerProgressPayload = {
                type: 'progress',
                ...progress,
            };
            port.postMessage(progressPayload);
        });
        const payload: ICombineWorkerResultPayload = {
            type: 'result',
            ok: true,
            data: output,
        };
        port.postMessage(payload);
    } catch (error) {
        const payload: ICombineWorkerResultPayload = {
            type: 'result',
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
        port.postMessage(payload);
    }
}

await runCombineWorker();
