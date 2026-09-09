import { existsSync } from 'fs';
import {
    stat,
    unlink,
} from 'fs/promises';
import { limitAsync } from 'es-toolkit/promise';
import { clamp } from 'es-toolkit/math';
import { dirname } from 'node:path';
import { buildDjvuRuntimeEnv } from '@electron/features/djvu/main/buildDjvuRuntimeEnv';
import { getDjvuNativeToolPaths } from '@electron/features/djvu/main/nativeToolPaths';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    cancelNativeCommandGroup,
    runNativeCommand,
} from '@electron/native-tools/runNativeCommand';
import type { IRunCommandOptions } from '@electron/native-tools/runNativeCommand';
import { abortErrorFromSignal } from '@electron/utils/abort';
import {
    createDjvuDiskQuotaMonitor,
    openDjvuArtifactJob,
} from '@electron/features/djvu/main/djvuArtifactManifest';
import { mainJobBroker } from '@electron/resources/jobBroker';
import type { THostResourceTier } from '@contracts/hostResourceProfile';
import { getHostResourceProfileSnapshot } from '@electron/resources/hostResourceProfile';
import { PdfCombineCapabilityError } from '@electron/image/pdfCombineErrors';

interface IDjvuConversionOptions {
    subsample?: number;
    pages?: string;
    pageCount?: number;
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
}

export interface IRegisteredDjvuProcessOptions {
    env?: NodeJS.ProcessEnv;
    onStderr?: (chunk: string) => void;
    onStdout?: (chunk: string) => void;
    timeoutMs?: number;
    maxStderrBytes?: number;
    signal?: AbortSignal;
}

interface IDjvuConversionResult {
    success: boolean;
    outputPath: string;
    fileSize: number;
    error?: string;
}

const MAX_RANGE_WORKERS = 12;
const MIN_PAGES_FOR_RANGE_PARALLELISM = 24;
const PROGRESS_CAP = 90;
const DJVU_PROCESS_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_PROCESS_TIMEOUT_MS ?? `${4 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 4 * 60 * 1000;
    }
    return parsed;
})();
const DJVU_IMAGE_PROCESS_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_IMAGE_PROCESS_TIMEOUT_MS ?? `${2 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 2 * 60 * 1000;
    }
    return parsed;
})();
const DJVU_KILL_GRACE_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_KILL_GRACE_MS ?? '2000', 10);
    if (!Number.isFinite(parsed) || parsed < 250) {
        return 2_000;
    }
    return parsed;
})();
const DJVU_MAX_STDERR_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_MAX_STDERR_BYTES ?? '262144', 10);
    if (!Number.isFinite(parsed) || parsed < 1_024) {
        return 262_144;
    }
    return parsed;
})();
const activeProcessIds = new Set<string>();
const canceledProcessIds = new Set<string>();
const logger = createLogger('djvu-convert');
const DJVU_CONVERSION_CANCELED_MESSAGE = 'DjVu conversion canceled';

export async function withDjvuNativeResourceLease<T>(options: {
    jobId: string;
    kind: 'metadata' | 'structure';
    signal?: AbortSignal;
    task: () => Promise<T>;
}) {
    const lease = await mainJobBroker.acquire({
        ownerId: options.jobId,
        kind: `djvu-${options.kind}`,
        priority: 'user',
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: 64 * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 1,
        },
        ...(options.signal ? {signal: options.signal} : {}),
    });
    try {
        return await options.task();
    } finally {
        lease.release();
    }
}

function getDjvuQuotaFailureMessage(quotaMonitor: {failure: {message: string} | null}) {
    return quotaMonitor.failure?.message;
}

interface IDjvuPageRangeChunk {
    index: number;
    startPage: number;
    endPage: number;
    outputPath: string;
}

async function cleanupPartialOutput(outputPath: string) {
    try {
        if (!existsSync(outputPath)) {
            return;
        }
        await unlink(outputPath);
    } catch {
        // Ignore cleanup failures for partial outputs.
    }
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

async function _convertDjvuToPdfWithRanges(
    inputPath: string,
    outputPath: string,
    jobId: string,
    options: IDjvuConversionOptions,
): Promise<IDjvuConversionResult> {
    const totalPages = options.pageCount ?? 0;
    const workerCount = getRangeWorkerCount(totalPages);
    if (workerCount < 2) {
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: 'Parallel conversion is not applicable',
        };
    }

    const pageRanges = createPageRanges(totalPages, workerCount);
    const artifactJob = await openDjvuArtifactJob(inputPath, pageRanges, {...(options.subsample === undefined ? {} : {subsample: options.subsample})});
    const chunks = artifactJob.manifest.ranges.map((range, index) => ({
        index,
        startPage: range.startPage,
        endPage: range.endPage,
        outputPath: range.outputPath,
    }));
    const chunkPaths = chunks.map(chunk => chunk.outputPath);
    let completedPageCount = 0;
    let firstError = null as string | null;
    const quotaMonitor = await createDjvuDiskQuotaMonitor({
        paths: [
            artifactJob.directory,
            outputPath,
        ],
        fileSystemPath: artifactJob.directory,
        maxTotalBytes: artifactJob.maxTotalBytes,
        ...(options.signal ? {signal: options.signal} : {}),
    }).catch(async (error: unknown) => {
        await artifactJob.close();
        return error instanceof Error ? error : new Error(String(error));
    });
    if (quotaMonitor instanceof Error) {
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: getErrorMessage(quotaMonitor),
        };
    }
    const conversionSignal = quotaMonitor.signal;
    try {
        const convertChunkWithLimit = limitAsync(async (chunk: IDjvuPageRangeChunk) => {
            throwIfAborted(conversionSignal);
            if (firstError) {
                return firstError;
            }

            const checkpoint = artifactJob.manifest.ranges[chunk.index];
            if (checkpoint?.status === 'verified') {
                completedPageCount += chunk.endPage - chunk.startPage + 1;
                options.onProgress?.(Math.min(
                    PROGRESS_CAP,
                    Math.round((completedPageCount / totalPages) * PROGRESS_CAP),
                ));
                return null;
            }
            await artifactJob.updateRange(chunk.index, {status: 'running'});

            const rangeJobId = `${jobId}-range-${chunk.index + 1}-pages-${chunk.startPage}-${chunk.endPage}`;
            const brokerLease = await mainJobBroker.acquire({
                ownerId: jobId,
                kind: 'djvu-range-conversion',
                priority: 'user',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 96 * 1024 * 1024,
                    nativeProcesses: 1,
                    ioWeight: 2,
                },
                signal: conversionSignal,
            });
            if (firstError) {
                brokerLease.release();
                return firstError;
            }
            const pageResult = await convertPageRangeToPdf(
                inputPath,
                chunk.outputPath,
                rangeJobId,
                chunk.startPage,
                chunk.endPage,
                options.subsample,
                conversionSignal,
            ).finally(() => brokerLease.release());

            if (!pageResult.success) {
                const pageError = getDjvuQuotaFailureMessage(quotaMonitor)
                    ?? pageResult.error
                    ?? `Failed to convert pages ${chunk.startPage}-${chunk.endPage}`;
                await cleanupPartialOutput(chunk.outputPath);
                await artifactJob.updateRange(chunk.index, {
                    status: 'failed',
                    error: pageError,
                });
                if (!firstError) {
                    // Preserve the initiating failure before canceling sibling
                    // processes, whose cancellation results must not suppress
                    // the safe single-process fallback.
                    firstError = pageError;
                    await cancelConversion(jobId);
                }
                return firstError;
            }

            if (firstError) {
                return firstError;
            }

            const artifact = await stat(chunk.outputPath);
            if (artifact.size <= 0) {
                await artifactJob.updateRange(chunk.index, {
                    status: 'failed',
                    error: 'Range artifact is empty',
                });
                firstError = `Converted pages ${chunk.startPage}-${chunk.endPage} produced an empty artifact`;
                return firstError;
            }
            try {
                await quotaMonitor.checkNow();
                await artifactJob.updateRange(chunk.index, {
                    status: 'verified',
                    size: artifact.size,
                });
            } catch (error) {
                const verificationError = getErrorMessage(error);
                firstError = firstError ?? verificationError;
                await cancelConversion(jobId);
                return firstError;
            }

            completedPageCount += chunk.endPage - chunk.startPage + 1;
            if (options.onProgress) {
                const percent = Math.min(
                    PROGRESS_CAP,
                    Math.round((completedPageCount / totalPages) * PROGRESS_CAP),
                );
                options.onProgress(percent);
            }
            return null;
        }, workerCount);

        const conversionErrors = await Promise.all(chunks.map(convertChunkWithLimit));
        for (const conversionError of conversionErrors) {
            if (conversionError !== null) {
                firstError = firstError ?? conversionError;
                break;
            }
        }

        if (firstError) {
            await cleanupPartialOutput(outputPath);
            return {
                success: false,
                outputPath,
                fileSize: 0,
                error: firstError,
            };
        }

        throwIfAborted(conversionSignal);
        let mergeResult: Awaited<ReturnType<typeof mergePdfChunks>>;
        try {
            mergeResult = await mergePdfChunks(
                chunkPaths,
                outputPath,
                `${jobId}-merge`,
                conversionSignal,
            );
        } catch (error) {
            await cleanupPartialOutput(outputPath);
            throw error;
        }
        if (!mergeResult.success) {
            await cleanupPartialOutput(outputPath);
            return {
                success: false,
                outputPath,
                fileSize: 0,
                error: getDjvuQuotaFailureMessage(quotaMonitor)
                    ?? mergeResult.error,
            };
        }

        try {
            await quotaMonitor.checkNow();
            const s = await stat(outputPath);
            if (options.onProgress) {
                options.onProgress(PROGRESS_CAP + 5);
            }
            await artifactJob.cleanup?.().catch((error: unknown) => {
                logger.debug(`Failed to cleanup successful DjVu range artifacts: ${getErrorMessage(error)}`);
            });
            return {
                success: true,
                outputPath,
                fileSize: s.size,
            };
        } catch (err) {
            return {
                success: false,
                outputPath,
                fileSize: 0,
                error: getDjvuQuotaFailureMessage(quotaMonitor)
                    ?? `Output file not found after parallel conversion: ${getErrorMessage(err)}`,
            };
        }
    } finally {
        await quotaMonitor.stop();
        // Verified range artifacts intentionally survive failures and process exits for resume.
        await artifactJob.close();
    }
}

async function _convertDjvuToPdfSingleProcess(
    inputPath: string,
    outputPath: string,
    jobId: string,
    options: IDjvuConversionOptions,
    totalPages: number,
): Promise<IDjvuConversionResult> {
    const quotaMonitor = await createDjvuDiskQuotaMonitor({
        paths: [outputPath],
        fileSystemPath: dirname(outputPath),
        ...(options.signal ? {signal: options.signal} : {}),
    }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    if (quotaMonitor instanceof Error) {
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: getErrorMessage(quotaMonitor),
        };
    }

    try {
        const brokerLease = await mainJobBroker.acquire({
            ownerId: jobId,
            kind: 'djvu-conversion',
            priority: 'user',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 128 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 2,
            },
            signal: quotaMonitor.signal,
        });
        const args = buildPdfArgs(inputPath, outputPath, options.subsample, options.pages);
        // A single ddjvu process reports completed pages in ascending order. Keep
        // only the last marker and a scalar count, so progress cannot grow a
        // page-sized Set for very large documents. Repeated markers remain
        // idempotent, which preserves the old progress behavior on noisy stderr.
        let lastProgressPage = 0;
        let completedPageCount = 0;
        const result = await runProcess(
            jobId,
            getDjvuNativeToolPaths().ddjvu,
            args,
            {
                env: buildDjvuRuntimeEnv(),
                signal: quotaMonitor.signal,
                onStderr: (chunk) => {
                    if (!options.onProgress || totalPages <= 0) {
                        return;
                    }
                    const pageMatches = chunk.matchAll(/-------- page (\d+)/g);
                    for (const match of pageMatches) {
                        const pageNum = parseInt(match[1] ?? '0', 10);
                        if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > totalPages) {
                            continue;
                        }
                        if (pageNum <= lastProgressPage) {
                            continue;
                        }
                        lastProgressPage = pageNum;
                        completedPageCount += 1;
                        const percent = Math.min(
                            PROGRESS_CAP,
                            Math.round((completedPageCount / totalPages) * PROGRESS_CAP),
                        );
                        options.onProgress(percent);
                    }
                },
            },
        ).finally(() => brokerLease.release());

        if (!result.success) {
            await cleanupPartialOutput(outputPath);
            return {
                success: false,
                outputPath,
                fileSize: 0,
                error: getDjvuQuotaFailureMessage(quotaMonitor) ?? result.error,
            };
        }

        await quotaMonitor.checkNow();
        const s = await stat(outputPath);
        return {
            success: true,
            outputPath,
            fileSize: s.size,
        };
    } catch (err) {
        await cleanupPartialOutput(outputPath);
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: getDjvuQuotaFailureMessage(quotaMonitor)
                ?? `DjVu conversion failed: ${getErrorMessage(err)}`,
        };
    } finally {
        await quotaMonitor.stop();
    }
}

export async function convertDjvuToPdfFile(
    inputPath: string,
    outputPath: string,
    jobId: string,
    options: IDjvuConversionOptions = {},
): Promise<IDjvuConversionResult> {
    const totalPages = options.pageCount ?? 0;
    if (_shouldUseParallelRangeConversion(options)) {
        const parallelResult = await _convertDjvuToPdfWithRanges(
            inputPath,
            outputPath,
            jobId,
            options,
        );
        if (parallelResult.success || shouldSkipSingleProcessFallback(parallelResult.error)) {
            return parallelResult;
        }

        logger.warn(
            `[${jobId}] Parallel DjVu range conversion failed, falling back to single process: ${parallelResult.error ?? 'unknown error'}`,
        );
        await cleanupPartialOutput(outputPath);
    }

    return _convertDjvuToPdfSingleProcess(
        inputPath,
        outputPath,
        jobId,
        options,
        totalPages,
    );
}

async function convertPageRangeToPdf(
    inputPath: string,
    outputPath: string,
    pageJobId: string,
    startPage: number,
    endPage: number,
    subsample: number | undefined,
    signal?: AbortSignal,
) {
    const pages = startPage === endPage
        ? String(startPage)
        : `${startPage}-${endPage}`;
    const args = buildPdfArgs(
        inputPath,
        outputPath,
        subsample,
        pages,
    );
    const result = await runProcess(
        pageJobId,
        getDjvuNativeToolPaths().ddjvu,
        args,
        {
            env: buildDjvuRuntimeEnv(),
            ...(signal ? { signal } : {}),
        },
    );

    if (!result.success) {
        return {
            success: false,
            error: result.error,
        };
    }

    return { success: true };
}

async function mergePdfChunks(
    chunkPaths: string[],
    outputPath: string,
    mergeJobId: string,
    signal?: AbortSignal,
) {
    let qpdf: string;
    try {
        qpdf = getPdfNativeToolPaths().qpdf;
    } catch (error) {
        throw createDjvuNativeCapabilityError(
            'native-unavailable',
            `DjVu PDF chunk merge cannot find qpdf: ${getErrorMessage(error)}`,
            error,
        );
    }

    const qpdfResult = await runProcess(
        mergeJobId,
        qpdf,
        [
            '--empty',
            '--pages',
            ...chunkPaths,
            '--',
            outputPath,
        ],
        signal ? { signal } : {},
    );
    if (qpdfResult.success) {
        return { success: true as const };
    }

    if (isDjvuConversionCancellationError(qpdfResult.error)) {
        return qpdfResult;
    }

    throw createDjvuNativeCapabilityError(
        'native-failure',
        `DjVu PDF chunk merge failed: ${qpdfResult.error}`,
        qpdfResult.cause,
    );
}

function createDjvuNativeCapabilityError(
    code: 'native-unavailable' | 'native-failure',
    message: string,
    cause?: unknown,
) {
    return new PdfCombineCapabilityError(code, message, {
        ...(cause === undefined ? {} : {cause}),
        operation: 'djvu-pdf-merge',
    });
}

function buildPdfArgs(
    inputPath: string,
    outputPath: string,
    subsample?: number,
    pages?: string,
) {
    const args = [
        '-format=pdf',
        '-verbose',
    ];

    if (subsample && subsample > 1) {
        args.push(`-subsample=${subsample}`);
    }

    if (pages) {
        args.push(`-page=${pages}`);
    }

    args.push(inputPath, outputPath);
    return args;
}

type TImageFormat = 'pbm' | 'pgm' | 'ppm';
type TDjvuRenderMode = 'background' | 'black' | 'foreground' | 'mask';

export async function convertDjvuPageToImage(
    inputPath: string,
    outputPath: string,
    pageNum: number,
    jobId: string,
    options: {
        subsample?: number;
        format?: TImageFormat;
        signal?: AbortSignal;
        targetHeightPx?: number;
        targetWidthPx?: number;
    } = {},
): Promise<IDjvuConversionResult> {
    return renderDjvuPageToImage(inputPath, outputPath, pageNum, jobId, options);
}

export async function renderDjvuPageToImage(
    inputPath: string,
    outputPath: string,
    pageNum: number,
    jobId: string,
    options: {
        subsample?: number;
        format?: TImageFormat;
        mode?: TDjvuRenderMode;
        signal?: AbortSignal;
        targetHeightPx?: number;
        targetWidthPx?: number;
    } = {},
): Promise<IDjvuConversionResult> {
    const { ddjvu } = getDjvuNativeToolPaths();
    const format = options.format ?? 'ppm';

    const args = [
        `-format=${format}`,
        `-page=${pageNum}`,
    ];

    if (options.mode) {
        args.push(`-mode=${options.mode}`);
    }

    if (options.targetWidthPx && options.targetHeightPx) {
        args.push(`-size=${options.targetWidthPx}x${options.targetHeightPx}`);
    } else if (options.subsample && options.subsample > 1) {
        args.push(`-subsample=${options.subsample}`);
    }

    args.push(inputPath, outputPath);

    const result = await runProcess(jobId, ddjvu, args, {
        env: buildDjvuRuntimeEnv(),
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: DJVU_IMAGE_PROCESS_TIMEOUT_MS,
    });
    if (!result.success) {
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: result.error,
        };
    }

    try {
        const s = await stat(outputPath);
        return {
            success: true,
            outputPath,
            fileSize: s.size,
        };
    } catch (err) {
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: `Output file not found: ${getErrorMessage(err)}`,
        };
    }
}

export async function runRegisteredDjvuProcess(
    processId: string,
    command: string,
    args: string[],
    options: IRegisteredDjvuProcessOptions = {},
) {
    return runProcess(processId, command, args, options);
}

export async function cancelConversion(jobId: string) {
    let canceled = false;

    if (activeProcessIds.has(jobId)) {
        canceledProcessIds.add(jobId);
        cancelNativeCommandGroup(jobId);
        canceled = true;
    }

    for (const id of activeProcessIds) {
        if (id.startsWith(`${jobId}-`)) {
            canceledProcessIds.add(id);
            cancelNativeCommandGroup(id);
            canceled = true;
        }
    }

    await Promise.resolve();
    return canceled;
}

interface IRunProcessOptions {
    env?: NodeJS.ProcessEnv;
    onStderr?: (chunk: string) => void;
    onStdout?: (chunk: string) => void;
    timeoutMs?: number;
    maxStderrBytes?: number;
    signal?: AbortSignal;
}

async function runProcess(
    processId: string,
    command: string,
    args: string[],
    options: IRunProcessOptions = {},
): Promise<{ success: true } | {
    success: false;
    error: string;
    cause?: unknown;
}> {
    activeProcessIds.add(processId);
    try {
        const commandOptions: IRunCommandOptions = {
            cancelGroup: processId,
            commandLabel: command,
            maxStderrBytes: options.maxStderrBytes ?? DJVU_MAX_STDERR_BYTES,
            terminationGraceMs: DJVU_KILL_GRACE_MS,
            timeoutMs: options.timeoutMs ?? DJVU_PROCESS_TIMEOUT_MS,
        };
        if (options.env !== undefined) {
            commandOptions.env = options.env;
        }
        if (options.signal !== undefined) {
            commandOptions.signal = options.signal;
        }
        if (options.onStderr !== undefined) {
            commandOptions.onStderr = options.onStderr;
        }
        if (options.onStdout !== undefined) {
            commandOptions.onStdout = options.onStdout;
        }
        await runNativeCommand(command, args, commandOptions);
        return { success: true };
    } catch (error) {
        if (canceledProcessIds.has(processId)) {
            return {
                success: false,
                error: DJVU_CONVERSION_CANCELED_MESSAGE,
            };
        }
        return {
            success: false,
            error: getErrorMessage(error),
            cause: error,
        };
    } finally {
        activeProcessIds.delete(processId);
        canceledProcessIds.delete(processId);
    }
}

function shouldSkipSingleProcessFallback(error: string | undefined) {
    if (!error) {
        return false;
    }
    return isDjvuConversionCancellationError(error)
        || error.includes('timed out after')
        || error.includes('disk ceiling')
        || error.includes('DjVu disk quota exceeded')
        || error.includes('free temporary disk space');
}

function isDjvuConversionCancellationError(error: string | undefined) {
    return error?.includes(DJVU_CONVERSION_CANCELED_MESSAGE) ?? false;
}

function _shouldUseParallelRangeConversion(options: IDjvuConversionOptions) {
    const totalPages = options.pageCount ?? 0;
    if (options.pages) {
        return false;
    }
    if (totalPages < MIN_PAGES_FOR_RANGE_PARALLELISM) {
        return false;
    }
    return getRangeWorkerCount(totalPages) > 1;
}

function createPageRanges(
    totalPages: number,
    workerCount: number,
) {
    const chunkCount = Math.min(totalPages, workerCount);
    const baseChunkSize = Math.floor(totalPages / chunkCount);
    const remainder = totalPages % chunkCount;
    const chunks: Array<{
        startPage: number;
        endPage: number
    }> = [];
    let startPage = 1;

    for (let index = 0; index < chunkCount; index += 1) {
        const pageCount = baseChunkSize + (index < remainder ? 1 : 0);
        const endPage = startPage + pageCount - 1;
        chunks.push({
            startPage,
            endPage,
        });
        startPage = endPage + 1;
    }

    return chunks;
}

export function resolveDjvuRangeWorkerCount(
    pageCount: number,
    logicalCpuCount = getHostResourceProfileSnapshot().logicalCpus,
    tier: THostResourceTier = getHostResourceProfileSnapshot().tier,
) {
    if (tier === 'low') {
        return Math.min(pageCount, 1);
    }
    const cpuBound = Math.max(1, logicalCpuCount - 1);
    const desired = clamp(cpuBound, 1, MAX_RANGE_WORKERS);
    return Math.min(pageCount, desired);
}

function getRangeWorkerCount(pageCount: number) {
    return resolveDjvuRangeWorkerCount(pageCount);
}
