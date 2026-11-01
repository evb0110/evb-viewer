import {
    readFile, stat,
} from 'fs/promises';
import {join} from 'node:path';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import type {
    IOcrPipelinePaths, TWorkerLog,
} from '@electron/features/ocr/pipeline/types';
import {resolveTesseractLanguageConfig} from '@ocr-core/resolveTesseractLanguageConfig';
import { getErrorMessage } from '@electron/utils/error';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';
import type {
    IOcrDiagnostic, IOcrSearchablePdfOptions,
} from '@contracts/electronApiOcr';
import {decodeNativeScanCleanupOutputMetadataJson} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import type {IScanCleanupPreviewAffine} from '@contracts/scan-cleanup/geometry';
import {
    createOcrScanCleanupOptions,
    readOcrScanCleanupGeometry,
    type TOcrScanCleanupMode,
} from '@contracts/scan-cleanup/ocrPreprocessing';

export interface IOcrPreprocessedImage {
    path: string;
    inverseTransform?: IScanCleanupPreviewAffine;
}

/**
 * Render, cleanup and recognition children run sequentially under one page
 * lease. Reserve their peak, rather than summing phases or counting one RGBA
 * raster. Pinned-tool measurements at 150/300/450 DPI reached 59–142 MiB for
 * recognition, 117 MiB for polarity and 296/574 MiB for clean preprocessing.
 * With 1–16 Rayon workers, clean peaked below 582 MiB at 450 DPI. Its
 * 40 B/pixel matches the native BW planner; polarity needs fewer copies.
 * Recognition includes decoded rasters, model working copies and process overhead.
 */
export async function estimateOcrPageResidentBytes(
    pixels: number,
    languages: string[],
    paths: Pick<IOcrPipelinePaths, 'tessdataPath' | 'scanCleanupBinary'>,
    options: IOcrSearchablePdfOptions,
) {
    const {orderedLanguages} = resolveTesseractLanguageConfig(languages);
    const models = await Promise.all(orderedLanguages.filter(model => !model.startsWith('~'))
        .map(async model => (await stat(join(paths.tessdataPath, `${model}.traineddata`))).size));
    const recognitionBytes = pixels * 12 + 2 * models.reduce((bytes, size) => bytes + size, 0);
    const preprocessingBytes = paths.scanCleanupBinary
        ? pixels * (options.preprocessingMode === 'clean' ? 40 : options.preprocessingMode === 'off' ? 16 : 0)
        : 0;
    return 32 * 1024 * 1024 + Math.max(recognitionBytes, preprocessingBytes);
}

const OCR_PREPROCESS_TIMEOUT_MS = 30_000;
function createOptionalPreprocessingLog(log: TWorkerLog): TWorkerLog {
    return (level, message) => {
        log(level === 'error' ? 'warn' : level, message);
    };
}

async function isNonEmptyFile(path: string) {
    try {
        return (await stat(path)).size > 0;
    } catch {
        return false;
    }
}

async function readNativePreprocessResult(
    outputPath: string,
    metadataPath: string,
    log: TWorkerLog,
    onDiagnostic?: (diagnostic: IOcrDiagnostic) => void,
): Promise<IOcrPreprocessedImage | null> {
    try {
        const metadata = decodeNativeScanCleanupOutputMetadataJson(await readFile(metadataPath, 'utf8'));
        return {
            path: outputPath,
            ...readOcrScanCleanupGeometry(metadata),
        };
    } catch (error) {
        const message = `OCR preprocessing metadata is unusable; using raw page render: ${getErrorMessage(error)}`;
        log('warn', message);
        onDiagnostic?.({
            code: 'OCR_PREPROCESSING_FAILED',
            severity: 'warning',
            message,
        });
        return null;
    }
}

export async function tryPreprocessOcrImage(
    inputPath: string,
    outputPath: string,
    log: TWorkerLog,
    signal: AbortSignal,
    onDiagnostic?: (diagnostic: IOcrDiagnostic) => void,
    scanCleanupBinary?: string,
    metadataPath = `${outputPath}.json`,
    dpi = 300,
    mode: TOcrScanCleanupMode = 'clean',
    grantedCpuTokens?: number,
): Promise<IOcrPreprocessedImage> {
    if (scanCleanupBinary) {
        try {
            await runNativeToolCommand(scanCleanupBinary, [
                '--input',
                inputPath,
                '--output',
                outputPath,
                '--metadata',
                metadataPath,
                '--ocr-mode',
                '--options',
                JSON.stringify(createOcrScanCleanupOptions(mode, dpi)),
            ], {
                ...(grantedCpuTokens === undefined ? {} : {env: {
                    ...process.env,
                    RAYON_NUM_THREADS: String(grantedCpuTokens),
                }}),
                timeoutMs: OCR_PREPROCESS_TIMEOUT_MS,
                commandLabel: 'evb-scan-cleanup(ocr-preprocess)',
                signal,
                log: createOptionalPreprocessingLog(log),
            });
            if (await isNonEmptyFile(outputPath)) {
                const result = await readNativePreprocessResult(outputPath, metadataPath, log, onDiagnostic);
                if (result !== null) {
                    return result;
                }
            }
            log('warn', 'Native scan cleanup produced no usable image; using raw page render');
        } catch (error) {
            if (signal.aborted || getUnprovenNativeTerminationDetail(error) !== undefined) {
                throw error;
            }
            log('warn', `Native scan cleanup failed; using raw page render: ${getErrorMessage(error)}`);
        }
    }

    const message = scanCleanupBinary
        ? 'OCR preprocessing failed; using raw page render'
        : 'OCR preprocessing requested, but scan cleanup is unavailable for this platform';
    log('warn', message);
    onDiagnostic?.({
        code: scanCleanupBinary ? 'OCR_PREPROCESSING_FAILED' : 'OCR_PREPROCESSING_UNAVAILABLE',
        severity: 'warning',
        message,
    });
    return {path: inputPath};
}
