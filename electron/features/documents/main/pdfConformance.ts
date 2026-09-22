import { randomUUID } from 'node:crypto';
import {
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { compact } from 'es-toolkit/array';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import { isRecord } from '@contracts/runtimeGuards';
import { createDefaultPdfConformanceProfile } from '@pdf-core';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import {
    validatePdfStructureFromPath,
    type IPdfConformancePathAnalysisOptions,
} from '@electron/features/documents/main/pdfConformancePathAnalysis';
import {
    resolveUnpackedWorkerPath,
    runResultWorkerTask,
} from '@electron/utils/workerTask';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';

const logger = createLogger('documents-pdfConformance');
const QPDF_VALIDATE_BASE_TIMEOUT_MS = 30_000;
const QPDF_VALIDATE_MAX_TIMEOUT_MS = 10 * 60_000;
const QPDF_VALIDATE_TIMEOUT_SCALE_START_BYTES = 64 * 1024 * 1024;
const QPDF_VALIDATE_TIMEOUT_BYTES_PER_STEP = 16 * 1024 * 1024;
const QPDF_VALIDATE_TIMEOUT_STEP_MS = 1_000;
const QPDF_VALIDATE_COMMAND_LABEL = 'qpdf(validate-pdf)';
const QPDF_VALIDATE_TIMEOUT_PATTERN = /^qpdf\(validate-pdf\) timed out after \d+ms$/u;
const QPDF_STRUCTURAL_VALIDATE_TIMEOUT_MS = 10_000;
const QPDF_OPENING_VALIDATE_COMMAND_LABEL = 'qpdf(validate-pdf-opening)';
const QPDF_SAVE_VALIDATE_COMMAND_LABEL = 'qpdf(validate-pdf-structure)';
const QPDF_EXIT_CODE_OK = 0;
const QPDF_EXIT_CODE_WARNINGS = 3;
const PDF_CONFORMANCE_WORKER_FILENAME = WORKER_BUNDLES_BY_ID['pdf-conformance'].fileName;
const __dirname = dirname(fileURLToPath(import.meta.url));

export type {IPdfConformancePathAnalysisOptions};

type TPdfFileStat = Awaited<ReturnType<typeof stat>>;

function resolveQpdfValidationTimeoutMs(fileSize: number | bigint | undefined) {
    const normalizedFileSize = typeof fileSize === 'bigint'
        ? Number(fileSize > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : fileSize)
        : fileSize;
    if (typeof normalizedFileSize !== 'number' || !Number.isFinite(normalizedFileSize)) {
        return QPDF_VALIDATE_BASE_TIMEOUT_MS;
    }
    const extraBytes = Math.max(0, normalizedFileSize - QPDF_VALIDATE_TIMEOUT_SCALE_START_BYTES);
    const extraSteps = Math.ceil(extraBytes / QPDF_VALIDATE_TIMEOUT_BYTES_PER_STEP);
    return Math.min(
        QPDF_VALIDATE_MAX_TIMEOUT_MS,
        QPDF_VALIDATE_BASE_TIMEOUT_MS + extraSteps * QPDF_VALIDATE_TIMEOUT_STEP_MS,
    );
}

async function tryStatPdfFile(filePath: string): Promise<TPdfFileStat | null> {
    try {
        return await stat(filePath);
    } catch {
        return null;
    }
}

function sanitizeValidationFileName(fileName?: string) {
    const fallback = 'document.pdf';
    const trimmed = fileName?.trim();
    const baseName = basename(trimmed && trimmed.length > 0 ? trimmed : fallback);
    const sanitized = baseName.replace(/[^\w.-]+/gu, '-');
    return sanitized.toLowerCase().endsWith('.pdf') ? sanitized : `${sanitized}.pdf`;
}

function extractQpdfWarnings(text: string) {
    return compact(text
        .split(/\r?\n/u)
        .map(line => line.trim()))
        .filter(line => !/^checking /iu.test(line));
}

class PdfConformanceWorkerStartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PdfConformanceWorkerStartupError';
    }
}

function getPdfConformanceWorkerPath() {
    return resolveUnpackedWorkerPath(__dirname, PDF_CONFORMANCE_WORKER_FILENAME);
}

function decodePdfConformanceResult(data: unknown): IPdfConformanceProfile | null {
    if (data === undefined) {
        return {
            ...createDefaultPdfConformanceProfile(),
            saveRestrictions: [],
        };
    }
    if (!isRecord(data)
        || typeof data.isSigned !== 'boolean'
        || typeof data.isEncrypted !== 'boolean'
        || typeof data.isTagged !== 'boolean'
        || !(data.pdfaLevel === null || typeof data.pdfaLevel === 'string')
        || typeof data.hasAcroForm !== 'boolean'
        || typeof data.hasXfa !== 'boolean'
        || typeof data.canIncrementalSave !== 'boolean'
        || !Array.isArray(data.saveRestrictions)
        || !data.saveRestrictions.every(restriction => typeof restriction === 'string')) {
        return null;
    }
    return {
        isSigned: data.isSigned,
        isEncrypted: data.isEncrypted,
        isTagged: data.isTagged,
        pdfaLevel: data.pdfaLevel,
        hasAcroForm: data.hasAcroForm,
        hasXfa: data.hasXfa,
        canIncrementalSave: data.canIncrementalSave,
        saveRestrictions: data.saveRestrictions,
    };
}

function createDefaultPdfConformanceResult(): IPdfConformanceProfile {
    return {
        ...createDefaultPdfConformanceProfile(),
        saveRestrictions: [],
    };
}

function runPdfConformanceWorker(
    filePath: string,
    options: IPdfConformancePathAnalysisOptions = {},
) {
    return runResultWorkerTask<IPdfConformanceProfile>({
        workerPath: getPdfConformanceWorkerPath(),
        workerData: {
            filePath,
            ...(options.cancelGroup === undefined ? {} : {cancelGroup: options.cancelGroup}),
            ...(options.markerEvidence === undefined ? {} : {markerEvidence: options.markerEvidence}),
        },
        invalidPayloadMessage: 'PDF conformance worker returned an invalid payload',
        invalidResultMessage: 'PDF conformance worker returned an invalid payload',
        createStartupError: (message) => new PdfConformanceWorkerStartupError(
            `PDF conformance worker failed before becoming ready: ${message}`,
        ),
        createStartError: (message) => new PdfConformanceWorkerStartupError(
            `PDF conformance worker failed to start: ${message}`,
        ),
        createStartupExitError: (code) => new PdfConformanceWorkerStartupError(
            `PDF conformance worker exited during startup with code ${code}`,
        ),
        createWorkerExitError: (code) => new Error(`PDF conformance worker exited with code ${code}`),
        timeoutMs: options.timeoutMs ?? QPDF_VALIDATE_MAX_TIMEOUT_MS,
        createCancelMessage: () => ({type: 'cancel'}),
        cooperativeCancelDelayMs: 5_000,
        ...(options.signal === undefined ? {} : {signal: options.signal}),
        decodeResult: (data) => {
            if (data === undefined) {
                return createDefaultPdfConformanceResult();
            }
            return decodePdfConformanceResult(data);
        },
    });
}

export async function analyzePdfConformanceFile(
    filePath: string,
    options: IPdfConformancePathAnalysisOptions = {},
): Promise<IPdfConformanceProfile> {
    try {
        return await runPdfConformanceWorker(filePath, options);
    } catch (error) {
        if (error instanceof PdfConformanceWorkerStartupError) {
            logger.warn(`PDF conformance worker unavailable for ${filePath}: ${error.message}`);
        } else {
            logger.warn(
                `PDF conformance worker failed for ${filePath}: ${
                    getErrorMessage(error)
                }`,
            );
        }
        throw error;
    }
}

function createEmptyPdfValidationResult(): IPdfValidationResult {
    return {
        isValid: false,
        tool: 'qpdf',
        errors: ['PDF validation failed: empty document data'],
        warnings: [],
    };
}

function isQpdfValidationTimeoutError(error: unknown) {
    return error instanceof Error
        && QPDF_VALIDATE_TIMEOUT_PATTERN.test(getErrorMessage(error));
}

async function validatePdfFileWithStructuralFallback(
    filePath: string,
    timeoutError: unknown,
    validationTimeoutMs: number,
    options: IPdfConformancePathAnalysisOptions = {},
): Promise<IPdfValidationResult> {
    try {
        await validatePdfStructureFromPath(filePath, {
            ...options,
            timeoutMs: QPDF_VALIDATE_MAX_TIMEOUT_MS,
        });
        logger.warn(
            `qpdf validation timed out for ${filePath}; fallback PDF structure validation succeeded: ${
                getErrorMessage(timeoutError)
            }`,
        );
        return {
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [`qpdf validation timed out after ${validationTimeoutMs}ms; fallback PDF structure validation succeeded.`],
        };
    } catch (fallbackError) {
        return {
            isValid: false,
            tool: 'qpdf',
            errors: [`${getErrorMessage(timeoutError)}; fallback PDF structure validation failed: ${
                getErrorMessage(fallbackError)
            }`],
            warnings: [],
        };
    }
}

export async function validatePdfFile(
    filePath: string,
    options: IPdfConformancePathAnalysisOptions = {},
): Promise<IPdfValidationResult> {
    const fileStat = await tryStatPdfFile(filePath);
    const validationTimeoutMs = resolveQpdfValidationTimeoutMs(fileStat?.size);
    try {
        const qpdf = getPdfNativeToolPaths().qpdf;
        const result = await runNativeToolCommand(qpdf, [
            '--check',
            filePath,
        ], {
            timeoutMs: validationTimeoutMs,
            allowedExitCodes: [
                QPDF_EXIT_CODE_OK,
                QPDF_EXIT_CODE_WARNINGS,
            ],
            commandLabel: QPDF_VALIDATE_COMMAND_LABEL,
            ...(options.signal ? {signal: options.signal} : {}),
            ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
        });

        return {
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [
                ...extractQpdfWarnings(result.stdout),
                ...extractQpdfWarnings(result.stderr),
            ],
        };
    } catch (error) {
        if (isQpdfValidationTimeoutError(error)) {
            return validatePdfFileWithStructuralFallback(
                filePath,
                error,
                validationTimeoutMs,
                options,
            );
        }
        if (options.signal?.aborted) {
            throw abortErrorFromSignal(options.signal);
        }
        if (isAbortError(error)) {
            throw error;
        }
        return {
            isValid: false,
            tool: 'qpdf',
            errors: [error instanceof Error ? getErrorMessage(error) : 'PDF validation failed'],
            warnings: [],
        };
    }
}

async function validatePdfFileWithPageCount(
    filePath: string,
    commandLabel: string,
    options: IPdfConformancePathAnalysisOptions = {},
): Promise<IPdfValidationResult> {
    try {
        const qpdf = getPdfNativeToolPaths().qpdf;
        const result = await runNativeToolCommand(qpdf, [
            '--show-npages',
            filePath,
        ], {
            timeoutMs: QPDF_STRUCTURAL_VALIDATE_TIMEOUT_MS,
            allowedExitCodes: [
                QPDF_EXIT_CODE_OK,
                QPDF_EXIT_CODE_WARNINGS,
            ],
            commandLabel,
            ...(options.signal ? {signal: options.signal} : {}),
            ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
        });
        const pageCountText = result.stdout.trim();
        const pageCount = Number(pageCountText);
        if (!/^[1-9]\d*$/u.test(pageCountText) || !Number.isSafeInteger(pageCount)) {
            return {
                isValid: false,
                tool: 'qpdf',
                errors: ['PDF structural validation returned an invalid page count'],
                warnings: [],
            };
        }
        return {
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: extractQpdfWarnings(result.stderr),
        };
    } catch (error) {
        if (options.signal?.aborted) {
            throw abortErrorFromSignal(options.signal);
        }
        if (isAbortError(error)) {
            throw error;
        }
        return {
            isValid: false,
            tool: 'qpdf',
            errors: [error instanceof Error ? getErrorMessage(error) : 'PDF structural validation failed'],
            warnings: [],
        };
    }
}

// Opening authorization is layered. qpdf proves that the page tree is readable,
// then PDF.js must pass its render and viewport fences before the native preview
// retires. This same structural check is the save boundary after the mutation
// owner has already performed the expensive full validation.
export function validatePdfFileForOpening(
    filePath: string,
    options: IPdfConformancePathAnalysisOptions = {},
) {
    return validatePdfFileWithPageCount(filePath, QPDF_OPENING_VALIDATE_COMMAND_LABEL, options);
}

export function validatePdfFileForSave(
    filePath: string,
    options: IPdfConformancePathAnalysisOptions = {},
) {
    return validatePdfFileWithPageCount(filePath, QPDF_SAVE_VALIDATE_COMMAND_LABEL, options);
}

export async function validatePdfData(
    data: Uint8Array,
    fileName?: string,
): Promise<IPdfValidationResult> {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        return createEmptyPdfValidationResult();
    }

    const tempPath = join(
        getAppTempDir(),
        `pdf-validate-${randomUUID()}-${sanitizeValidationFileName(fileName)}`,
    );

    await writeFile(tempPath, data);

    try {
        return await validatePdfFile(tempPath);
    } finally {
        await unlink(tempPath).catch(() => undefined);
    }
}
