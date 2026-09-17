import type {
    IScanCleanupOptions, IScanCleanupPageOverride,
} from '@contracts/scan-cleanup/domain';
import {
    attachScanCleanupPageOverrideDefaults,
    getScanCleanupPageOverride,
    getScanCleanupPageOverrideDefaults,
} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {requirePageNumber} from '@contracts/pageNumbers';

function pageOverrideSignature(override: IScanCleanupPageOverride) {
    return {
        layoutOverride: override.layoutOverride,
        rotationDegrees: override.rotationDegrees,
        manualSplit: override.manualSplit,
        manualSkewDegrees: override.manualSkewDegrees,
        manualZones: override.manualZones ?? {
            picture: [],
            fill: [],
        },
    };
}

function placementAnchorCalibrationOverrideSignature(override: IScanCleanupPageOverride) {
    return {
        excluded: override.excluded,
        manualContentBoxes: override.manualContentBoxes ?? {},
        placementOverrides: override.placementOverrides ?? {},
    };
}

function scanCleanupSignatureToken(value: string) {
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= BigInt(value.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, '0');
}

/** Identifies the settings and page edits that detection evidence depends on. */
export function createScanCleanupDetectionSignature(options: IScanCleanupOptions) {
    attachScanCleanupPageOverrideDefaults(
        options.pageOverrides,
        options.pageOverrideDefaults,
        options.marginsMm,
    );
    const defaults = getScanCleanupPageOverrideDefaults(options.pageOverrides);
    const defaultSignature = JSON.stringify(pageOverrideSignature(defaults));
    const pageOverrides = Object.keys(options.pageOverrides)
        .map(pageKey => {
            const signature = JSON.stringify(pageOverrideSignature(
                getScanCleanupPageOverride(
                    options.pageOverrides,
                    requirePageNumber(Number(pageKey)),
                ),
            ));
            return signature === defaultSignature ? null : [
                pageKey,
                signature,
            ];
        })
        .filter((entry): entry is [string, string] => entry !== null)
        .sort(([left], [right]) => left.localeCompare(right));
    const lossless = options.preserveOriginalQuality === true;
    return scanCleanupSignatureToken(JSON.stringify({
        document: {
            layoutMode: options.layoutMode,
            preserveOriginalQuality: lossless,
            crop: options.crop,
            marginsMm: options.marginsMm,
            normalizeIllumination: !lossless && (options.normalizeIllumination ?? true),
            autoDewarp: !lossless && (options.autoDewarp ?? false),
            autoDewarpDepth: options.autoDewarpDepth,
            pageOverrideDefaults: pageOverrideSignature(defaults),
        },
        pageOverrides,
    }));
}

/** Identifies the inputs that change document-wide ink placement calibration. */
export function createScanCleanupPlacementAnchorCalibrationSignature(options: IScanCleanupOptions) {
    attachScanCleanupPageOverrideDefaults(
        options.pageOverrides,
        options.pageOverrideDefaults,
        options.marginsMm,
    );
    const defaults = getScanCleanupPageOverrideDefaults(options.pageOverrides);
    const defaultSignature = JSON.stringify(placementAnchorCalibrationOverrideSignature(defaults));
    const pageOverrides = Object.keys(options.pageOverrides)
        .map(pageKey => {
            const signature = JSON.stringify(placementAnchorCalibrationOverrideSignature(
                getScanCleanupPageOverride(
                    options.pageOverrides,
                    requirePageNumber(Number(pageKey)),
                ),
            ));
            return signature === defaultSignature ? null : [
                pageKey,
                signature,
            ];
        })
        .filter((entry): entry is [string, string] => entry !== null)
        .sort(([left], [right]) => Number(left) - Number(right));
    return scanCleanupSignatureToken(JSON.stringify({
        matchPageSize: options.matchPageSize,
        pageAlignment: options.pageAlignment,
        defaults: placementAnchorCalibrationOverrideSignature(defaults),
        pageOverrides,
    }));
}
