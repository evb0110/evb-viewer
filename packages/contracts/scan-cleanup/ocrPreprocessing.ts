import type {
    IOcrDiagnostic,
    TOcrPreprocessingMode,
} from '@contracts/electronApiOcr';
import type {TPageNumber} from '@contracts/pageNumbers';
import type {IScanCleanupPreviewAffine} from '@contracts/scan-cleanup/geometry';
import type {INativeScanCleanupOptionsV3} from '@contracts/scan-cleanup/nativeProtocolV3';
import type {TNativeScanCleanupOutputArtifactMetadataV3} from '@contracts/scan-cleanup/nativeArtifactCodecs';

/**
 * How the cleanup engine prepares an OCR page: full cleanup, or only the
 * polarity normalization every recognition pass needs.
 */
export type TOcrScanCleanupMode = 'clean' | 'polarity-only';

/**
 * The user's preprocessing setting decides how much cleanup runs, never
 * whether it runs: with preprocessing off, OCR still normalizes polarity so
 * light-on-dark pages are recognized.
 */
export function getOcrScanCleanupMode(setting: TOcrPreprocessingMode): TOcrScanCleanupMode {
    return setting === 'clean' ? 'clean' : 'polarity-only';
}

/**
 * OCR reads the pixels the cleanup engine produces, so anything left unset here
 * would be answered by the engine's own defaults — the same defaults viewer
 * binarization and layout tuning keeps moving. Pinning every pixel-affecting
 * option keeps recognition results reproducible: OCR input can then only change
 * when this object changes, which is an OCR decision rather than a side effect
 * of a viewer-facing one. Desktop and browser OCR both read it, so one page
 * gets the same preprocessing on either platform.
 *
 * `ocrMode` restates what the CLI's `--ocr-mode` flag forces on, and
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

/** The complete cleanup options for one OCR page rendered at `dpi`. */
export function createOcrScanCleanupOptions(mode: TOcrScanCleanupMode, dpi: number): INativeScanCleanupOptionsV3 {
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
    return {
        ...options,
        dpi,
        sourceDpi: dpi,
        requestedRenderDpi: dpi,
    };
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

/** `inverseTransform` maps preprocessed pixels back to the rendered page; absent when unmoved. */
export interface IOcrScanCleanupGeometry {inverseTransform?: IScanCleanupPreviewAffine;}

/**
 * The geometry OCR may use from one preprocessed page's metadata. Recognized
 * words are mapped back through the inverse transform, so a deskew without
 * one, or a singular one, makes the preprocessed image unusable; the caller
 * then recognizes the raw page render instead.
 */
export function readOcrScanCleanupGeometry(metadata: TNativeScanCleanupOutputArtifactMetadataV3): IOcrScanCleanupGeometry {
    const inverseTransform = metadata.inverseTransform ?? undefined;
    if (metadata.skewApplied && inverseTransform === undefined) {
        throw new Error('native preprocessing applied deskew without inverse transform metadata');
    }
    if (!isInvertibleAffine(inverseTransform)) {
        throw new Error('native preprocessing inverse transform is singular or non-finite');
    }
    return inverseTransform === undefined ? {} : {inverseTransform};
}

interface IOcrRasterSize {
    width: number;
    height: number;
}

/**
 * A preprocessed page of another size than its render would misplace the text
 * layer, so OCR reads the render and both platforms report this warning.
 */
export function createOcrPreprocessingGeometryDiagnostic(
    pageNumber: TPageNumber,
    raw: IOcrRasterSize,
    clean: IOcrRasterSize,
): IOcrDiagnostic {
    return {
        code: 'OCR_PREPROCESSING_GEOMETRY_CHANGED',
        severity: 'warning',
        pageNumber,
        message: `Preprocessing changed image dimensions from ${raw.width}x${raw.height} to ${clean.width}x${clean.height}; used raw render to preserve alignment`,
    };
}
