import {stat} from 'fs/promises';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import {
    extractQpdfWarnings,
    getQpdfCheckArgs,
    getQpdfPageCountArgs,
    parseQpdfPageCount,
    QPDF_SUCCESS_EXIT_CODES,
    resolveQpdfValidationTimeoutMs,
    QPDF_VALIDATE_MAX_TIMEOUT_MS,
    QPDF_STRUCTURAL_VALIDATE_TIMEOUT_MS,
} from '@pdf-core/qpdfCommands';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';
import {mainJobBroker} from '@electron/resources/jobBroker';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import {
    analyzePdfConformancePath,
    validatePdfStructureFromPath,
    type IPdfConformancePathAnalysisOptions,
} from '@electron/features/documents/main/pdfConformancePathAnalysis';

const logger = createLogger('documents-pdfConformance');
const QPDF_VALIDATE_COMMAND_LABEL = 'qpdf(validate-pdf)';
const QPDF_VALIDATE_TIMEOUT_PATTERN = /^qpdf\(validate-pdf\) timed out after \d+ms$/u;
const QPDF_OPENING_VALIDATE_COMMAND_LABEL = 'qpdf(validate-pdf-opening)';
const QPDF_SAVE_VALIDATE_COMMAND_LABEL = 'qpdf(validate-pdf-structure)';

export type {IPdfConformancePathAnalysisOptions};

type TPdfFileStat = Awaited<ReturnType<typeof stat>>;

async function tryStatPdfFile(filePath: string): Promise<TPdfFileStat | null> {
    try {
        return await stat(filePath);
    } catch {
        return null;
    }
}

export async function analyzePdfConformanceFile(
    filePath: string,
    options: IPdfConformancePathAnalysisOptions = {},
): Promise<IPdfConformanceProfile> {
    try {
        const result = await mainJobBroker.run({
            ownerId: 'pdf-conformance',
            kind: 'pdf-conformance',
            priority: 'background',
            resources: {
                cpuTokens: 2,
                estimatedResidentBytes: 512 * 1024 * 1024,
                nativeProcesses: 2,
                ioWeight: 1,
            },
            ...(options.signal === undefined ? {} : {signal: options.signal}),
        }, ({onTerminationProof}) => analyzePdfConformancePath(filePath, {
            ...options,
            timeoutMs: options.timeoutMs ?? QPDF_VALIDATE_MAX_TIMEOUT_MS,
            onTerminationProof,
        }));
        logger.debug('PDF conformance analysis completed', {filePath});
        return result;
    } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) {
            logger.info('PDF conformance analysis canceled', {filePath});
        } else {
            logger.warn(
                `PDF conformance analysis failed for ${filePath}: ${
                    getErrorMessage(error)
                }`,
            );
        }
        throw error;
    }
}

function throwIfValidationMustRefuse(error: unknown, signal?: AbortSignal) {
    if (getUnprovenNativeTerminationDetail(error) !== undefined || isAbortError(error)) {
        throw error;
    }
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
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
        throwIfValidationMustRefuse(fallbackError, options.signal);
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
        const result = await runNativeToolCommand(qpdf, getQpdfCheckArgs(filePath), {
            timeoutMs: validationTimeoutMs,
            allowedExitCodes: QPDF_SUCCESS_EXIT_CODES,
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
        throwIfValidationMustRefuse(error, options.signal);
        if (error instanceof Error && QPDF_VALIDATE_TIMEOUT_PATTERN.test(getErrorMessage(error))) {
            return validatePdfFileWithStructuralFallback(
                filePath,
                error,
                validationTimeoutMs,
                options,
            );
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
        const result = await runNativeToolCommand(qpdf, getQpdfPageCountArgs(filePath), {
            timeoutMs: QPDF_STRUCTURAL_VALIDATE_TIMEOUT_MS,
            allowedExitCodes: QPDF_SUCCESS_EXIT_CODES,
            commandLabel,
            ...(options.signal ? {signal: options.signal} : {}),
            ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
        });
        if (parseQpdfPageCount(result.stdout) === null) {
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
        throwIfValidationMustRefuse(error, options.signal);
        return {
            isValid: false,
            tool: 'qpdf',
            errors: [error instanceof Error ? getErrorMessage(error) : 'PDF structural validation failed'],
            warnings: [],
        };
    }
}

// Opening authorization is layered. qpdf proves that the page tree is readable,
// then PDF.js must pass its render and viewport fences before the document is
// presented. This same structural check is the save boundary after the mutation
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

