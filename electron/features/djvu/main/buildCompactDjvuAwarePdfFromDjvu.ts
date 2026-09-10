import { randomUUID } from 'node:crypto';
import {
    closeSync,
    createReadStream,
    openSync,
    writeSync,
} from 'node:fs';
import {
    appendFile,
    mkdir,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'node:readline';
import { limitAsync } from 'es-toolkit/promise';
import type {
    IDjvuConversionPageMetrics,
    TDjvuCompactFidelityPreset,
} from '@contracts/djvuConversionPolicy';
import { isRecord } from '@contracts/runtimeGuards';
import { buildDjvuRuntimeEnv } from '@electron/features/djvu/main/buildDjvuRuntimeEnv';
import { getDjvuNativeToolPaths } from '@electron/features/djvu/main/nativeToolPaths';
import {
    renderDjvuPageToImage,
    runRegisteredDjvuProcess,
    withDjvuNativeResourceLease,
} from '@electron/features/djvu/main/ddjvuConversion';
import { runNativeCommand } from '@electron/native-tools/runNativeCommand';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { probeNativeNetpbm } from '@electron/features/djvu/main/probeNativeNetpbm';
import { withCompactDjvuResourceLease } from '@electron/features/djvu/main/withCompactDjvuResourceLease';
import { createPdfCombineProgressHandler } from '@electron/native-tools/createPdfCombineProgressHandler';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';
import {
    getCompactDjvuFidelity,
    openCompactDjvuFidelityManifestWriter,
    readCompactDjvuIntegerEnv,
} from '@electron/features/djvu/main/compactDjvuFidelity';
import {
    loadOrBuildCompactDjvuPage,
    openCompactDjvuCheckpointJob,
    type ICheckpointedCompactPageSpec as ICompactPageSpec,
} from '@electron/features/djvu/main/compactDjvuCheckpoint';
import {
    assertDjvuSourceIdentity,
    createDjvuDiskQuotaMonitor,
    type IDjvuSourceIdentity,
} from '@electron/features/djvu/main/djvuArtifactManifest';
import {
    createPdfCombineOutputTooLargeError,
    isPdfCombineOutputTooLargeError,
    PDF_COMBINE_MAX_OUTPUT_BYTES,
    PDF_COMBINE_OUTPUT_POLICY,
} from '@contracts/pdfCombineOutputPolicy';

interface ICompactDjvuPdfExportOptions {
    jobId: string;
    djvuPath: string;
    outputPath: string;
    tempDir: string;
    pageCount: number;
    sourceDpi: number;
    pageSizes: IDjvuConversionPageMetrics[] | null;
    signal?: AbortSignal;
    pages?: number[];
    onProgress?: (percent: number) => void;
    qualityPreset?: TDjvuCompactFidelityPreset;
}

interface INetpbmInfo {
    magic: 'P4' | 'P5' | 'P6';
    width: number;
    height: number;
    dataOffset: number;
}

interface INetpbmStats extends INetpbmInfo {
    nonWhiteRatio: number;
    darkRatio: number;
    colorRatio: number;
    maxDarkRunRatio: number;
    minChannel: number;
    maxChannel: number;
}

interface IForegroundColorAnalysis {
    dominantColor: [number, number, number];
    colorRatio: number;
}

interface IPbmMaskStats extends INetpbmInfo {
    blackRatio: number;
    maxBlackRunRatio: number;
}

interface IDjvuPageInfo {
    width: number;
    height: number;
    dpi: number;
}

interface IDjvuLayerInfo {
    present: boolean;
    kind: string;
    bytes: number;
    width?: number;
    height?: number;
    subsample?: number;
}

interface IDjvuPageStructure {
    pageNumber: number;
    pageBytes: number | null;
    info: IDjvuPageInfo | null;
    hasMask: boolean;
    maskBytes: number | null;
    background: IDjvuLayerInfo | null;
    foreground: IDjvuLayerInfo | null;
}

interface IMutableDjvuPageStructure extends IDjvuPageStructure { hasPageChunk: boolean; }

const logger = createLogger('djvu-compact-pdf');
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRESS_EXTRACTION_CAP = 86;
const PROGRESS_COMBINE_START = 88;
const PROGRESS_COMBINE_CAP = 94;
const DEFAULT_DPI = 300;
const FOREGROUND_COLOR_RATIO_MIN = 0.05;
const FOREGROUND_COLOR_SATURATION_MIN = 24;
const FOREGROUND_DOMINANT_NON_WHITE_MAX = 230;
const FOREGROUND_NEAR_BLACK_MAX = 80;
const BACKGROUND_FLAT_NON_WHITE_RATIO = 0.002;
const BACKGROUND_FLAT_MIN_CHANNEL = 220;
const BACKGROUND_FLAT_CHANNEL_RANGE = 20;
const BACKGROUND_FLAT_COLOR_RATIO = 0.02;
const DJVU_COMPACT_MAX_PAGE_WORKERS = 2;
const DJVU_COMPACT_FOREGROUND_SUBSAMPLE = 12;
const DJVU_COMPACT_BACKGROUND_JPEG_QUALITY = readCompactDjvuIntegerEnv(
    'EVB_DJVU_COMPACT_BACKGROUND_JPEG_QUALITY',
    80,
    1,
    100,
);
const DJVU_COMPACT_PHOTO_JPEG_QUALITY = readCompactDjvuIntegerEnv(
    'EVB_DJVU_COMPACT_PHOTO_JPEG_QUALITY',
    85,
    1,
    100,
);
const DJVU_COMPACT_PHOTO_PPI_CAP = readCompactDjvuIntegerEnv(
    'EVB_DJVU_COMPACT_PHOTO_PPI_CAP',
    300,
    72,
    1200,
);

const DJVU_COMPACT_NETPBM_MAX_INPUT_BYTES = 192 * 1024 * 1024;
const DJVU_COMPACT_REAL_MASK_MIN_BYTES = 128;
const DJVU_COMPACT_DUMP_TIMEOUT_MS = 20_000;
const DJVU_COMPACT_DUMP_MAX_STDOUT_BYTES = 64 * 1024;
const DJVU_COMPACT_DUMP_MAX_LINE_BYTES = 256 * 1024;
const DJVU_COMPACT_DUMP_MAX_STDERR_BYTES = 1024 * 1024;
const DJVU_COMPACT_PAGE_BATCH_SIZE = 32;
const DJVU_COMPACT_RESULT_SPEC_LIMIT = 256;
const COMPACT_MANIFEST_JSONL_FORMAT = 'evb-pdf-image-combine-jsonl';
const COMPACT_MANIFEST_JSONL_SCHEMA_VERSION = 1;
const DJVU_NATIVE_LAYER_DEFAULT_SUBSAMPLE = 1;
const DJVU_COMPACT_MIN_SUBSAMPLE = 1;
const DJVU_COMPACT_MAX_SUBSAMPLE = 64;
const DJVU_COMPACT_LAYER_DIMENSION_MATCH_TOLERANCE = 0.25;
const DJVU_COMPACT_MAX_PAGE_BYTES = 0xffffffff;
const DJVU_COMPACT_INFO_REGEX = /\bINFO\b.*?(\d+)x(\d+).*?(\d+)\s*dpi/u;
const DJVU_COMPACT_CHUNK_REGEX = /^\s+([A-Za-z0-9]{4})\s+\[(\d+)\]/u;
const DJVU_COMPACT_DIMENSIONS_REGEX = /(\d+)x(\d+)/gu;
const DJVU_COMPACT_FORM_PAGE_REGEX = /\bFORM:DJVU\b\s+\[(\d+)\](?:.*?\[P(\d+)\])?(?:.*?\((\d+)\))?/u;
const DJVU_COMPACT_BACKGROUND_CHUNKS = new Set([
    'BG44',
    'BGjp',
    'BG2k',
    'PM44',
]);
const DJVU_COMPACT_FOREGROUND_CHUNKS = new Set([
    'FG44',
    'FGbz',
    'FGjp',
    'FG2k',
]);
const DJVU_COMPACT_MASK_CHUNKS = new Set(['Sjbz']);
export async function buildCompactDjvuAwarePdfFromDjvu(options: ICompactDjvuPdfExportOptions) {
    const selectedPages = normalizePages(options.pages, options.pageCount);
    const selectedPageCount = options.pages ? selectedPages.length : Math.max(0, options.pageCount);
    if (selectedPageCount === 0) {
        return {
            success: false,
            outputPath: options.outputPath,
            fileSize: 0,
            error: 'No DjVu pages available for compact PDF export',
            expected: {
                kind: 'expected' as const,
                code: 'validation-rejected' as const,
            },
        };
    }
    const structurePath = join(options.tempDir, `.djvu-structure-${randomUUID()}.jsonl`);
    const manifestPath = join(options.tempDir, 'compact-manifest.jsonl');
    const batchDirectoriesPath = join(options.tempDir, `.compact-batch-directories-${randomUUID()}.jsonl`);
    const resultPageSpecs: ICompactPageSpec[] = [];
    let fidelityWriter: Awaited<ReturnType<typeof openCompactDjvuFidelityManifestWriter>> | null = null;
    let combineQuotaMonitor: Awaited<ReturnType<typeof createDjvuDiskQuotaMonitor>> | null = null;
    let structureReady = false;
    try {
        await writeFile(manifestPath, `${JSON.stringify({
            format: COMPACT_MANIFEST_JSONL_FORMAT,
            schemaVersion: COMPACT_MANIFEST_JSONL_SCHEMA_VERSION,
            pageCount: selectedPageCount,
        })}\n`, 'utf8');
        fidelityWriter = await openCompactDjvuFidelityManifestWriter(options.tempDir, options.qualityPreset);
        const activeFidelityWriter = fidelityWriter;
        await withDjvuNativeResourceLease({
            jobId: options.jobId,
            kind: 'structure',
            ...(options.signal ? {signal: options.signal} : {}),
            task: () => readDjvuPageStructures(options.djvuPath, options.jobId, options.signal, structurePath),
        });
        structureReady = true;

        let completedPageCount = 0;
        let layeredCount = 0;
        let layeredColorCount = 0;
        let bitonalCount = 0;
        let photoCount = 0;
        let sourceIdentity: IDjvuSourceIdentity | undefined;
        let lastProgress = 0;
        const emitProgress = (percent: number) => {
            const nextProgress = Math.max(lastProgress, Math.min(PROGRESS_COMBINE_CAP, percent));
            lastProgress = nextProgress;
            options.onProgress?.(nextProgress);
        };

        for await (const {
            pages,
            pageStructures,
        } of iterateDjvuPageStructureWindows(
                structurePath,
                pageWindows(options.pages ? selectedPages : undefined, options.pageCount),
                options.signal,
            )) {
            throwIfAborted(options.signal);
            const checkpointJob = await openCompactDjvuCheckpointJob(
                options.djvuPath,
                [...pages],
                options.qualityPreset,
                options.signal,
                sourceIdentity,
            );
            sourceIdentity ??= checkpointJob.sourceIdentity;
            try {
                await appendFile(batchDirectoriesPath, `${checkpointJob.directory}\n`, 'utf8');
            } catch (error) {
                await checkpointJob.close();
                throw error;
            }
            let quotaMonitor: Awaited<ReturnType<typeof createDjvuDiskQuotaMonitor>> | null = null;
            try {
                const pageTempDir = join(checkpointJob.directory, 'compact-pages');
                await mkdir(pageTempDir, {recursive: true});
                quotaMonitor = await createDjvuDiskQuotaMonitor({
                    paths: [
                        checkpointJob.directory,
                        options.outputPath,
                    ],
                    fileSystemPath: checkpointJob.directory,
                    maxTotalBytes: checkpointJob.maxTotalBytes,
                    ...(options.signal ? {signal: options.signal} : {}),
                });
                const activeQuotaMonitor = quotaMonitor;
                const conversionOptions: ICompactDjvuPdfExportOptions = {
                    ...options,
                    signal: activeQuotaMonitor.signal,
                };
                const workerCount = Math.min(DJVU_COMPACT_MAX_PAGE_WORKERS, pages.length);
                const buildPageWithLimit = limitAsync(async (pageNumber: number, pageIndex: number) => {
                    throwIfAborted(activeQuotaMonitor.signal);
                    const pageSpec = await loadOrBuildCompactDjvuPage(checkpointJob, pageIndex, () => withCompactDjvuResourceLease({
                        jobId: options.jobId,
                        kind: 'page',
                        signal: activeQuotaMonitor.signal,
                        task: () => buildCompactPageSpec(
                            conversionOptions,
                            pageTempDir,
                            pageNumber,
                            pageStructures.get(pageNumber) ?? null,
                        ),
                    }));
                    await activeQuotaMonitor.checkNow();
                    throwIfAborted(activeQuotaMonitor.signal);
                    return pageSpec;
                }, workerCount);

                let pageSpecs: ICompactPageSpec[];
                try {
                    pageSpecs = await Promise.all(pages.map(buildPageWithLimit));
                } catch (error) {
                    if (activeQuotaMonitor.failure) {
                        throw new Error(activeQuotaMonitor.failure.message, {cause: error});
                    }
                    throw error;
                }
                await appendFile(
                    manifestPath,
                    `${pageSpecs.map(spec => spec.manifestLine).join('\n')}\n`,
                    'utf8',
                );
                await activeFidelityWriter.append(pageSpecs);
                if (resultPageSpecs.length < DJVU_COMPACT_RESULT_SPEC_LIMIT) {
                    resultPageSpecs.push(...pageSpecs.slice(0, DJVU_COMPACT_RESULT_SPEC_LIMIT - resultPageSpecs.length));
                }
                for (const pageSpec of pageSpecs) {
                    if (pageSpec.kind === 'layered') layeredCount += 1;
                    if (pageSpec.kind === 'layered-color') layeredColorCount += 1;
                    if (pageSpec.kind === 'bitonal') bitonalCount += 1;
                    if (pageSpec.kind === 'photo') photoCount += 1;
                }
                completedPageCount += pageSpecs.length;
                emitProgress(Math.round((completedPageCount / selectedPageCount) * PROGRESS_EXTRACTION_CAP));
                await activeQuotaMonitor.checkNow();
            } finally {
                await quotaMonitor?.stop();
                await checkpointJob.close();
            }
        }

        await fidelityWriter.close();
        fidelityWriter = null;
        emitProgress(PROGRESS_COMBINE_START);
        throwIfAborted(options.signal);
        if (!sourceIdentity) {
            throw new Error('Compact DjVu export did not establish source identity');
        }
        await assertDjvuSourceIdentity(options.djvuPath, sourceIdentity, options.signal);
        logger.info(
            `[${options.jobId}] Compact DjVu PDF manifest ready: ${bitonalCount} bitonal, ${layeredCount} layered, ${layeredColorCount} layered-color, ${photoCount} photo page(s)`,
        );

        const binaryPath = resolveNativePdfImageCombinePath();
        if (!binaryPath) {
            return {
                success: false,
                outputPath: options.outputPath,
                fileSize: 0,
                error: 'Native PDF image combiner is unavailable',
                expected: {
                    kind: 'expected' as const,
                    code: 'temporarily-unavailable' as const,
                },
            };
        }

        combineQuotaMonitor = await createDjvuDiskQuotaMonitor({
            paths: [options.outputPath],
            fileSystemPath: dirname(options.outputPath),
            ...(options.signal ? {signal: options.signal} : {}),
        });
        const combineSignal = combineQuotaMonitor.signal;
        const result = await withCompactDjvuResourceLease({
            jobId: options.jobId,
            kind: 'combine',
            signal: combineSignal,
            task: () => runRegisteredDjvuProcess(
                `${options.jobId}-compact-combine`,
                binaryPath,
                [
                    '--output',
                    options.outputPath,
                    '--json-progress',
                    '--compact-manifest',
                    manifestPath,
                ],
                {
                    signal: combineSignal,
                    env: {
                        ...process.env,
                        EVB_PDF_COMBINE_MAX_PAGES: String(Math.max(selectedPageCount, 1)),
                        EVB_PDF_COMBINE_MAX_OUTPUT_BYTES: process.env.EVB_PDF_COMBINE_MAX_OUTPUT_BYTES
                            ?? String(PDF_COMBINE_MAX_OUTPUT_BYTES),
                    },
                    onStdout: createPdfCombineProgressHandler(
                        selectedPageCount,
                        (processed, total) => emitProgress(PROGRESS_COMBINE_START + Math.round(
                            (processed / total) * (PROGRESS_COMBINE_CAP - PROGRESS_COMBINE_START),
                        )),
                        line => logger.debug(`Ignoring malformed native compact PDF progress: ${line}`),
                    ),
                },
            ),
        });
        if (!result.success) {
            const unprovenTermination = getUnprovenNativeTerminationDetail(result.cause);
            if (unprovenTermination !== undefined) {
                throw result.cause instanceof Error
                    ? result.cause
                    : new Error(`${result.error}: ${unprovenTermination}`);
            }
            const nativeCode = typeof result.cause === 'object'
                && result.cause !== null
                && 'code' in result.cause
                ? result.cause.code
                : undefined;
            if (nativeCode === PDF_COMBINE_OUTPUT_POLICY.tooLargeCode
                || isPdfCombineOutputTooLargeError(result.cause)) {
                await rm(options.outputPath, {force: true}).catch(() => undefined);
                throw createPdfCombineOutputTooLargeError();
            }
            return {
                success: false,
                outputPath: options.outputPath,
                fileSize: 0,
                error: combineQuotaMonitor.failure?.message ?? result.error,
            };
        }

        try {
            const s = await stat(options.outputPath);
            if (s.size > PDF_COMBINE_MAX_OUTPUT_BYTES) {
                await rm(options.outputPath, {force: true}).catch(() => undefined);
                throw createPdfCombineOutputTooLargeError();
            }
            emitProgress(PROGRESS_COMBINE_CAP);
            await cleanupCompactBatchJobs(batchDirectoriesPath);
            return {
                success: true,
                outputPath: options.outputPath,
                fileSize: s.size,
                pageSpecs: resultPageSpecs,
            };
        } catch (error) {
            if (isPdfCombineOutputTooLargeError(error)) {
                throw error;
            }
            return {
                success: false,
                outputPath: options.outputPath,
                fileSize: 0,
                error: `Compact PDF output file not found: ${getErrorMessage(error)}`,
            };
        }
    } finally {
        await combineQuotaMonitor?.stop();
        await fidelityWriter?.abort().catch(() => undefined);
        if (structureReady) {
            await rm(structurePath, {force: true}).catch(() => undefined);
        }
        await rm(batchDirectoriesPath, {force: true}).catch(() => undefined);
    }
}

async function cleanupCompactBatchJobs(path: string) {
    const input = createReadStream(path, {encoding: 'utf8'});
    const lines = createInterface({
        input,
        crlfDelay: Infinity,
    });
    try {
        for await (const line of lines) {
            if (line.trim()) {
                await rm(line, {
                    force: true,
                    recursive: true,
                }).catch(() => undefined);
            }
        }
    } finally {
        lines.close();
        input.destroy();
    }
}

async function readDjvuPageStructures(
    djvuPath: string,
    jobId: string,
    signal: AbortSignal | undefined,
    outputPath: string,
): Promise<string> {
    let fileDescriptor: number | null = null;
    let structureCount = 0;
    try {
        const { djvudump } = getDjvuNativeToolPaths();
        fileDescriptor = openSync(outputPath, 'w');
        let carry = '';
        const parser = createDjvuPageStructureParser(structure => {
            const data = Buffer.from(`${JSON.stringify(structure)}\n`, 'utf8');
            let offset = 0;
            while (offset < data.length) {
                offset += writeSync(fileDescriptor!, data, offset);
            }
            structureCount += 1;
        });
        await runNativeCommand(djvudump, [djvuPath], {
            env: buildDjvuRuntimeEnv(),
            timeoutMs: DJVU_COMPACT_DUMP_TIMEOUT_MS,
            maxStdoutBytes: DJVU_COMPACT_DUMP_MAX_STDOUT_BYTES,
            maxStderrBytes: DJVU_COMPACT_DUMP_MAX_STDERR_BYTES,
            rejectOnStdoutTruncation: false,
            commandLabel: 'djvudump',
            defaultCwdToCommandDir: true,
            prependCommandDirToPath: true,
            includeProcessEnv: true,
            windowsHide: true,
            ...(signal ? { signal } : {}),
            onStdout: chunk => {
                carry += chunk;
                let newline = carry.indexOf('\n');
                while (newline >= 0) {
                    parser.consumeLine(carry.slice(0, newline).replace(/\r$/u, ''));
                    carry = carry.slice(newline + 1);
                    newline = carry.indexOf('\n');
                }
                if (Buffer.byteLength(carry, 'utf8') > DJVU_COMPACT_DUMP_MAX_LINE_BYTES) {
                    throw new Error('djvudump emitted an overlong structure record');
                }
            },
        });
        if (carry.length > 0) {
            parser.consumeLine(carry);
        }
        parser.finish();
        closeSync(fileDescriptor);
        fileDescriptor = null;
        if (structureCount > 0) {
            logger.debug(`[${jobId}] Read DjVu native layer structure for ${structureCount} page(s)`);
        }
        return outputPath;
    } catch (error) {
        if (fileDescriptor !== null) {
            closeSync(fileDescriptor);
        }
        await rm(outputPath, {force: true}).catch(() => undefined);
        throw new Error(`DjVu layer structure inspection failed; compact export stopped without flattening the document: ${getErrorMessage(error)}`);
    }
}

function createDjvuPageStructureParser(onPage: (structure: IDjvuPageStructure) => void) {
    let current: IMutableDjvuPageStructure | null = null;
    let nextImplicitPageNumber = 1;
    const flushCurrent = () => {
        if (!current?.hasPageChunk) {
            return;
        }
        onPage({
            pageNumber: current.pageNumber,
            pageBytes: current.pageBytes,
            info: current.info,
            hasMask: current.hasMask,
            maskBytes: current.maskBytes,
            background: current.background,
            foreground: current.foreground,
        });
    };

    return {
        consumeLine(line: string) {
            const pageMatch = line.match(DJVU_COMPACT_FORM_PAGE_REGEX);
            if (pageMatch) {
                flushCurrent();
                const pageNumber = parsePositiveInteger(pageMatch[2])
                ?? parsePositiveInteger(pageMatch[3])
                ?? nextImplicitPageNumber;
                nextImplicitPageNumber = Math.max(nextImplicitPageNumber, pageNumber + 1);
                current = {
                    pageNumber,
                    pageBytes: parseBoundedInteger(pageMatch[1], 0, DJVU_COMPACT_MAX_PAGE_BYTES),
                    info: null,
                    hasMask: false,
                    hasPageChunk: true,
                    maskBytes: null,
                    background: null,
                    foreground: null,
                };
                return;
            }

            if (!current) {
                return;
            }

            const infoMatch = line.match(DJVU_COMPACT_INFO_REGEX);
            if (infoMatch?.[1] && infoMatch[2] && infoMatch[3]) {
                current.info = {
                    width: Number.parseInt(infoMatch[1], 10),
                    height: Number.parseInt(infoMatch[2], 10),
                    dpi: Number.parseInt(infoMatch[3], 10),
                };
                return;
            }

            const chunkMatch = line.match(DJVU_COMPACT_CHUNK_REGEX);
            if (!chunkMatch?.[1] || !chunkMatch[2]) {
                return;
            }

            const chunkId = chunkMatch[1];
            const chunkBytes = Number.parseInt(chunkMatch[2], 10);
            if (!Number.isFinite(chunkBytes) || chunkBytes < 0) {
                return;
            }
            const dimensions = lastDimensions(line);
            const layer = createDjvuLayerInfo(chunkId, chunkBytes, dimensions, current.info);

            if (DJVU_COMPACT_MASK_CHUNKS.has(chunkId)) {
                current.hasMask = true;
                current.maskBytes = chunkBytes;
            } else if (DJVU_COMPACT_BACKGROUND_CHUNKS.has(chunkId)) {
                current.background = layer;
            } else if (DJVU_COMPACT_FOREGROUND_CHUNKS.has(chunkId)) {
                current.foreground = layer;
            }
        },
        finish() {
            flushCurrent();
        },
    };
}

async function* iterateDjvuPageStructureWindows(
    structurePath: string,
    pageWindowsToRead: Iterable<readonly number[]>,
    signal: AbortSignal | undefined,
) {
    const structures = new Map<number, IDjvuPageStructure>();
    const input = createReadStream(structurePath, {encoding: 'utf8'});
    const lines = createInterface({
        input,
        crlfDelay: Infinity,
    });
    const iterator: AsyncIterator<string> = lines[Symbol.asyncIterator]();
    let pending: IDjvuPageStructure | null = null;
    let exhausted = false;
    try {
        for (const pages of pageWindowsToRead) {
            const wanted = new Set(pages);
            const minPage = pages[0] ?? Number.MAX_SAFE_INTEGER;
            const maxPage = pages[pages.length - 1] ?? 0;
            structures.clear();
            while (!exhausted) {
                throwIfAborted(signal);
                const next: IDjvuPageStructure | null = pending;
                pending = null;
                if (!next) {
                    const result = await iterator.next();
                    if (result.done) {
                        exhausted = true;
                        break;
                    }
                    if (result.value.length > DJVU_COMPACT_DUMP_MAX_LINE_BYTES || !result.value.trim()) {
                        continue;
                    }
                    try {
                        const value: unknown = JSON.parse(result.value);
                        pending = decodeDjvuPageStructure(value);
                    } catch {
                        pending = null;
                    }
                    if (!pending) continue;
                    continue;
                }
                if (!Number.isSafeInteger(next.pageNumber)) {
                    continue;
                }
                if (next.pageNumber > maxPage) {
                    pending = next;
                    break;
                }
                if (next.pageNumber >= minPage && wanted.has(next.pageNumber)) {
                    structures.set(next.pageNumber, next);
                }
            }
            yield {
                pages,
                pageStructures: new Map(structures),
            };
        }
    } finally {
        lines.close();
        input.destroy();
    }
}

function decodeDjvuPageStructure(value: unknown): IDjvuPageStructure | null {
    if (!isRecord(value)
        || !isSafeBoundedInteger(value.pageNumber, 1, Number.MAX_SAFE_INTEGER)
        || typeof value.hasMask !== 'boolean') {
        return null;
    }
    const pageBytes = readNullableBoundedInteger(value.pageBytes, 0, DJVU_COMPACT_MAX_PAGE_BYTES);
    const maskBytes = readNullableBoundedInteger(value.maskBytes, 0, DJVU_COMPACT_MAX_PAGE_BYTES);
    if (pageBytes === undefined || maskBytes === undefined) {
        return null;
    }
    return {
        pageNumber: value.pageNumber,
        pageBytes,
        info: decodeDjvuPageInfo(value.info),
        hasMask: value.hasMask,
        maskBytes,
        background: decodeDjvuLayerInfo(value.background),
        foreground: decodeDjvuLayerInfo(value.foreground),
    };
}

function decodeDjvuPageInfo(value: unknown): IDjvuPageInfo | null {
    if (value === null) {
        return null;
    }
    if (!isRecord(value)) {
        return null;
    }
    const width = readPositiveInteger(value.width);
    const height = readPositiveInteger(value.height);
    const dpi = readPositiveInteger(value.dpi);
    if (width === null || height === null || dpi === null) {
        return null;
    }
    return {
        width,
        height,
        dpi,
    };
}

function decodeDjvuLayerInfo(value: unknown): IDjvuLayerInfo | null {
    if (value === null) {
        return null;
    }
    if (!isRecord(value) || typeof value.present !== 'boolean' || typeof value.kind !== 'string') {
        return null;
    }
    const bytes = readSafeBoundedInteger(value.bytes, 0, DJVU_COMPACT_MAX_PAGE_BYTES);
    const width = readOptionalPositiveInteger(value.width);
    const height = readOptionalPositiveInteger(value.height);
    const subsample = readOptionalPositiveInteger(value.subsample);
    if (bytes === null || width === null || height === null || subsample === null) {
        return null;
    }
    return {
        present: value.present,
        kind: value.kind,
        bytes,
        ...(width === undefined ? {} : {width}),
        ...(height === undefined ? {} : {height}),
        ...(subsample === undefined ? {} : {subsample}),
    };
}

function isSafeBoundedInteger(value: unknown, minValue: number, maxValue: number): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= minValue
        && value <= maxValue;
}

function readSafeBoundedInteger(value: unknown, minValue: number, maxValue: number): number | null {
    return isSafeBoundedInteger(value, minValue, maxValue) ? value : null;
}

function readNullableBoundedInteger(value: unknown, minValue: number, maxValue: number): number | null | undefined {
    if (value === null) {
        return null;
    }
    return isSafeBoundedInteger(value, minValue, maxValue) ? value : undefined;
}

function readPositiveInteger(value: unknown): number | null {
    return readSafeBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

function readOptionalPositiveInteger(value: unknown): number | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    return readPositiveInteger(value) ?? null;
}

function createDjvuLayerInfo(
    kind: string,
    bytes: number,
    dimensions: {
        width: number;
        height: number
    } | null,
    pageInfo: IDjvuPageInfo | null,
): IDjvuLayerInfo {
    return {
        present: true,
        kind,
        bytes,
        ...(dimensions ?? {}),
        ...(dimensions && pageInfo ? {subsample: deriveLayerSubsample(pageInfo, dimensions)} : {}),
    };
}

function lastDimensions(line: string) {
    let match: RegExpExecArray | null;
    let dimensions: {
        width: number;
        height: number
    } | null = null;
    DJVU_COMPACT_DIMENSIONS_REGEX.lastIndex = 0;
    while ((match = DJVU_COMPACT_DIMENSIONS_REGEX.exec(line)) !== null) {
        const width = parsePositiveInteger(match[1]);
        const height = parsePositiveInteger(match[2]);
        if (width !== null && height !== null) {
            dimensions = {
                width,
                height,
            };
        }
    }
    return dimensions;
}

function deriveLayerSubsample(
    pageInfo: IDjvuPageInfo,
    dimensions: {
        width: number;
        height: number
    },
) {
    if (dimensions.width <= 0 || dimensions.height <= 0) {
        return DJVU_NATIVE_LAYER_DEFAULT_SUBSAMPLE;
    }
    const widthRatio = pageInfo.width / dimensions.width;
    const heightRatio = pageInfo.height / dimensions.height;
    const rounded = Math.round(Math.max(widthRatio, heightRatio));
    if (
        !Number.isFinite(rounded)
        || rounded < DJVU_COMPACT_MIN_SUBSAMPLE
        || Math.abs(widthRatio - heightRatio) > DJVU_COMPACT_LAYER_DIMENSION_MATCH_TOLERANCE * Math.max(1, rounded)
    ) {
        return DJVU_NATIVE_LAYER_DEFAULT_SUBSAMPLE;
    }
    return Math.min(DJVU_COMPACT_MAX_SUBSAMPLE, Math.max(DJVU_COMPACT_MIN_SUBSAMPLE, rounded));
}

function hasRealForegroundMask(structure: IDjvuPageStructure) {
    return structure.hasMask
        && typeof structure.maskBytes === 'number'
        && structure.maskBytes >= DJVU_COMPACT_REAL_MASK_MIN_BYTES;
}

function parsePositiveInteger(value: string | undefined) {
    return parseBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

function parseBoundedInteger(value: string | undefined, minValue: number, maxValue: number) {
    if (value === undefined) {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < minValue || parsed > maxValue) {
        return null;
    }
    return parsed;
}

async function buildCompactPageSpec(
    options: ICompactDjvuPdfExportOptions,
    pageTempDir: string,
    pageNumber: number,
    structure: IDjvuPageStructure | null,
): Promise<ICompactPageSpec> {
    const pagePrefix = join(pageTempDir, `page-${String(pageNumber).padStart(5, '0')}-${randomUUID()}`);
    const fidelity = getCompactDjvuFidelity(options.qualityPreset);
    if (!structure) {
        return buildPhotoPageSpec(options, pagePrefix, pageNumber, null, 'DjVu layer structure unavailable; rendering capped photo page');
    }

    if (!hasRealForegroundMask(structure)) {
        return buildPhotoPageSpec(
            options,
            pagePrefix,
            pageNumber,
            structure,
            noRealMaskPhotoReason(structure),
        );
    }

    const maskPath = await renderMaskLayer(options, pagePrefix, pageNumber);
    const maskStats = await readPbmMaskStats(maskPath);
    const pageSize = resolvePageSizePoints(
        options.pageSizes?.[pageNumber - 1] ?? null,
        options.sourceDpi,
        maskStats,
        1,
        structure,
    );

    const foregroundColorPath = structure.foreground
        ? await renderForegroundLayer(options, pagePrefix, pageNumber, structure)
        : null;
    const foregroundColor = foregroundColorPath
        ? await analyzeForegroundColor(foregroundColorPath)
        : null;

    if (foregroundColor && hasRealForegroundColor(foregroundColor)) {
        return buildPhotoPageSpec(
            options,
            pagePrefix,
            pageNumber,
            structure,
            'colored foreground preserved as a full-color image layer instead of averaged RGB',
        );
    }

    if (!structure.background) {
        return {
            pageNumber,
            kind: 'bitonal',
            reason: 'DjVu page has only a foreground mask',
            effectivePpi: structure.info?.dpi ?? options.sourceDpi,
            manifestLine: createManifestLine('mask', pageSize, [maskPath]),
        };
    }

    const backgroundPath = await renderBackgroundLayer(options, pagePrefix, pageNumber, structure);
    const backgroundStats = await readNetpbmStats(backgroundPath);
    if (isFlatBackground(backgroundStats)) {
        return {
            pageNumber,
            kind: 'bitonal',
            reason: 'foreground mask over flat background',
            effectivePpi: structure.info?.dpi ?? options.sourceDpi,
            manifestLine: createManifestLine('mask', pageSize, [maskPath]),
        };
    }

    return {
        pageNumber,
        kind: 'layered',
        reason: 'DjVu native mask and background layers',
        effectivePpi: Math.min(structure.info?.dpi ?? options.sourceDpi, fidelity.ppiCap),
        jpegQuality: fidelity.backgroundQuality,
        manifestLine: createManifestLine(
            'layered-jpeg',
            pageSize,
            [
                backgroundPath,
                maskPath,
            ],
            {jpegQuality: fidelity.backgroundQuality},
        ),
    };
}

async function renderMaskLayer(
    options: ICompactDjvuPdfExportOptions,
    pagePrefix: string,
    pageNumber: number,
) {
    const outputPath = `${pagePrefix}-mask.pbm`;
    throwIfAborted(options.signal);
    const result = await renderDjvuPageToImage(
        options.djvuPath,
        outputPath,
        pageNumber,
        `${options.jobId}-compact-page-${pageNumber}-mask`,
        {
            format: 'pbm',
            mode: 'mask',
        },
    );
    throwIfCanceledRenderResult(result, options.signal);
    if (!result.success) {
        throw new Error(result.error ?? `Failed to render DjVu foreground mask for page ${pageNumber}`);
    }
    return outputPath;
}

async function renderBackgroundLayer(
    options: ICompactDjvuPdfExportOptions,
    pagePrefix: string,
    pageNumber: number,
    structure: IDjvuPageStructure,
) {
    const outputPath = `${pagePrefix}-background.ppm`;
    throwIfAborted(options.signal);
    const result = await renderDjvuPageToImage(
        options.djvuPath,
        outputPath,
        pageNumber,
        `${options.jobId}-compact-page-${pageNumber}-background`,
        {
            format: 'ppm',
            mode: 'background',
            subsample: nativeSubsample(structure.background),
        },
    );
    throwIfCanceledRenderResult(result, options.signal);
    if (!result.success) {
        throw new Error(result.error ?? `Failed to render DjVu background layer for page ${pageNumber}`);
    }
    return outputPath;
}

async function renderForegroundLayer(
    options: ICompactDjvuPdfExportOptions,
    pagePrefix: string,
    pageNumber: number,
    structure: IDjvuPageStructure,
) {
    const outputPath = `${pagePrefix}-foreground.ppm`;
    throwIfAborted(options.signal);
    const result = await renderDjvuPageToImage(
        options.djvuPath,
        outputPath,
        pageNumber,
        `${options.jobId}-compact-page-${pageNumber}-foreground`,
        {
            format: 'ppm',
            mode: 'foreground',
            subsample: nativeSubsample(structure.foreground, DJVU_COMPACT_FOREGROUND_SUBSAMPLE),
        },
    );
    throwIfCanceledRenderResult(result, options.signal);
    if (!result.success) {
        throw new Error(result.error ?? `Failed to render DjVu foreground layer for page ${pageNumber}`);
    }
    return outputPath;
}

async function buildPhotoPageSpec(
    options: ICompactDjvuPdfExportOptions,
    pagePrefix: string,
    pageNumber: number,
    structure: IDjvuPageStructure | null,
    reason: string,
): Promise<ICompactPageSpec> {
    throwIfAborted(options.signal);
    const photoPath = `${pagePrefix}-photo.ppm`;
    const renderOptions = resolvePhotoRenderOptions(options, pageNumber, structure);
    const fidelity = getCompactDjvuFidelity(options.qualityPreset);
    const result = await renderDjvuPageToImage(
        options.djvuPath,
        photoPath,
        pageNumber,
        `${options.jobId}-compact-page-${pageNumber}-photo`,
        renderOptions,
    );
    throwIfCanceledRenderResult(result, options.signal);
    if (!result.success) {
        throw new Error(result.error ?? `Failed to render compact photo page ${pageNumber}`);
    }

    const photoStats = await readNetpbmStats(photoPath);
    const pageSize = resolvePageSizePoints(
        options.pageSizes?.[pageNumber - 1] ?? null,
        options.sourceDpi,
        photoStats,
        renderOptions.subsample ?? DJVU_NATIVE_LAYER_DEFAULT_SUBSAMPLE,
        structure,
    );
    return {
        pageNumber,
        kind: 'photo',
        reason,
        effectivePpi: Math.min(structure?.info?.dpi ?? options.sourceDpi, fidelity.ppiCap),
        jpegQuality: fidelity.photoQuality,
        manifestLine: createManifestLine(
            'photo-jpeg',
            pageSize,
            [photoPath],
            {
                jpegQuality: fidelity.photoQuality,
                ppiCap: fidelity.ppiCap,
            },
        ),
    };
}

function resolvePhotoRenderOptions(
    options: ICompactDjvuPdfExportOptions,
    pageNumber: number,
    structure: IDjvuPageStructure | null,
) {
    const pageInfo = structure?.info;
    const metrics = options.pageSizes?.[pageNumber - 1] ?? null;
    const dpi = positiveNumber(pageInfo?.dpi) ?? positiveNumber(options.sourceDpi) ?? DEFAULT_DPI;
    const fidelity = getCompactDjvuFidelity(options.qualityPreset);
    const width = positiveNumber(metrics?.width) ?? positiveNumber(pageInfo?.width);
    const height = positiveNumber(metrics?.height) ?? positiveNumber(pageInfo?.height);
    if (width && height) {
        const scale = Math.max(1, dpi / fidelity.ppiCap);
        return {
            format: 'ppm' as const,
            targetWidthPx: Math.max(1, Math.round(width / scale)),
            targetHeightPx: Math.max(1, Math.round(height / scale)),
        };
    }

    return {
        format: 'ppm' as const,
        subsample: Math.max(1, Math.ceil(dpi / fidelity.ppiCap)),
    };
}

function noRealMaskPhotoReason(structure: IDjvuPageStructure) {
    if (structure.background) {
        const maskDescription = structure.maskBytes === null
            ? 'without a foreground mask'
            : `with tiny foreground mask (${structure.maskBytes} bytes)`;
        return `DjVu page has continuous-tone background ${maskDescription}; rendering capped photo page`;
    }
    return 'DjVu page has no real foreground mask; rendering capped photo page';
}

function nativeSubsample(layer: IDjvuLayerInfo | null, fallback = DJVU_NATIVE_LAYER_DEFAULT_SUBSAMPLE) {
    const subsample = layer?.subsample ?? fallback;
    return Math.min(DJVU_COMPACT_MAX_SUBSAMPLE, Math.max(DJVU_COMPACT_MIN_SUBSAMPLE, subsample));
}

async function analyzeForegroundColor(foregroundPath: string): Promise<IForegroundColorAnalysis> {
    const nativeProbe = await readNativeNetpbmProbe(foregroundPath);
    if (nativeProbe) {
        return {
            dominantColor: nativeProbe.dominantColor,
            colorRatio: nativeProbe.colorRatio,
        };
    }
    const stats = await readNetpbmStats(foregroundPath);
    return {
        dominantColor: await readDominantForegroundColor(foregroundPath),
        colorRatio: stats.colorRatio,
    };
}

function hasRealForegroundColor(analysis: IForegroundColorAnalysis) {
    const spread = colorSpread(analysis.dominantColor);
    const maxChannel = Math.max(...analysis.dominantColor);
    return analysis.colorRatio > FOREGROUND_COLOR_RATIO_MIN
        && spread > FOREGROUND_COLOR_SATURATION_MIN
        && maxChannel >= FOREGROUND_NEAR_BLACK_MAX;
}

function resolveNativePdfImageCombinePath() {
    const isPackaged = __dirname.includes('app.asar');
    const binaryName = process.platform === 'win32'
        ? 'evb-pdf-image-combine.exe'
        : 'evb-pdf-image-combine';
    return resolveNativeToolPath({
        binaryName,
        crateName: 'pdf-image-combine',
        currentDir: __dirname,
        envOverridePath: process.env.EVB_PDF_IMAGE_COMBINE_PATH,
        isPackaged,
    });
}

function normalizePages(pages: number[] | undefined, pageCount: number) {
    if (pages) {
        return Array.from(new Set(pages.filter(page => Number.isInteger(page) && page >= 1 && page <= pageCount)))
            .sort((left, right) => left - right);
    }
    return [];
}

function* pageWindows(pages: readonly number[] | undefined, pageCount: number) {
    if (pages) {
        for (let offset = 0; offset < pages.length; offset += DJVU_COMPACT_PAGE_BATCH_SIZE) {
            yield pages.slice(offset, offset + DJVU_COMPACT_PAGE_BATCH_SIZE);
        }
        return;
    }
    for (let startPage = 1; startPage <= pageCount; startPage += DJVU_COMPACT_PAGE_BATCH_SIZE) {
        const endPage = Math.min(pageCount, startPage + DJVU_COMPACT_PAGE_BATCH_SIZE - 1);
        const window: number[] = [];
        for (let page = startPage; page <= endPage; page += 1) {
            window.push(page);
        }
        yield window;
    }
}

function resolvePageSizePoints(
    metrics: IDjvuConversionPageMetrics | null,
    sourceDpi: number,
    renderedInfo: Pick<INetpbmInfo, 'width' | 'height'>,
    renderedSubsample: number,
    structure: IDjvuPageStructure | null = null,
) {
    const dpi = positiveNumber(structure?.info?.dpi)
        ?? positiveNumber(sourceDpi)
        ?? DEFAULT_DPI;
    const width = positiveNumber(metrics?.width)
        ?? positiveNumber(structure?.info?.width)
        ?? renderedInfo.width * renderedSubsample;
    const height = positiveNumber(metrics?.height)
        ?? positiveNumber(structure?.info?.height)
        ?? renderedInfo.height * renderedSubsample;
    return {
        widthPoints: pointsFromPixels(width, dpi),
        heightPoints: pointsFromPixels(height, dpi),
    };
}

function pointsFromPixels(pixels: number, dpi: number) {
    return Math.max(1, pixels / Math.max(1, dpi) * 72);
}

function positiveNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

type TCompactManifestKind = 'image' | 'image-jpeg' | 'photo-jpeg' | 'layered' | 'layered-jpeg' | 'layered-color-jpeg' | 'mask';

function createManifestLine(
    kind: TCompactManifestKind,
    pageSize: {
        widthPoints: number;
        heightPoints: number;
    },
    paths: string[],
    options: {
        jpegQuality?: number;
        ppiCap?: number;
        foregroundColor?: [number, number, number];
    } = {},
) {
    for (const path of paths) {
        if (!canRepresentManifestPath(path)) {
            throw new Error(`Compact PDF manifest path is not representable: ${path}`);
        }
    }
    const fields = [
        kind,
        pageSize.widthPoints.toFixed(4),
        pageSize.heightPoints.toFixed(4),
    ];
    if (kind === 'image-jpeg' || kind === 'layered-jpeg' || kind === 'layered-color-jpeg') {
        fields.push(String(options.jpegQuality ?? DJVU_COMPACT_BACKGROUND_JPEG_QUALITY));
    }
    if (kind === 'photo-jpeg') {
        fields.push(
            String(options.jpegQuality ?? DJVU_COMPACT_PHOTO_JPEG_QUALITY),
            String(options.ppiCap ?? DJVU_COMPACT_PHOTO_PPI_CAP),
        );
    }
    fields.push(...paths);
    if (kind === 'layered-color-jpeg') {
        const color = options.foregroundColor ?? [
            0,
            0,
            0,
        ];
        fields.push(...color.map(channel => String(Math.min(255, Math.max(0, Math.round(channel))))));
    }
    return fields.join('\t');
}

function canRepresentManifestPath(path: string) {
    return path.length > 0
        && path.trim() === path
        && !/[\r\n\t]/u.test(path);
}

function readNativeNetpbmProbe(path: string) {
    return probeNativeNetpbm(resolveNativePdfImageCombinePath(), path);
}

async function readNetpbmStats(path: string) {
    const nativeProbe = await readNativeNetpbmProbe(path);
    if (nativeProbe) {
        if (nativeProbe.magic === 'P4') {
            throw new Error('PBM foreground probes are not supported');
        }
        return nativeProbe;
    }
    return readNetpbmStatsFallback(path);
}

async function readNetpbmStatsFallback(path: string) {
    await assertNetpbmReadSafe(path);
    const data = await readFile(path);
    const info = parseNetpbmInfo(data);
    if (info.magic === 'P4') {
        throw new Error('PBM foreground probes are not supported');
    }

    const payload = data.subarray(info.dataOffset);
    const totalPixels = info.width * info.height;
    let nonWhitePixels = 0;
    let darkPixels = 0;
    let colorPixels = 0;
    let maxDarkRun = 0;
    let minChannel = 255;
    let maxChannel = 0;

    if (info.magic === 'P5') {
        for (let y = 0; y < info.height; y += 1) {
            let darkRun = 0;
            for (let x = 0; x < info.width; x += 1) {
                const value = payload[y * info.width + x] ?? 255;
                minChannel = Math.min(minChannel, value);
                maxChannel = Math.max(maxChannel, value);
                const isNonWhite = value < 245;
                const isDark = value < 80;
                if (isNonWhite) {
                    nonWhitePixels += 1;
                }
                if (isDark) {
                    darkPixels += 1;
                    darkRun += 1;
                    maxDarkRun = Math.max(maxDarkRun, darkRun);
                } else {
                    darkRun = 0;
                }
            }
        }
    } else {
        for (let y = 0; y < info.height; y += 1) {
            let darkRun = 0;
            for (let x = 0; x < info.width; x += 1) {
                const offset = (y * info.width + x) * 3;
                const red = payload[offset] ?? 255;
                const green = payload[offset + 1] ?? 255;
                const blue = payload[offset + 2] ?? 255;
                const min = Math.min(red, green, blue);
                const max = Math.max(red, green, blue);
                minChannel = Math.min(minChannel, min);
                maxChannel = Math.max(maxChannel, max);
                const isNonWhite = red < 245 || green < 245 || blue < 245;
                const isDark = red < 80 && green < 80 && blue < 80;
                if (isNonWhite) {
                    nonWhitePixels += 1;
                    if (max - min > 12) {
                        colorPixels += 1;
                    }
                }
                if (isDark) {
                    darkPixels += 1;
                    darkRun += 1;
                    maxDarkRun = Math.max(maxDarkRun, darkRun);
                } else {
                    darkRun = 0;
                }
            }
        }
    }

    return {
        ...info,
        nonWhiteRatio: nonWhitePixels / totalPixels,
        darkRatio: darkPixels / totalPixels,
        colorRatio: colorPixels / Math.max(1, nonWhitePixels),
        maxDarkRunRatio: maxDarkRun / Math.max(1, info.width),
        minChannel,
        maxChannel,
    } satisfies INetpbmStats;
}

async function readDominantForegroundColor(path: string): Promise<[number, number, number]> {
    await assertNetpbmReadSafe(path);
    const data = await readFile(path);
    const info = parseNetpbmInfo(data);
    if (info.magic === 'P4') {
        throw new Error('PBM foreground color probes are not supported');
    }

    const payload = data.subarray(info.dataOffset);
    let redTotal = 0;
    let greenTotal = 0;
    let blueTotal = 0;
    let weightTotal = 0;

    if (info.magic === 'P5') {
        for (let index = 0; index < info.width * info.height; index += 1) {
            const value = payload[index] ?? 255;
            if (value >= FOREGROUND_DOMINANT_NON_WHITE_MAX) {
                continue;
            }
            const weight = 255 - value;
            redTotal += value * weight;
            greenTotal += value * weight;
            blueTotal += value * weight;
            weightTotal += weight;
        }
    } else {
        for (let index = 0; index < info.width * info.height; index += 1) {
            const offset = index * 3;
            const red = payload[offset] ?? 255;
            const green = payload[offset + 1] ?? 255;
            const blue = payload[offset + 2] ?? 255;
            const max = Math.max(red, green, blue);
            if (max >= FOREGROUND_DOMINANT_NON_WHITE_MAX) {
                continue;
            }
            const weight = 255 - max;
            redTotal += red * weight;
            greenTotal += green * weight;
            blueTotal += blue * weight;
            weightTotal += weight;
        }
    }

    if (weightTotal <= 0) {
        return [
            0,
            0,
            0,
        ];
    }
    return [
        Math.round(redTotal / weightTotal),
        Math.round(greenTotal / weightTotal),
        Math.round(blueTotal / weightTotal),
    ];
}

function colorSpread(color: [number, number, number]) {
    return Math.max(...color) - Math.min(...color);
}

async function readPbmMaskStats(path: string) {
    const nativeProbe = await readNativeNetpbmProbe(path);
    if (nativeProbe) {
        if (nativeProbe.magic !== 'P4') {
            throw new Error(`Unsupported foreground mask magic: ${nativeProbe.magic}`);
        }
        return nativeProbe;
    }
    return readPbmMaskStatsFallback(path);
}

async function readPbmMaskStatsFallback(path: string) {
    await assertNetpbmReadSafe(path);
    const data = await readFile(path);
    const info = parseNetpbmInfo(data);
    if (info.magic !== 'P4') {
        throw new Error(`Unsupported foreground mask magic: ${info.magic}`);
    }

    const rowStride = Math.ceil(info.width / 8);
    const payload = data.subarray(info.dataOffset);
    const expectedBytes = rowStride * info.height;
    if (payload.byteLength < expectedBytes) {
        throw new Error('Truncated PBM foreground mask payload');
    }

    let blackPixels = 0;
    let maxBlackRun = 0;
    for (let y = 0; y < info.height; y += 1) {
        let blackRun = 0;
        const rowOffset = y * rowStride;
        for (let x = 0; x < info.width; x += 1) {
            const byte = payload[rowOffset + Math.floor(x / 8)] ?? 0;
            const bit = (byte & (0x80 >> (x % 8))) !== 0;
            if (bit) {
                blackPixels += 1;
                blackRun += 1;
                maxBlackRun = Math.max(maxBlackRun, blackRun);
            } else {
                blackRun = 0;
            }
        }
    }

    const totalPixels = info.width * info.height;
    return {
        ...info,
        blackRatio: blackPixels / totalPixels,
        maxBlackRunRatio: maxBlackRun / Math.max(1, info.width),
    } satisfies IPbmMaskStats;
}

function isFlatBackground(stats: INetpbmStats) {
    if (stats.nonWhiteRatio <= BACKGROUND_FLAT_NON_WHITE_RATIO) {
        return true;
    }

    const colorTotalRatio = stats.colorRatio * stats.nonWhiteRatio;
    return stats.darkRatio === 0
        && stats.minChannel >= BACKGROUND_FLAT_MIN_CHANNEL
        && stats.maxChannel - stats.minChannel <= BACKGROUND_FLAT_CHANNEL_RANGE
        && colorTotalRatio <= BACKGROUND_FLAT_COLOR_RATIO;
}

async function assertNetpbmReadSafe(path: string) {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
        throw new Error(`Netpbm input is not a regular file: ${path}`);
    }
    if (fileStat.size > DJVU_COMPACT_NETPBM_MAX_INPUT_BYTES) {
        const maxMb = Math.floor(DJVU_COMPACT_NETPBM_MAX_INPUT_BYTES / (1024 * 1024));
        throw new Error(`Netpbm input exceeds safe read limit (${maxMb}MB): ${path}`);
    }
}

function parseNetpbmInfo(data: Buffer): INetpbmInfo {
    if (data.byteLength < 4) {
        throw new Error('Netpbm payload is too short');
    }
    const magic = data.subarray(0, 2).toString('ascii');
    if (magic !== 'P4' && magic !== 'P5' && magic !== 'P6') {
        throw new Error(`Unsupported Netpbm magic: ${magic}`);
    }

    const state = {offset: 2};
    const width = readNetpbmNumber(data, state, 'width');
    const height = readNetpbmNumber(data, state, 'height');
    if (magic !== 'P4') {
        const maxValue = readNetpbmNumber(data, state, 'max value');
        if (maxValue !== 255) {
            throw new Error(`Unsupported Netpbm max value: ${maxValue}`);
        }
    }
    if (state.offset >= data.byteLength || !isWhitespaceByte(data[state.offset]!)) {
        throw new Error('Invalid Netpbm header terminator');
    }
    state.offset += data[state.offset] === 0x0d && data[state.offset + 1] === 0x0a ? 2 : 1;
    if (width <= 0 || height <= 0) {
        throw new Error('Invalid Netpbm dimensions');
    }

    return {
        magic,
        width,
        height,
        dataOffset: state.offset,
    };
}

function readNetpbmNumber(
    data: Buffer,
    state: {offset: number},
    label: string,
) {
    skipNetpbmWhitespaceAndComments(data, state);
    let raw = '';
    while (state.offset < data.byteLength && !isWhitespaceByte(data[state.offset]!)) {
        raw += String.fromCharCode(data[state.offset]!);
        state.offset += 1;
    }
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid Netpbm ${label}`);
    }
    return value;
}

function skipNetpbmWhitespaceAndComments(data: Buffer, state: {offset: number}) {
    while (state.offset < data.byteLength) {
        const byte = data[state.offset]!;
        if (isWhitespaceByte(byte)) {
            state.offset += 1;
            continue;
        }
        if (byte === 0x23) {
            while (state.offset < data.byteLength && data[state.offset] !== 0x0a) {
                state.offset += 1;
            }
            continue;
        }
        break;
    }
}

function isWhitespaceByte(byte: number) {
    return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function throwIfAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw new Error('DjVu conversion canceled');
    }
}

function throwIfCanceledRenderResult(
    result: {
        success: boolean;
        error?: string;
    },
    signal: AbortSignal | undefined,
) {
    throwIfAborted(signal);
    if (!result.success && result.error?.includes('DjVu conversion canceled')) {
        throw new Error('DjVu conversion canceled');
    }
}
