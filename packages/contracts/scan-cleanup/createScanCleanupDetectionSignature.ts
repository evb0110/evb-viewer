import type {
    IScanCleanupOptions, IScanCleanupPageOverride,
} from '@contracts/scan-cleanup/domain';
import {
    attachScanCleanupPageOverrideDefaults,
    getScanCleanupPageOverride,
    getScanCleanupPageOverrideDefaults,
} from '@contracts/scanCleanupPageOverrides';
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
                getScanCleanupPageOverride(options.pageOverrides, requirePageNumber(Number(pageKey))),
            ));
            return signature === defaultSignature ? null : [
                pageKey,
                signature,
            ];
        })
        .filter((entry): entry is [string, string] => entry !== null)
        .sort(([left], [right]) => left.localeCompare(right));
    const lossless = options.preserveOriginalQuality === true;
    return JSON.stringify({
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
    });
}
