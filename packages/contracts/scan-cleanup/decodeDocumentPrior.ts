import {isRecord} from '@contracts/runtimeGuards';
import type {IScanCleanupDocumentPrior} from '@contracts/scan-cleanup/domain';
import {SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS} from '@contracts/scan-cleanup/domain';

function isSafeFiniteNumber(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
    return Object.keys(value).every(key => keys.includes(key));
}

function isLayoutClassification(value: unknown): value is IScanCleanupDocumentPrior['dominantLayout'] {
    return SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS.some(classification => classification === value);
}

/** Decodes the document prior shared by renderer requests and native results. */
export function decodeDocumentPrior(value: unknown): IScanCleanupDocumentPrior {
    if (!isRecord(value) || !hasOnlyKeys(value, [
        'dominantLayout',
        'cutterRatioMedian',
        'clusterDims',
        'agreementStrength',
        'strokeWidthMedianPx',
        'xHeightMedianPx',
    ])) {
        throw new Error('invalid scan-cleanup document prior');
    }
    if (!isLayoutClassification(value.dominantLayout)
        || !isRecord(value.clusterDims)
        || !hasOnlyKeys(value.clusterDims, [
            'widthPx',
            'heightPx',
        ])
        || !isSafeFiniteNumber(value.clusterDims.widthPx)
        || value.clusterDims.widthPx <= 0
        || !isSafeFiniteNumber(value.clusterDims.heightPx)
        || value.clusterDims.heightPx <= 0
        || typeof value.agreementStrength !== 'number'
        || !Number.isFinite(value.agreementStrength)
        || value.agreementStrength < 0
        || value.agreementStrength > 1
        || !(value.strokeWidthMedianPx === undefined
            || (isSafeFiniteNumber(value.strokeWidthMedianPx)
                && value.strokeWidthMedianPx > 0))
        || !(value.xHeightMedianPx === undefined
            || (isSafeFiniteNumber(value.xHeightMedianPx)
                && value.xHeightMedianPx > 0))
        || !(value.cutterRatioMedian === null || (
            typeof value.cutterRatioMedian === 'number'
            && Number.isFinite(value.cutterRatioMedian)
            && value.cutterRatioMedian >= 0.2
            && value.cutterRatioMedian <= 0.8
        ))
        || (value.dominantLayout === 'two-page-spread' && value.cutterRatioMedian === null)
    ) {
        throw new Error('invalid scan-cleanup document prior');
    }
    return {
        dominantLayout: value.dominantLayout,
        cutterRatioMedian: value.cutterRatioMedian,
        clusterDims: {
            widthPx: value.clusterDims.widthPx,
            heightPx: value.clusterDims.heightPx,
        },
        agreementStrength: value.agreementStrength,
        ...(value.strokeWidthMedianPx === undefined
            ? {}
            : {strokeWidthMedianPx: value.strokeWidthMedianPx}),
        ...(value.xHeightMedianPx === undefined
            ? {}
            : {xHeightMedianPx: value.xHeightMedianPx}),
    };
}
