import {existsSync} from 'fs';
import {
    copyFile,
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    stat,
    rename,
    rm,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    basename,
    dirname as dirnameFromPath,
    dirname,
    extname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import type { ResourceLimits } from 'worker_threads';
import {
    sortBy,
    uniq,
} from 'es-toolkit/array';
import {
    clamp,
    range,
} from 'es-toolkit/math';
import { encode as encodePng } from 'fast-png';
import { isErrnoException } from '@contracts/runtimeGuards';
import type { TImageExportProgressPhase } from '@contracts/electronApiDocuments';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import {
    buildPopplerEnv,
    type IPopplerRuntimePaths,
} from '@electron/native-tools/buildPopplerEnv';
import { detectSourceDpiDetails } from '@electron/pdf/sourceDpiDetection';
import { forEachConcurrent } from '@electron/utils/concurrency';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { createLogger } from '@electron/utils/createLogger';
import { measureElectronPerfAsync } from '@electron/utils/measureElectronPerfAsync';
import {
    combinePagesIntoMultiPageTiffLocal,
    readTiffPageDescriptors,
    splitTiffPageDescriptorsForClassicLimit,
} from '@electron/features/image-export/main/combinePagesIntoMultiPageTiffLocal';
import {
    resolveUnpackedWorkerPath,
    runResultWorkerTask,
} from '@electron/utils/workerTask';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import {
    isNativePdfImageCombineDisabled,
    resolveNativePdfImageCombinePath,
} from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import { getErrorMessage } from '@electron/utils/error';
import {
    type TManagedScratchPrefix,
    usingManagedScratchScope,
} from '@electron/utils/managedScratchTemp';
import {
    addStagedImageFileBytes,
    assertImageExportOutputPathBudget,
    type IExportPageSize,
    IMAGE_EXPORT_MAX_NETPBM_READ_BYTES,
    resolveExportRenderDpi,
    validateRenderedImagePageFiles,
} from '@electron/features/image-export/main/imageExportResourceLimits';
import {
    buildOutputPathWithSuffix,
    buildMultiPageTiffOutputPaths,
    resolveOutputPathConflicts,
} from '@electron/features/image-export/main/imageExportPathPlanning';
import {addPngPhysicalResolution} from '@electron/features/image-export/main/addPngPhysicalResolution';
import {canUseLocalTiffCombineFallback} from '@electron/features/image-export/main/canUseLocalTiffCombineFallback';
import {TiffCombineWorkerStartupError} from '@electron/features/image-export/main/tiffCombineWorkerStartupError';
import {
    createPdfInfoPageSizeStreamScanner,
    parsePdfInfoPageSizeLine,
} from '@electron/features/image-export/main/parsePdfInfoPageSizes';
export type TImageExportFormat = 'png' | 'jpeg' | 'tiff';
type TPageRenderFormat = TImageExportFormat | 'ppm';
interface IRenderedPageFile {
    page: number;
    path: string;
}
interface IExportPdfOptions {
    cancelGroup?: string;
    pageNumbers?: number[];
    signal?: AbortSignal;
    beforePublish?: () => Promise<void> | void;
    onProgress?: (progress: IImageExportProgressUpdate) => void;
    scratch?: {using<T>(prefix: TManagedScratchPrefix, run: (scratchPath: string) => Promise<T>): Promise<T>;};
}
interface IImageExportProgressUpdate {
    phase: TImageExportProgressPhase;
    processed: number;
    total: number;
    percent?: number;
}
interface IExportPageRange {
    firstPage: number;
    lastPage: number;
}
const logger = createLogger('image-export');
function logImageExportMessage(level: 'debug' | 'error' | 'info' | 'warn', message: string) {
    if (level === 'error') {
        logger.error(message, {
            code: 'MAIN_IMAGE_EXPORT_FAILED',
            context: {},
        });
        return;
    }
    logger[level](message);
}
const __dirname = dirnameFromPath(fileURLToPath(import.meta.url));
const PDFINFO_PAGE_SIZE_TIMEOUT_MS = 30 * 1000;
const PDFTOPPM_TIMEOUT_MS = 3 * 60 * 1000;
const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_RENDER_DPI = 300;
const PDF_EXPORT_DPI_PROBE_SAMPLE_PAGES = 8;
const PDF_EXPORT_PPM_CONVERT_CONCURRENCY = parseIntegerEnv('EVB_PDF_IMAGE_EXPORT_CONVERT_CONCURRENCY', 4, 1, 16);
const PDF_EXPORT_RENDER_CHUNK_PAGES = parseIntegerEnv('EVB_PDF_IMAGE_EXPORT_RENDER_CHUNK_PAGES', 25, 1, 100);
const PDF_EXPORT_PNG_RENDER_CHUNK_PAGES = parseIntegerEnv('EVB_PDF_IMAGE_EXPORT_PNG_RENDER_CHUNK_PAGES', 5, 1, 25);
const TIFF_COMBINE_WORKER_TIMEOUT_MS = 10 * 60 * 1000;
const TIFF_COMBINE_WORKER_FILENAME = WORKER_BUNDLES_BY_ID['image-export-tiff'].fileName;
const TIFF_COMBINE_WORKER_RESOURCE_LIMITS: ResourceLimits = {
    maxOldGenerationSizeMb: parseIntegerEnv('EVB_TIFF_COMBINE_WORKER_MAX_OLD_MB', 384, 128, 2048),
    maxYoungGenerationSizeMb: parseIntegerEnv('EVB_TIFF_COMBINE_WORKER_MAX_YOUNG_MB', 64, 16, 256),
    stackSizeMb: parseIntegerEnv('EVB_TIFF_COMBINE_WORKER_STACK_MB', 8, 2, 64),
};
const TIFF_COMBINE_LOCAL_FALLBACK_MAX_PAGES = (() => {
    const parsed = Number.parseInt(process.env.EVB_TIFF_COMBINE_FALLBACK_MAX_PAGES ?? '2', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 2;
    }
    return Math.min(parsed, 16);
})();
const TIFF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_TIFF_COMBINE_FALLBACK_MAX_TOTAL_MB ?? '16', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 16 * 1024 * 1024;
    }
    return Math.min(parsed, 128) * 1024 * 1024;
})();
function resolveFormatExtension(format: TImageExportFormat) {
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
    const extension = extname(filePath).toLowerCase();

    if (extension === '.png' || extension === '.jpg' || extension === '.jpeg' || extension === '.tif' || extension === '.tiff') {
        const format = parseImageExportFormat(filePath);
        return {
            normalizedPath: buildOutputPathWithSuffix(filePath, ''),
            format,
        };
    }

    const format = fallbackFormat;
    const pathWithExtension = `${filePath}${resolveFormatExtension(format)}`;
    return {
        normalizedPath: buildOutputPathWithSuffix(pathWithExtension, ''),
        format,
    };
}

function toPdftoppmFormatArgs(format: TPageRenderFormat) {
    if (format === 'jpeg') {
        return ['-jpeg'];
    }
    if (format === 'tiff') {
        return ['-tiff'];
    }
    if (format === 'png') {
        return ['-png'];
    }
    return [];
}

function parsePageNumber(fileName: string) {
    const match = fileName.match(/-(\d+)\.[^.]+$/);
    if (!match) {
        return Number.POSITIVE_INFINITY;
    }
    return Number.parseInt(match[1] ?? '', 10);
}

function isExpectedPageFile(fileName: string, format: TPageRenderFormat) {
    const extension = extname(fileName).toLowerCase();

    if (format === 'jpeg') {
        return extension === '.jpg' || extension === '.jpeg';
    }
    if (format === 'tiff') {
        return extension === '.tif' || extension === '.tiff';
    }
    if (format === 'ppm') {
        return extension === '.ppm';
    }

    return extension === '.png';
}

function readPnmToken(bytes: Uint8Array, cursor: { offset: number }) {
    while (cursor.offset < bytes.length) {
        const byte = bytes[cursor.offset];
        if (byte === 0x23) {
            while (cursor.offset < bytes.length && bytes[cursor.offset] !== 0x0A) {
                cursor.offset += 1;
            }
            continue;
        }
        if (byte !== undefined && byte <= 0x20) {
            cursor.offset += 1;
            continue;
        }
        break;
    }

    const start = cursor.offset;
    while (cursor.offset < bytes.length) {
        const byte = bytes[cursor.offset];
        if (byte === undefined || byte <= 0x20) {
            break;
        }
        cursor.offset += 1;
    }

    if (start === cursor.offset) {
        throw new Error('Invalid PPM image header');
    }

    return Buffer.from(bytes.buffer, bytes.byteOffset + start, cursor.offset - start).toString('ascii');
}

function parsePositivePnmInteger(value: string, label: string) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Invalid PPM ${label}`);
    }
    return parsed;
}

function parseRawPpm(bytes: Uint8Array) {
    const cursor = { offset: 0 };
    const magic = readPnmToken(bytes, cursor);
    if (magic !== 'P6') {
        throw new Error(`Unsupported PPM image type: ${magic}`);
    }

    const width = parsePositivePnmInteger(readPnmToken(bytes, cursor), 'width');
    const height = parsePositivePnmInteger(readPnmToken(bytes, cursor), 'height');
    const maxValue = parsePositivePnmInteger(readPnmToken(bytes, cursor), 'max value');
    if (maxValue !== 255) {
        throw new Error(`Unsupported PPM max value: ${maxValue}`);
    }

    if (cursor.offset < bytes.length) {
        const separator = bytes[cursor.offset];
        if (separator !== undefined && separator <= 0x20) {
            cursor.offset += 1;
        }
    }

    const expectedByteLength = width * height * 3;
    const data = bytes.subarray(cursor.offset);
    if (data.length !== expectedByteLength) {
        throw new Error(`Invalid PPM pixel data length: expected ${expectedByteLength}, found ${data.length}`);
    }

    return {
        width,
        height,
        data,
    };
}

function createLosslessGrayscaleData(data: Uint8Array) {
    const grayscaleData = new Uint8Array(data.length / 3);
    for (let sourceIndex = 0, targetIndex = 0; sourceIndex < data.length; sourceIndex += 3, targetIndex += 1) {
        const red = data[sourceIndex];
        const green = data[sourceIndex + 1];
        const blue = data[sourceIndex + 2];
        if (red === undefined || green === undefined || blue === undefined || red !== green || red !== blue) {
            return null;
        }
        grayscaleData[targetIndex] = red;
    }
    return grayscaleData;
}

async function tryConvertRenderedPpmToPngNative(
    sourcePath: string,
    pngPath: string,
    signal?: AbortSignal,
    cancelGroup?: string,
    dpi = DEFAULT_RENDER_DPI,
) {
    if (isNativePdfImageCombineDisabled()) {
        return false;
    }

    const binaryPath = resolveNativePdfImageCombinePath();
    if (!binaryPath) {
        return false;
    }

    try {
        await runNativeToolCommand(binaryPath, [
            '--format',
            'png',
            '--dpi',
            String(dpi),
            '--output',
            pngPath,
            '--',
            sourcePath,
        ], {
            timeoutMs: PDFTOPPM_TIMEOUT_MS,
            commandLabel: 'evb-pdf-image-combine(ppm-to-png)',
            ...(signal ? { signal } : {}),
            ...(cancelGroup ? { cancelGroup } : {}),
        });
        await unlink(sourcePath).catch(() => undefined);
        return true;
    } catch (error) {
        logger.debug(`Native PPM-to-PNG conversion failed, falling back to JS encoder: ${getErrorMessage(error)}`);
        await rm(pngPath, {force: true}).catch(() => undefined);
        return false;
    }
}

export async function convertRenderedPpmToPng(
    sourcePath: string,
    signal?: AbortSignal,
    cancelGroup?: string,
    dpi = DEFAULT_RENDER_DPI,
) {
    const pngPath = sourcePath.replace(/\.ppm$/i, '.png');
    if (await tryConvertRenderedPpmToPngNative(sourcePath, pngPath, signal, cancelGroup, dpi)) {
        return pngPath;
    }

    throwIfAborted(signal);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) {
        throw new Error(`Rendered PPM output is not a regular file: ${sourcePath}`);
    }
    if (sourceStat.size > IMAGE_EXPORT_MAX_NETPBM_READ_BYTES) {
        const maxMb = Math.floor(IMAGE_EXPORT_MAX_NETPBM_READ_BYTES / (1024 * 1024));
        throw new Error(`Rendered PPM output exceeds safe read limit (${maxMb}MB): ${sourcePath}`);
    }
    const sourceBytes = await readFile(sourcePath);
    throwIfAborted(signal);
    const image = parseRawPpm(sourceBytes);
    const grayscaleData = createLosslessGrayscaleData(image.data);
    const pngBytes = encodePng({
        width: image.width,
        height: image.height,
        channels: grayscaleData ? 1 : 3,
        depth: 8,
        data: grayscaleData ?? image.data,
    });
    await writeFile(pngPath, addPngPhysicalResolution(pngBytes, dpi));
    await unlink(sourcePath).catch(() => undefined);
    return pngPath;
}

export async function convertRenderedPpmToImage(
    sourcePath: string,
    format: TImageExportFormat,
    signal?: AbortSignal,
    cancelGroup?: string,
    dpi = DEFAULT_RENDER_DPI,
) {
    if (format === 'png') {
        return convertRenderedPpmToPng(sourcePath, signal, cancelGroup, dpi);
    }
    const outputPath = sourcePath.replace(/\.ppm$/i, format === 'jpeg' ? '.jpg' : '.tif');
    if (isNativePdfImageCombineDisabled()) {
        throw new Error(`Native ${format.toUpperCase()} output service is unavailable for DjVu export`);
    }
    const binaryPath = resolveNativePdfImageCombinePath();
    if (!binaryPath) {
        throw new Error(`Native ${format.toUpperCase()} output service is unavailable for DjVu export`);
    }
    await runNativeToolCommand(binaryPath, [
        '--format',
        format === 'tiff' ? 'tiff-single' : format,
        '--dpi',
        String(Math.max(1, Math.round(dpi))),
        '--output',
        outputPath,
        '--',
        sourcePath,
    ], {
        timeoutMs: PDFTOPPM_TIMEOUT_MS,
        commandLabel: `evb-pdf-image-combine(ppm-to-${format})`,
        ...(signal ? {signal} : {}),
        ...(cancelGroup ? {cancelGroup} : {}),
    });
    await unlink(sourcePath).catch(() => undefined);
    return outputPath;
}

async function moveFile(sourcePath: string, targetPath: string) {
    try {
        await rename(sourcePath, targetPath);
    } catch (error) {
        if (!isErrnoException(error) || error.code !== 'EXDEV') {
            throw error;
        }

        const tempPath = makeSiblingTempPath(targetPath);
        let replaced = false;
        try {
            await copyFile(sourcePath, tempPath);
            await atomicReplace(tempPath, targetPath);
            replaced = true;
            await unlink(sourcePath);
        } finally {
            if (!replaced) {
                await rm(tempPath, { force: true }).catch(() => undefined);
            }
        }
    }
}

export interface IStagedFilePublication {
    targetPath: string;
    backupPath: string | null;
    targetIdentity: {
        dev: number;
        ino: number;
        size: number;
        mtimeMs: number;
    } | null;
}

export interface IStagedFilePublicationLedger {
    promotedFiles: IStagedFilePublication[];
    backupPaths: string[];
}

export function createStagedFilePublicationLedger(): IStagedFilePublicationLedger {
    return {
        promotedFiles: [],
        backupPaths: [],
    };
}

export async function rollbackStagedFilePublications(ledger: IStagedFilePublicationLedger) {
    const rollbackFailures: Error[] = [];
    const restoredBackups = new Set<string>();
    for (const promotedFile of [...ledger.promotedFiles].reverse()) {
        const currentTargetIdentity = await stat(promotedFile.targetPath).then(target => ({
            dev: target.dev,
            ino: target.ino,
            size: target.size,
            mtimeMs: target.mtimeMs,
        })).catch(() => null);
        const targetStillOwned = promotedFile.targetIdentity !== null
            && currentTargetIdentity !== null
            && promotedFile.targetIdentity.dev === currentTargetIdentity.dev
            && promotedFile.targetIdentity.ino === currentTargetIdentity.ino
            && promotedFile.targetIdentity.size === currentTargetIdentity.size
            && promotedFile.targetIdentity.mtimeMs === currentTargetIdentity.mtimeMs;
        if (promotedFile.backupPath) {
            if (!targetStillOwned) {
                rollbackFailures.push(new Error(`Refusing to restore ${promotedFile.targetPath} after external modification`));
                continue;
            }
            try {
                await atomicReplace(promotedFile.backupPath, promotedFile.targetPath);
                restoredBackups.add(promotedFile.backupPath);
            } catch (restoreError) {
                rollbackFailures.push(new Error(
                    `Failed to restore ${promotedFile.targetPath} from ${promotedFile.backupPath}`,
                    {cause: restoreError},
                ));
            }
            continue;
        }

        if (promotedFile.targetIdentity !== null && currentTargetIdentity === null) {
            continue;
        }
        if (!targetStillOwned) {
            rollbackFailures.push(new Error(`Refusing to remove ${promotedFile.targetPath} after external modification`));
            continue;
        }
        await rm(promotedFile.targetPath, {force: true}).catch((removeError: unknown) => {
            rollbackFailures.push(new Error(`Failed to remove partially promoted ${promotedFile.targetPath}`, {cause: removeError}));
        });
    }
    const retainedBackups = ledger.backupPaths.filter(backupPath => !restoredBackups.has(backupPath));
    if (rollbackFailures.length > 0 || retainedBackups.length > 0) {
        const backupMessage = retainedBackups.length > 0
            ? ` Recovery backup(s) retained at: ${retainedBackups.join(', ')}`
            : '';
        throw new AggregateError(rollbackFailures, `Image export rollback failed.${backupMessage}`);
    }
    ledger.promotedFiles.length = 0;
    ledger.backupPaths.length = 0;
}

export async function commitStagedFilePublications(ledger: IStagedFilePublicationLedger) {
    await Promise.all(ledger.backupPaths.map(backupPath => rm(backupPath, {force: true}).catch(() => undefined)));
    ledger.promotedFiles.length = 0;
    ledger.backupPaths.length = 0;
}

export async function promoteStagedFiles(
    stagedFiles: Array<{
        stagedPath: string;
        targetPath: string;
        targetExisted: boolean;
    }>,
    signal?: AbortSignal,
    ledger?: IStagedFilePublicationLedger,
) {
    const promotedFiles: IStagedFilePublication[] = [];
    const backupPaths: string[] = [];
    let pendingBackupPath: string | null = null;
    let pendingReplacementAttempted = false;
    try {
        for (const stagedFile of stagedFiles) {
            throwIfAborted(signal);
            const targetExistsAtPromotion = existsSync(stagedFile.targetPath);
            const backupPath = targetExistsAtPromotion
                ? makeSiblingTempPath(stagedFile.targetPath)
                : null;
            pendingBackupPath = backupPath;
            pendingReplacementAttempted = false;
            if (backupPath) {
                await copyFile(stagedFile.targetPath, backupPath);
                backupPaths.push(backupPath);
            }
            throwIfAborted(signal);
            pendingReplacementAttempted = true;
            await atomicReplace(stagedFile.stagedPath, stagedFile.targetPath);
            promotedFiles.push({
                targetPath: stagedFile.targetPath,
                backupPath,
                targetIdentity: null,
            });
            const promotedFile = promotedFiles.at(-1);
            if (!promotedFile) throw new Error('Image export publication record is missing');
            const targetIdentity = await stat(stagedFile.targetPath);
            promotedFile.targetIdentity = {
                dev: targetIdentity.dev,
                ino: targetIdentity.ino,
                size: targetIdentity.size,
                mtimeMs: targetIdentity.mtimeMs,
            };
            pendingBackupPath = null;
            pendingReplacementAttempted = false;
        }
    } catch (error) {
        await Promise.all(stagedFiles.map(stagedFile => rm(stagedFile.stagedPath, { force: true }).catch(() => undefined)));
        if (pendingBackupPath && !pendingReplacementAttempted) {
            await rm(pendingBackupPath, {force: true}).catch(() => undefined);
            const pendingBackupIndex = backupPaths.indexOf(pendingBackupPath);
            if (pendingBackupIndex >= 0) backupPaths.splice(pendingBackupIndex, 1);
        }
        const batchLedger = {
            promotedFiles,
            backupPaths,
        };
        const rollbackFailures: Error[] = [];
        try {
            await rollbackStagedFilePublications(batchLedger);
        } catch (rollbackError) {
            if (rollbackError instanceof AggregateError) {
                rollbackFailures.push(...rollbackError.errors.filter((entry): entry is Error => entry instanceof Error));
            } else {
                rollbackFailures.push(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
            }
        }
        const retainedBackups = backupPaths;
        if (rollbackFailures.length > 0 || retainedBackups.length > 0) {
            const primaryMessage = getErrorMessage(error);
            const backupMessage = retainedBackups.length > 0
                ? ` Recovery backup(s) retained at: ${retainedBackups.join(', ')}`
                : '';
            throw new AggregateError([
                error,
                ...rollbackFailures,
            ], `Image export promotion failed: ${primaryMessage}.${backupMessage}`);
        }
        throw error;
    }

    if (ledger) {
        ledger.promotedFiles.push(...promotedFiles);
        ledger.backupPaths.push(...backupPaths);
        return;
    }
    await commitStagedFilePublications({
        promotedFiles,
        backupPaths,
    });
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new Error('The operation was aborted');
    }
}

async function readExportPageSizes(
    pdfPath: string,
    popplerRuntimePaths: IPopplerRuntimePaths & { pdfinfo: string },
    pageCount: number,
    signal?: AbortSignal,
    cancelGroup?: string,
) {
    throwIfAborted(signal);
    try {
        const popplerEnv = buildPopplerEnv(popplerRuntimePaths);
        let longestSidePts = 0;
        const trackPageSize = (pageSize: IExportPageSize) => {
            longestSidePts = Math.max(longestSidePts, pageSize.widthPts, pageSize.heightPts);
        };
        const onStdout = createPdfInfoPageSizeStreamScanner(trackPageSize);
        const commandOptions: Parameters<typeof runNativeToolCommand>[2] = {
            timeoutMs: PDFINFO_PAGE_SIZE_TIMEOUT_MS,
            commandLabel: 'pdfinfo(export-page-size)',
            onStdout,
            ...(signal ? { signal } : {}),
            ...(cancelGroup ? { cancelGroup } : {}),
        };
        if (popplerEnv !== undefined) {
            commandOptions.env = popplerEnv;
        }

        const result = await runNativeToolCommand(popplerRuntimePaths.pdfinfo, [
            '-f',
            '1',
            '-l',
            String(pageCount),
            pdfPath,
        ], commandOptions);
        // Streaming already sees every byte; also parse the bounded stdout
        // buffer so command runners that never call onStdout still contribute.
        for (const line of result.stdout.split(/\r?\n/u)) {
            const pageSize = parsePdfInfoPageSizeLine(line);
            if (pageSize) {
                trackPageSize(pageSize);
            }
        }

        // DPI planning only needs the longest side, so complete per-page
        // metadata is reduced while streaming instead of being kept dense.
        if (longestSidePts <= 0) {
            return [];
        }
        return [{
            widthPts: longestSidePts,
            heightPts: longestSidePts,
        }];
    } catch (error) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : error;
        }

        logger.debug(`pdfinfo export page-size probe failed: ${getErrorMessage(error)}`);
        return [];
    }
}

function selectDpiProbePages(pageCount: number) {
    const sampleCount = Math.min(pageCount, PDF_EXPORT_DPI_PROBE_SAMPLE_PAGES);
    if (sampleCount < 2) {
        return [1];
    }

    return uniq(range(0, sampleCount).map(index => 1 + Math.round(
        (index / (sampleCount - 1)) * (pageCount - 1),
    )));
}

async function detectExportRenderDpi(
    pdfPath: string,
    popplerRuntimePaths: IPopplerRuntimePaths & {
        pdfinfo: string;
        pdfimages?: string;
    },
    pageCount: number,
    signal?: AbortSignal,
    cancelGroup?: string,
) {
    const [
        pageSizes,
        detection,
    ] = await Promise.all([
        readExportPageSizes(pdfPath, popplerRuntimePaths, pageCount, signal, cancelGroup),
        detectSourceDpiDetails(
            pdfPath,
            popplerRuntimePaths.pdfimages,
            logImageExportMessage,
            buildPopplerEnv(popplerRuntimePaths),
            signal,
            selectDpiProbePages(pageCount),
        ),
    ]);

    return resolveExportRenderDpi(detection.documentDpi, pageSizes);
}

export async function getPdfPageCount(
    pdfPath: string,
    options: {
        cancelGroup?: string;
        signal?: AbortSignal;
    } = {},
) {
    const result = await runNativeToolCommand(getPdfNativeToolPaths().qpdf, [
        '--show-npages',
        pdfPath,
    ], {
        timeoutMs: QPDF_TIMEOUT_MS,
        commandLabel: 'qpdf(export-page-count)',
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.cancelGroup ? { cancelGroup: options.cancelGroup } : {}),
    });
    const pageCount = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('Failed to read PDF page count');
    }
    return pageCount;
}

function assertExportPageCount(pageCount: number) {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('PDF export source has no pages');
    }
}

function emitExportProgress(options: IExportPdfOptions, progress: IImageExportProgressUpdate) {
    const total = Math.max(1, Math.trunc(progress.total));
    const processed = clamp(Math.trunc(progress.processed), 0, total);
    options.onProgress?.({
        phase: progress.phase,
        processed,
        total,
        percent: clamp(progress.percent ?? ((processed / total) * 100), 0, 100),
    });
}

function usingExportScratch<T>(
    options: IExportPdfOptions,
    prefix: TManagedScratchPrefix,
    run: (scratchPath: string) => Promise<T>,
) {
    return (options.scratch?.using ?? usingManagedScratchScope)(prefix, run);
}

async function renderPdfToTempPages(
    pdfPath: string,
    format: TImageExportFormat,
    pageRange: IExportPageRange,
    tempDir: string,
    renderDpi: number,
    signal?: AbortSignal,
    cancelGroup?: string,
): Promise<IRenderedPageFile[]> {
    const prefix = join(tempDir, 'page');
    const paths = getPdfNativeToolPaths();
    throwIfAborted(signal);

    const renderFormat: TPageRenderFormat = format === 'png' ? 'ppm' : format;
    const popplerEnv = buildPopplerEnv(paths);
    const commandOptions: Parameters<typeof runNativeToolCommand>[2] = {
        timeoutMs: PDFTOPPM_TIMEOUT_MS,
        commandLabel: `pdftoppm(export-${format})`,
        ...(signal ? { signal } : {}),
        ...(cancelGroup ? { cancelGroup } : {}),
    };
    if (popplerEnv !== undefined) {
        commandOptions.env = popplerEnv;
    }

    await runNativeToolCommand(paths.pdftoppm, [
        '-cropbox',
        ...toPdftoppmFormatArgs(renderFormat),
        '-r',
        String(renderDpi),
        '-f',
        String(pageRange.firstPage),
        '-l',
        String(pageRange.lastPage),
        pdfPath,
        prefix,
    ], commandOptions);
    throwIfAborted(signal);

    const fileNames = await readdir(tempDir);
    const pageFiles = sortBy(
        fileNames
            .filter(fileName => fileName.startsWith('page-'))
            .filter(fileName => isExpectedPageFile(fileName, renderFormat))
            .map(fileName => ({
                fileName,
                page: parsePageNumber(fileName),
            }))
            .filter(file => file.page >= pageRange.firstPage && file.page <= pageRange.lastPage),
        ['page'],
    )
        .map((file) => ({
            page: file.page,
            path: join(tempDir, file.fileName),
        }));

    if (pageFiles.length === 0) {
        throw new Error('No page images were generated from the PDF');
    }

    if (renderFormat === 'ppm') {
        await forEachConcurrent(pageFiles, PDF_EXPORT_PPM_CONVERT_CONCURRENCY, async (pageFile) => {
            throwIfAborted(signal);
            pageFile.path = await convertRenderedPpmToPng(pageFile.path, signal, cancelGroup, renderDpi);
        });
    }

    await validateRenderedImagePageFiles(pageFiles);

    return pageFiles;
}

function normalizePageNumbers(pageNumbers: number[] | undefined): number[] | null {
    if (!pageNumbers) {
        return null;
    }

    if (pageNumbers.some(page => !Number.isSafeInteger(page) || page < 1)) {
        throw new Error('pageNumbers must contain positive safe integers');
    }
    const unique = uniq(pageNumbers).sort((left, right) => left - right);

    if (unique.length === 0) {
        throw new Error('At least one page number must be provided for scoped export');
    }

    return unique;
}

function getRequestedPageCount(options: IExportPdfOptions) {
    const normalizedPages = normalizePageNumbers(options.pageNumbers);
    return normalizedPages?.length ?? null;
}

function formatPageList(pageNumbers: number[]) {
    const ranges: string[] = [];
    let rangeStart: number | null = null;
    let previous: number | null = null;

    for (const pageNumber of pageNumbers) {
        if (rangeStart === null || previous === null) {
            rangeStart = pageNumber;
            previous = pageNumber;
            continue;
        }

        if (pageNumber === previous + 1) {
            previous = pageNumber;
            continue;
        }

        ranges.push(rangeStart === previous ? String(rangeStart) : `${rangeStart}-${previous}`);
        rangeStart = pageNumber;
        previous = pageNumber;
    }

    if (rangeStart !== null && previous !== null) {
        ranges.push(rangeStart === previous ? String(rangeStart) : `${rangeStart}-${previous}`);
    }

    return ranges.join(',');
}

async function usingPreparedSourcePdf<T>(
    pdfPath: string,
    options: IExportPdfOptions,
    run: (preparedPath: string) => Promise<T>,
) {
    const normalizedPages = normalizePageNumbers(options.pageNumbers);

    if (!normalizedPages) {
        return run(pdfPath);
    }

    return usingExportScratch(options, 'pdfExport-scope-', async tempDir => {
        const subsetPdfPath = join(tempDir, 'subset.pdf');
        throwIfAborted(options.signal);
        const qpdfArgs = [
            pdfPath,
            '--pages',
            pdfPath,
            formatPageList(normalizedPages),
            '--',
            subsetPdfPath,
        ];
        await usingExportScratch(options, 'qpdfArgs-', async argsDir => {
            const argsPath = join(argsDir, 'args.txt');
            await writeFile(argsPath, qpdfArgs.map(arg => arg.replace(/\r?\n/g, ' ')).join('\n'));
            await runNativeToolCommand(getPdfNativeToolPaths().qpdf, [`@${argsPath}`], {
                timeoutMs: QPDF_TIMEOUT_MS,
                commandLabel: 'qpdf(export-subset)',
                ...(options.signal ? { signal: options.signal } : {}),
                ...(options.cancelGroup ? { cancelGroup: options.cancelGroup } : {}),
            });
        });
        return run(subsetPdfPath);
    });
}

async function planExportRender(preparedSourcePdf: string, options: IExportPdfOptions) {
    const requestedPageCount = getRequestedPageCount(options);
    const pageCount = requestedPageCount ?? await getPdfPageCount(preparedSourcePdf, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.cancelGroup ? { cancelGroup: options.cancelGroup } : {}),
    });
    assertExportPageCount(pageCount);

    return {
        pageCount,
        renderDpi: await detectExportRenderDpi(
            preparedSourcePdf,
            getPdfNativeToolPaths(),
            pageCount,
            options.signal,
            options.cancelGroup,
        ),
    };
}

export function* createPageRanges(
    pageCount: number,
    chunkPages = PDF_EXPORT_RENDER_CHUNK_PAGES,
): Generator<IExportPageRange> {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error('pageCount must be a positive safe integer');
    if (!Number.isSafeInteger(chunkPages) || chunkPages < 1) throw new Error('chunkPages must be a positive safe integer');

    let firstPage = 1;
    while (firstPage <= pageCount) {
        const pageSpan = Math.min(chunkPages, pageCount - firstPage + 1);
        const lastPage = firstPage + pageSpan - 1;
        yield {
            firstPage,
            lastPage,
        };
        if (lastPage === pageCount) {
            return;
        }
        firstPage = lastPage + 1;
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

    return usingPreparedSourcePdf(pdfPath, options, async preparedSourcePdf => {
        const {
            pageCount,
            renderDpi,
        } = await planExportRender(preparedSourcePdf, options);
        assertImageExportOutputPathBudget(pageCount);
        const exportedPaths: string[] = [];

        const stagedFiles: Array<{
            stagedPath: string;
            targetPath: string;
            targetExisted: boolean;
        }> = [];
        let processedPages = 0;
        emitExportProgress(options, {
            phase: 'rendering',
            processed: 0,
            total: pageCount,
        });

        try {
            for (const pageRange of createPageRanges(
                pageCount,
                format === 'png' ? PDF_EXPORT_PNG_RENDER_CHUNK_PAGES : PDF_EXPORT_RENDER_CHUNK_PAGES,
            )) {
                throwIfAborted(options.signal);
                await usingExportScratch(options, 'pdfExport-', async tempDir => {
                    let stagedBytes = 0;
                    const pageFiles = await renderPdfToTempPages(
                        preparedSourcePdf,
                        format,
                        pageRange,
                        tempDir,
                        renderDpi,
                        options.signal,
                        options.cancelGroup,
                    );
                    for (const source of pageFiles) {
                        const outputIndex = processedPages;
                        const plannedPath = pageCount === 1
                            ? normalizedPath
                            : buildOutputPathWithSuffix(
                                join(outputDirectory, `${outputStem}${outputExtension}`),
                                `-${String(outputIndex + 1).padStart(3, '0')}`,
                            );
                        const targetPath = resolveOutputPathConflicts(
                            [plannedPath],
                            pageCount === 1,
                        )[0];
                        if (!targetPath) {
                            throw new Error('Image export target path is missing');
                        }
                        exportedPaths.push(targetPath);
                        const stagedPath = makeSiblingTempPath(targetPath);

                        throwIfAborted(options.signal);
                        await moveFile(source.path, stagedPath);
                        stagedBytes = await addStagedImageFileBytes(stagedBytes, stagedPath,
                            'Image export exceeds the 2 GiB staged-output limit for one render window');
                        stagedFiles.push({
                            stagedPath,
                            targetPath,
                            targetExisted: existsSync(targetPath),
                        });
                        processedPages += 1;
                        emitExportProgress(options, {
                            phase: 'rendering',
                            processed: processedPages,
                            total: pageCount,
                        });
                    }
                });
            }
            throwIfAborted(options.signal);
            await options.beforePublish?.();
            await promoteStagedFiles(stagedFiles, options.signal);
        } catch (error) {
            await Promise.all(stagedFiles.map(stagedFile => rm(stagedFile.stagedPath, { force: true }).catch(() => undefined)));
            throw error;
        }
        return exportedPaths;
    });
}

function resolveTiffCombineWorkerPath() {
    return resolveUnpackedWorkerPath(__dirname, TIFF_COMBINE_WORKER_FILENAME);
}

function decodeUndefinedWorkerResult(data: unknown): undefined | null {
    return data === undefined ? undefined : null;
}

function getTiffCombineFallbackDisabledError() {
    const maxMb = Math.floor(TIFF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_BYTES / (1024 * 1024));
    return new Error(
        `TIFF combine worker unavailable and local fallback is disabled for exports larger than ${TIFF_COMBINE_LOCAL_FALLBACK_MAX_PAGES} pages or ${maxMb}MB`,
    );
}

async function runLocalTiffCombine(
    pagePaths: string[],
    outputPath: string,
    signal?: AbortSignal,
    deleteSourcePages = false,
    defaultDpi = DEFAULT_RENDER_DPI,
) {
    throwIfAborted(signal);
    await measureElectronPerfAsync('image-export:tiffCombineLocal', () => combinePagesIntoMultiPageTiffLocal(pagePaths, outputPath, {
        deleteSourcePages,
        defaultDpi,
        ...(signal ? { signal } : {}),
    }), {
        thresholdMs: 25,
        details: {
            pageCount: pagePaths.length,
            outputPath,
        },
    });
    throwIfAborted(signal);
}

async function combinePagesIntoMultiPageTiff(
    pagePaths: string[],
    outputPath: string,
    signal?: AbortSignal,
    deleteSourcePages = false,
    defaultDpi = DEFAULT_RENDER_DPI,
) {
    throwIfAborted(signal);
    const tempOutputPath = makeSiblingTempPath(outputPath);
    let replacedOutput = false;

    const workerPath = resolveTiffCombineWorkerPath();

    try {
        if (!existsSync(workerPath)) {
            if (!(await canUseLocalTiffCombineFallback(
                pagePaths,
                TIFF_COMBINE_LOCAL_FALLBACK_MAX_PAGES,
                TIFF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_BYTES,
            ))) {
                logger.warn(`TIFF combine worker unavailable, refusing unsafe local fallback at ${workerPath}`);
                throw getTiffCombineFallbackDisabledError();
            }

            logger.warn(`TIFF combine worker unavailable, falling back to local combine: missing worker at ${workerPath}`);
            await runLocalTiffCombine(pagePaths, tempOutputPath, signal, deleteSourcePages, defaultDpi);
            throwIfAborted(signal);
            await atomicReplace(tempOutputPath, outputPath);
            replacedOutput = true;
            return;
        }

        try {
            await measureElectronPerfAsync('image-export:tiffCombineWorker', () => runResultWorkerTask<undefined>({
                workerPath,
                workerData: {
                    deleteSourcePages,
                    defaultDpi,
                    pagePaths,
                    outputPath: tempOutputPath,
                },
                invalidPayloadMessage: 'TIFF combine worker returned an invalid payload',
                createStartError: message => new TiffCombineWorkerStartupError(
                    `TIFF combine worker failed to start: ${message}`,
                ),
                createStartupError: message => new TiffCombineWorkerStartupError(
                    `TIFF combine worker failed before becoming ready: ${message}`,
                ),
                createStartupExitError: code => new TiffCombineWorkerStartupError(
                    `TIFF combine worker exited during startup with code ${code}`,
                ),
                createWorkerExitError: code => new Error(`TIFF combine worker exited with code ${code}`),
                decodeResult: decodeUndefinedWorkerResult,
                invalidResultMessage: 'TIFF combine worker returned an invalid result',
                resourceLimits: TIFF_COMBINE_WORKER_RESOURCE_LIMITS,
                ...(signal ? { signal } : {}),
                createCancelMessage: () => ({type: 'cancel'}),
                cooperativeCancelDelayMs: 1_500,
                timeoutMs: TIFF_COMBINE_WORKER_TIMEOUT_MS,
            }), {
                thresholdMs: 25,
                details: {
                    pageCount: pagePaths.length,
                    outputPath,
                },
            });
        } catch (error) {
            if (!(error instanceof TiffCombineWorkerStartupError)) {
                throw error;
            }

            if (!(await canUseLocalTiffCombineFallback(
                pagePaths,
                TIFF_COMBINE_LOCAL_FALLBACK_MAX_PAGES,
                TIFF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_BYTES,
            ))) {
                logger.warn(`TIFF combine worker unavailable, refusing unsafe local fallback: ${error.message}`);
                throw getTiffCombineFallbackDisabledError();
            }

            logger.warn(`TIFF combine worker unavailable, falling back to local combine: ${error.message}`);
            await runLocalTiffCombine(pagePaths, tempOutputPath, signal, deleteSourcePages, defaultDpi);
        }

        throwIfAborted(signal);
        await atomicReplace(tempOutputPath, outputPath);
        replacedOutput = true;
    } finally {
        if (!replacedOutput) {
            await rm(tempOutputPath, { force: true }).catch(() => undefined);
        }
    }
}

export async function exportPdfAsMultiPageTiff(
    pdfPath: string,
    outputPath: string,
    options: IExportPdfOptions = {},
) {
    const targetPath = outputPath.toLowerCase().endsWith('.tif') || outputPath.toLowerCase().endsWith('.tiff')
        ? outputPath
        : `${outputPath}.tiff`;

    const outputDirectory = dirname(targetPath);
    await mkdir(outputDirectory, { recursive: true });

    return usingPreparedSourcePdf(pdfPath, options, async preparedSourcePdf => usingExportScratch(
        options,
        'pdfExport-',
        async tempDir => {
            const {
                pageCount,
                renderDpi,
            } = await planExportRender(preparedSourcePdf, options);
            let renderedPageCount = 0;
            emitExportProgress(options, {
                phase: 'rendering',
                processed: 0,
                total: pageCount,
                percent: 0,
            });
            const stagedGroupPaths: string[] = [];
            let combinedGroupCount = 0;
            const expectedRenderWindowCount = Math.max(1, Math.ceil(pageCount / PDF_EXPORT_RENDER_CHUNK_PAGES));
            for (const pageRange of createPageRanges(pageCount)) {
                throwIfAborted(options.signal);
                const renderDir = await mkdtemp(join(tempDir, 'render-pages-'));
                try {
                    const renderedPageFiles = await renderPdfToTempPages(
                        preparedSourcePdf,
                        'tiff',
                        pageRange,
                        renderDir,
                        renderDpi,
                        options.signal,
                        options.cancelGroup,
                    );
                    let stagedPageBytes = 0;
                    for (const renderedPageFile of renderedPageFiles) {
                        stagedPageBytes = await addStagedImageFileBytes(stagedPageBytes, renderedPageFile.path,
                            'Multi-page TIFF export exceeds the 2 GiB scratch limit for one render window');
                    }
                    renderedPageCount += renderedPageFiles.length;
                    emitExportProgress(options, {
                        phase: 'rendering',
                        processed: renderedPageCount,
                        total: pageCount,
                        percent: (renderedPageCount / pageCount) * 90,
                    });

                    const tiffPageDescriptors = await readTiffPageDescriptors(
                        renderedPageFiles.map(pageFile => pageFile.path),
                        options.signal,
                        renderDpi,
                    );
                    const tiffPageGroups = splitTiffPageDescriptorsForClassicLimit(tiffPageDescriptors);
                    for (const tiffPageGroup of tiffPageGroups) {
                        throwIfAborted(options.signal);
                        const stagedPath = join(
                            tempDir,
                            `tiff-group-${String(combinedGroupCount + 1).padStart(6, '0')}.tiff`,
                        );
                        await combinePagesIntoMultiPageTiff(
                            tiffPageGroup.map(page => page.path),
                            stagedPath,
                            options.signal,
                            true,
                            renderDpi,
                        );
                        stagedGroupPaths.push(stagedPath);
                        combinedGroupCount += 1;
                        emitExportProgress(options, {
                            phase: 'combining',
                            processed: combinedGroupCount,
                            total: Math.max(expectedRenderWindowCount, combinedGroupCount),
                            percent: 90 + ((combinedGroupCount / Math.max(expectedRenderWindowCount, combinedGroupCount)) * 10),
                        });
                    }
                } finally {
                    await rm(renderDir, {
                        recursive: true,
                        force: true,
                    }).catch(() => undefined);
                }
            }
            const outputPaths = resolveOutputPathConflicts(buildMultiPageTiffOutputPaths(targetPath, stagedGroupPaths.length));
            const stagedFiles = stagedGroupPaths.map((stagedPath, index) => {
                const targetOutputPath = outputPaths[index];
                if (!targetOutputPath) {
                    throw new Error('Multi-page TIFF export target path is missing');
                }
                return {
                    stagedPath,
                    targetPath: targetOutputPath,
                    targetExisted: existsSync(targetOutputPath),
                };
            });
            throwIfAborted(options.signal);
            await options.beforePublish?.();
            await promoteStagedFiles(stagedFiles, options.signal);
            for (const outputPath of outputPaths) {
                if (!existsSync(outputPath)) {
                    throw new Error('Multi-page TIFF export did not produce an output file');
                }
            }

            return outputPaths;
        },
    ));
}
