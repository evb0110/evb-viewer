import {
    copyFile,
    mkdtemp,
    readFile,
    rm,
    stat,
    statfs,
    writeFile,
} from 'fs/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import {
    extname,
    dirname,
    join,
} from 'path';
import {
    cancelConversion,
    convertDjvuToPdfFile,
} from '@electron/features/djvu/public';
import { getDjvuPageCount } from '@electron/djvu/metadata';
import {
    assertNonEmptyPdfOutput,
    getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES,
    QPDF_TIMEOUT_MS,
    runQpdfCommand,
} from '@electron/features/page-ops/publicNative';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public/nativePageOpsPath';
import {runNativeCommand} from '@electron/native-tools/runNativeCommand';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
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
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {
    createPdfCombineOutputTooLargeError,
    isPdfCombineOutputTooLargeError,
    normalizePdfCombineOutputLimit,
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
}

const IN_MEMORY_NATIVE_ASSEMBLER_MAX_PAGES = 500;
const FILE_BACKED_NATIVE_ASSEMBLER_MAX_PAGES = Number.MAX_SAFE_INTEGER;
const PDF_COMBINE_SMALL_MEMORY_MAX_PAGES_LIMIT = 10_000;
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
    return process.env.EVB_PDF_NATIVE_ASSEMBLER_DISABLE === '1'
        || (process.env.VITEST === 'true' && process.env.EVB_PDF_NATIVE_ASSEMBLER_ENABLE !== '1');
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
): INativePdfAssemblerResourceLimits {
    if (mode === 'file-backed') {
        return {
            maxOutputBytes: normalizePdfCombineOutputLimit(
                parseIntegerEnv(
                    'EVB_PDF_COMBINE_MAX_OUTPUT_MB',
                    PDF_COMBINE_MAX_OUTPUT_BYTES / BYTES_PER_MEBIBYTE,
                    1,
                    PDF_COMBINE_MAX_OUTPUT_BYTES / BYTES_PER_MEBIBYTE,
                ) * BYTES_PER_MEBIBYTE,
            ),
            maxPages: FILE_BACKED_NATIVE_ASSEMBLER_MAX_PAGES,
        };
    }

    return {
        maxOutputBytes: normalizePdfCombineOutputLimit(
            parseIntegerEnv(
                'EVB_PDF_COMBINE_MAX_OUTPUT_MB',
                PDF_COMBINE_MAX_OUTPUT_BYTES / BYTES_PER_MEBIBYTE,
                1,
                PDF_COMBINE_MAX_OUTPUT_BYTES / BYTES_PER_MEBIBYTE,
            ) * BYTES_PER_MEBIBYTE,
        ),
        maxPages: parseIntegerEnv(
            'EVB_PDF_COMBINE_MAX_PAGES',
            IN_MEMORY_NATIVE_ASSEMBLER_MAX_PAGES,
            1,
            PDF_COMBINE_SMALL_MEMORY_MAX_PAGES_LIMIT,
        ),
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
        ...(options?.failureMode === 'capability-error'
            ? {maxInputBytes: NATIVE_IMAGE_COMBINER_MAX_INPUT_BYTES}
            : {}),
        onProgress,
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

async function mergePdfChunks(chunkPaths: string[], outputPath: string, signal?: AbortSignal) {
    const catalog = await readAndOffsetPdfCatalogs(chunkPaths, signal);
    await runQpdfCommand([
        '--empty',
        '--pages',
        ...chunkPaths,
        '--',
        outputPath,
    ], {
        timeoutMs: QPDF_TIMEOUT_MS,
        allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
        commandLabel: 'qpdf(native-pdf-assembler)',
        ...(signal ? { signal } : {}),
    });
    if (catalog !== null) {
        const pageOpsPath = resolveNativePageOpsPath();
        if (!pageOpsPath) {
            throw new Error('Native page operations are required to preserve PDF catalog metadata');
        }
        const mutationsDir = await mkdtemp(join(tmpdir(), 'pdf-catalog-mutations-'));
        try {
            const mutationsPath = join(mutationsDir, 'mutations.json');
            await writeFile(mutationsPath, JSON.stringify(catalog), 'utf8');
            await runNativeCommand(pageOpsPath, [
                'save-mutations',
                '--input',
                outputPath,
                '--output',
                outputPath,
                '--mutations-file',
                mutationsPath,
                '--qpdf',
                getPdfNativeToolPaths().qpdf,
                '--modified-at',
                'D:19700101000000Z',
                '--append',
            ], {
                commandLabel: 'pdf-page-ops(save-mutations-catalog)',
                timeoutMs: QPDF_TIMEOUT_MS,
                ...(signal ? {signal} : {}),
            });
        } finally {
            await rm(mutationsDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        }
    }
    await assertNonEmptyPdfOutput(outputPath, 'Assembling PDF inputs');
}

interface IPdfCatalogBookmark {
    title: string;
    pageIndex: number | null;
    namedDest: string | null;
    bold: boolean;
    italic: boolean;
    color: string | null;
    items: IPdfCatalogBookmark[];
}

interface IPdfCatalogLabel {
    pageIndex: number;
    style?: string;
    prefix?: string;
    start?: number;
}

interface IPdfCombineCatalogMutations {
    pageLabels: {
        totalPages: number;
        ranges: Array<{
            startPage: number;
            style?: string;
            prefix: string;
            startNumber: number
        }>
    };
    bookmarks: {
        totalPages: number;
        untitledLabel: string;
        items: IPdfCatalogBookmark[]
    };
}

async function readAndOffsetPdfCatalogs(chunkPaths: string[], signal?: AbortSignal) {
    const pageOpsPath = resolveNativePageOpsPath();
    const hasPdfInput = chunkPaths.some(path => extname(path).toLowerCase() === '.pdf');
    if (!pageOpsPath) {
        if (hasPdfInput) {
            throw new Error('Native page operations are required to preserve PDF catalog metadata');
        }
        return null;
    }
    if (!hasPdfInput) {
        return null;
    }
    const catalogDir = await mkdtemp(join(tmpdir(), 'pdf-catalog-'));
    try {
        const bookmarks: IPdfCatalogBookmark[] = [];
        const labels: IPdfCatalogLabel[] = [];
        let pageOffset = 0;
        for (const [
            index,
            inputPath,
        ] of chunkPaths.entries()) {
            const pageCount = await getPdfPageCount(inputPath, signal ? {signal} : {});
            if (extname(inputPath).toLowerCase() !== '.pdf') {
                pageOffset = addPageCounts(pageOffset, pageCount);
                continue;
            }
            const catalogPath = join(catalogDir, `${index}.json`);
            await runNativeCommand(pageOpsPath, [
                'read-catalog',
                '--input',
                inputPath,
                '--output',
                catalogPath,
            ], {
                commandLabel: 'pdf-page-ops(read-catalog)',
                timeoutMs: QPDF_TIMEOUT_MS,
                ...(signal ? {signal} : {}),
            });
            const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
                bookmarks?: IPdfCatalogBookmark[];
                pageLabels?: IPdfCatalogLabel[]
            };
            if (!Array.isArray(catalog.bookmarks) || !Array.isArray(catalog.pageLabels)) {
                throw new Error(`Native PDF catalog read returned an invalid result for ${inputPath}`);
            }
            const offsetBookmark = (item: IPdfCatalogBookmark): IPdfCatalogBookmark => ({
                ...item,
                pageIndex: item.pageIndex === null ? null : item.pageIndex + pageOffset,
                items: item.items.map(offsetBookmark),
            });
            bookmarks.push(...catalog.bookmarks.map(offsetBookmark));
            labels.push(...catalog.pageLabels.map(label => ({
                ...label,
                pageIndex: label.pageIndex + pageOffset,
            })));
            pageOffset = addPageCounts(pageOffset, pageCount);
        }
        if (bookmarks.length === 0 && labels.length === 0) {
            return null;
        }
        const mutations: IPdfCombineCatalogMutations = {
            pageLabels: {
                totalPages: pageOffset,
                ranges: labels.map(label => ({
                    startPage: label.pageIndex + 1,
                    ...(label.style === undefined ? {} : {style: label.style}),
                    prefix: label.prefix ?? '',
                    startNumber: label.start ?? 1,
                })),
            },
            bookmarks: {
                totalPages: pageOffset,
                untitledLabel: 'Untitled',
                items: bookmarks,
            },
        };
        return mutations;
    } finally {
        await rm(catalogDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
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

    let tempDir: string;
    try {
        tempDir = await mkdtemp(join(tmpdir(), 'pdf-native-assembler-'));
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
    const limits = getResourceLimits('file-backed');

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
        await rm(stagedOutputPath, { force: true }).catch(() => undefined);
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
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

    let tempDir: string;
    try {
        tempDir = await mkdtemp(join(tmpdir(), 'pdf-native-assembler-'));
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
    const outputPath = join(tempDir, `${randomUUID()}.pdf`);
    // Both native entrypoints use the same finite output policy. The
    // file-backed form keeps bytes on disk, but it still cannot publish an
    // oversized combine result to its caller.
    const limits = getResourceLimits(strict ? 'file-backed' : 'memory');

    try {
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
        return await readLimitedPdfOutput(outputPath, limits);
    } catch (error) {
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
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}
