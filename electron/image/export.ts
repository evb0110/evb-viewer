import { existsSync } from 'fs';
import {
    copyFile,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rename,
    rm,
    unlink,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import { uniq } from 'es-toolkit/array';
import * as utifModule from 'utif';
import { getOcrToolPaths } from '@electron/ocr/paths';
import {
    detectSourceDpi,
    clampDpi,
} from '@electron/ocr/worker/dpi-detection';
import { runCommand } from '@electron/ocr/worker/run-command';
import { createLogger } from '@electron/utils/logger';

type TImageExportFormat = 'png' | 'jpeg' | 'tiff';

interface IRenderedPageFile {
    page: number;
    path: string;
}

interface IExportPdfOptions {pageNumbers?: number[];}

interface IPreparedSourcePdf {
    pdfPath: string;
    cleanup: () => Promise<void>;
}

interface IUtifFrame {
    width?: number;
    height?: number;
    [key: string]: unknown;
}

interface IUtifModule {
    decode(input: Uint8Array | ArrayBuffer): IUtifFrame[];
    decodeImage(input: Uint8Array | ArrayBuffer, frame: IUtifFrame): void;
    toRGBA8(frame: IUtifFrame): Uint8Array;
    encode(ifds: Record<string, unknown>[]): ArrayBuffer;
}

interface ITiffPageRgba {
    width: number;
    height: number;
    rgba: Uint8Array;
}

const UTIF = utifModule as IUtifModule;
const logger = createLogger('image-export');

function resolveFormatExtension(format: TImageExportFormat): string {
    if (format === 'jpeg') {
        return '.jpg';
    }
    if (format === 'tiff') {
        return '.tif';
    }
    return '.png';
}

function parseImageExportFormat(filePath: string): TImageExportFormat {
    const extension = extname(filePath).toLowerCase();

    if (extension === '.jpg' || extension === '.jpeg') {
        return 'jpeg';
    }
    if (extension === '.tif' || extension === '.tiff') {
        return 'tiff';
    }

    return 'png';
}

export function normalizeImageExportPath(filePath: string, fallbackFormat: TImageExportFormat = 'png'): {
    normalizedPath: string;
    format: TImageExportFormat;
} {
    const trimmedPath = filePath.trim();
    const extension = extname(trimmedPath).toLowerCase();

    if (extension === '.png' || extension === '.jpg' || extension === '.jpeg' || extension === '.tif' || extension === '.tiff') {
        const format = parseImageExportFormat(trimmedPath);
        return {
            normalizedPath: trimmedPath,
            format,
        };
    }

    const format = fallbackFormat;
    return {
        normalizedPath: `${trimmedPath}${resolveFormatExtension(format)}`,
        format,
    };
}

function toPdftoppmFormatArg(format: TImageExportFormat): string {
    if (format === 'jpeg') {
        return '-jpeg';
    }
    if (format === 'tiff') {
        return '-tiff';
    }
    return '-png';
}

function parsePageNumber(fileName: string): number {
    const match = fileName.match(/-(\d+)\.[^.]+$/);
    if (!match) {
        return Number.POSITIVE_INFINITY;
    }
    return Number.parseInt(match[1] ?? '', 10);
}

function isExpectedPageFile(fileName: string, format: TImageExportFormat): boolean {
    const extension = extname(fileName).toLowerCase();

    if (format === 'jpeg') {
        return extension === '.jpg' || extension === '.jpeg';
    }
    if (format === 'tiff') {
        return extension === '.tif' || extension === '.tiff';
    }

    return extension === '.png';
}

async function moveFile(sourcePath: string, targetPath: string) {
    try {
        await rename(sourcePath, targetPath);
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'EXDEV') {
            throw error;
        }

        await copyFile(sourcePath, targetPath);
        await unlink(sourcePath);
    }
}

async function renderPdfToTempPages(pdfPath: string, format: TImageExportFormat): Promise<IRenderedPageFile[]> {
    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-export-'));
    const prefix = join(tempDir, 'page');
    const paths = getOcrToolPaths();

    const detectedDpi = await detectSourceDpi(
        pdfPath,
        paths.pdfimages,
        (level, message) => logger[level === 'error' ? 'error' : 'debug'](message),
    );
    const renderDpi = clampDpi(detectedDpi ?? 300);

    try {
        await runCommand(paths.pdftoppm, [
            toPdftoppmFormatArg(format),
            '-r',
            String(renderDpi),
            pdfPath,
            prefix,
        ]);

        const fileNames = await readdir(tempDir);
        const pageFiles = fileNames
            .filter(fileName => fileName.startsWith('page-'))
            .filter(fileName => isExpectedPageFile(fileName, format))
            .sort((left, right) => parsePageNumber(left) - parsePageNumber(right))
            .map((fileName) => ({
                page: parsePageNumber(fileName),
                path: join(tempDir, fileName),
            }));

        if (pageFiles.length === 0) {
            throw new Error('No page images were generated from the PDF');
        }

        return pageFiles;
    } catch (error) {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
        throw error;
    }
}

function normalizePageNumbers(pageNumbers: number[] | undefined): number[] | null {
    if (!pageNumbers) {
        return null;
    }

    const unique = uniq(pageNumbers)
        .filter(page => Number.isInteger(page) && page > 0)
        .sort((left, right) => left - right);

    if (unique.length === 0) {
        throw new Error('At least one page number must be provided for scoped export');
    }

    return unique;
}

function formatPageList(pageNumbers: number[]): string {
    return pageNumbers.join(',');
}

async function prepareSourcePdfForExport(pdfPath: string, options: IExportPdfOptions): Promise<IPreparedSourcePdf> {
    const normalizedPages = normalizePageNumbers(options.pageNumbers);

    if (!normalizedPages) {
        return {
            pdfPath,
            cleanup: async () => {},
        };
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-export-scope-'));
    const subsetPdfPath = join(tempDir, 'subset.pdf');
    const qpdf = getOcrToolPaths().qpdf;

    try {
        await runCommand(qpdf, [
            pdfPath,
            '--pages',
            pdfPath,
            formatPageList(normalizedPages),
            '--',
            subsetPdfPath,
        ]);

        return {
            pdfPath: subsetPdfPath,
            cleanup: async () => {
                await rm(tempDir, {
                    recursive: true,
                    force: true,
                });
            },
        };
    } catch (error) {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
        throw error;
    }
}

export async function exportPdfPagesAsImages(
    pdfPath: string,
    outputTemplatePath: string,
    options: IExportPdfOptions = {},
): Promise<string[]> {
    const {
        normalizedPath,
        format,
    } = normalizeImageExportPath(outputTemplatePath);

    const outputDirectory = dirname(normalizedPath);
    const outputStem = basename(normalizedPath, extname(normalizedPath));
    const outputExtension = resolveFormatExtension(format);

    await mkdir(outputDirectory, { recursive: true });

    const preparedSourcePdf = await prepareSourcePdfForExport(pdfPath, options);

    try {
        const pageFiles = await renderPdfToTempPages(preparedSourcePdf.pdfPath, format);

        try {
            const exportedPaths: string[] = [];
            const isSinglePageExport = pageFiles.length === 1;

            for (let index = 0; index < pageFiles.length; index += 1) {
                const source = pageFiles[index]!;

                const targetPath = isSinglePageExport
                    ? normalizedPath
                    : join(
                        outputDirectory,
                        `${outputStem}-${String(index + 1).padStart(3, '0')}${outputExtension}`,
                    );

                await moveFile(source.path, targetPath);
                exportedPaths.push(targetPath);
            }

            return exportedPaths;
        } finally {
            const tempDir = dirname(pageFiles[0]!.path);
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    } finally {
        await preparedSourcePdf.cleanup();
    }
}

function decodeSinglePageTiff(tiffBytes: Uint8Array): ITiffPageRgba {
    const ifds = UTIF.decode(tiffBytes);

    for (const ifd of ifds) {
        UTIF.decodeImage(tiffBytes, ifd);

        const width = typeof ifd.width === 'number' ? ifd.width : 0;
        const height = typeof ifd.height === 'number' ? ifd.height : 0;
        if (width <= 0 || height <= 0) {
            continue;
        }

        const rgba = UTIF.toRGBA8(ifd);
        if (!rgba || rgba.length !== width * height * 4) {
            continue;
        }

        return {
            width,
            height,
            rgba,
        };
    }

    throw new Error('Failed to decode TIFF page data');
}

function alignOffset(offset: number, alignment: number): number {
    if (alignment <= 1) {
        return offset;
    }
    const remainder = offset % alignment;
    return remainder === 0 ? offset : offset + (alignment - remainder);
}

function buildTiffIfd(
    page: ITiffPageRgba,
    dataOffset: number,
): Record<string, unknown> {
    return {
        t256: [page.width],
        t257: [page.height],
        t258: [
            8,
            8,
            8,
            8,
        ],
        t259: [1],
        t262: [2],
        t273: [dataOffset],
        t277: [4],
        t278: [page.height],
        t279: [page.rgba.length],
        t282: [1],
        t283: [1],
        t284: [1],
        t286: [0],
        t287: [0],
        t296: [1],
        t305: ['EVB Viewer'],
        t338: [1],
    };
}

function resolvePageDataOffsets(
    pages: ITiffPageRgba[],
    firstDataOffset: number,
): number[] {
    const offsets: number[] = [];
    let cursor = firstDataOffset;

    for (const page of pages) {
        offsets.push(cursor);
        cursor += page.rgba.length;
    }

    return offsets;
}

async function combinePagesIntoMultiPageTiff(pagePaths: string[], outputPath: string) {
    if (pagePaths.length === 0) {
        throw new Error('No pages available for TIFF export');
    }

    const pages: ITiffPageRgba[] = [];

    for (const pagePath of pagePaths) {
        const tiffBytes = await readFile(pagePath);
        pages.push(decodeSinglePageTiff(tiffBytes));
    }

    // UTIF encodes IFDs only; pixel data must be appended at explicit offsets.
    let firstDataOffset = 0;
    let header = new Uint8Array();
    let pageOffsets: number[] = [];

    for (let attempt = 0; attempt < 4; attempt += 1) {
        pageOffsets = resolvePageDataOffsets(pages, firstDataOffset);
        const ifds = pages.map((page, index) => buildTiffIfd(page, pageOffsets[index]!));
        header = new Uint8Array(UTIF.encode(ifds));
        const nextFirstDataOffset = alignOffset(header.length, 8);
        if (nextFirstDataOffset === firstDataOffset) {
            break;
        }
        firstDataOffset = nextFirstDataOffset;
    }

    pageOffsets = resolvePageDataOffsets(pages, alignOffset(header.length, 8));
    const finalIfds = pages.map((page, index) => buildTiffIfd(page, pageOffsets[index]!));
    header = new Uint8Array(UTIF.encode(finalIfds));

    const finalFirstDataOffset = alignOffset(header.length, 8);
    pageOffsets = resolvePageDataOffsets(pages, finalFirstDataOffset);

    const lastPage = pages[pages.length - 1]!;
    const lastOffset = pageOffsets[pageOffsets.length - 1]!;
    const output = new Uint8Array(lastOffset + lastPage.rgba.length);
    output.set(header, 0);

    for (let index = 0; index < pages.length; index += 1) {
        output.set(pages[index]!.rgba, pageOffsets[index]!);
    }

    await writeFile(outputPath, output);
}

export async function exportPdfAsMultiPageTiff(
    pdfPath: string,
    outputPath: string,
    options: IExportPdfOptions = {},
): Promise<string> {
    const targetPath = outputPath.toLowerCase().endsWith('.tif') || outputPath.toLowerCase().endsWith('.tiff')
        ? outputPath
        : `${outputPath}.tiff`;

    const outputDirectory = dirname(targetPath);
    await mkdir(outputDirectory, { recursive: true });

    const preparedSourcePdf = await prepareSourcePdfForExport(pdfPath, options);

    try {
        const pageFiles = await renderPdfToTempPages(preparedSourcePdf.pdfPath, 'tiff');

        try {
            const orderedPagePaths = pageFiles
                .sort((left, right) => left.page - right.page)
                .map(pageFile => pageFile.path);

            await combinePagesIntoMultiPageTiff(orderedPagePaths, targetPath);

            if (!existsSync(targetPath)) {
                throw new Error('Multi-page TIFF export did not produce an output file');
            }

            return targetPath;
        } finally {
            const tempDir = dirname(pageFiles[0]!.path);
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    } finally {
        await preparedSourcePdf.cleanup();
    }
}
