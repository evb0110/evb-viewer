import {
    readFile, stat,
} from 'fs/promises';
import {join} from 'node:path';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import type {
    IOcrPipelinePaths, TWorkerLog,
} from '@electron/features/ocr/pipeline/types';
import {resolveTesseractLanguageConfig} from '@electron/features/ocr/main/resolveTesseractLanguageConfig';
import { getErrorMessage } from '@electron/utils/error';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';
import type {
    IOcrDiagnostic, IOcrSearchablePdfOptions,
} from '@contracts/electronApiOcr';
import type { INativeScanCleanupOptionsV3 } from '@contracts/scan-cleanup/nativeProtocolV3';
import {decodeNativeScanCleanupOutputMetadataJson} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import type {IScanCleanupPreviewAffine} from '@contracts/scan-cleanup/geometry';

export interface IOcrPreprocessedImage {
    path: string;
    inverseTransform?: IScanCleanupPreviewAffine;
}

export type TOcrPreprocessingMode = 'clean' | 'polarity-only';

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

/**
 * OCR reads the pixels the cleanup engine produces, so anything left unset here
 * would be answered by the engine's own defaults — the same defaults viewer
 * binarization and layout tuning keeps moving. Pinning every pixel-affecting
 * option keeps recognition results reproducible: OCR input can then only change
 * when this object changes, which is an OCR decision rather than a side effect
 * of a viewer-facing one. The values reproduce the defaults the OCR path
 * inherited implicitly, so pinning them changes no pixel today.
 *
 * `ocrMode` restates what the `--ocr-mode` flag already forces on, and
 * `sourceDpi`/`requestedRenderDpi` are supplied per call because the engine
 * otherwise derives both from `dpi`.
 */
const OCR_PREPROCESS_PINNED_OPTIONS: Omit<
    INativeScanCleanupOptionsV3,
    'dpi' | 'sourceDpi' | 'requestedRenderDpi'
> = {
    sourceHasBilevelLayer: false,
    binarization: 'auto',
    thickness: 0,
    normalizeIllumination: true,
    despeckle: true,
    despeckleLevel: 'normal',
    outputMode: 'bw',
    ocrMode: true,
    layout: 'auto',
    manualSplit: null,
    manualContentBoxes: {},
    manualZones: {
        picture: [],
        fill: [],
    },
    cropContent: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    placementOverrides: {},
    margins: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    experimental: {autoDewarp: false},
    rotationDegrees: 0,
    excluded: false,
    skipBlankPages: false,
    maxPixels: 160_000_000,
    maxDimensionPx: 40_000,
};

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

function isInvertibleAffine(affine: IScanCleanupPreviewAffine | null | undefined) {
    if (affine === undefined || affine === null) {
        return true;
    }
    const matrix = affine.matrix;
    if (matrix.length !== 3 || matrix.some(row => row.length !== 3 || row.some(value => !Number.isFinite(value)))) {
        return false;
    }
    const determinant = matrix[0]![0]! * (matrix[1]![1]! * matrix[2]![2]! - matrix[1]![2]! * matrix[2]![1]!)
        - matrix[0]![1]! * (matrix[1]![0]! * matrix[2]![2]! - matrix[1]![2]! * matrix[2]![0]!)
        + matrix[0]![2]! * (matrix[1]![0]! * matrix[2]![1]! - matrix[1]![1]! * matrix[2]![0]!);
    return Number.isFinite(determinant) && Math.abs(determinant) > Number.EPSILON;
}

async function readNativePreprocessResult(
    outputPath: string,
    metadataPath: string,
    log: TWorkerLog,
    onDiagnostic?: (diagnostic: IOcrDiagnostic) => void,
): Promise<IOcrPreprocessedImage | null> {
    try {
        const metadata = decodeNativeScanCleanupOutputMetadataJson(await readFile(metadataPath, 'utf8'));
        const inverseTransform = metadata.inverseTransform ?? undefined;
        if (metadata.skewApplied && inverseTransform === undefined) {
            throw new Error('native preprocessing applied deskew without inverse transform metadata');
        }
        if (!isInvertibleAffine(inverseTransform)) {
            throw new Error('native preprocessing inverse transform is singular or non-finite');
        }
        return {
            path: outputPath,
            ...(inverseTransform === undefined ? {} : {inverseTransform}),
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
    mode: TOcrPreprocessingMode = 'clean',
    grantedCpuTokens?: number,
): Promise<IOcrPreprocessedImage> {
    if (scanCleanupBinary) {
        try {
            const options = mode === 'polarity-only'
                ? {
                    ...OCR_PREPROCESS_PINNED_OPTIONS,
                    normalizeIllumination: false,
                    despeckle: false,
                    layout: 'force-single' as const,
                    cropContent: false,
                    matchPageSize: false,
                    margins: {
                        leftMm: 0,
                        topMm: 0,
                        rightMm: 0,
                        bottomMm: 0,
                    },
                    ocrPolarityOnly: true,
                }
                : OCR_PREPROCESS_PINNED_OPTIONS;
            await runNativeToolCommand(scanCleanupBinary, [
                '--input',
                inputPath,
                '--output',
                outputPath,
                '--metadata',
                metadataPath,
                '--ocr-mode',
                '--options',
                JSON.stringify({
                    ...options,
                    dpi,
                    sourceDpi: dpi,
                    requestedRenderDpi: dpi,
                }),
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
