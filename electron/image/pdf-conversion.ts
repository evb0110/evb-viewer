import { nativeImage } from 'electron';
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import { Worker } from 'worker_threads';
import { encode } from 'fast-png';
import { PDFDocument } from 'pdf-lib';

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

const require = createRequire(import.meta.url);
const UTIF = require('utif') as IUtifModule;
const WORKER_SUPPORTED_IMAGE_EXTENSIONS = new Set<string>([
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
]);

export const SUPPORTED_IMAGE_EXTENSIONS = [
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
    '.bmp',
    '.webp',
    '.gif',
] as const;

const SUPPORTED_IMAGE_EXTENSION_SET = new Set<string>(SUPPORTED_IMAGE_EXTENSIONS);

function isImagePath(filePath: string): boolean {
    return SUPPORTED_IMAGE_EXTENSION_SET.has(extname(filePath).toLowerCase());
}

export function isPdfPath(filePath: string): boolean {
    return extname(filePath).toLowerCase() === '.pdf';
}

export function isDjvuPath(filePath: string): boolean {
    return extname(filePath).toLowerCase() === '.djvu';
}

export function isPdfOrImagePath(filePath: string): boolean {
    return isPdfPath(filePath) || isImagePath(filePath);
}

export function isSupportedOpenPath(filePath: string): boolean {
    return isPdfOrImagePath(filePath) || isDjvuPath(filePath);
}

export function buildCombinedPdfOutputPath(inputPaths: string[]): string {
    if (inputPaths.length === 0) {
        return 'combined.pdf';
    }

    const firstPath = inputPaths[0]!;
    const dir = dirname(firstPath);
    const stem = basename(firstPath, extname(firstPath));
    const outputName = inputPaths.length === 1
        ? `${stem}.pdf`
        : `${stem}-combined.pdf`;

    return join(dir, outputName);
}

async function appendPdfPages(targetPdf: PDFDocument, sourcePath: string): Promise<number> {
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

async function appendBitmapPage(targetPdf: PDFDocument, sourcePath: string): Promise<number> {
    const image = nativeImage.createFromPath(sourcePath);
    if (image.isEmpty()) {
        throw new Error(`Unsupported or unreadable image: ${sourcePath}`);
    }

    const imageBytes = image.toPNG();
    const embeddedImage = await targetPdf.embedPng(imageBytes);
    const width = embeddedImage.width;
    const height = embeddedImage.height;

    const page = targetPdf.addPage([
        width,
        height,
    ]);

    page.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width,
        height,
    });

    return 1;
}

async function appendTiffPages(targetPdf: PDFDocument, sourcePath: string): Promise<number> {
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

async function appendImagePages(targetPdf: PDFDocument, sourcePath: string): Promise<number> {
    const extension = extname(sourcePath).toLowerCase();

    if (extension === '.tif' || extension === '.tiff') {
        return appendTiffPages(targetPdf, sourcePath);
    }

    return appendBitmapPage(targetPdf, sourcePath);
}

async function createPdfFromInputPathsLocal(inputPaths: string[]): Promise<Uint8Array> {
    const normalizedPaths = inputPaths
        .map(path => path.trim())
        .filter(path => path.length > 0);

    if (normalizedPaths.length === 0) {
        throw new Error('No input files were provided');
    }

    const targetPdf = await PDFDocument.create();
    let pageCount = 0;

    for (const sourcePath of normalizedPaths) {
        if (isPdfPath(sourcePath)) {
            pageCount += await appendPdfPages(targetPdf, sourcePath);
            continue;
        }

        if (isImagePath(sourcePath)) {
            pageCount += await appendImagePages(targetPdf, sourcePath);
            continue;
        }

        throw new Error(`Unsupported file type: ${sourcePath}`);
    }

    if (pageCount === 0) {
        throw new Error('No pages were generated from the input files');
    }

    return targetPdf.save();
}

function canCombineInWorker(inputPaths: string[]): boolean {
    return inputPaths.every((sourcePath) => {
        const extension = extname(sourcePath).toLowerCase();
        return extension === '.pdf' || WORKER_SUPPORTED_IMAGE_EXTENSIONS.has(extension);
    });
}

const COMBINE_WORKER_SCRIPT = `
import { parentPort, workerData } from 'worker_threads';
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import { extname } from 'path';
import { PDFDocument } from 'pdf-lib';
import { encode } from 'fast-png';

const require = createRequire(import.meta.url);
const UTIF = require('utif');

async function appendPdfPages(targetPdf, sourcePath) {
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

async function appendPngOrJpegPage(targetPdf, sourcePath, extension) {
    const imageBytes = await readFile(sourcePath);
    const embeddedImage = extension === '.jpg' || extension === '.jpeg'
        ? await targetPdf.embedJpg(imageBytes)
        : await targetPdf.embedPng(imageBytes);

    const page = targetPdf.addPage([embeddedImage.width, embeddedImage.height]);
    page.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width: embeddedImage.width,
        height: embeddedImage.height,
    });

    return 1;
}

async function appendTiffPages(targetPdf, sourcePath) {
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
        const page = targetPdf.addPage([embeddedImage.width, embeddedImage.height]);
        page.drawImage(embeddedImage, {
            x: 0,
            y: 0,
            width: embeddedImage.width,
            height: embeddedImage.height,
        });
        addedPages += 1;
    }

    if (addedPages === 0) {
        throw new Error('No decodable TIFF pages found in ' + sourcePath);
    }

    return addedPages;
}

async function createCombinedPdf(inputPaths) {
    const normalizedPaths = inputPaths
        .map(path => String(path).trim())
        .filter(path => path.length > 0);

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

        throw new Error('Unsupported file type for worker combine: ' + sourcePath);
    }

    if (pageCount === 0) {
        throw new Error('No pages were generated from the input files');
    }

    return targetPdf.save();
}

try {
    const inputPaths = Array.isArray(workerData?.inputPaths) ? workerData.inputPaths : [];
    const output = await createCombinedPdf(inputPaths);
    parentPort?.postMessage({ ok: true, data: output }, [output.buffer]);
} catch (error) {
    parentPort?.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
    });
}
`;

function createPdfFromInputPathsWorker(inputPaths: string[]): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(COMBINE_WORKER_SCRIPT, {
            eval: true,
            workerData: { inputPaths },
        });

        let settled = false;

        worker.once('message', (message: unknown) => {
            settled = true;
            const payload = message as {
                ok?: boolean;
                error?: string;
                data?: Uint8Array;
            };

            if (!payload.ok) {
                reject(new Error(payload.error || 'Image combine worker failed'));
                return;
            }

            const data = payload.data;
            if (!data || !(data instanceof Uint8Array)) {
                reject(new Error('Image combine worker returned invalid PDF data'));
                return;
            }

            resolve(data);
        });

        worker.once('error', (error) => {
            if (!settled) {
                reject(error);
            }
        });

        worker.once('exit', (code) => {
            if (!settled && code !== 0) {
                reject(new Error(`Image combine worker exited with code ${code}`));
            }
        });
    });
}

export async function createPdfFromInputPaths(inputPaths: string[]): Promise<Uint8Array> {
    const normalizedPaths = inputPaths
        .map(path => path.trim())
        .filter(path => path.length > 0);

    if (normalizedPaths.length === 0) {
        throw new Error('No input files were provided');
    }

    if (!canCombineInWorker(normalizedPaths)) {
        return createPdfFromInputPathsLocal(normalizedPaths);
    }

    return createPdfFromInputPathsWorker(normalizedPaths);
}
