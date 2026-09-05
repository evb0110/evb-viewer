import { spawn } from 'child_process';
import {
    mkdtemp,
    open,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import {
    dirname,
    extname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { verifyNativeToolProtocol } from '@electron/native-tools/runNativeToolCommand';
import { createNativeFallbackTestError } from '@electron/native-tools/createNativeFallbackTestError';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';
import { abortErrorFromSignal } from '@electron/utils/abort';
import {
    createDetachedChildProcessSpawnOptions,
    terminateDetachedChildProcess,
} from '@electron/utils/nativeChildProcess';
import { readJpegExifOrientation } from '@electron/image/imageDpi';
import { includesAsciiToken } from '@electron/utils/includesAsciiToken';
import {
    createPdfCombineOutputTooLargeError,
    isPdfCombineOutputTooLargeError,
    normalizePdfCombineOutputLimit,
    PDF_COMBINE_MAX_OUTPUT_BYTES,
} from '@contracts/pdfCombineOutputPolicy';
import {isNativeErrorEnvelope} from '@contracts/nativeErrors';
import {
    decodeSerializableErrorEnvelope,
    SerializableError,
} from '@contracts/serializableError';

interface INativePdfImageCombineProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface INativePdfImageCombineOptions {
    maxPages?: number;
    /** Maximum input size passed to the native decoder. */
    maxInputBytes?: number;
    /** Maximum output size accepted from the native writer. */
    maxOutputBytes?: number;
    onProgress?: (progress: INativePdfImageCombineProgress) => void;
    signal?: AbortSignal;
    rotationDegrees?: readonly number[];
}

type TNativeProgressPayload = INativePdfImageCombineProgress & {type: 'progress';};
type TNativePdfImageCombineTermination =
    | {
        kind: 'resolve';
        ok: boolean;
    }
    | {
        kind: 'reject';
        error: Error;
    };

const logger = createLogger('nativePdfImageCombine');
const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = __dirname.includes('app.asar');
const SUPPORTED_NATIVE_BITMAP_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
]);
const SUPPORTED_NATIVE_NETPBM_EXTENSIONS = new Set([
    '.pgm',
    '.ppm',
]);
const NATIVE_PDF_IMAGE_COMBINE_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_IMAGE_COMBINE_TIMEOUT_MS ?? `${5 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
        return 5 * 60 * 1000;
    }
    return parsed;
})();
const NATIVE_PDF_IMAGE_COMBINE_MAX_STDOUT_BUFFER_BYTES = 64 * 1024;
const NATIVE_PDF_IMAGE_COMBINE_TEST_ENABLE_ENV = 'EVB_PDF_IMAGE_COMBINE_ENABLE';
const PDF_HEADER_SCAN_BYTES = 1024;
const PDF_EOF_SCAN_BYTES = 1024 * 1024;
const JPEG_ORIENTATION_SCAN_MAX_BYTES = 4 * 1024 * 1024;
const BYTES_PER_MEBIBYTE = 1024 * 1024;
const NATIVE_PDF_IMAGE_COMBINE_MAX_INPUT_MB = 4_096;
const NATIVE_PDF_IMAGE_COMBINE_MAX_OUTPUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_COMBINE_MAX_OUTPUT_MB ?? String(
        PDF_COMBINE_MAX_OUTPUT_BYTES / BYTES_PER_MEBIBYTE,
    ), 10);
    const megabytes = Number.isFinite(parsed) && parsed >= 1
        ? Math.min(parsed, PDF_COMBINE_MAX_OUTPUT_BYTES / BYTES_PER_MEBIBYTE)
        : PDF_COMBINE_MAX_OUTPUT_BYTES / BYTES_PER_MEBIBYTE;
    return megabytes * BYTES_PER_MEBIBYTE;
})();

function getBinaryName() {
    return process.platform === 'win32'
        ? 'evb-pdf-image-combine.exe'
        : 'evb-pdf-image-combine';
}

export function isNativePdfImageCombineDisabled() {
    return process.env.EVB_PDF_IMAGE_COMBINE_DISABLE === '1'
        || (process.env.VITEST === 'true' && process.env[NATIVE_PDF_IMAGE_COMBINE_TEST_ENABLE_ENV] !== '1');
}

export function resolveNativePdfImageCombinePath() {
    return resolveNativeToolPath({
        binaryName: getBinaryName(),
        crateName: 'pdf-image-combine',
        currentDir: __dirname,
        envOverridePath: process.env.EVB_PDF_IMAGE_COMBINE_PATH,
        isPackaged,
    });
}

function canUseNativePdfImageCombine(inputPaths: string[], supportedExtensions: Set<string>) {
    return !isNativePdfImageCombineDisabled()
        && inputPaths.length > 0
        && inputPaths.every(path => supportedExtensions.has(extname(path).toLowerCase()))
        && inputPaths.every(canRepresentPathInNativeInputsFile);
}

export function isNativePdfImageCombineBitmapPath(inputPath: string) {
    return SUPPORTED_NATIVE_BITMAP_EXTENSIONS.has(extname(inputPath).toLowerCase());
}

function parseProgressPayload(value: unknown): TNativeProgressPayload | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const payload = value as Record<string, unknown>;
    if (payload.type !== 'progress') {
        return null;
    }
    if (
        typeof payload.processed !== 'number'
        || typeof payload.total !== 'number'
        || typeof payload.percent !== 'number'
        || typeof payload.elapsedMs !== 'number'
    ) {
        return null;
    }

    return {
        type: 'progress',
        processed: payload.processed,
        total: payload.total,
        percent: payload.percent,
        elapsedMs: payload.elapsedMs,
        estimatedRemainingMs: typeof payload.estimatedRemainingMs === 'number'
            ? payload.estimatedRemainingMs
            : null,
    };
}

function canRepresentPathInNativeInputsFile(inputPath: string) {
    return inputPath.length > 0
        && inputPath.trim() === inputPath
        && !/[\r\n]/u.test(inputPath);
}

function createNativeInputsFileContents(inputPaths: string[]) {
    if (!inputPaths.every(canRepresentPathInNativeInputsFile)) {
        throw new Error('Native image combine input paths must not contain leading/trailing whitespace or line breaks');
    }
    return `${inputPaths.join('\n')}\n`;
}

function createNativeRotationFileContents(rotationDegrees: readonly number[]) {
    return `${rotationDegrees.join('\n')}\n`;
}

async function isStructurallyPlausiblePdfFile(outputPath: string) {
    const handle = await open(outputPath, 'r');
    try {
        const fileStat = await handle.stat();
        if (!fileStat.isFile() || fileStat.size <= 0) {
            return false;
        }

        const headerLength = Math.min(fileStat.size, PDF_HEADER_SCAN_BYTES);
        const eofLength = Math.min(fileStat.size, PDF_EOF_SCAN_BYTES);
        const header = Buffer.alloc(headerLength);
        const eof = Buffer.alloc(eofLength);

        await handle.read(header, 0, headerLength, 0);
        await handle.read(eof, 0, eofLength, Math.max(0, fileStat.size - eofLength));

        return includesAsciiToken(header, '%PDF-', 0, header.byteLength)
            && includesAsciiToken(eof, '%%EOF', 0, eof.byteLength);
    } finally {
        await handle.close();
    }
}

function normalizeOutputLimit(value: number | undefined) {
    return Math.min(
        NATIVE_PDF_IMAGE_COMBINE_MAX_OUTPUT_BYTES,
        normalizePdfCombineOutputLimit(value),
    );
}

async function assertNativePdfOutputSize(outputPath: string, maxOutputBytes: number) {
    const outputHandle = await open(outputPath, 'r');
    try {
        const outputStat = await outputHandle.stat();
        if (outputStat.size > maxOutputBytes) {
            throw createPdfCombineOutputTooLargeError();
        }
    } finally {
        await outputHandle.close();
    }
}

async function isNativePdfOutputPlausibleAfterSizeCheck(outputPath: string) {
    return isStructurallyPlausiblePdfFile(outputPath);
}

async function readNativePdfOutputAfterSizeCheck(outputPath: string) {
    if (!await isNativePdfOutputPlausibleAfterSizeCheck(outputPath)) {
        return null;
    }
    return new Uint8Array(await readFile(outputPath));
}

async function handleInvalidNativePdfOutput<T>(
    outputPath: string,
    fallbackDetail: string,
    fallbackCause: unknown,
    fallbackValue: T,
) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    const testFailure = createNativeFallbackTestError(
        NATIVE_PDF_IMAGE_COMBINE_TEST_ENABLE_ENV,
        'Native image PDF combine',
        fallbackDetail,
        fallbackCause,
    );
    if (testFailure) {
        throw testFailure;
    }
    return fallbackValue;
}

async function validateNativePdfOutput<T>(
    outputPath: string,
    validateOutput: (path: string) => Promise<T | null | false>,
    fallbackValue: T,
    maxOutputBytes = NATIVE_PDF_IMAGE_COMBINE_MAX_OUTPUT_BYTES,
    assertOutputSizeOutsideTry = false,
): Promise<T> {
    if (assertOutputSizeOutsideTry) {
        await assertNativePdfOutputSize(outputPath, maxOutputBytes);
    }
    let fallbackDetail = `native output at "${outputPath}" could not be validated`;
    let fallbackCause: unknown;

    try {
        if (!assertOutputSizeOutsideTry) {
            await assertNativePdfOutputSize(outputPath, maxOutputBytes);
        }
        const output = await validateOutput(outputPath);
        if (output) {
            return output;
        }
        logger.warn(`Native image PDF combine produced invalid PDF output at "${outputPath}"`);
        fallbackDetail = `native output at "${outputPath}" is not a structurally valid PDF`;
    } catch (error) {
        if (isPdfCombineOutputTooLargeError(error)) {
            await rm(outputPath, { force: true }).catch(() => undefined);
            throw error;
        }
        logger.warn(`Native image PDF combine output is unavailable at "${outputPath}": ${getErrorMessage(error)}`);
        fallbackDetail = `native output at "${outputPath}" could not be read`;
        fallbackCause = error;
    }

    return handleInvalidNativePdfOutput(
        outputPath,
        fallbackDetail,
        fallbackCause,
        fallbackValue,
    );
}

async function readValidatedNativePdfOutput(
    outputPath: string,
    maxOutputBytes = NATIVE_PDF_IMAGE_COMBINE_MAX_OUTPUT_BYTES,
) {
    return validateNativePdfOutput(
        outputPath,
        readNativePdfOutputAfterSizeCheck,
        null,
        maxOutputBytes,
        true,
    );
}

async function validateNativePdfOutputFile(
    outputPath: string,
    maxOutputBytes = NATIVE_PDF_IMAGE_COMBINE_MAX_OUTPUT_BYTES,
) {
    return validateNativePdfOutput(
        outputPath,
        isNativePdfOutputPlausibleAfterSizeCheck,
        false,
        maxOutputBytes,
    );
}

interface INativePdfImageCombineTempFiles {
    tempDir: string;
    inputsPath: string;
    rotationsPath: string;
}

async function withNativePdfImageCombineTempFiles<T>(
    inputPaths: string[],
    rotationDegrees: readonly number[] | undefined,
    operation: (files: INativePdfImageCombineTempFiles) => Promise<T>,
) {
    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-image-combine-'));
    const files = {
        tempDir,
        inputsPath: join(tempDir, 'inputs.txt'),
        rotationsPath: join(tempDir, 'rotations.txt'),
    };

    try {
        await writeFile(files.inputsPath, createNativeInputsFileContents(inputPaths), 'utf8');
        await writeFile(
            files.rotationsPath,
            createNativeRotationFileContents(rotationDegrees ?? inputPaths.map(() => 0)),
            'utf8',
        );
        return await operation(files);
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}

export async function tryCreatePdfWithNativeImageCombiner(
    inputPaths: string[],
    options?: INativePdfImageCombineOptions,
): Promise<Uint8Array | null> {
    if (!canUseNativePdfImageCombine(inputPaths, SUPPORTED_NATIVE_BITMAP_EXTENSIONS)) {
        return null;
    }
    const rotationDegrees = await readInputRotationDegrees(inputPaths, options?.signal);
    if (rotationDegrees === null) {
        return null;
    }
    return createPdfWithNativeImageCombiner(inputPaths, {
        ...options,
        rotationDegrees,
    });
}

export async function tryWritePdfWithNativeImageCombiner(
    inputPaths: string[],
    outputPath: string,
    options?: INativePdfImageCombineOptions,
): Promise<boolean> {
    if (!canUseNativePdfImageCombine(inputPaths, SUPPORTED_NATIVE_BITMAP_EXTENSIONS)) {
        return false;
    }
    const rotationDegrees = await readInputRotationDegrees(inputPaths, options?.signal);
    if (rotationDegrees === null) {
        return false;
    }
    return writePdfWithNativeImageCombiner(inputPaths, outputPath, {
        ...options,
        rotationDegrees,
    });
}

function hasCompleteJpegMetadataPrefix(bytes: Uint8Array) {
    if (bytes.byteLength < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return true;
    }
    let offset = 2;
    while (offset < bytes.byteLength) {
        while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.byteLength) {
            return false;
        }
        const marker = bytes[offset]!;
        offset += 1;
        if (marker === 0xda || marker === 0xd9) {
            return true;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > bytes.byteLength) {
            return false;
        }
        const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
        if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
            return false;
        }
        offset += segmentLength;
    }
    return false;
}

async function readBoundedJpegMetadata(inputPath: string, signal?: AbortSignal) {
    const handle = await open(inputPath, 'r');
    try {
        const fileStat = await handle.stat();
        if (!fileStat.isFile()) {
            throw new Error(`Input path is not a regular file: ${inputPath}`);
        }
        const byteLength = Math.min(fileStat.size, JPEG_ORIENTATION_SCAN_MAX_BYTES);
        const bytes = Buffer.alloc(byteLength);
        let bytesRead = 0;
        while (bytesRead < byteLength) {
            if (signal?.aborted) throw abortErrorFromSignal(signal);
            const result = await handle.read(bytes, bytesRead, byteLength - bytesRead, bytesRead);
            if (result.bytesRead <= 0) break;
            bytesRead += result.bytesRead;
        }
        return bytes.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

async function readInputRotationDegrees(inputPaths: string[], signal?: AbortSignal): Promise<number[] | null> {
    const rotations: number[] = [];
    for (const inputPath of inputPaths) {
        if (signal?.aborted) throw abortErrorFromSignal(signal);
        const extension = extname(inputPath).toLowerCase();
        if (extension !== '.jpg' && extension !== '.jpeg') {
            rotations.push(0);
            continue;
        }
        const metadata = await readBoundedJpegMetadata(inputPath, signal);
        if (!hasCompleteJpegMetadataPrefix(metadata)) {
            return null;
        }
        const orientation = readJpegExifOrientation(metadata);
        rotations.push(orientation === 3 ? 180 : orientation === 6 ? 90 : orientation === 8 ? 270 : 0);
    }
    return rotations;
}

export async function tryBuildOptimizedPdfWithNativeImageCombiner(
    imagePaths: string[],
    dpi: number,
    onPageProcessed?: (pageNum: number, totalPages: number) => void,
    options: Pick<INativePdfImageCombineOptions, 'signal'> = {},
): Promise<Uint8Array | null> {
    if (!Number.isFinite(dpi) || dpi <= 0 || !canUseNativePdfImageCombine(imagePaths, SUPPORTED_NATIVE_NETPBM_EXTENSIONS)) {
        return null;
    }

    return createPdfWithNativeImageCombiner(imagePaths, {
        ...(onPageProcessed ? {onProgress: progress => onPageProcessed(progress.processed, progress.total)} : {}),
        ...(options.signal === undefined ? {} : {signal: options.signal}),
    }, [
        '--dpi',
        String(Math.round(dpi)),
    ]);
}

async function createPdfWithNativeImageCombiner(
    inputPaths: string[],
    options?: INativePdfImageCombineOptions,
    extraArgs: string[] = [],
) {
    const binaryPath = resolveNativePdfImageCombinePath();
    if (!binaryPath) {
        const testFailure = createNativeFallbackTestError(
            NATIVE_PDF_IMAGE_COMBINE_TEST_ENABLE_ENV,
            'Native image PDF combine',
            'native binary path could not be resolved',
        );
        if (testFailure) {
            throw testFailure;
        }
        return null;
    }

    return withNativePdfImageCombineTempFiles(inputPaths, options?.rotationDegrees, async ({
        tempDir,
        inputsPath,
        rotationsPath,
    }) => {
        const outputPath = join(tempDir, `${randomUUID()}.pdf`);
        const ok = await runNativePdfImageCombine(binaryPath, outputPath, [], options, [
            ...extraArgs,
            '--inputs-file',
            inputsPath,
            '--rotations-file',
            rotationsPath,
        ]);
        if (!ok) {
            return null;
        }
        return readValidatedNativePdfOutput(
            outputPath,
            normalizeOutputLimit(options?.maxOutputBytes),
        );
    });
}

async function writePdfWithNativeImageCombiner(
    inputPaths: string[],
    outputPath: string,
    options?: INativePdfImageCombineOptions,
) {
    const binaryPath = resolveNativePdfImageCombinePath();
    if (!binaryPath) {
        const testFailure = createNativeFallbackTestError(
            NATIVE_PDF_IMAGE_COMBINE_TEST_ENABLE_ENV,
            'Native image PDF combine',
            'native binary path could not be resolved',
        );
        if (testFailure) {
            throw testFailure;
        }
        return false;
    }

    return withNativePdfImageCombineTempFiles(inputPaths, options?.rotationDegrees, async ({
        inputsPath,
        rotationsPath,
    }) => {
        try {
            const ok = await runNativePdfImageCombine(binaryPath, outputPath, [], options, [
                '--inputs-file',
                inputsPath,
                '--rotations-file',
                rotationsPath,
            ]);
            if (!ok) {
                await rm(outputPath, { force: true }).catch(() => undefined);
                return false;
            }
            return await validateNativePdfOutputFile(
                outputPath,
                normalizeOutputLimit(options?.maxOutputBytes),
            );
        } catch (error) {
            if (
                error instanceof Error
            && error.message.startsWith('Native image PDF combine fallback is not allowed in tests:')
            ) {
                await rm(outputPath, { force: true }).catch(() => undefined);
            }
            throw error;
        }
    });
}

async function runNativePdfImageCombine(
    binaryPath: string,
    outputPath: string,
    inputPaths: string[],
    options?: INativePdfImageCombineOptions,
    extraArgs: string[] = [],
) {
    if (options?.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }

    const args = [
        '--output',
        outputPath,
        '--json-progress',
        ...extraArgs,
    ];
    if (inputPaths.length > 0) {
        args.push('--', ...inputPaths);
    }
    const maxPages = normalizeMaxPagesForEnv(options?.maxPages);
    const maxInputMb = normalizeMaxInputMbForEnv(options?.maxInputBytes);
    const maxOutputBytes = normalizeOutputLimit(options?.maxOutputBytes);
    const env = {
        ...process.env,
        EVB_PDF_COMBINE_MAX_OUTPUT_BYTES: String(maxOutputBytes),
        ...(maxInputMb ? {EVB_PDF_COMBINE_MAX_INPUT_MB: maxInputMb} : {}),
        ...(maxPages ? {EVB_PDF_COMBINE_MAX_PAGES: maxPages} : {}),
    };

    await verifyNativeToolProtocol(binaryPath, {
        env,
        ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (options?.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }

    return new Promise<boolean>((resolve, reject) => {
        const proc = spawn(binaryPath, args, createDetachedChildProcessSpawnOptions({
            env,
            shell: false,
            windowsHide: true,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        }));

        let settled = false;
        let stdoutBuffer = '';
        let stderr = '';
        let abortHandler: (() => void) | null = null;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let forceSettleHandle: ReturnType<typeof setTimeout> | null = null;
        let pendingTermination: TNativePdfImageCombineTermination | null = null;

        const cleanup = () => {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (forceSettleHandle) {
                clearTimeout(forceSettleHandle);
                forceSettleHandle = null;
            }
            if (abortHandler) {
                options?.signal?.removeEventListener('abort', abortHandler);
                abortHandler = null;
            }
        };

        const finish = (ok: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(ok);
        };

        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };

        const createFailure = (detail: string, cause?: unknown) => createNativeFallbackTestError(
            NATIVE_PDF_IMAGE_COMBINE_TEST_ENABLE_ENV,
            'Native image PDF combine',
            detail,
            cause,
        );

        const finishFailure = (detail: string, cause?: unknown) => {
            const failure = createFailure(detail, cause);
            if (failure) {
                fail(failure);
                return;
            }
            finish(false);
        };

        const requestFailureTermination = (detail: string, cause?: unknown) => {
            const failure = createFailure(detail, cause);
            requestTermination(failure
                ? {
                    kind: 'reject',
                    error: failure,
                }
                : {
                    kind: 'resolve',
                    ok: false,
                });
        };

        const settleAfterTermination = (completion: TNativePdfImageCombineTermination) => {
            if (pendingTermination !== completion) {
                return;
            }
            pendingTermination = null;
            if (completion.kind === 'reject') {
                fail(completion.error);
                return;
            }
            finish(completion.ok);
        };

        const requestTermination = (completion: TNativePdfImageCombineTermination) => {
            if (settled || pendingTermination) {
                return;
            }
            pendingTermination = completion;
            proc.stdout?.removeAllListeners('data');
            proc.stderr?.removeAllListeners('data');
            proc.stdout?.destroy?.();
            proc.stderr?.destroy?.();
            void terminateDetachedChildProcess(proc, 1_000)
                .finally(() => settleAfterTermination(completion));
            forceSettleHandle = setTimeout(() => {
                settleAfterTermination(completion);
            }, 3_000);
            forceSettleHandle.unref?.();
        };

        const handleProgressLine = (line: string) => {
            if (!line.trim() || !options?.onProgress) {
                return;
            }
            try {
                const payload = parseProgressPayload(JSON.parse(line));
                if (payload) {
                    options.onProgress({
                        processed: payload.processed,
                        total: payload.total,
                        percent: payload.percent,
                        elapsedMs: payload.elapsedMs,
                        estimatedRemainingMs: payload.estimatedRemainingMs,
                    });
                }
            } catch {
                return;
            }
        };

        timeoutHandle = setTimeout(() => {
            logger.warn(`Native image PDF combine timed out after ${NATIVE_PDF_IMAGE_COMBINE_TIMEOUT_MS}ms`);
            requestFailureTermination(`native process timed out after ${NATIVE_PDF_IMAGE_COMBINE_TIMEOUT_MS}ms`);
        }, NATIVE_PDF_IMAGE_COMBINE_TIMEOUT_MS);
        timeoutHandle.unref?.();

        if (options?.signal) {
            abortHandler = () => {
                requestTermination({
                    kind: 'reject',
                    error: abortErrorFromSignal(options.signal!),
                });
            };
            options.signal.addEventListener('abort', abortHandler, { once: true });
            if (options.signal.aborted) {
                abortHandler();
            }
        }

        proc.stdout?.on('data', (data: Buffer) => {
            stdoutBuffer += data.toString('utf8');
            if (Buffer.byteLength(stdoutBuffer, 'utf8') > NATIVE_PDF_IMAGE_COMBINE_MAX_STDOUT_BUFFER_BYTES) {
                logger.warn(`Native image PDF combine stdout line exceeded ${NATIVE_PDF_IMAGE_COMBINE_MAX_STDOUT_BUFFER_BYTES} bytes`);
                requestFailureTermination(
                    `native stdout line exceeded ${NATIVE_PDF_IMAGE_COMBINE_MAX_STDOUT_BUFFER_BYTES} bytes`,
                );
                return;
            }
            let lineBreak = stdoutBuffer.indexOf('\n');
            while (lineBreak >= 0) {
                const line = stdoutBuffer.slice(0, lineBreak);
                stdoutBuffer = stdoutBuffer.slice(lineBreak + 1);
                handleProgressLine(line);
                lineBreak = stdoutBuffer.indexOf('\n');
            }
        });

        proc.stderr?.on('data', (data: Buffer) => {
            stderr = `${stderr}${data.toString('utf8')}`.slice(-8_192);
        });

        proc.on('error', (error) => {
            logger.warn(`Native image PDF combine failed to start: ${getErrorMessage(error)}`);
            finishFailure('native process failed to start', error);
        });

        proc.on('close', (code) => {
            if (settled) {
                return;
            }
            if (pendingTermination) {
                settleAfterTermination(pendingTermination);
                return;
            }
            if (stdoutBuffer) {
                handleProgressLine(stdoutBuffer);
                stdoutBuffer = '';
            }
            if (code !== 0) {
                const detail = stderr.trim();
                logger.debug(`Native image PDF combine exited with code ${code}${detail ? `: ${detail}` : ''}`);
                const nativeError = decodeSerializableErrorEnvelope(
                    detail,
                    isNativeErrorEnvelope,
                    {allowBareJsonString: true},
                );
                if (nativeError?.code === 'too-large') {
                    fail(new SerializableError(nativeError));
                    return;
                }
                finishFailure(`native process exited with code ${code}${detail ? `: ${detail}` : ''}`);
                return;
            }
            finish(true);
        });
    });
}

function normalizeMaxPagesForEnv(value: number | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
        return null;
    }
    return String(Math.trunc(value));
}

function normalizeMaxInputMbForEnv(value: number | undefined) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < BYTES_PER_MEBIBYTE) {
        return null;
    }
    return String(Math.min(
        NATIVE_PDF_IMAGE_COMBINE_MAX_INPUT_MB,
        Math.max(16, Math.ceil(value / BYTES_PER_MEBIBYTE)),
    ));
}
