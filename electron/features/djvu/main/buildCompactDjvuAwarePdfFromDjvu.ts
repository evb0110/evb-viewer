import { randomUUID } from 'node:crypto';
import { createAbortError } from '@contracts/isAbortError';
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
import {
    DJVU_COMPACT_FOREGROUND_DOMINANT_NON_WHITE_MAX,
    DJVU_COMPACT_FOREGROUND_SUBSAMPLE,
    DJVU_COMPACT_REAL_MASK_MIN_BYTES,
    getDjvuCompactFidelity,
    hasDjvuCompactForegroundColor,
    isDjvuCompactFlatBackground,
    measureDjvuCompactRasterStats,
    type IDjvuConversionPageMetrics,
    type TDjvuCompactFidelityPreset,
} from '@contracts/djvuConversionPolicy';
import { runDjvuEngine } from '@electron/features/djvu/main/djvuEnginePool';
import {
    renderDjvuPageToImage,
    runRegisteredDjvuProcess,
    withDjvuNativeResourceLease,
} from '@electron/features/djvu/main/ddjvuConversion';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { probeNativeNetpbm } from '@electron/features/djvu/main/probeNativeNetpbm';
import { withCompactDjvuResourceLease } from '@electron/features/djvu/main/withCompactDjvuResourceLease';
import type {
    IJobBrokerRunContext,
    TTerminationProofSink,
} from '@electron/resources/jobBroker';
import {createPdfCombineProgressHandler} from '@evb/scan-cleanup/core/createPdfCombineProgressHandler';
import {readPpmDimensions} from '@evb/scan-cleanup/core/rasterLayerDimensions';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    getUnprovenNativeTerminationDetail, markUnprovenNativeTermination,
} from '@electron/utils/nativeTerminationProof';
import {runtimeConfig} from '@electron/runtimeConfig';
import { openCompactDjvuFidelityManifestWriter } from '@electron/features/djvu/main/openCompactDjvuFidelityManifestWriter';
import {
    loadOrBuildCompactDjvuPage,
    openCompactDjvuCheckpointJob,
    type ICheckpointedCompactPageSpec as ICompactPageSpec,
} from '@electron/features/djvu/main/compactDjvuCheckpoint';
import {
    assertDjvuSourceIdentity,
    createDjvuDiskQuotaMonitor,
    type IDjvuSourceIdentity,
    releaseDjvuArtifactConsumer,
} from '@electron/features/djvu/main/djvuArtifactManifest';
import {
    createFileBackedPdfCombineEnv,
    createPdfCombineOutputTooLargeError,
    isPdfCombineOutputTooLargeError,
    PDF_COMBINE_OUTPUT_POLICY,
} from '@contracts/pdfCombineOutputPolicy';
import * as v from 'valibot';

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
    /** The page lease's run context, so page renders and probes reuse that lease. */
    brokerRun?: IJobBrokerRunContext;
    /** The page lease's proof sink, so every page render runs under that lease. */
    onTerminationProof?: TTerminationProofSink;
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

const DJVU_COMPACT_MAX_PAGE_BYTES = 0xffffffff;
const positiveIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const boundedPageBytesSchema = v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(0),
    v.maxValue(DJVU_COMPACT_MAX_PAGE_BYTES),
);
const djvuPageInfoSchema = v.object({
    width: positiveIntegerSchema,
    height: positiveIntegerSchema,
    dpi: positiveIntegerSchema,
});
const djvuLayerInfoSchema = v.object({
    present: v.boolean(),
    kind: v.string(),
    bytes: boundedPageBytesSchema,
    width: v.optional(v.fallback(v.nullable(positiveIntegerSchema), null)),
    height: v.optional(v.fallback(v.nullable(positiveIntegerSchema), null)),
    subsample: v.optional(v.fallback(v.nullable(positiveIntegerSchema), null)),
});
const djvuPageStructureSchema = v.object({
    pageNumber: positiveIntegerSchema,
    pageBytes: v.nullable(boundedPageBytesSchema),
    info: v.fallback(v.nullable(djvuPageInfoSchema), null),
    hasMask: v.boolean(),
    maskBytes: v.nullable(boundedPageBytesSchema),
    background: v.fallback(v.nullable(djvuLayerInfoSchema), null),
    foreground: v.fallback(v.nullable(djvuLayerInfoSchema), null),
});

type IDjvuPageInfo = v.InferOutput<typeof djvuPageInfoSchema>;
type IDjvuLayerInfo = v.InferOutput<typeof djvuLayerInfoSchema>;
type IDjvuPageStructure = v.InferOutput<typeof djvuPageStructureSchema>;

const logger = createLogger('djvu-compact-pdf');
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRESS_EXTRACTION_CAP = 86;
const PROGRESS_COMBINE_START = 88;
const PROGRESS_COMBINE_CAP = 94;
const DEFAULT_DPI = 300;
const DJVU_COMPACT_MAX_PAGE_WORKERS = 2;
const DJVU_COMPACT_BACKGROUND_JPEG_QUALITY = 80;
const DJVU_COMPACT_PHOTO_JPEG_QUALITY = 85;
const DJVU_COMPACT_PHOTO_PPI_CAP = 300;

const DJVU_COMPACT_NETPBM_MAX_INPUT_BYTES = 192 * 1024 * 1024;
const DJVU_COMPACT_DUMP_TIMEOUT_MS = 60_000;
const DJVU_COMPACT_DUMP_MAX_LINE_BYTES = 256 * 1024;
const DJVU_COMPACT_PAGE_BATCH_SIZE = 32;
const DJVU_COMPACT_RESULT_SPEC_LIMIT = 256;
const COMPACT_MANIFEST_JSONL_FORMAT = 'evb-pdf-image-combine-jsonl';
const COMPACT_MANIFEST_JSONL_SCHEMA_VERSION = 1;
const DJVU_NATIVE_LAYER_DEFAULT_SUBSAMPLE = 1;
const DJVU_COMPACT_MIN_SUBSAMPLE = 1;
const DJVU_COMPACT_MAX_SUBSAMPLE = 64;
const DJVU_COMPACT_LAYER_DIMENSION_MATCH_TOLERANCE = 0.25;
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
    let consumersReleased = false;
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
            task: () => readDjvuPageStructures(
                options.djvuPath,
                options.jobId,
                options.signal,
                structurePath,
                options.pages ? selectedPages : undefined,
            ),
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
                await releaseDjvuArtifactConsumer(checkpointJob.directory, {remove: false});
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
                        task: brokerRun => buildCompactPageSpec(
                            {
                                ...conversionOptions,
                                brokerRun,
                                onTerminationProof: brokerRun.onTerminationProof,
                            },
                            pageTempDir,
                            pageNumber,
                            pageStructures.get(pageNumber) ?? null,
                        ),
                    }));
                    await activeQuotaMonitor.checkNow();
                    throwIfAborted(activeQuotaMonitor.signal);
                    // Count each page as it finishes; a window holds up to 32
                    // pages, so counting per window left short books at 0%.
                    completedPageCount += 1;
                    emitProgress(Math.round((completedPageCount / selectedPageCount) * PROGRESS_EXTRACTION_CAP));
                    return pageSpec;
                }, workerCount);

                let pageSpecs: ICompactPageSpec[];
                const pageTasks = pages.map(buildPageWithLimit);
                try {
                    pageSpecs = await Promise.all(pageTasks);
                } catch (error) {
                    activeQuotaMonitor.cancel(error);
                    const settled = await Promise.allSettled(pageTasks);
                    const unproven = settled.find(result => result.status === 'rejected'
                        && getUnprovenNativeTerminationDetail(result.reason) !== undefined);
                    if (unproven?.status === 'rejected') {
                        throw markUnprovenNativeTermination(
                            new AggregateError([
                                error,
                                unproven.reason,
                            ], getErrorMessage(error)),
                            getUnprovenNativeTerminationDetail(unproven.reason)!,
                        );
                    }
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
            task: async (brokerRun) => {
                const combined = await runRegisteredDjvuProcess(
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
                        brokerRun,
                        // A book-length combine can outlast any fixed deadline;
                        // it streams per-page progress, so only silence times out.
                        timeoutResetsOnStdout: true,
                        // The PDF stays a file under the disk-quota monitor above;
                        // only byte-returning combines take the shared memory cap.
                        env: {
                            ...process.env,
                            ...createFileBackedPdfCombineEnv({maxPages: selectedPageCount}),
                        },
                        onStdout: createPdfCombineProgressHandler(
                            selectedPageCount,
                            (processed, total) => emitProgress(PROGRESS_COMBINE_START + Math.round(
                                (processed / total) * (PROGRESS_COMBINE_CAP - PROGRESS_COMBINE_START),
                            )),
                            line => logger.debug(`Ignoring malformed native compact PDF progress: ${line}`),
                        ),
                    },
                );
                // Thrown inside the lease, so a combiner not proven gone keeps it charged.
                const unprovenTermination = combined.success
                    ? undefined
                    : getUnprovenNativeTerminationDetail(combined.cause);
                if (!combined.success && unprovenTermination !== undefined) {
                    throw combined.cause instanceof Error
                        ? combined.cause
                        : new Error(`${combined.error}: ${unprovenTermination}`);
                }
                return combined;
            },
        });
        if (!result.success) {
            const nativeCode = typeof result.cause === 'object'
                && result.cause !== null
                && 'code' in result.cause
                ? result.cause.code
                : undefined;
            if (nativeCode === PDF_COMBINE_OUTPUT_POLICY.tooLargeCode
                || isPdfCombineOutputTooLargeError(result.cause)) {
                await rm(options.outputPath, {force: true}).catch(() => undefined);
                throw createPdfCombineOutputTooLargeError(result.error);
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
            emitProgress(PROGRESS_COMBINE_CAP);
            await releaseCompactBatchJobs(batchDirectoriesPath, {remove: true});
            consumersReleased = true;
            return {
                success: true,
                outputPath: options.outputPath,
                fileSize: s.size,
                pageSpecs: resultPageSpecs,
            };
        } catch (error) {
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
        if (!consumersReleased) await releaseCompactBatchJobs(batchDirectoriesPath, {remove: false}).catch(() => undefined);
        await rm(batchDirectoriesPath, {force: true}).catch(() => undefined);
    }
}

/** Lets go of this export's checkpoint directories; the last export to read one removes it. */
async function releaseCompactBatchJobs(path: string, options: {remove: boolean}) {
    const input = createReadStream(path, {encoding: 'utf8'});
    const lines = createInterface({
        input,
        crlfDelay: Infinity,
    });
    try {
        for await (const line of lines) {
            if (line.trim()) await releaseDjvuArtifactConsumer(line, options);
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
    pageNumbers?: readonly number[],
): Promise<string> {
    let fileDescriptor: number | null = null;
    try {
        const rawStructures = await runDjvuEngine<'getPageStructures'>({
            type: 'getPageStructures',
            djvuPath,
            ...(pageNumbers ? { pageNumbers } : {}),
        }, {
            ...(signal ? { signal } : {}),
            timeoutMs: DJVU_COMPACT_DUMP_TIMEOUT_MS,
        });
        fileDescriptor = openSync(outputPath, 'w');
        for (const raw of rawStructures) {
            const pageInfo = raw.info && raw.info.width > 0 && raw.info.height > 0 && raw.info.dpi > 0
                ? {
                    width: raw.info.width,
                    height: raw.info.height,
                    dpi: raw.info.dpi,
                }
                : null;
            const background = raw.background
                ? createDjvuLayerInfo(
                    raw.background.kind,
                    raw.background.bytes,
                    raw.background.width !== null
                        && raw.background.height !== null
                        && raw.background.width > 0
                        && raw.background.height > 0
                        ? {
                            width: raw.background.width,
                            height: raw.background.height,
                        }
                        : null,
                    pageInfo,
                )
                : null;
            const foreground = raw.foreground
                ? createDjvuLayerInfo(
                    raw.foreground.kind,
                    raw.foreground.bytes,
                    raw.foreground.width !== null
                        && raw.foreground.height !== null
                        && raw.foreground.width > 0
                        && raw.foreground.height > 0
                        ? {
                            width: raw.foreground.width,
                            height: raw.foreground.height,
                        }
                        : null,
                    pageInfo,
                )
                : null;
            const structure: IDjvuPageStructure = {
                pageNumber: raw.pageNumber,
                pageBytes: raw.pageBytes,
                info: pageInfo,
                hasMask: raw.hasMask,
                maskBytes: raw.maskBytes,
                background,
                foreground,
            };
            const data = Buffer.from(`${JSON.stringify(structure)}\n`, 'utf8');
            let offset = 0;
            while (offset < data.length) {
                offset += writeSync(fileDescriptor, data, offset);
            }
        }
        closeSync(fileDescriptor);
        fileDescriptor = null;
        if (rawStructures.length > 0) {
            logger.debug(`[${jobId}] Read DjVu native layer structure for ${rawStructures.length} page(s)`);
        }
        return outputPath;
    } catch (error) {
        if (fileDescriptor !== null) {
            const fd = fileDescriptor;
            fileDescriptor = null;
            closeSync(fd);
        }
        await rm(outputPath, {force: true}).catch(() => undefined);
        if (getUnprovenNativeTerminationDetail(error) !== undefined) {
            throw error;
        }
        throw new Error(`DjVu layer structure inspection failed; compact export stopped without flattening the document: ${getErrorMessage(error)}`);
    }
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
    const result = v.safeParse(djvuPageStructureSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
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

async function buildCompactPageSpec(
    options: ICompactDjvuPdfExportOptions,
    pageTempDir: string,
    pageNumber: number,
    structure: IDjvuPageStructure | null,
): Promise<ICompactPageSpec> {
    const pagePrefix = join(pageTempDir, `page-${String(pageNumber).padStart(5, '0')}-${randomUUID()}`);
    const fidelity = getDjvuCompactFidelity(options.qualityPreset);
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
    const maskStats = await readPbmMaskStats(maskPath, options);
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
        ? await analyzeForegroundColor(foregroundColorPath, options)
        : null;

    if (foregroundColor && hasDjvuCompactForegroundColor(foregroundColor)) {
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
    const backgroundStats = await readNetpbmStats(backgroundPath, options);
    if (isDjvuCompactFlatBackground(backgroundStats)) {
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
            ...(options.signal ? {signal: options.signal} : {}),
            ...(options.onTerminationProof ? {onTerminationProof: options.onTerminationProof} : {}),
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
            ...(options.signal ? {signal: options.signal} : {}),
            ...(options.onTerminationProof ? {onTerminationProof: options.onTerminationProof} : {}),
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
            ...(options.signal ? {signal: options.signal} : {}),
            ...(options.onTerminationProof ? {onTerminationProof: options.onTerminationProof} : {}),
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
    const fidelity = getDjvuCompactFidelity(options.qualityPreset);
    const result = await renderDjvuPageToImage(
        options.djvuPath,
        photoPath,
        pageNumber,
        `${options.jobId}-compact-page-${pageNumber}-photo`,
        {
            ...renderOptions,
            ...(options.signal ? {signal: options.signal} : {}),
            ...(options.onTerminationProof ? {onTerminationProof: options.onTerminationProof} : {}),
        },
    );
    throwIfCanceledRenderResult(result, options.signal);
    if (!result.success) {
        throw new Error(result.error ?? `Failed to render compact photo page ${pageNumber}`);
    }

    // Only the rendered size is needed; its header has it, without a native probe per page.
    const pageSize = resolvePageSizePoints(
        options.pageSizes?.[pageNumber - 1] ?? null,
        options.sourceDpi,
        await readPpmDimensions(photoPath),
        renderOptions.subsample ?? DJVU_NATIVE_LAYER_DEFAULT_SUBSAMPLE,
        structure,
    );
    return {
        pageNumber,
        kind: 'photo',
        reason,
        effectivePpi: Math.min(structure?.info?.dpi ?? options.pageSizes?.[pageNumber - 1]?.dpi ?? options.sourceDpi, fidelity.ppiCap),
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
    const dpi = positiveNumber(pageInfo?.dpi) ?? positiveNumber(metrics?.dpi) ?? positiveNumber(options.sourceDpi) ?? DEFAULT_DPI;
    const fidelity = getDjvuCompactFidelity(options.qualityPreset);
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

async function analyzeForegroundColor(
    foregroundPath: string,
    options?: Pick<ICompactDjvuPdfExportOptions, 'brokerRun' | 'signal'>,
): Promise<IForegroundColorAnalysis> {
    const nativeProbe = await readNativeNetpbmProbe(foregroundPath, options);
    if (nativeProbe) {
        return {
            dominantColor: nativeProbe.dominantColor,
            colorRatio: nativeProbe.colorRatio,
        };
    }
    const stats = await readNetpbmStats(foregroundPath, options);
    return {
        dominantColor: await readDominantForegroundColor(foregroundPath),
        colorRatio: stats.colorRatio,
    };
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
        envOverridePath: runtimeConfig.pdfImageCombinePath,
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
    // An indirect document's index holds no page INFO; the page's own
    // resolution then comes with its size.
    const dpi = positiveNumber(structure?.info?.dpi)
        ?? positiveNumber(metrics?.dpi)
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

function readNativeNetpbmProbe(
    path: string,
    options?: Pick<ICompactDjvuPdfExportOptions, 'brokerRun' | 'signal'>,
) {
    return probeNativeNetpbm(resolveNativePdfImageCombinePath(), path, options);
}

async function readNetpbmStats(
    path: string,
    options?: Pick<ICompactDjvuPdfExportOptions, 'brokerRun' | 'signal'>,
) {
    const nativeProbe = await readNativeNetpbmProbe(path, options);
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

    return {
        ...info,
        ...measureDjvuCompactRasterStats(data.subarray(info.dataOffset), info.width, info.height, info.magic === 'P5' ? 1 : 3),
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
            if (value >= DJVU_COMPACT_FOREGROUND_DOMINANT_NON_WHITE_MAX) {
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
            if (max >= DJVU_COMPACT_FOREGROUND_DOMINANT_NON_WHITE_MAX) {
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

async function readPbmMaskStats(
    path: string,
    options?: Pick<ICompactDjvuPdfExportOptions, 'brokerRun' | 'signal'>,
) {
    const nativeProbe = await readNativeNetpbmProbe(path, options);
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
        throw createAbortError('DjVu conversion canceled');
    }
}

function throwIfCanceledRenderResult(
    result: {
        success: boolean;
        error?: string;
        cause?: unknown;
    },
    signal: AbortSignal | undefined,
) {
    if (getUnprovenNativeTerminationDetail(result.cause) !== undefined) throw result.cause;
    throwIfAborted(signal);
    if (!result.success && result.error?.includes('DjVu conversion canceled')) {
        throw createAbortError('DjVu conversion canceled');
    }
}
