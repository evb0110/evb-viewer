import {
    readFile, stat,
} from 'fs/promises';
import { runOcrCommand } from '@electron/features/ocr/worker/runOcrCommand';
import type { TWorkerLog } from '@electron/ocr/worker/types';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import type { IOcrDiagnostic } from '@contracts/electronApiOcr';
import type { INativeScanCleanupOptionsV3 } from '@contracts/scan-cleanup/nativeProtocolV3';
import {decodeNativeScanCleanupOutputMetadataJson} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import type {IScanCleanupPreviewAffine} from '@contracts/scan-cleanup/geometry';

export interface IOcrPreprocessedImage {
    path: string;
    inverseTransform?: IScanCleanupPreviewAffine;
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

const OCR_PREPROCESS_TIMEOUT_MS = parseIntegerEnv('EVB_OCR_PREPROCESS_TIMEOUT_MS', 30_000, 1_000);
const OCR_UNPAPER_PROBE_TIMEOUT_MS = parseIntegerEnv('EVB_OCR_UNPAPER_PROBE_TIMEOUT_MS', 10_000, 1_000);
const OCR_UNPAPER_NEGATIVE_PROBE_TTL_MS = parseIntegerEnv('EVB_OCR_UNPAPER_NEGATIVE_PROBE_TTL_MS', 5 * 60_000, 1_000);
const unpaperProbeByBinary = new Map<string, {
    promise: Promise<boolean>;
    negativeExpiresAtMs?: number;
}>();

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

async function probeUnpaperBinary(
    unpaperBinary: string,
    log: TWorkerLog,
    signal: AbortSignal,
) {
    const cachedProbe = unpaperProbeByBinary.get(unpaperBinary);
    if (cachedProbe) {
        if (cachedProbe.negativeExpiresAtMs === undefined || cachedProbe.negativeExpiresAtMs > Date.now()) {
            return cachedProbe.promise;
        }
        unpaperProbeByBinary.delete(unpaperBinary);
    }

    const probe = runOcrCommand(unpaperBinary, ['--version'], {
        timeoutMs: OCR_UNPAPER_PROBE_TIMEOUT_MS,
        commandLabel: 'unpaper(version-probe)',
        signal,
        log: createOptionalPreprocessingLog(log),
    }).then(
        () => true,
        (error) => {
            if (signal.aborted) {
                unpaperProbeByBinary.delete(unpaperBinary);
                throw error;
            }
            log('warn', `OCR preprocessing disabled because bundled unpaper is not runnable: ${getErrorMessage(error)}`);
            return false;
        },
    );
    void probe.then((isRunnable) => {
        if (isRunnable) {
            return;
        }
        const cached = unpaperProbeByBinary.get(unpaperBinary);
        if (cached?.promise === probe) {
            cached.negativeExpiresAtMs = Date.now() + OCR_UNPAPER_NEGATIVE_PROBE_TTL_MS;
        }
    }, () => {});

    unpaperProbeByBinary.set(unpaperBinary, {promise: probe});
    return probe;
}

export async function tryPreprocessOcrImage(
    unpaperBinary: string | undefined,
    inputPath: string,
    outputPath: string,
    log: TWorkerLog,
    signal: AbortSignal,
    onDiagnostic?: (diagnostic: IOcrDiagnostic) => void,
    scanCleanupBinary?: string,
    metadataPath = `${outputPath}.json`,
    dpi = 300,
): Promise<IOcrPreprocessedImage> {
    if (scanCleanupBinary) {
        try {
            await runOcrCommand(scanCleanupBinary, [
                '--input',
                inputPath,
                '--output',
                outputPath,
                '--metadata',
                metadataPath,
                '--ocr-mode',
                '--options',
                JSON.stringify({
                    ...OCR_PREPROCESS_PINNED_OPTIONS,
                    dpi,
                    sourceDpi: dpi,
                    requestedRenderDpi: dpi,
                }),
            ], {
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
            log('warn', 'Native scan cleanup produced no usable image; trying unpaper fallback');
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            log('warn', `Native scan cleanup failed; trying unpaper fallback: ${getErrorMessage(error)}`);
        }
    }

    if (!unpaperBinary) {
        const message = 'OCR preprocessing requested, but unpaper is not bundled and scan cleanup is unavailable for this platform';
        log('warn', message);
        onDiagnostic?.({
            code: 'OCR_PREPROCESSING_UNAVAILABLE',
            severity: 'warning',
            message,
        });
        return {path: inputPath};
    }

    if (!await probeUnpaperBinary(unpaperBinary, log, signal)) {
        onDiagnostic?.({
            code: 'OCR_PREPROCESSING_UNAVAILABLE',
            severity: 'warning',
            message: 'OCR preprocessing is unavailable because unpaper is not runnable; using raw page render',
        });
        return {path: inputPath};
    }

    try {
        await runOcrCommand(unpaperBinary, [
            '--layout',
            'single',
            '--deskew-scan-direction',
            'left,right',
            '--no-mask-center',
            inputPath,
            outputPath,
        ], {
            timeoutMs: OCR_PREPROCESS_TIMEOUT_MS,
            commandLabel: 'unpaper(ocr-preprocess)',
            signal,
            log: createOptionalPreprocessingLog(log),
        });
        if (!await isNonEmptyFile(outputPath)) {
            const message = 'OCR preprocessing did not produce a usable image; using raw page render';
            log('warn', message);
            onDiagnostic?.({
                code: 'OCR_PREPROCESSING_FAILED',
                severity: 'warning',
                message,
            });
            return {path: inputPath};
        }
        const message = 'unpaper preprocessing has no inverse geometry metadata; using raw page render';
        log('warn', message);
        onDiagnostic?.({
            code: 'OCR_PREPROCESSING_FAILED',
            severity: 'warning',
            message,
        });
        return {path: inputPath};
    } catch (error) {
        if (signal.aborted) {
            throw error;
        }
        const message = `OCR preprocessing failed; using raw page render: ${getErrorMessage(error)}`;
        log('warn', message);
        onDiagnostic?.({
            code: 'OCR_PREPROCESSING_FAILED',
            severity: 'warning',
            message,
        });
        return {path: inputPath};
    }
}
