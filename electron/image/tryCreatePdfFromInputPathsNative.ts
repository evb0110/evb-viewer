import { getAppTempDir } from '@electron/utils/appTempDir';
import {
    createManagedScratchTempDir,
    removeManagedScratchTempDir,
    usingManagedScratchScope,
} from '@electron/utils/managedScratchTemp';
import {
    copyFile,
    readFile,
    rm,
    stat,
    statfs,
} from 'fs/promises';
import { randomUUID } from 'crypto';
import {
    extname,
    dirname,
    join,
} from 'path';
import {
    cancelConversion,
    convertDjvuToPdfFile,
    getDjvuPageCount,
} from '@electron/features/djvu/public';
import {
    assertNonEmptyPdfOutput,
    getPdfPageCount,
    runPageStructureCommand,
} from '@electron/features/page-ops/publicNative';
import { createLogger } from '@electron/utils/createLogger';
import {runtimeConfig} from '@electron/runtimeConfig';
import { getErrorMessage } from '@electron/utils/error';
import {
    isNativePdfImageCombineBitmapPath,
    tryWritePdfWithNativeImageCombiner,
} from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import {
    PdfCombineCapabilityError,
    isPdfCombineCapabilityError,
} from '@electron/image/pdfCombineErrors';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {
    createPdfCombineOutputTooLargeError,
    isPdfCombineOutputTooLargeError,
    PDF_COMBINE_MAX_OUTPUT_BYTES,
} from '@contracts/pdfCombineOutputPolicy';

interface INativePdfAssemblerProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface INativePdfAssemblerOptions {
    /** Keep the native attempt strict instead of allowing the JS fallback. */
    failureMode?: 'fallback' | 'capability-error';
    onProgress?: (progress: INativePdfAssemblerProgress) => void;
    onTerminationProof?: (proof: Promise<boolean>) => void;
    signal?: AbortSignal;
}

interface IProgressState {
    processed: number;
    total: number;
    startedAt: number;
}

const log = createLogger('nativePdfAssembler');

interface INativePdfAssemblerResourceLimits {
    maxOutputBytes: number;
    maxPages: number;
    outputMode: 'memory' | 'file-backed';
}

const IN_MEMORY_NATIVE_ASSEMBLER_MAX_PAGES = 500;
const FILE_BACKED_NATIVE_ASSEMBLER_MAX_PAGES = Number.MAX_SAFE_INTEGER;
const FILE_BACKED_NATIVE_ASSEMBLER_MAX_OUTPUT_BYTES = Number.MAX_SAFE_INTEGER;
const BYTES_PER_MEBIBYTE = 1024 * 1024;
const NATIVE_IMAGE_COMBINER_MAX_INPUT_BYTES = 4_096 * BYTES_PER_MEBIBYTE;
const MIN_NATIVE_DISK_RESERVATION_BYTES = 16 * BYTES_PER_MEBIBYTE;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

type TNativePdfAssemblerMode = 'memory' | 'file-backed';

function isStrictNativeFailure(options: INativePdfAssemblerOptions | undefined) {
    return options?.failureMode === 'capability-error';
}

function createNativeCapabilityError(
    code: 'native-unavailable' | 'native-failure',
    message: string,
    cause?: unknown,
) {
    return new PdfCombineCapabilityError(code, message, {
        ...(cause === undefined ? {} : {cause}),
        operation: 'pdf-combine',
    });
}

function throwNativeCapabilityError(
    code: 'native-unavailable' | 'native-failure',
    message: string,
    cause?: unknown,
): never {
    throw createNativeCapabilityError(code, message, cause);
}

function isNativePdfAssemblerDisabled() {
    return process.env.VITEST === 'true' && !runtimeConfig.test.nativePdfAssemblerEnabled;
}

function isPdfPath(inputPath: string) {
    return extname(inputPath).toLowerCase() === '.pdf';
}

function isDjvuPath(inputPath: string) {
    const extension = extname(inputPath).toLowerCase();
    return extension === '.djvu' || extension === '.djv';
}

function isNativePdfAssemblerInputPath(inputPath: string) {
    return isPdfPath(inputPath)
        || isDjvuPath(inputPath)
        || isNativePdfImageCombineBitmapPath(inputPath);
}

function canUseNativePdfAssembler(inputPaths: string[]) {
    return !isNativePdfAssemblerDisabled()
        && inputPaths.length > 0
        && inputPaths.every(isNativePdfAssemblerInputPath);
}

function describeUnsupportedNativeInput(inputPaths: string[]) {
    const unsupportedPath = inputPaths.find(inputPath => !isNativePdfAssemblerInputPath(inputPath));
    return unsupportedPath === undefined
        ? 'Native PDF combine is unavailable'
        : `Native PDF combine does not support input path: ${unsupportedPath}`;
}

function estimateRemainingMs(elapsedMs: number, processed: number, total: number) {
    if (processed <= 0 || processed >= total) {
        return 0;
    }

    return Math.max(0, Math.round((elapsedMs / processed) * (total - processed)));
}

function emitProgress(
    state: IProgressState,
    options: INativePdfAssemblerOptions | undefined,
    processed: number,
) {
    if (!options?.onProgress) {
        return;
    }

    const clampedProcessed = Math.max(0, Math.min(state.total, processed));
    const elapsedMs = Math.max(0, Date.now() - state.startedAt);
    options.onProgress({
        processed: clampedProcessed,
        total: state.total,
        percent: Math.round((clampedProcessed / state.total) * 100),
        elapsedMs,
        estimatedRemainingMs: estimateRemainingMs(elapsedMs, clampedProcessed, state.total),
    });
}

function throwIfAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function getResourceLimits(
    mode: TNativePdfAssemblerMode = 'memory',
    allowLargeOutput = false,
): INativePdfAssemblerResourceLimits {
    if (mode === 'file-backed') {
        return {
            // Only the strict output-path API may opt out of the shared
            // byte-returning cap. The compatibility API still reads bytes
            // back into JavaScript and must remain bounded.
            maxOutputBytes: allowLargeOutput
                ? FILE_BACKED_NATIVE_ASSEMBLER_MAX_OUTPUT_BYTES
                : PDF_COMBINE_MAX_OUTPUT_BYTES,
            maxPages: FILE_BACKED_NATIVE_ASSEMBLER_MAX_PAGES,
            outputMode: allowLargeOutput ? 'file-backed' : 'memory',
        };
    }

    return {
        maxOutputBytes: PDF_COMBINE_MAX_OUTPUT_BYTES,
        maxPages: IN_MEMORY_NATIVE_ASSEMBLER_MAX_PAGES,
        outputMode: 'memory',
    };
}

function assertPageLimit(nextPageCount: number, limits: INativePdfAssemblerResourceLimits) {
    if (!Number.isSafeInteger(nextPageCount) || nextPageCount < 0) {
        throw new RangeError('Combined PDF page count is outside the safe integer range');
    }
    if (nextPageCount > limits.maxPages) {
        throw new Error(`Combined PDF is capped at ${limits.maxPages} pages`);
    }
}

function addPageCounts(currentPageCount: number, addedPageCount: number) {
    if (
        !Number.isSafeInteger(currentPageCount)
        || currentPageCount < 0
        || !Number.isSafeInteger(addedPageCount)
        || addedPageCount < 0
        || addedPageCount > Number.MAX_SAFE_INTEGER - currentPageCount
    ) {
        throw new RangeError('Combined PDF page count is outside the safe integer range');
    }
    return currentPageCount + addedPageCount;
}

function assertOutputLimit(byteLength: number, limits: INativePdfAssemblerResourceLimits) {
    if (byteLength > limits.maxOutputBytes) {
        throw createPdfCombineOutputTooLargeError();
    }
}

async function readLimitedPdfOutput(outputPath: string, limits: INativePdfAssemblerResourceLimits) {
    const outputStat = await stat(outputPath);
    assertOutputLimit(toSafeByteCount(outputStat.size, `native PDF output ${outputPath}`), limits);
    const outputBytes = new Uint8Array(await readFile(outputPath));
    assertOutputLimit(outputBytes.byteLength, limits);
    return outputBytes;
}

function toSafeByteCount(value: number | bigint, label: string) {
    if (typeof value === 'bigint') {
        if (value < 0n || value > MAX_SAFE_INTEGER_BIGINT) {
            throw new RangeError(`${label} exceeds the safe integer byte range`);
        }
        return Number(value);
    }
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${label} is not a safe integer byte count`);
    }
    return value;
}

function addSafeByteCounts(total: number, next: number, label: string) {
    if (next > Number.MAX_SAFE_INTEGER - total) {
        throw new RangeError(`${label} exceeds the safe integer byte range`);
    }
    return total + next;
}

function multiplySafeByteCount(value: number, multiplier: number, label: string) {
    if (value > Math.floor(Number.MAX_SAFE_INTEGER / multiplier)) {
        throw new RangeError(`${label} exceeds the safe integer byte range`);
    }
    return value * multiplier;
}

async function flushImageChunk(
    imagePaths: string[],
    tempDir: string,
    chunkPaths: string[],
    progress: IProgressState,
    currentPageCount: number,
    limits: INativePdfAssemblerResourceLimits,
    countGeneratedPages: boolean,
    options?: INativePdfAssemblerOptions,
) {
    if (imagePaths.length === 0) {
        return 0;
    }

    throwIfAborted(options?.signal);
    const chunkInputPaths = [...imagePaths];
    const chunkPath = join(tempDir, `image-chunk-${chunkPaths.length + 1}-${randomUUID()}.pdf`);
    const onProgress = (chunkProgress: INativePdfAssemblerProgress) => emitProgress(
        progress,
        options,
        progress.processed + chunkProgress.processed,
    );
    const ok = await tryWritePdfWithNativeImageCombiner(chunkInputPaths, chunkPath, {
        maxPages: limits.maxPages,
        maxOutputBytes: limits.maxOutputBytes,
        outputMode: limits.outputMode,
        ...(options?.failureMode === 'capability-error'
            ? {maxInputBytes: NATIVE_IMAGE_COMBINER_MAX_INPUT_BYTES}
            : {}),
        onProgress,
        ...(options?.onTerminationProof ? {onTerminationProof: options.onTerminationProof} : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
    });
    throwIfAborted(options?.signal);
    if (!ok) {
        if (isStrictNativeFailure(options)) {
            throwNativeCapabilityError(
                'native-unavailable',
                'Native image PDF combine did not produce an output file',
            );
        }
        return null;
    }

    await assertNonEmptyPdfOutput(chunkPath, 'Combining image pages');
    const chunkPageCount = countGeneratedPages
        ? await getPdfPageCount(chunkPath, options?.signal ? { signal: options.signal } : {})
        : 0;
    if (countGeneratedPages) {
        assertPageLimit(addPageCounts(currentPageCount, chunkPageCount), limits);
    }
    progress.processed += chunkInputPaths.length;
    emitProgress(progress, options, progress.processed);
    chunkPaths.push(chunkPath);
    imagePaths.length = 0;
    return chunkPageCount;
}

async function convertDjvuChunk(
    inputPath: string,
    tempDir: string,
    options?: INativePdfAssemblerOptions,
) {
    throwIfAborted(options?.signal);
    const outputPath = join(tempDir, `djvu-chunk-${randomUUID()}.pdf`);
    const jobId = `pdf-native-assembler-djvu-${randomUUID()}`;
    const abortHandler = options?.signal
        ? () => {
            void cancelConversion(jobId);
        }
        : null;
    if (options?.signal && abortHandler) {
        options.signal.addEventListener('abort', abortHandler, { once: true });
    }
    try {
        const pageCount = await getOptionalDjvuPageCount(inputPath, options?.signal);
        throwIfAborted(options?.signal);
        const result = await convertDjvuToPdfFile(
            inputPath,
            outputPath,
            jobId,
            {
                subsample: 1,
                ...(pageCount > 0 ? { pageCount } : {}),
                ...(options?.signal ? { signal: options.signal } : {}),
            },
        );
        throwIfAborted(options?.signal);
        if (!result.success) {
            throw new Error(result.error ?? `Failed to convert DjVu file: ${inputPath}`);
        }
    } finally {
        if (options?.signal && abortHandler) {
            options.signal.removeEventListener('abort', abortHandler);
        }
    }

    await assertNonEmptyPdfOutput(outputPath, 'Converting DjVu input');
    return outputPath;
}

async function getOptionalDjvuPageCount(inputPath: string, signal?: AbortSignal) {
    try {
        return await getDjvuPageCount(inputPath, signal ? { signal } : {});
    } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
            throw error;
        }
        log.debug(`Failed to read DjVu page count before native assemble conversion: ${getErrorMessage(error)}`);
        return 0;
    }
}

/** Every chunk's pages in order, with each chunk's outline and page labels. */
async function mergePdfChunks(chunkPaths: string[], outputPath: string, signal?: AbortSignal) {
    const [first, ...rest] = chunkPaths;
    await runPageStructureCommand('merge-pages', first!, outputPath, {sources: rest}, signal ? {signal} : {});
}

async function writePdfFromInputPathsNativeWithTempDir(
    inputPaths: string[],
    outputPath: string,
    tempDir: string,
    limits: INativePdfAssemblerResourceLimits,
    options?: INativePdfAssemblerOptions,
): Promise<number | null> {
    try {
        throwIfAborted(options?.signal);
        const progress: IProgressState = {
            processed: 0,
            total: inputPaths.length,
            startedAt: Date.now(),
        };
        assertPageLimit(inputPaths.length, limits);
        const chunkPaths: string[] = [];
        const imageChunkPaths: string[] = [];
        let pageCount = 0;

        for (const inputPath of inputPaths) {
            throwIfAborted(options?.signal);
            if (isNativePdfImageCombineBitmapPath(inputPath)) {
                imageChunkPaths.push(inputPath);
                continue;
            }

            const addedImagePages = await flushImageChunk(
                imageChunkPaths,
                tempDir,
                chunkPaths,
                progress,
                pageCount,
                limits,
                true,
                options,
            );
            if (addedImagePages === null) {
                return null;
            }
            pageCount = addPageCounts(pageCount, addedImagePages);

            if (isPdfPath(inputPath)) {
                const sourcePageCount = await getPdfPageCount(inputPath, options?.signal ? { signal: options.signal } : {});
                assertPageLimit(addPageCounts(pageCount, sourcePageCount), limits);
                chunkPaths.push(inputPath);
                pageCount = addPageCounts(pageCount, sourcePageCount);
            } else if (isDjvuPath(inputPath)) {
                const convertedPath = await convertDjvuChunk(inputPath, tempDir, options);
                const sourcePageCount = await getPdfPageCount(convertedPath, options?.signal ? { signal: options.signal } : {});
                assertPageLimit(addPageCounts(pageCount, sourcePageCount), limits);
                chunkPaths.push(convertedPath);
                pageCount = addPageCounts(pageCount, sourcePageCount);
            } else {
                if (isStrictNativeFailure(options)) {
                    throwNativeCapabilityError(
                        'native-unavailable',
                        describeUnsupportedNativeInput([inputPath]),
                    );
                }
                return null;
            }

            progress.processed += 1;
            emitProgress(progress, options, progress.processed);
        }

        throwIfAborted(options?.signal);
        const addedImagePages = await flushImageChunk(
            imageChunkPaths,
            tempDir,
            chunkPaths,
            progress,
            pageCount,
            limits,
            true,
            options,
        );
        if (addedImagePages === null) {
            return null;
        }
        pageCount = addPageCounts(pageCount, addedImagePages);

        if (chunkPaths.length === 0) {
            return null;
        }

        if (chunkPaths.length === 1) {
            await copyFile(chunkPaths[0]!, outputPath);
            await assertNonEmptyPdfOutput(outputPath, 'Assembling PDF inputs');
            throwIfAborted(options?.signal);
            emitProgress(progress, options, progress.total);
            return pageCount;
        }

        await mergePdfChunks(chunkPaths, outputPath, options?.signal);
        throwIfAborted(options?.signal);
        emitProgress(progress, options, progress.total);
        return pageCount;
    } catch (error) {
        if (getUnprovenNativeTerminationDetail(error) !== undefined) {
            throw error;
        }
        if (options?.signal?.aborted || isAbortError(error)) {
            throw error;
        }
        if (isPdfCombineOutputTooLargeError(error)) {
            throw error;
        }
        if (isStrictNativeFailure(options)) {
            if (isPdfCombineCapabilityError(error)) {
                throw error;
            }
            throw createNativeCapabilityError(
                'native-failure',
                `Native PDF assembler failed: ${getErrorMessage(error)}`,
                error,
            );
        }
        log.warn(`Native PDF assembler failed, falling back to JS combine: ${getErrorMessage(error)}`);
        return null;
    }
}

async function assertNativeCombineDiskSpace(inputPaths: string[], outputPath: string, limits: INativePdfAssemblerResourceLimits) {
    if (typeof statfs !== 'function') {
        return;
    }
    const inputStats = await Promise.all(inputPaths.map(async path => ({
        path,
        stat: await stat(path, {bigint: true}),
    })));
    const totalInputBytes = inputStats.reduce(
        (total, entry) => addSafeByteCounts(
            total,
            toSafeByteCount(entry.stat.size, `Input file ${entry.path}`),
            'Combined input files',
        ),
        0,
    );
    const estimatedOutputBytes = Math.min(
        limits.maxOutputBytes,
        Math.max(
            MIN_NATIVE_DISK_RESERVATION_BYTES,
            multiplySafeByteCount(totalInputBytes, 2, 'Estimated PDF combine output'),
        ),
    );
    const filesystem = await statfs(dirname(outputPath), {bigint: true});
    const availableBytes = multiplySafeByteCount(
        toSafeByteCount(filesystem.bavail, 'Available filesystem blocks'),
        toSafeByteCount(filesystem.bsize, 'Filesystem block size'),
        'Available filesystem bytes',
    );
    const requiredBytes = multiplySafeByteCount(estimatedOutputBytes, 2, 'Required PDF combine scratch space');
    if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
        throw new Error(`Insufficient disk space for PDF combine (requires ${requiredBytes} bytes)`);
    }
}

export async function tryWritePdfFromInputPathsNative(
    inputPaths: string[],
    outputPath: string,
    options?: INativePdfAssemblerOptions,
): Promise<boolean> {
    const strict = isStrictNativeFailure(options);
    if (strict && isNativePdfAssemblerDisabled()) {
        throwNativeCapabilityError(
            'native-unavailable',
            'Native PDF combine is disabled or unavailable',
        );
    }
    if (strict && inputPaths.length > 0 && !inputPaths.every(isNativePdfAssemblerInputPath)) {
        throwNativeCapabilityError(
            'native-unavailable',
            describeUnsupportedNativeInput(inputPaths),
        );
    }
    if (!canUseNativePdfAssembler(inputPaths)) {
        return false;
    }

    const normalizedOutputPath = typeof outputPath === 'string' ? outputPath : '';
    if (!normalizedOutputPath) {
        return false;
    }

    const scratchRoot = getAppTempDir();
    let tempDir: string;
    try {
        tempDir = await createManagedScratchTempDir('pdfExport-scope-', scratchRoot);
    } catch (error) {
        if (strict) {
            throw createNativeCapabilityError(
                'native-failure',
                `Native PDF assembler temp directory could not be created: ${getErrorMessage(error)}`,
                error,
            );
        }
        throw error;
    }
    const stagedOutputPath = makeSiblingTempPath(normalizedOutputPath);
    const limits = getResourceLimits('file-backed', strict);
    let retainNativeCleanup = false;

    try {
        await assertNativeCombineDiskSpace(inputPaths, normalizedOutputPath, limits);
        const expectedPageCount = await writePdfFromInputPathsNativeWithTempDir(
            inputPaths,
            stagedOutputPath,
            tempDir,
            limits,
            options,
        );
        if (expectedPageCount === null) {
            if (strict) {
                throwNativeCapabilityError(
                    'native-failure',
                    'Native PDF assembler did not produce an output file',
                );
            }
            return false;
        }

        const outputStat = await stat(stagedOutputPath);
        assertOutputLimit(toSafeByteCount(outputStat.size, `Native PDF output ${stagedOutputPath}`), limits);
        const outputPageCount = await getPdfPageCount(
            stagedOutputPath,
            options?.signal ? {signal: options.signal} : {},
        );
        if (outputPageCount !== expectedPageCount || outputPageCount < 1) {
            throw new Error(`Combined PDF page-count postcondition failed: expected ${expectedPageCount}, got ${outputPageCount}`);
        }

        throwIfAborted(options?.signal);
        await atomicReplace(stagedOutputPath, normalizedOutputPath);
        return true;
    } catch (error) {
        if (getUnprovenNativeTerminationDetail(error) !== undefined) {
            retainNativeCleanup = true;
            throw error;
        }
        if (options?.signal?.aborted || isAbortError(error)) {
            throw error;
        }
        if (isPdfCombineOutputTooLargeError(error)) {
            throw error;
        }
        if (!strict) {
            throw error;
        }
        if (isPdfCombineCapabilityError(error)) {
            throw error;
        }
        throw createNativeCapabilityError(
            'native-failure',
            `Native PDF assembler failed: ${getErrorMessage(error)}`,
            error,
        );
    } finally {
        if (!retainNativeCleanup) {
            await rm(stagedOutputPath, { force: true }).catch(() => undefined);
            await removeManagedScratchTempDir(tempDir, 'pdfExport-scope-', scratchRoot).catch(() => undefined);
        }
    }
}

export async function tryCreatePdfFromInputPathsNative(
    inputPaths: string[],
    options?: INativePdfAssemblerOptions,
): Promise<Uint8Array | null> {
    const strict = isStrictNativeFailure(options);
    if (strict && isNativePdfAssemblerDisabled()) {
        throwNativeCapabilityError(
            'native-unavailable',
            'Native PDF combine is disabled or unavailable',
        );
    }
    if (strict && inputPaths.length > 0 && !inputPaths.every(isNativePdfAssemblerInputPath)) {
        throwNativeCapabilityError(
            'native-unavailable',
            describeUnsupportedNativeInput(inputPaths),
        );
    }
    if (!canUseNativePdfAssembler(inputPaths)) {
        return null;
    }

    try {
        return await usingManagedScratchScope('pdfExport-scope-', getAppTempDir(), async tempDir => {
            const outputPath = join(tempDir, `${randomUUID()}.pdf`);
            // This API returns a Uint8Array to its caller. Keep its output budget
            // finite even when strict mode prevents a JS fallback. Callers that need
            // large native output must use the file-backed API above.
            const limits = getResourceLimits(strict ? 'file-backed' : 'memory');

            const expectedPageCount = await writePdfFromInputPathsNativeWithTempDir(
                inputPaths,
                outputPath,
                tempDir,
                limits,
                options,
            );
            if (expectedPageCount === null) {
                if (strict) {
                    throwNativeCapabilityError(
                        'native-failure',
                        'Native PDF assembler did not produce an output file',
                    );
                }
                return null;
            }
            const outputPageCount = await getPdfPageCount(outputPath, options?.signal ? {signal: options.signal} : {});
            if (outputPageCount !== expectedPageCount || outputPageCount < 1) {
                throw new Error(`Combined PDF page-count postcondition failed: expected ${expectedPageCount}, got ${outputPageCount}`);
            }
            return readLimitedPdfOutput(outputPath, limits);
        });
    } catch (error) {
        if (getUnprovenNativeTerminationDetail(error) !== undefined) {
            throw error;
        }
        if (options?.signal?.aborted || isAbortError(error)) {
            throw error;
        }
        if (isPdfCombineOutputTooLargeError(error)) {
            throw error;
        }
        if (strict) {
            if (isPdfCombineCapabilityError(error)) {
                throw error;
            }
            throw createNativeCapabilityError(
                'native-failure',
                `Native PDF assembler failed: ${getErrorMessage(error)}`,
                error,
            );
        }
        log.warn(`Native PDF assembler failed, falling back to JS combine: ${getErrorMessage(error)}`);
        return null;
    }
}
