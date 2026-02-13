import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import {
    copyFile,
    mkdir,
    mkdtemp,
    readdir,
    rename,
    rm,
    unlink,
} from 'fs/promises';
import { tmpdir } from 'os';
import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import { getOcrToolPaths } from '@electron/ocr/paths';
import { runCommand } from '@electron/ocr/worker/run-command';

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
    const pdftoppm = getOcrToolPaths().pdftoppm;

    try {
        await runCommand(pdftoppm, [
            toPdftoppmFormatArg(format),
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

    const unique = Array.from(new Set(pageNumbers))
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

function findExecutable(command: string): string | null {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(lookupCommand, [command], {
        encoding: 'utf-8',
        stdio: [
            'ignore',
            'pipe',
            'ignore',
        ],
    });

    if (result.status !== 0) {
        return null;
    }

    const firstLine = (result.stdout ?? '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => line.length > 0);

    return firstLine ?? null;
}

async function combinePagesIntoMultiPageTiff(pagePaths: string[], outputPath: string) {
    const tiffcp = findExecutable('tiffcp');
    if (tiffcp) {
        await runCommand(tiffcp, [
            ...pagePaths,
            outputPath,
        ]);
        return;
    }

    if (process.platform === 'darwin') {
        await runCommand('/usr/bin/tiffutil', [
            '-cat',
            ...pagePaths,
            '-out',
            outputPath,
        ]);
        return;
    }

    const magick = findExecutable('magick');
    if (magick) {
        await runCommand(magick, [
            ...pagePaths,
            outputPath,
        ]);
        return;
    }

    throw new Error('No available utility to create multi-page TIFF (tiffcp, tiffutil, or magick)');
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
