import type { TPageNumber } from '@contracts/pageNumbers';
import {isEqual} from 'es-toolkit/predicate';

import type {
    IScanCleanupPageOverride,
    TScanCleanupPageOverrides,
} from '@contracts/scan-cleanup/domain';
import type {IScanCleanupMarginsMm} from '@contracts/scan-cleanup/geometry';

export const DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE: Readonly<IScanCleanupPageOverride> = Object.freeze({
    rotationDegrees: 0,
    layoutOverride: 'auto',
    excluded: false,
    manualSplit: null,
});

export {SCAN_CLEANUP_OUTPUT_HALVES} from '@contracts/scan-cleanup/domain';

// Page overrides are plain data at structured-clone and persistence
// boundaries. Keep the document-wide default associated with the in-memory
// record so shared callers can resolve a page with only its page number.
const scanCleanupPageOverrideDefaults = new WeakMap<
    TScanCleanupPageOverrides,
    IScanCleanupPageOverride
>();

export function createScanCleanupPageOverride(
    value: Partial<IScanCleanupPageOverride> = {},
    documentMargins?: IScanCleanupMarginsMm,
): IScanCleanupPageOverride {
    const {
        manualContentBoxes,
        manualZones,
        manualSkewDegrees,
        marginsMm,
        outputModeOverride,
        placementOverrides,
        ...scalarValues
    } = value;
    return {
        ...DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
        ...scalarValues,
        ...(manualSkewDegrees === undefined ? {} : {manualSkewDegrees}),
        ...(manualContentBoxes ? {manualContentBoxes: {...manualContentBoxes}} : {}),
        ...(manualZones ? {manualZones: {
            picture: manualZones.picture.map(zone => ({
                layer: zone.layer,
                polygon: {
                    points: zone.polygon.points.map(point => ({...point})),
                    rotationDegrees: zone.polygon.rotationDegrees,
                },
            })),
            fill: manualZones.fill.map(polygon => ({
                points: polygon.points.map(point => ({...point})),
                rotationDegrees: polygon.rotationDegrees,
            })),
        }} : {}),
        ...(outputModeOverride ? {outputModeOverride} : {}),
        ...(marginsMm && (!documentMargins || !areScanCleanupMarginsMmEqual(marginsMm, documentMargins))
            ? {marginsMm: {...marginsMm}}
            : {}),
        ...(placementOverrides ? {placementOverrides: {...placementOverrides}} : {}),
    };
}

export function attachScanCleanupPageOverrideDefaults(
    overrides: TScanCleanupPageOverrides,
    defaults: IScanCleanupPageOverride | undefined,
    documentMargins?: IScanCleanupMarginsMm,
) {
    if (defaults === undefined) {
        scanCleanupPageOverrideDefaults.delete(overrides);
        return;
    }
    scanCleanupPageOverrideDefaults.set(
        overrides,
        createScanCleanupPageOverride(defaults, documentMargins),
    );
}

export function setScanCleanupPageOverrideDefaults(
    overrides: TScanCleanupPageOverrides,
    defaults: IScanCleanupPageOverride,
    documentMargins?: IScanCleanupMarginsMm,
) {
    const normalized = createScanCleanupPageOverride(defaults, documentMargins);
    scanCleanupPageOverrideDefaults.set(overrides, normalized);
    return normalized;
}

export function getScanCleanupPageOverrideDefaults(overrides: TScanCleanupPageOverrides): IScanCleanupPageOverride {
    return createScanCleanupPageOverride(scanCleanupPageOverrideDefaults.get(overrides));
}

export function getScanCleanupPageOverride(
    overrides: TScanCleanupPageOverrides,
    pageNumber: TPageNumber,
    defaults?: IScanCleanupPageOverride | undefined,
    documentMargins?: IScanCleanupMarginsMm,
): IScanCleanupPageOverride {
    const explicit = overrides[String(pageNumber)];
    const fallback = arguments.length >= 3
        ? defaults
        : scanCleanupPageOverrideDefaults.get(overrides);
    return explicit === undefined
        ? createScanCleanupPageOverride(fallback, documentMargins)
        : createScanCleanupPageOverride(explicit);
}

export function setScanCleanupPageOverride(
    overrides: TScanCleanupPageOverrides,
    pageNumber: TPageNumber,
    value: IScanCleanupPageOverride,
    documentMargins?: IScanCleanupMarginsMm,
) {
    const key = String(pageNumber);
    const normalized = createScanCleanupPageOverride(value, documentMargins);
    // An absent page resolves to the all-pages defaults, so only a value equal to
    // them is redundant. A built-in value is kept when the defaults differ.
    if (isEqual(normalized, getScanCleanupPageOverrideDefaults(overrides))) {
        Reflect.deleteProperty(overrides, key);
        return;
    }
    overrides[key] = normalized;
}

export function isDefaultScanCleanupPageOverride(value: IScanCleanupPageOverride) {
    return value.rotationDegrees === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.rotationDegrees
        && value.layoutOverride === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.layoutOverride
        && value.excluded === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.excluded
        && value.manualSplit === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.manualSplit
        && value.manualSkewDegrees === undefined
        && value.outputModeOverride === undefined
        && Object.keys(value.manualContentBoxes ?? {}).length === 0
        && (value.manualZones?.picture.length ?? 0) === 0
        && (value.manualZones?.fill.length ?? 0) === 0
        && value.marginsMm === undefined
        && Object.keys(value.placementOverrides ?? {}).length === 0;
}

export function areScanCleanupMarginsMmEqual(
    left: IScanCleanupMarginsMm,
    right: IScanCleanupMarginsMm,
) {
    return left.leftMm === right.leftMm
        && left.topMm === right.topMm
        && left.rightMm === right.rightMm
        && left.bottomMm === right.bottomMm;
}
