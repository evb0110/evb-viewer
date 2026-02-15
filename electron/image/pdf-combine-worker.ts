import { readFile } from 'fs/promises';
import { extname } from 'path';
import {
    parentPort,
    workerData,
} from 'worker_threads';
import { encode } from 'fast-png';
import { PDFDocument } from 'pdf-lib';
import * as utifModule from 'utif';

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
    const embeddedImage = extension === '.jpg' || extension === '.jpeg'
        ? await targetPdf.embedJpg(imageBytes)
        : await targetPdf.embedPng(imageBytes);

    const page = targetPdf.addPage([
        embeddedImage.width,
        embeddedImage.height,
    ]);
    page.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width: embeddedImage.width,
        height: embeddedImage.height,
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

        const pngBytes = encode({
            width,
            height,
            data: rgba,
            channels: 4,
        });

        const embeddedImage = await targetPdf.embedPng(pngBytes);
        const page = targetPdf.addPage([
            embeddedImage.width,
            embeddedImage.height,
        ]);
        page.drawImage(embeddedImage, {
            x: 0,
            y: 0,
            width: embeddedImage.width,
            height: embeddedImage.height,
        });

        addedPages += 1;
    }

    if (addedPages === 0) {
        throw new Error(`No decodable TIFF pages found in ${sourcePath}`);
    }

    return addedPages;
}

async function createCombinedPdf(inputPaths: string[]): Promise<Uint8Array> {
    const normalizedPaths = inputPaths
        .map((path) => path.trim())
        .filter((path) => path.length > 0);

    if (normalizedPaths.length === 0) {
        throw new Error('No input files were provided');
    }

    const targetPdf = await PDFDocument.create();
    let pageCount = 0;

    for (const sourcePath of normalizedPaths) {
        const extension = extname(sourcePath).toLowerCase();

        if (extension === '.pdf') {
            pageCount += await appendPdfPages(targetPdf, sourcePath);
            continue;
        }

        if (extension === '.png' || extension === '.jpg' || extension === '.jpeg') {
            pageCount += await appendPngOrJpegPage(targetPdf, sourcePath, extension);
            continue;
        }

        if (extension === '.tif' || extension === '.tiff') {
            pageCount += await appendTiffPages(targetPdf, sourcePath);
            continue;
        }

        throw new Error(`Unsupported file type for worker combine: ${sourcePath}`);
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

    try {
        const inputPaths = resolveWorkerInputPaths();
        const output = await createCombinedPdf(inputPaths);
        parentPort.postMessage({
            ok: true,
            data: output,
        });
    } catch (error) {
        parentPort.postMessage({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

await runCombineWorker();
