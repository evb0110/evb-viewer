import {existsSync} from 'node:fs';
import {stat, unlink, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {limitAsync} from 'es-toolkit/promise';
import {DEFAULT_DJVU_SOURCE_DPI} from '@contracts/djvuConversionPolicy';
import {PDF_POINTS_PER_INCH} from '@pdf-core/imageExportResolution';
import {
    createFileBackedPdfCombineEnv,
    createPdfCombineOutputTooLargeError,
    isPdfCombineOutputTooLargeError,
    PDF_COMBINE_OUTPUT_POLICY,
} from '@contracts/pdfCombineOutputPolicy';
import type {TDjvuRenderMode} from '@djvu-core/djvuLibreTypes';
import {createDjvuDiskQuotaMonitor} from '@electron/features/djvu/main/djvuArtifactManifest';
import {runDjvuEngine} from '@electron/features/djvu/main/djvuEnginePool';
import type {TDjvuNetpbmFormat} from '@electron/features/djvu/main/djvuEngineProtocol';
import {runPageStructureCommand} from '@electron/features/page-ops/publicNative';
import {PdfCombineCapabilityError} from '@electron/image/pdfCombineErrors';
import {cancelNativeCommandGroup, runNativeCommand, type IRunCommandOptions} from '@electron/native-tools/runNativeCommand';
import {resolveNativeToolPath} from '@electron/native-tools/resolveNativeToolPath';
import {getHostResourceProfileSnapshot} from '@electron/resources/hostResourceProfile';
import {mainJobBroker, type IJobBrokerRunContext, type TTerminationProofSink} from '@electron/resources/jobBroker';
import {runtimeConfig} from '@electron/runtimeConfig';
import {abortErrorFromSignal} from '@electron/utils/abort';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {getErrorMessage} from '@electron/utils/error';
import {usingManagedScratchScope} from '@electron/utils/managedScratchTemp';
import {createPdfCombineProgressHandler} from '@evb/scan-cleanup/core/createPdfCombineProgressHandler';

interface IDjvuConversionOptions {
    subsample?: number;
    pages?: string;
    pageCount?: number;
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
}

export interface IRegisteredDjvuProcessOptions {
    env?: NodeJS.ProcessEnv;
    timeoutResetsOnStdout?: boolean;
    onStderr?: (chunk: string) => void;
    onStdout?: (chunk: string) => void;
    brokerRun?: IJobBrokerRunContext;
    onTerminationProof?: TTerminationProofSink;
    timeoutMs?: number;
    maxStderrBytes?: number;
    signal?: AbortSignal;
}

interface IDjvuConversionResult {
    success: boolean;
    outputPath: string;
    fileSize: number;
    error?: string;
    cause?: unknown;
}

export interface IDjvuImageRenderOptions {
    format?: TDjvuNetpbmFormat;
    mode?: TDjvuRenderMode;
    subsample?: number;
    targetWidthPx?: number;
    targetHeightPx?: number;
    signal?: AbortSignal;
    onTerminationProof?: (proof: Promise<boolean>) => void;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DJVU_DIRECT_PDF_JPEG_QUALITY = 92;
const DJVU_DIRECT_PDF_PAGE_BATCH_SIZE = 24;
const DJVU_PROCESS_TIMEOUT_MS = 4 * 60 * 1000;
const DJVU_IMAGE_PROCESS_TIMEOUT_MS = 2 * 60 * 1000;
const DJVU_KILL_GRACE_MS = 2_000;
const DJVU_MAX_STDERR_BYTES = 262_144;
const DJVU_CONVERSION_CANCELED_MESSAGE = 'DjVu conversion canceled';
const COMPACT_MANIFEST_JSONL_FORMAT = 'evb-pdf-image-combine-jsonl';
const COMPACT_MANIFEST_JSONL_SCHEMA_VERSION = 1;

const activeProcessIds = new Set<string>();
const canceledProcessIds = new Set<string>();
const activeJobAbortControllers = new Map<string, Set<AbortController>>();

function registerJobAbortController(jobId: string, controller: AbortController) {
    let set = activeJobAbortControllers.get(jobId);
    if (!set) {
        set = new Set();
        activeJobAbortControllers.set(jobId, set);
    }
    set.add(controller);
    return () => {
        set?.delete(controller);
        if (set && set.size === 0) {
            activeJobAbortControllers.delete(jobId);
        }
    };
}

function createJobSignal(jobId: string, externalSignal?: AbortSignal) {
    const controller = new AbortController();
    const unregister = registerJobAbortController(jobId, controller);
    if (externalSignal?.aborted) {
        controller.abort(externalSignal.reason ?? new DOMException(DJVU_CONVERSION_CANCELED_MESSAGE, 'AbortError'));
    }
    const onExternalAbort = () => {
        controller.abort(externalSignal?.reason ?? new DOMException(DJVU_CONVERSION_CANCELED_MESSAGE, 'AbortError'));
    };
    externalSignal?.addEventListener('abort', onExternalAbort, {once: true});
    return {
        signal: controller.signal,
        cleanup() {
            externalSignal?.removeEventListener('abort', onExternalAbort);
            unregister();
        },
    };
}

function parsePageRangeSpec(pagesSpec: string | undefined, totalPages: number): number[] {
    if (!pagesSpec || pagesSpec.trim().length === 0) {
        return Array.from({length: totalPages}, (_, index) => index + 1);
    }
    const selected: number[] = [];
    const seen = new Set<number>();
    for (const part of pagesSpec.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) {
            continue;
        }
        const dashIndex = trimmed.indexOf('-');
        if (dashIndex >= 0) {
            const start = Number.parseInt(trimmed.slice(0, dashIndex).trim(), 10);
            const end = Number.parseInt(trimmed.slice(dashIndex + 1).trim(), 10);
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
                continue;
            }
            for (let page = start; page <= Math.min(end, totalPages); page += 1) {
                if (!seen.has(page)) {
                    seen.add(page);
                    selected.push(page);
                }
            }
        } else {
            const page = Number.parseInt(trimmed, 10);
            if (Number.isSafeInteger(page) && page >= 1 && page <= totalPages && !seen.has(page)) {
                seen.add(page);
                selected.push(page);
            }
        }
    }
    return selected;
}

function resolveNativePdfImageCombinePath() {
    const isPackaged = __dirname.includes('app.asar');
    const binaryName = process.platform === 'win32' ? 'evb-pdf-image-combine.exe' : 'evb-pdf-image-combine';
    return resolveNativeToolPath({
        binaryName,
        crateName: 'pdf-image-combine',
        currentDir: __dirname,
        envOverridePath: runtimeConfig.pdfImageCombinePath,
        isPackaged,
    });
}

async function cleanupPartialOutput(outputPath: string) {
    try {
        if (existsSync(outputPath)) {
            await unlink(outputPath);
        }
    } catch {
        // Ignore cleanup failures for partial outputs.
    }
}

export async function withDjvuNativeResourceLease<T>(options: {
    jobId: string;
    kind: 'metadata' | 'structure';
    signal?: AbortSignal;
    task: (onTerminationProof: (proof: Promise<boolean>) => void) => Promise<T>;
}) {
    return mainJobBroker.run(
        {
            ownerId: options.jobId,
            kind: `djvu-${options.kind}`,
            priority: 'user',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 64 * 1024 * 1024,
                nativeProcesses: 0,
                ioWeight: 1,
            },
            ...(options.signal ? {signal: options.signal} : {}),
        },
        ({onTerminationProof}) => options.task(onTerminationProof),
    );
}

export async function renderDjvuPageToImage(
    inputPath: string,
    outputPath: string,
    pageNumber: number,
    jobId: string,
    options: IDjvuImageRenderOptions = {},
): Promise<IDjvuConversionResult> {
    const {signal, cleanup} = createJobSignal(jobId, options.signal);
    try {
        if (signal.aborted) {
            throw abortErrorFromSignal(signal);
        }
        await runDjvuEngine(
            {
                type: 'renderPageToFile',
                djvuPath: inputPath,
                pageNumber,
                outputPath,
                options: {
                    format: options.format ?? 'ppm',
                    ...(options.mode ? {mode: options.mode} : {}),
                    ...(options.subsample !== undefined && options.subsample > 1 ? {subsample: options.subsample} : {}),
                    ...(options.targetWidthPx !== undefined && options.targetHeightPx !== undefined
                        ? {
                              targetWidthPx: options.targetWidthPx,
                              targetHeightPx: options.targetHeightPx,
                          }
                        : {}),
                },
            },
            {
                signal,
                timeoutMs: DJVU_IMAGE_PROCESS_TIMEOUT_MS,
            },
        );
        const outputStat = await stat(outputPath);
        if (signal.aborted) {
            throw abortErrorFromSignal(signal);
        }
        return {
            success: true,
            outputPath,
            fileSize: outputStat.size,
        };
    } catch (error) {
        await cleanupPartialOutput(outputPath);
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: signal.aborted ? DJVU_CONVERSION_CANCELED_MESSAGE : getErrorMessage(error),
            cause: error,
        };
    } finally {
        cleanup();
    }
}

export const convertDjvuPageToImage = renderDjvuPageToImage;

/**
 * Converts a DjVu file to PDF using the DjVu engine and the native
 * `evb-pdf-image-combine` tool.
 */
export async function convertDjvuToPdfFile(
    inputPath: string,
    outputPath: string,
    jobId: string,
    options: IDjvuConversionOptions = {},
): Promise<IDjvuConversionResult> {
    const {signal, cleanup} = createJobSignal(jobId, options.signal);
    try {
        if (signal.aborted) {
            throw abortErrorFromSignal(signal);
        }
        const nativeCombinePath = resolveNativePdfImageCombinePath();
        if (!nativeCombinePath) {
            throw new PdfCombineCapabilityError('native-unavailable', 'Native PDF image combiner is unavailable for DjVu PDF export', {
                operation: 'djvu-convert',
            });
        }
        const docInfo = await runDjvuEngine(
            {
                type: 'getDocInfo',
                djvuPath: inputPath,
            },
            {signal},
        );
        const totalPages = options.pageCount && options.pageCount > 0 ? options.pageCount : docInfo.pageCount;
        const selectedPages = parsePageRangeSpec(options.pages, totalPages);
        if (selectedPages.length === 0) {
            return {
                success: false,
                outputPath,
                fileSize: 0,
                error: 'No DjVu pages selected for conversion',
            };
        }
        const pageSizes = await runDjvuEngine(
            {
                type: 'getPageSizes',
                djvuPath: inputPath,
                pageNumbers: selectedPages,
            },
            {signal},
        );

        const subsample = options.subsample && options.subsample > 1 ? Math.trunc(options.subsample) : 1;
        const workerConcurrency = getHostResourceProfileSnapshot().tier === 'low' ? 1 : 2;

        return await usingManagedScratchScope('djvu-export-', getAppTempDir(), async (scratchDir) => {
            if (signal.aborted) {
                throw abortErrorFromSignal(signal);
            }
            const quotaMonitor = await createDjvuDiskQuotaMonitor({
                paths: [scratchDir, outputPath],
                fileSystemPath: scratchDir,
                signal,
            });
            const effectiveSignal = quotaMonitor.signal;
            try {
                const batchCount = Math.ceil(selectedPages.length / DJVU_DIRECT_PDF_PAGE_BATCH_SIZE);
                const chunkPaths: string[] = [];
                let completedPages = 0;

                for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
                    if (effectiveSignal.aborted) {
                        throw abortErrorFromSignal(effectiveSignal);
                    }
                    const batchStart = batchIndex * DJVU_DIRECT_PDF_PAGE_BATCH_SIZE;
                    const batchEnd = Math.min(selectedPages.length, batchStart + DJVU_DIRECT_PDF_PAGE_BATCH_SIZE);
                    const batchLength = batchEnd - batchStart;
                    const renderedEntries = new Array<{
                        ppmPath: string;
                        widthPoints: number;
                        heightPoints: number;
                    }>(batchLength);
                    const renderAbortController = new AbortController();
                    const renderSignal = AbortSignal.any([effectiveSignal, renderAbortController.signal]);

                    const renderWithLimit = limitAsync(async (offset: number) => {
                        if (renderSignal.aborted) {
                            throw abortErrorFromSignal(renderSignal);
                        }
                        const index = batchStart + offset;
                        const pageNumber = selectedPages[index]!;
                        const size = pageSizes[index];
                        const ppmPath = join(scratchDir, `page-${String(pageNumber).padStart(6, '0')}.ppm`);
                        const rendered = await runDjvuEngine(
                            {
                                type: 'renderPageToFile',
                                djvuPath: inputPath,
                                pageNumber,
                                outputPath: ppmPath,
                                options: {
                                    format: 'ppm',
                                    mode: 'color',
                                    ...(subsample > 1 ? {subsample} : {}),
                                },
                            },
                            {
                                signal: renderSignal,
                                timeoutMs: DJVU_IMAGE_PROCESS_TIMEOUT_MS,
                            },
                        );
                        await quotaMonitor.checkNow();
                        const dpi = size?.dpi && size.dpi > 0 ? size.dpi : docInfo.sourceDpi || DEFAULT_DJVU_SOURCE_DPI;
                        const nativeW = size?.width && size.width > 0 ? size.width : rendered.width * subsample;
                        const nativeH = size?.height && size.height > 0 ? size.height : rendered.height * subsample;
                        renderedEntries[offset] = {
                            ppmPath,
                            widthPoints: Math.max(1, (nativeW / dpi) * PDF_POINTS_PER_INCH),
                            heightPoints: Math.max(1, (nativeH / dpi) * PDF_POINTS_PER_INCH),
                        };
                        if (!renderSignal.aborted) {
                            completedPages += 1;
                            const renderProgressCap = batchCount > 1 ? 84 : 85;
                            options.onProgress?.(
                                Math.min(renderProgressCap, Math.round((completedPages / selectedPages.length) * renderProgressCap)),
                            );
                        }
                    }, workerConcurrency);

                    const renderTasks = Array.from({length: batchLength}, (_, offset) => renderWithLimit(offset));
                    try {
                        await Promise.all(renderTasks);
                    } catch (error) {
                        renderAbortController.abort(error);
                        await Promise.allSettled(renderTasks);
                        throw error;
                    }
                    if (effectiveSignal.aborted) {
                        throw abortErrorFromSignal(effectiveSignal);
                    }

                    const manifestPath = join(scratchDir, `direct-manifest-${String(batchIndex + 1).padStart(4, '0')}.jsonl`);
                    const manifestLines: string[] = [
                        JSON.stringify({
                            format: COMPACT_MANIFEST_JSONL_FORMAT,
                            schemaVersion: COMPACT_MANIFEST_JSONL_SCHEMA_VERSION,
                            pageCount: batchLength,
                        }),
                    ];
                    for (const entry of renderedEntries) {
                        manifestLines.push(
                            subsample === 1
                                ? ['image', entry.widthPoints.toFixed(4), entry.heightPoints.toFixed(4), entry.ppmPath].join('\t')
                                : [
                                      'image-jpeg',
                                      entry.widthPoints.toFixed(4),
                                      entry.heightPoints.toFixed(4),
                                      String(DJVU_DIRECT_PDF_JPEG_QUALITY),
                                      entry.ppmPath,
                                  ].join('\t'),
                        );
                    }
                    await writeFile(manifestPath, `${manifestLines.join('\n')}\n`, 'utf8');

                    const batchOutputPath =
                        batchCount === 1 ? outputPath : join(scratchDir, `direct-chunk-${String(batchIndex + 1).padStart(4, '0')}.pdf`);
                    const onCombineStdout = createPdfCombineProgressHandler(batchLength, (processed, total) => {
                        if (total > 0 && batchCount === 1) {
                            options.onProgress?.(Math.min(94, 85 + Math.round((processed / total) * 9)));
                        }
                    });
                    const combineResult = await runRegisteredDjvuProcess(
                        batchCount === 1 ? `${jobId}-combine` : `${jobId}-combine-${batchIndex + 1}`,
                        nativeCombinePath,
                        ['--output', batchOutputPath, '--json-progress', '--compact-manifest', manifestPath],
                        {
                            env: {
                                ...process.env,
                                ...createFileBackedPdfCombineEnv({maxPages: batchLength}),
                            },
                            timeoutResetsOnStdout: true,
                            onStdout: onCombineStdout,
                            signal: effectiveSignal,
                            timeoutMs: DJVU_PROCESS_TIMEOUT_MS,
                        },
                    );
                    if (!combineResult.success) {
                        const combineError = combineResult.error;
                        const nativeCode =
                            typeof combineResult.cause === 'object' && combineResult.cause !== null && 'code' in combineResult.cause
                                ? combineResult.cause.code
                                : undefined;
                        if (
                            nativeCode === PDF_COMBINE_OUTPUT_POLICY.tooLargeCode ||
                            isPdfCombineOutputTooLargeError(combineResult.cause) ||
                            isPdfCombineOutputTooLargeError(combineError)
                        ) {
                            throw createPdfCombineOutputTooLargeError(combineError);
                        }
                        if (quotaMonitor.failure) {
                            throw new Error(quotaMonitor.failure.message, {cause: combineResult.cause ?? combineError});
                        }
                        await cleanupPartialOutput(outputPath);
                        return {
                            success: false,
                            outputPath,
                            fileSize: 0,
                            error: combineError,
                            cause: combineResult.cause,
                        };
                    }

                    if (batchCount > 1) {
                        chunkPaths.push(batchOutputPath);
                        // Release uncompressed PPM rasters before starting the next batch
                        // so multi-hundred-page exports never stage an entire book as raw PPMs.
                        await Promise.allSettled([unlink(manifestPath), ...renderedEntries.map((entry) => unlink(entry.ppmPath))]);
                        await quotaMonitor.checkNow();
                        options.onProgress?.(Math.min(88, 84 + Math.round(((batchIndex + 1) / batchCount) * 4)));
                    }
                }

                if (chunkPaths.length > 1) {
                    if (effectiveSignal.aborted) {
                        throw abortErrorFromSignal(effectiveSignal);
                    }
                    const [firstChunk, ...restChunks] = chunkPaths;
                    await runPageStructureCommand(
                        'merge-pages',
                        firstChunk!,
                        outputPath,
                        {sources: restChunks},
                        {
                            signal: effectiveSignal,
                            cancelGroup: `${jobId}-merge`,
                        },
                    );
                    await quotaMonitor.checkNow();
                    options.onProgress?.(94);
                }

                const outputStat = await stat(outputPath);
                if (effectiveSignal.aborted) {
                    throw abortErrorFromSignal(effectiveSignal);
                }
                return {
                    success: true,
                    outputPath,
                    fileSize: outputStat.size,
                };
            } catch (error) {
                if (quotaMonitor.failure && !signal.aborted) {
                    throw new Error(quotaMonitor.failure.message, {cause: error});
                }
                throw error;
            } finally {
                await quotaMonitor.stop();
            }
        });
    } catch (error) {
        await cleanupPartialOutput(outputPath);
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: signal.aborted ? DJVU_CONVERSION_CANCELED_MESSAGE : getErrorMessage(error),
            cause: error,
        };
    } finally {
        cleanup();
    }
}

export async function runRegisteredDjvuProcess(
    processId: string,
    command: string,
    args: string[],
    options: IRegisteredDjvuProcessOptions = {},
): Promise<
    | {success: true}
    | {
          success: false;
          error: string;
          cause?: unknown;
      }
> {
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
        if (options.timeoutResetsOnStdout !== undefined) {
            commandOptions.timeoutResetsOnStdout = options.timeoutResetsOnStdout;
        }
        if (options.signal !== undefined) {
            commandOptions.signal = options.signal;
        }
        if (options.onStderr !== undefined) {
            commandOptions.onStderr = options.onStderr;
        }
        if (options.onStdout !== undefined) {
            commandOptions.longLived = true;
            commandOptions.onStdout = options.onStdout;
        }
        if (options.brokerRun !== undefined) {
            commandOptions.brokerRun = options.brokerRun;
        }
        if (options.onTerminationProof !== undefined) {
            commandOptions.onTerminationProof = options.onTerminationProof;
        }
        await runNativeCommand(command, args, commandOptions);
        return {success: true};
    } catch (error) {
        return {
            success: false,
            error: canceledProcessIds.has(processId) ? DJVU_CONVERSION_CANCELED_MESSAGE : getErrorMessage(error),
            cause: error,
        };
    } finally {
        activeProcessIds.delete(processId);
        canceledProcessIds.delete(processId);
    }
}

export async function cancelConversion(jobId: string) {
    let canceled = false;
    mainJobBroker.cancelOwner(jobId, DJVU_CONVERSION_CANCELED_MESSAGE);

    for (const [activeId, controllers] of activeJobAbortControllers.entries()) {
        if (activeId === jobId || activeId.startsWith(`${jobId}-`)) {
            for (const controller of controllers) {
                if (!controller.signal.aborted) {
                    controller.abort(new DOMException(DJVU_CONVERSION_CANCELED_MESSAGE, 'AbortError'));
                    canceled = true;
                }
            }
        }
    }

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
