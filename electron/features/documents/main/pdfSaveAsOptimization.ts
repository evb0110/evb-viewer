import {decodePdfSaveAsOptions} from '@contracts/documentsPersistenceSchemas';
import {
    rm,
    stat,
} from 'fs/promises';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import type { IPdfSaveAsOptions } from '@contracts/electronApiDocuments';
import {
    resolveDocumentSavePerformanceTier,
    type TDocumentSavePerformanceTier,
} from '@contracts/hostResourceProfile';
import { isRecord } from '@contracts/runtimeGuards';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import {
    analyzePdfConformanceFile,
    validatePdfFile,
} from '@electron/features/documents/main/pdfConformance';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import { getHostResourceProfileSnapshot } from '@electron/resources/hostResourceProfile';

const logger = createLogger('documents-pdfSaveAsOptimization');

const QPDF_SAVE_AS_OPTIMIZE_TIMEOUT_MS = parseIntegerEnv(
    'EVB_QPDF_SAVE_AS_OPTIMIZE_TIMEOUT_MS',
    10 * 60 * 1000,
    1_000,
);
const DEFAULT_LARGE_PDF_SAVE_OPTIMIZE_MIN_BYTES = 64 * 1024 * 1024;
const LARGE_PDF_SAVE_OPTIMIZE_MIN_BYTES = parseIntegerEnv(
    'EVB_LARGE_PDF_SAVE_OPTIMIZE_MIN_BYTES',
    DEFAULT_LARGE_PDF_SAVE_OPTIMIZE_MIN_BYTES,
    1,
);

interface IPdfSaveOptimizationOptions {
    cancelGroup?: string;
    force?: boolean;
    minBytes?: number;
    skipSemanticPreflight?: boolean;
    label?: string;
    signal?: AbortSignal;
}

interface IExplicitPdfSaveOptimizationOptions extends IPdfSaveOptimizationOptions {force: true;}

interface IOrdinaryPdfSaveOptimizationOptions {deviceTier?: TDocumentSavePerformanceTier;}

export function normalizePdfSaveAsOptions(value: unknown): IPdfSaveAsOptions | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const decoded = decodePdfSaveAsOptions(value);
    return decoded?.optimizeLossless === true || decoded?.stagedOutput
        ? decoded
        : undefined;
}

async function shouldSkipOptimization(filePath: string) {
    const profile = await analyzePdfConformanceFile(filePath);
    if (profile.isSigned) {
        return 'signed PDF';
    }
    if (profile.isEncrypted) {
        return 'encrypted PDF';
    }
    if (profile.pdfaLevel) {
        return `${profile.pdfaLevel} PDF`;
    }
    if (profile.hasXfa) {
        return 'XFA PDF';
    }

    return null;
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

async function rewritePdfLosslessly(
    inputPath: string,
    outputPath: string,
    label: string,
    signal?: AbortSignal,
    cancelGroup?: string,
) {
    await runNativeToolCommand(getPdfNativeToolPaths().qpdf, [
        '--linearize',
        '--stream-data=preserve',
        '--object-streams=generate',
        inputPath,
        outputPath,
    ], {
        allowedExitCodes: [
            0,
            3,
        ],
        commandLabel: label,
        timeoutMs: QPDF_SAVE_AS_OPTIMIZE_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
        ...(cancelGroup ? {cancelGroup} : {}),
    });
}

async function optimizePdf(
    tempPath: string,
    options: IPdfSaveOptimizationOptions = {},
): Promise<IPdfValidationResult | null> {
    throwIfAborted(options.signal);
    const label = options.label ?? 'qpdf(save-optimize)';
    let originalStats;
    try {
        originalStats = await stat(tempPath);
    } catch (error) {
        logger.warn(`Skipping PDF save optimization for "${tempPath}": ${getErrorMessage(error)}`);
        return null;
    }

    throwIfAborted(options.signal);
    if (options.force !== true && originalStats.size < normalizeMinBytes(options.minBytes)) {
        return null;
    }

    if (options.skipSemanticPreflight !== true) {
        try {
            const skipReason = await shouldSkipOptimization(tempPath);
            if (skipReason) {
                logger.debug(`Skipping PDF save optimization for "${tempPath}": ${skipReason}`);
                return null;
            }
        } catch (error) {
            logger.warn(`Skipping PDF save optimization for "${tempPath}": ${getErrorMessage(error)}`);
            return null;
        }
    }

    const optimizedPath = makeSiblingTempPath(tempPath);
    let consumedOptimizedPath = false;
    try {
        throwIfAborted(options.signal);
        await rewritePdfLosslessly(tempPath, optimizedPath, label, options.signal, options.cancelGroup);
        throwIfAborted(options.signal);
        const optimizedStats = await stat(optimizedPath);

        const validation = await validatePdfFile(optimizedPath, {
            ...(options.signal ? {signal: options.signal} : {}),
            ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
        });
        throwIfAborted(options.signal);
        if (!validation.isValid) {
            logger.warn(
                `Discarding PDF save optimization for "${tempPath}": optimized file failed validation`,
            );
            return null;
        }

        await atomicReplace(optimizedPath, tempPath);
        consumedOptimizedPath = true;
        logger.debug(
            `Applied PDF save optimization for "${tempPath}": ${
                originalStats.size
            } -> ${optimizedStats.size} bytes`,
        );
        return validation;
    } catch (error) {
        if (options.signal?.aborted || isAbortError(error)) {
            throw options.signal?.aborted ? abortErrorFromSignal(options.signal) : error;
        }
        logger.warn(`PDF save optimization failed for "${tempPath}": ${getErrorMessage(error)}`);
        return null;
    } finally {
        if (!consumedOptimizedPath) {
            await rm(optimizedPath, { force: true }).catch(() => undefined);
        }
    }
}

export function optimizePdfForSave(
    tempPath: string,
    options: IExplicitPdfSaveOptimizationOptions,
) {
    return optimizePdf(tempPath, options);
}

export function optimizeLargePdfForOrdinarySave(
    tempPath: string,
    options: IOrdinaryPdfSaveOptimizationOptions = {},
) {
    const deviceTier = options.deviceTier
        ?? resolveDocumentSavePerformanceTier(getHostResourceProfileSnapshot().tier);
    if (deviceTier === 'low') {
        return Promise.resolve(null);
    }
    return optimizePdf(tempPath, {label: 'qpdf(save-optimize-large)'});
}

export function optimizeGeneratedPdfForInteraction(
    tempPath: string,
    options: { signal?: AbortSignal } = {},
) {
    return optimizePdf(tempPath, {
        force: true,
        skipSemanticPreflight: true,
        label: 'qpdf(generated-pdf-optimize)',
        ...(options.signal ? { signal: options.signal } : {}),
    });
}

export async function optimizePdfForSaveAs(
    tempPath: string,
    options?: IPdfSaveAsOptions,
): Promise<IPdfValidationResult | null> {
    if (options?.optimizeLossless !== true) {
        return optimizePdf(tempPath, {label: 'qpdf(save-optimize-large)'});
    }

    return optimizePdf(tempPath, {
        force: true,
        label: 'qpdf(save-as-optimize)',
    });
}
