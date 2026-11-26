import {
    existsSync,
} from 'node:fs';
import {
    stat,
    unlink,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    join,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { clamp } from 'es-toolkit/math';
import { limitAsync } from 'es-toolkit/promise';
import type { THostResourceTier } from '@contracts/hostResourceProfile';
import {
    createFileBackedPdfCombineEnv,
    createPdfCombineOutputTooLargeError,
    isPdfCombineOutputTooLargeError,
    PDF_COMBINE_OUTPUT_POLICY,
} from '@contracts/pdfCombineOutputPolicy';
import type { TDjvuRenderMode } from '@djvu-core/djvuLibreTypes';
import { runDjvuEngine } from '@electron/features/djvu/main/djvuEnginePool';
import type { TDjvuNetpbmFormat } from '@electron/features/djvu/main/djvuEngineProtocol';
import { PdfCombineCapabilityError } from '@electron/image/pdfCombineErrors';
import {
    cancelNativeCommandGroup,
    runNativeCommand,
    type IRunCommandOptions,
} from '@electron/native-tools/runNativeCommand';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { getHostResourceProfileSnapshot } from '@electron/resources/hostResourceProfile';
import { mainJobBroker } from '@electron/resources/jobBroker';
import { runtimeConfig } from '@electron/runtimeConfig';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { getErrorMessage } from '@electron/utils/error';
import { usingManagedScratchScope } from '@electron/utils/managedScratchTemp';
import { createPdfCombineProgressHandler } from '@evb/scan-cleanup/core/createPdfCombineProgressHandler';

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
    onTerminationProof?: (proof: Promise<boolean>) => void;
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
const MAX_RANGE_WORKERS = 12;
const DJVU_DIRECT_PDF_JPEG_QUALITY = 92;
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
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
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
        return Array.from({ length: totalPages }, (_, index) => index + 1);
    }
    const selected: number[] = [];
    const seen = new Set<number>();
    for (const part of pagesSpec.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
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
    return mainJobBroker.run({
        ownerId: options.jobId,
        kind: `djvu-${options.kind}`,
        priority: 'user',
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: 64 * 1024 * 1024,
            nativeProcesses: 0,
            ioWeight: 1,
        },
        ...(options.signal ? { signal: options.signal } : {}),
    }, ({ onTerminationProof }) => options.task(onTerminationProof));
}

export async function renderDjvuPageToImage(
    inputPath: string,
    outputPath: string,
    pageNumber: number,
    jobId: string,
    options: IDjvuImageRenderOptions = {},
): Promise<IDjvuConversionResult> {
    const {
        signal,
        cleanup,
    } = createJobSignal(jobId, options.signal);
    try {
        if (signal.aborted) {
            throw abortErrorFromSignal(signal);
        }
        await runDjvuEngine<'renderPageToFile'>({
            type: 'renderPageToFile',
            djvuPath: inputPath,
            pageNumber,
            outputPath,
            options: {
                format: options.format ?? 'ppm',
                ...(options.mode ? { mode: options.mode } : {}),
                ...(options.subsample !== undefined && options.subsample > 1 ? { subsample: options.subsample } : {}),
                ...(options.targetWidthPx !== undefined && options.targetHeightPx !== undefined
                    ? {
                        targetWidthPx: options.targetWidthPx,
                        targetHeightPx: options.targetHeightPx,
                    }
                    : {}),
            },
        }, {
            signal,
            timeoutMs: DJVU_IMAGE_PROCESS_TIMEOUT_MS,
        });
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
 * Direct DjVu-to-PDF conversion powered by DjVuLibre WASM + native Rust
 * `evb-pdf-image-combine` (replacing legacy `ddjvu -format=pdf` / libtiff).
 */
export async function convertDjvuToPdfFile(
    inputPath: string,
    outputPath: string,
    jobId: string,
    options: IDjvuConversionOptions = {},
): Promise<IDjvuConversionResult> {
    const {
        signal,
        cleanup,
    } = createJobSignal(jobId, options.signal);
    try {
        if (signal.aborted) {
            throw abortErrorFromSignal(signal);
        }
        const nativeCombinePath = resolveNativePdfImageCombinePath();
        if (!nativeCombinePath) {
            throw new PdfCombineCapabilityError(
                'native-unavailable',
                'Native PDF image combiner is unavailable for DjVu PDF export',
                { operation: 'djvu-convert' },
            );
        }
        const docInfo = await runDjvuEngine<'getDocInfo'>({
            type: 'getDocInfo',
            djvuPath: inputPath,
        }, { signal });
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
        const pageSizes = await runDjvuEngine<'getPageSizes'>({
            type: 'getPageSizes',
            djvuPath: inputPath,
            pageNumbers: selectedPages,
        }, { signal });

        const subsample = options.subsample && options.subsample > 1 ? Math.trunc(options.subsample) : 1;
        const workerConcurrency = getHostResourceProfileSnapshot().tier === 'low' ? 1 : 2;

        return await usingManagedScratchScope('djvu-export-', getAppTempDir(), async (scratchDir) => {
            const manifestPath = join(scratchDir, 'direct-manifest.jsonl');
            const manifestLines: string[] = [JSON.stringify({
                format: COMPACT_MANIFEST_JSONL_FORMAT,
                schemaVersion: COMPACT_MANIFEST_JSONL_SCHEMA_VERSION,
                pageCount: selectedPages.length,
            })];
            const renderedEntries = new Array<{
                ppmPath: string;
                widthPoints: number;
                heightPoints: number;
            }>(selectedPages.length);
            let completed = 0;
            const renderAbortController = new AbortController();
            const onOuterAbort = () => {
                renderAbortController.abort(signal.reason ?? abortErrorFromSignal(signal));
            };
            signal.addEventListener('abort', onOuterAbort, { once: true });
            const renderSignal = renderAbortController.signal;

            const renderWithLimit = limitAsync(async (index: number) => {
                if (renderSignal.aborted) {
                    throw abortErrorFromSignal(renderSignal);
                }
                const pageNumber = selectedPages[index]!;
                const size = pageSizes[index];
                const ppmPath = join(scratchDir, `page-${String(pageNumber).padStart(6, '0')}.ppm`);
                const rendered = await runDjvuEngine<'renderPageToFile'>({
                    type: 'renderPageToFile',
                    djvuPath: inputPath,
                    pageNumber,
                    outputPath: ppmPath,
                    options: {
                        format: 'ppm',
                        mode: 'color',
                        ...(subsample > 1 ? { subsample } : {}),
                    },
                }, {
                    signal: renderSignal,
                    timeoutMs: DJVU_IMAGE_PROCESS_TIMEOUT_MS,
                });
                const dpi = size?.dpi && size.dpi > 0 ? size.dpi : docInfo.sourceDpi || 300;
                const nativeW = size?.width && size.width > 0 ? size.width : rendered.width * subsample;
                const nativeH = size?.height && size.height > 0 ? size.height : rendered.height * subsample;
                renderedEntries[index] = {
                    ppmPath,
                    widthPoints: Math.max(1, (nativeW / dpi) * 72),
                    heightPoints: Math.max(1, (nativeH / dpi) * 72),
                };
                if (!renderSignal.aborted) {
                    completed += 1;
                    options.onProgress?.(Math.min(85, Math.round((completed / selectedPages.length) * 85)));
                }
            }, workerConcurrency);

            const renderTasks = selectedPages.map((_, index) => renderWithLimit(index));
            try {
                await Promise.all(renderTasks);
            } catch (error) {
                renderAbortController.abort(error);
                await Promise.allSettled(renderTasks);
                throw error;
            } finally {
                signal.removeEventListener('abort', onOuterAbort);
            }
            if (signal.aborted) {
                throw abortErrorFromSignal(signal);
            }

            for (const entry of renderedEntries) {
                manifestLines.push([
                    'image-jpeg',
                    entry.widthPoints.toFixed(4),
                    entry.heightPoints.toFixed(4),
                    String(DJVU_DIRECT_PDF_JPEG_QUALITY),
                    entry.ppmPath,
                ].join('\t'));
            }
            await writeFile(manifestPath, `${manifestLines.join('\n')}\n`, 'utf8');

            const onCombineStdout = createPdfCombineProgressHandler(
                selectedPages.length,
                (processed, total) => {
                    if (total > 0) {
                        options.onProgress?.(Math.min(94, 85 + Math.round((processed / total) * 9)));
                    }
                },
            );
            const combineResult = await runRegisteredDjvuProcess(
                `${jobId}-combine`,
                nativeCombinePath,
                [
                    '--output',
                    outputPath,
                    '--json-progress',
                    '--compact-manifest',
                    manifestPath,
                ],
                {
                    env: {
                        ...process.env,
                        ...createFileBackedPdfCombineEnv({ maxPages: selectedPages.length }),
                    },
                    timeoutResetsOnStdout: true,
                    onStdout: onCombineStdout,
                    signal,
                    timeoutMs: DJVU_PROCESS_TIMEOUT_MS,
                },
            );
            if (!combineResult.success) {
                const combineError = combineResult.error;
                const nativeCode = typeof combineResult.cause === 'object'
                    && combineResult.cause !== null
                    && 'code' in combineResult.cause
                    ? combineResult.cause.code
                    : undefined;
                if (
                    nativeCode === PDF_COMBINE_OUTPUT_POLICY.tooLargeCode
                    || isPdfCombineOutputTooLargeError(combineResult.cause)
                    || isPdfCombineOutputTooLargeError(combineError)
                ) {
                    throw createPdfCombineOutputTooLargeError(combineError);
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

            const outputStat = await stat(outputPath);
            if (signal.aborted) {
                throw abortErrorFromSignal(signal);
            }
            return {
                success: true,
                outputPath,
                fileSize: outputStat.size,
            };
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
        if (options.onTerminationProof !== undefined) {
            commandOptions.onTerminationProof = options.onTerminationProof;
        }
        await runNativeCommand(command, args, commandOptions);
        return { success: true };
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

    for (const [
        activeId,
        controllers,
    ] of activeJobAbortControllers.entries()) {
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
