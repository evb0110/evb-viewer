import type {
    IScanCleanupNormalizedRect,
    IScanCleanupMarginsMm,
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    TScanCleanupOutputHalf,
    TScanCleanupPageOverrides,
    TScanCleanupPageRotation,
} from '@contracts/electronApiScanCleanup';
import {
    SCAN_CLEANUP_ALIGNMENTS,
    SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES,
    SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES,
} from '@contracts/electronApiScanCleanup';
import {createScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {BrowserLogger} from '@app/utils/browserLogger';
import {
    cloneScanCleanupPreferenceValue,
    scanCleanupPreferenceRecord,
} from '@contracts/scanCleanupSettings';
import {decodeScanCleanupPageOverrides} from '@contracts/scan-cleanup/ipcRequestCodecs';
import {
    SCAN_CLEANUP_MANUAL_SPLIT_MAX,
    SCAN_CLEANUP_MANUAL_SPLIT_MIN,
} from '@contracts/scan-cleanup/geometry';

// Version 1 is retained for documents saved before normalized geometry shipped.
// Expiry 2027-07: remove after the first release whose minimum supported upgrade
// path is newer than 2026-07, once support checks show no v1 records.

const OUTPUT_HALVES: readonly TScanCleanupOutputHalf[] = [
    'full',
    'left',
    'right',
];

let legacyOverrideWarningShown = false;

interface ILegacyRasterDimensions {
    width: number;
    height: number;
}

function decodeRotation(value: unknown): TScanCleanupPageRotation | null {
    return value === 0 || value === 90 || value === 180 || value === 270 ? value : null;
}

function decodeLayoutOverride(value: unknown): IScanCleanupPageOverride['layoutOverride'] {
    return value === 'single' || value === 'spread' || value === 'keep-left' || value === 'keep-right'
        ? value
        : 'auto';
}

function decodePlacementOverrides(value: unknown): IScanCleanupPageOverride['placementOverrides'] {
    const values = scanCleanupPreferenceRecord(value);
    if (!values) {
        return undefined;
    }
    const alignments = new Set<IScanCleanupOptions['pageAlignment']>(SCAN_CLEANUP_ALIGNMENTS);
    return Object.fromEntries(OUTPUT_HALVES.flatMap(half => alignments.has(values[half] as IScanCleanupOptions['pageAlignment'])
        ? [[
            half,
            values[half],
        ]]
        : []));
}

function decodeMarginsMm(value: unknown): IScanCleanupMarginsMm | undefined {
    const margins = scanCleanupPreferenceRecord(value);
    if (!margins) {
        return undefined;
    }
    const decoded = {
        leftMm: margins.leftMm,
        topMm: margins.topMm,
        rightMm: margins.rightMm,
        bottomMm: margins.bottomMm,
    };
    return Object.values(decoded).every(margin => (
        typeof margin === 'number'
        && Number.isFinite(margin)
        && margin >= 0
        && margin <= 25
    )) ? decoded as IScanCleanupMarginsMm : undefined;
}

function decodeManualZones(
    value: unknown,
    rotationDegrees: TScanCleanupPageRotation,
) {
    if (value === undefined) {
        return undefined;
    }
    try {
        return decodeScanCleanupPageOverrides({'1': {
            rotationDegrees,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
            manualZones: value,
        }})['1']?.manualZones;
    } catch {
        return undefined;
    }
}

function positiveDimension(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function legacyRasterDimensions(
    entry: Record<string, unknown> | null,
    override: Record<string, unknown>,
    pageKey: string,
    rotationDegrees: TScanCleanupPageRotation,
): ILegacyRasterDimensions | null {
    const dimensionsByPage = scanCleanupPreferenceRecord(entry?.rasterDimensionsByPage)
        ?? scanCleanupPreferenceRecord(entry?.rasterDimensions);
    const pageDimensions = scanCleanupPreferenceRecord(dimensionsByPage?.[pageKey]);
    const rawWidthPx = positiveDimension(pageDimensions?.width)
        ?? positiveDimension(override.referenceWidth)
        ?? positiveDimension(override.rawWidthPx)
        ?? positiveDimension(override.inputWidthPx);
    const rawHeightPx = positiveDimension(pageDimensions?.height)
        ?? positiveDimension(override.referenceHeight)
        ?? positiveDimension(override.rawHeightPx)
        ?? positiveDimension(override.inputHeightPx);
    if (rawWidthPx === null || rawHeightPx === null) {
        return null;
    }
    return rotationDegrees === 90 || rotationDegrees === 270
        ? {
            width: rawHeightPx,
            height: rawWidthPx,
        }
        : {
            width: rawWidthPx,
            height: rawHeightPx,
        };
}

function normalizedValue(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
        ? value
        : null;
}

function migratedManualSplitValue(value: unknown) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    return Math.min(SCAN_CLEANUP_MANUAL_SPLIT_MAX, Math.max(SCAN_CLEANUP_MANUAL_SPLIT_MIN, value));
}

function migrateManualSplit(
    value: unknown,
    rotationDegrees: TScanCleanupPageRotation,
    dimensions: ILegacyRasterDimensions | null,
) {
    if (value === null || value === undefined) {
        return {
            value: null,
            legacy: false,
        };
    }
    if (typeof value === 'number') {
        return {
            value: dimensions && Number.isFinite(value) && value > 0
                ? {
                    xNormalized: Math.min(1, value / dimensions.width),
                    rotationDegrees,
                }
                : null,
            legacy: true,
        };
    }
    const stored = scanCleanupPreferenceRecord(value);
    const rawXNormalized = stored?.xNormalized ?? stored?.x;
    const xNormalized = migratedManualSplitValue(rawXNormalized);
    return {
        value: xNormalized !== null
            && decodeRotation(stored?.rotationDegrees ?? stored?.rotation) === rotationDegrees ? {
                xNormalized,
                rotationDegrees,
            } : null,
        legacy: xNormalized !== null && xNormalized !== rawXNormalized,
    };
}

export function migrateScanCleanupPageOverrideV1(value: unknown) {
    const stored = scanCleanupPreferenceRecord(value);
    const rotationDegrees = decodeRotation(stored?.rotationDegrees ?? stored?.rotation);
    if (!stored || rotationDegrees === null) {
        return {
            value,
            migratedLegacyGeometry: false,
        };
    }
    const manualSplit = migrateManualSplit(stored.manualSplit ?? stored.manualSplitX, rotationDegrees, null);
    return {
        value: {
            ...stored,
            manualSplit: manualSplit.value,
        },
        migratedLegacyGeometry: manualSplit.legacy,
    };
}

function migrateManualContentBoxes(
    value: unknown,
    rotationDegrees: TScanCleanupPageRotation,
    dimensions: ILegacyRasterDimensions | null,
) {
    const stored = scanCleanupPreferenceRecord(value);
    const migrated: Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>> = {};
    let legacy = false;
    if (!stored) {
        return {
            value: migrated,
            legacy,
        };
    }
    for (const half of OUTPUT_HALVES) {
        const rect = scanCleanupPreferenceRecord(stored[half]);
        if (!rect) continue;
        const storedRotation = decodeRotation(rect.rotationDegrees ?? rect.rotation);
        if (storedRotation !== null) {
            const normalized = {
                xNormalized: normalizedValue(rect.xNormalized ?? rect.x),
                yNormalized: normalizedValue(rect.yNormalized ?? rect.y),
                widthNormalized: normalizedValue(rect.widthNormalized ?? rect.width),
                heightNormalized: normalizedValue(rect.heightNormalized ?? rect.height),
            };
            if (
                storedRotation === rotationDegrees
                && normalized.xNormalized !== null
                && normalized.yNormalized !== null
                && normalized.widthNormalized !== null
                && normalized.heightNormalized !== null
                && normalized.widthNormalized > 0
                && normalized.heightNormalized > 0
                && normalized.xNormalized + normalized.widthNormalized <= 1
                && normalized.yNormalized + normalized.heightNormalized <= 1
            ) {
                migrated[half] = {
                    ...normalized,
                    rotationDegrees,
                } as IScanCleanupNormalizedRect;
            }
            continue;
        }
        legacy = true;
        if (!dimensions) continue;
        const x = positiveDimension(rect.x) ?? (rect.x === 0 ? 0 : null);
        const y = positiveDimension(rect.y) ?? (rect.y === 0 ? 0 : null);
        const width = positiveDimension(rect.width);
        const height = positiveDimension(rect.height);
        if (x === null || y === null || width === null || height === null) continue;
        const normalized = {
            xNormalized: x / dimensions.width,
            yNormalized: y / dimensions.height,
            widthNormalized: width / dimensions.width,
            heightNormalized: height / dimensions.height,
            rotationDegrees,
        };
        if (
            normalized.xNormalized + normalized.widthNormalized <= 1
            && normalized.yNormalized + normalized.heightNormalized <= 1
        ) {
            migrated[half] = normalized;
        }
    }
    return {
        value: migrated,
        legacy,
    };
}

export function migrateScanCleanupDocumentOverridesV1(
    entry: Record<string, unknown> | null,
): {
    migratedLegacyGeometry: boolean;
    overrides: TScanCleanupPageOverrides;
} {
    const overrides = scanCleanupPreferenceRecord(entry?.overrides);
    if (!overrides) {
        return {
            migratedLegacyGeometry: false,
            overrides: {},
        };
    }
    const migrated: TScanCleanupPageOverrides = {};
    let legacyGeometryFound = false;
    for (const [
        pageKey,
        storedOverride,
    ] of Object.entries(overrides)) {
        const value = scanCleanupPreferenceRecord(storedOverride);
        const pageNumber = Number(pageKey);
        if (!value || !Number.isSafeInteger(pageNumber) || pageNumber < 1) continue;
        const rotationDegrees = decodeRotation(value.rotationDegrees ?? value.rotation) ?? 0;
        const dimensions = legacyRasterDimensions(entry, value, pageKey, rotationDegrees);
        const manualSplit = migrateManualSplit(value.manualSplit ?? value.manualSplitX, rotationDegrees, dimensions);
        const manualContentBoxes = migrateManualContentBoxes(value.manualContentBoxes, rotationDegrees, dimensions);
        const manualZones = decodeManualZones(value.manualZones, rotationDegrees);
        const placementOverrides = decodePlacementOverrides(value.placementOverrides);
        const marginsMm = decodeMarginsMm(value.marginsMm);
        const manualSkewDegrees = typeof value.manualSkewDegrees === 'number'
            && Number.isFinite(value.manualSkewDegrees)
            && value.manualSkewDegrees >= SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES
            && value.manualSkewDegrees <= SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES
            ? value.manualSkewDegrees
            : undefined;
        const outputModeOverride = [
            'bw',
            'mixed',
            'grayscale',
            'color',
        ].includes(String(value.outputModeOverride))
            ? value.outputModeOverride as IScanCleanupPageOverride['outputModeOverride']
            : undefined;
        legacyGeometryFound ||= manualSplit.legacy || manualContentBoxes.legacy;
        migrated[String(pageNumber)] = createScanCleanupPageOverride({
            rotationDegrees,
            layoutOverride: decodeLayoutOverride(value.layoutOverride),
            excluded: value.excluded === true,
            manualSplit: manualSplit.value,
            ...(manualSkewDegrees === undefined ? {} : {manualSkewDegrees}),
            ...(outputModeOverride === undefined ? {} : {outputModeOverride}),
            ...(Object.keys(manualContentBoxes.value).length > 0
                ? {manualContentBoxes: manualContentBoxes.value}
                : {}),
            ...(manualZones === undefined ? {} : {manualZones}),
            ...(marginsMm === undefined ? {} : {marginsMm}),
            ...(placementOverrides !== undefined
                ? {placementOverrides}
                : {}),
        });
    }
    return {
        migratedLegacyGeometry: legacyGeometryFound,
        overrides: cloneScanCleanupPreferenceValue(migrated),
    };
}

export function warnScanCleanupOverrideMigrationV1() {
    if (legacyOverrideWarningShown) {
        return;
    }
    legacyOverrideWarningShown = true;
    BrowserLogger.warn(
        'scan-cleanup',
        'Migrated legacy pixel-based overrides; geometry without known 150-DPI raster dimensions was dropped.',
    );
}
