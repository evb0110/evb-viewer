import {PDF_SAVE_AS_OPTIONS_SCHEMA} from '@contracts/documentsPersistenceSchemas';
import {rm, stat} from 'fs/promises';
import type {IPdfValidationResult} from '@contracts/pdfConformance';
import type {IPdfSaveAsOptions} from '@contracts/electronApiDocuments';
import {resolveDocumentSavePerformanceTier, type TDocumentSavePerformanceTier} from '@contracts/hostResourceProfile';
import {isRecord} from '@contracts/runtimeGuards';
import {atomicReplace, makeSiblingTempPath} from '@electron/utils/atomicReplace';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {runDesktopQpdfWasm} from '@electron/native-tools/qpdfWasmWorkerClient';
import {
    getQpdfLosslessRewriteArgs,
    QPDF_SUCCESS_EXIT_CODES,
    QPDF_LOSSLESS_REWRITE_TIMEOUT_MS,
    shouldKeepPdfOptimizationCandidate,
} from '@pdf-core/qpdfCommands';
import {analyzePdfConformanceFile, validatePdfFile} from '@electron/features/documents/main/pdfConformance';
import {abortErrorFromSignal, isAbortError} from '@electron/utils/abort';
import {getHostResourceProfileSnapshot} from '@electron/resources/hostResourceProfile';
import * as v from 'valibot';
import {getPdfLosslessOptimizationSkipReason} from '@pdf-core/pdfConformanceHelpers';
import {runtimeConfig} from '@electron/runtimeConfig';

const logger = createLogger('documents-pdfSaveAsOptimization');

const LARGE_PDF_SAVE_OPTIMIZE_MIN_BYTES = runtimeConfig.test.largePdfSaveOptimizeMinBytes;

interface IPdfSaveOptimizationOptions {
    cancelGroup?: string;
    failOnTooLarge?: boolean;
    force?: boolean;
    minBytes?: number;
    outputPath?: string;
    skipSemanticPreflight?: boolean;
    label?: string;
    signal?: AbortSignal;
}

interface IExplicitPdfSaveOptimizationOptions extends IPdfSaveOptimizationOptions {
    force: true;
}

interface IOrdinaryPdfSaveOptimizationOptions {
    deviceTier?: TDocumentSavePerformanceTier;
}

interface ISaveAsPdfOptimizationExecutionOptions extends IOrdinaryPdfSaveOptimizationOptions {
    outputPath?: string;
}

export function normalizePdfSaveAsOptions(value: unknown): IPdfSaveAsOptions | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const decoded = v.parse(PDF_SAVE_AS_OPTIONS_SCHEMA, value, {abortEarly: true});
    return decoded?.optimizeLossless === true || decoded?.stagedOutput ? decoded : undefined;
}

function normalizeMinBytes(value: number | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
        return LARGE_PDF_SAVE_OPTIMIZE_MIN_BYTES;
    }
    return Math.floor(value);
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

async function rewritePdfLosslessly(inputPath: string, outputPath: string, label: string, signal?: AbortSignal, cancelGroup?: string) {
    await runDesktopQpdfWasm(getQpdfLosslessRewriteArgs(inputPath, outputPath), {
        allowedExitCodes: QPDF_SUCCESS_EXIT_CODES,
        commandLabel: label,
        timeoutMs: QPDF_LOSSLESS_REWRITE_TIMEOUT_MS,
        ...(signal ? {signal} : {}),
        ...(cancelGroup ? {cancelGroup} : {}),
    });
}

async function optimizePdf(sourcePath: string, options: IPdfSaveOptimizationOptions = {}): Promise<IPdfValidationResult | null> {
    throwIfAborted(options.signal);
    const label = options.label ?? 'qpdf(save-optimize)';
    const targetPath = options.outputPath ?? sourcePath;
    let originalStats;
    try {
        originalStats = await stat(sourcePath);
    } catch (error) {
        logger.warn(`Skipping PDF save optimization for "${sourcePath}": ${getErrorMessage(error)}`);
        return null;
    }

    throwIfAborted(options.signal);
    if (options.force !== true && originalStats.size < normalizeMinBytes(options.minBytes)) {
        return null;
    }

    if (options.skipSemanticPreflight !== true) {
        try {
            const skipReason = getPdfLosslessOptimizationSkipReason(await analyzePdfConformanceFile(sourcePath));
            if (skipReason) {
                logger.debug(`Skipping PDF save optimization for "${sourcePath}": ${skipReason}`);
                return null;
            }
        } catch (error) {
            logger.warn(`Skipping PDF save optimization for "${sourcePath}": ${getErrorMessage(error)}`);
            return null;
        }
    }

    const optimizedPath = makeSiblingTempPath(targetPath);
    let consumedOptimizedPath = false;
    try {
        throwIfAborted(options.signal);
        await rewritePdfLosslessly(sourcePath, optimizedPath, label, options.signal, options.cancelGroup);
        throwIfAborted(options.signal);
        const optimizedStats = await stat(optimizedPath);
        if (optimizedStats.size >= originalStats.size) {
            logger.debug(
                `Discarding PDF save optimization for "${sourcePath}": candidate is not smaller (${
                    originalStats.size
                } -> ${optimizedStats.size} bytes)`,
            );
            return null;
        }

        const validation = await validatePdfFile(optimizedPath, {
            ...(options.signal ? {signal: options.signal} : {}),
            ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
        });
        throwIfAborted(options.signal);
        if (!shouldKeepPdfOptimizationCandidate(originalStats.size, optimizedStats.size, validation)) {
            logger.warn(`Discarding PDF save optimization for "${sourcePath}": optimized file failed validation`);
            return null;
        }

        await atomicReplace(optimizedPath, targetPath);
        consumedOptimizedPath = true;
        logger.debug(`Applied PDF save optimization for "${targetPath}": ${originalStats.size} -> ${optimizedStats.size} bytes`);
        return validation;
    } catch (error) {
        if (options.signal?.aborted || isAbortError(error)) {
            throw options.signal?.aborted ? abortErrorFromSignal(options.signal) : error;
        }
        if (options.force === true && options.failOnTooLarge !== false && hasNativeErrorCode(error) && error.code === 'too-large') {
            throw error;
        }
        logger.warn(`PDF save optimization failed for "${sourcePath}": ${getErrorMessage(error)}`);
        return null;
    } finally {
        if (!consumedOptimizedPath) {
            await rm(optimizedPath, {force: true}).catch(() => undefined);
        }
    }
}

export function optimizePdfForSave(tempPath: string, options: IExplicitPdfSaveOptimizationOptions) {
    return optimizePdf(tempPath, options);
}

export function optimizeLargePdfForOrdinarySave(tempPath: string, options: IOrdinaryPdfSaveOptimizationOptions = {}) {
    const deviceTier = options.deviceTier ?? resolveDocumentSavePerformanceTier(getHostResourceProfileSnapshot().tier);
    if (deviceTier === 'low') {
        return Promise.resolve(null);
    }
    return optimizePdf(tempPath, {label: 'qpdf(save-optimize-large)'});
}

export function optimizeGeneratedPdfForInteraction(tempPath: string, options: {signal?: AbortSignal} = {}) {
    return optimizePdf(tempPath, {
        force: true,
        failOnTooLarge: false,
        skipSemanticPreflight: true,
        label: 'qpdf(generated-pdf-optimize)',
        ...(options.signal ? {signal: options.signal} : {}),
    });
}

export async function optimizePdfForSaveAs(
    sourcePath: string,
    options?: IPdfSaveAsOptions,
    executionOptions: ISaveAsPdfOptimizationExecutionOptions = {},
): Promise<IPdfValidationResult | null> {
    const outputOption = executionOptions.outputPath === undefined ? {} : {outputPath: executionOptions.outputPath};
    if (options?.optimizeLossless !== true) {
        const deviceTier = executionOptions.deviceTier ?? resolveDocumentSavePerformanceTier(getHostResourceProfileSnapshot().tier);
        if (deviceTier === 'low') {
            return null;
        }
        return optimizePdf(sourcePath, {
            label: 'qpdf(save-optimize-large)',
            ...outputOption,
        });
    }

    return optimizePdf(sourcePath, {
        force: true,
        label: 'qpdf(save-as-optimize)',
        ...outputOption,
    });
}
