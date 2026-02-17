import {nativeImage} from 'electron';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { encode } from 'fast-png';
import { PDFDocument } from 'pdf-lib';
import * as utifModule from 'utif';
import { createLogger } from '@electron/utils/logger';
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

interface ICombineWorkerPayload {
    type?: string;
    ok?: boolean;
    error?: string;
    data?: unknown;
    processed?: number;
    total?: number;
    percent?: number;
    elapsedMs?: number;
    estimatedRemainingMs?: number | null;
}

export interface ICreatePdfFromInputPathsProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface ICreatePdfFromInputPathsOptions {onProgress?: (progress: ICreatePdfFromInputPathsProgress) => void;}

const UTIF = utifModule as IUtifModule;
const logger = createLogger('pdf-conversion');
const __dirname = dirname(fileURLToPath(import.meta.url));
const COMBINE_WORKER_FILENAME = 'pdf-combine-worker.js';
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

const SUPPORTED_IMAGE_EXTENSION_SET = new Set<string>(
    SUPPORTED_IMAGE_EXTENSIONS,
);

function isImagePath(filePath: string): boolean {
    return SUPPORTED_IMAGE_EXTENSION_SET.has(extname(filePath).toLowerCase());
}

export function isPdfPath(filePath: string): boolean {
    return extname(filePath).toLowerCase() === '.pdf';
}

export function isDjvuPath(filePath: string): boolean {
    const extension = extname(filePath).toLowerCase();
    return extension === '.djvu' || extension === '.djv';
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
    const outputName =
        inputPaths.length === 1 ? `${stem}.pdf` : `${stem}-combined.pdf`;

    return join(dir, outputName);
}

function estimateRemainingMs(elapsedMs: number, processed: number, total: number) {
    if (processed <= 0 || total <= processed) {
        return 0;
    }
    const averagePerItem = elapsedMs / processed;
    const remainingItems = total - processed;
    return Math.max(0, Math.round(averagePerItem * remainingItems));
}

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

async function appendBitmapPage(
    targetPdf: PDFDocument,
    sourcePath: string,
): Promise<number> {
    const originalBytes = await readFile(sourcePath);
    const extension = extname(sourcePath).toLowerCase();
    const dpi = readImageDpi(originalBytes, extension);

    let embeddedImage;
    if (extension === '.png') {
        embeddedImage = await targetPdf.embedPng(originalBytes);
    } else if (extension === '.jpg' || extension === '.jpeg') {
        embeddedImage = await targetPdf.embedJpg(originalBytes);
    } else {
        const image = nativeImage.createFromPath(sourcePath);
        if (image.isEmpty()) {
            throw new Error(`Unsupported or unreadable image: ${sourcePath}`);
        }
        embeddedImage = await targetPdf.embedPng(image.toPNG());
    }

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

async function appendImagePages(
    targetPdf: PDFDocument,
    sourcePath: string,
): Promise<number> {
    const extension = extname(sourcePath).toLowerCase();

    if (extension === '.tif' || extension === '.tiff') {
        return appendTiffPages(targetPdf, sourcePath);
    }

    return appendBitmapPage(targetPdf, sourcePath);
}

async function createPdfFromInputPathsLocal(
    inputPaths: string[],
    options?: ICreatePdfFromInputPathsOptions,
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
        if (isPdfPath(sourcePath)) {
            pageCount += await appendPdfPages(targetPdf, sourcePath);
        } else if (isImagePath(sourcePath)) {
            pageCount += await appendImagePages(targetPdf, sourcePath);
        } else {
            throw new Error(`Unsupported file type: ${sourcePath}`);
        }

        if (options?.onProgress) {
            const processed = index + 1;
            const total = normalizedPaths.length;
            const elapsedMs = Math.max(0, Date.now() - startedAt);
            options.onProgress({
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

function canCombineInWorker(inputPaths: string[]): boolean {
    return inputPaths.every((sourcePath) => {
        const extension = extname(sourcePath).toLowerCase();
        return (
            extension === '.pdf' || WORKER_SUPPORTED_IMAGE_EXTENSIONS.has(extension)
        );
    });
}

function getCombineWorkerPath(): string {
    const defaultPath = join(__dirname, COMBINE_WORKER_FILENAME);
    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedPath !== defaultPath && existsSync(unpackedPath)) {
        return unpackedPath;
    }

    return defaultPath;
}

function decodeWorkerPdfBytes(data: unknown): Uint8Array | null {
    if (data instanceof Uint8Array) {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
}

function createPdfFromInputPathsWorker(
    inputPaths: string[],
    options?: ICreatePdfFromInputPathsOptions,
): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(getCombineWorkerPath(), {workerData: { inputPaths }});

        let settled = false;

        worker.on('message', (message: unknown) => {
            const payload = message as ICombineWorkerPayload;

            if (payload.type === 'progress') {
                if (
                    options?.onProgress
                    && Number.isFinite(payload.processed)
                    && Number.isFinite(payload.total)
                    && Number.isFinite(payload.percent)
                    && Number.isFinite(payload.elapsedMs)
                ) {
                    options.onProgress({
                        processed: Number(payload.processed),
                        total: Number(payload.total),
                        percent: Number(payload.percent),
                        elapsedMs: Number(payload.elapsedMs),
                        estimatedRemainingMs:
                            typeof payload.estimatedRemainingMs === 'number'
                                ? payload.estimatedRemainingMs
                                : null,
                    });
                }
                return;
            }

            if (settled) {
                return;
            }
            settled = true;

            if (payload.type === 'result' && !payload.ok) {
                reject(new Error(payload.error || 'Image combine worker failed'));
                return;
            }
            if (payload.type === 'result' && payload.ok !== true) {
                reject(new Error(payload.error || 'Image combine worker failed'));
                return;
            }
            if (payload.type !== 'result' && payload.ok !== true) {
                reject(new Error(payload.error || 'Image combine worker failed'));
                return;
            }

            const data = decodeWorkerPdfBytes(payload.data);
            if (!data) {
                reject(new Error('Image combine worker returned invalid PDF data'));
                return;
            }

            worker.removeAllListeners('message');
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

export async function createPdfFromInputPaths(
    inputPaths: string[],
    options?: ICreatePdfFromInputPathsOptions,
): Promise<Uint8Array> {
    const normalizedPaths = inputPaths
        .map((path) => path.trim())
        .filter((path) => path.length > 0);

    if (normalizedPaths.length === 0) {
        throw new Error('No input files were provided');
    }

    if (!canCombineInWorker(normalizedPaths)) {
        return createPdfFromInputPathsLocal(normalizedPaths, options);
    }

    try {
        return await createPdfFromInputPathsWorker(normalizedPaths, options);
    } catch (workerError) {
        logger.warn(
            `Image combine worker failed, falling back to in-process conversion: ${workerError instanceof Error ? workerError.message : String(workerError)}`,
        );
        return createPdfFromInputPathsLocal(normalizedPaths, options);
    }
}
