import {isRecord} from '@contracts/runtimeGuards';
import type {
    IScanCleanupPlacementAnchorSummary,
    IScanCleanupPlacementAnchorSummaryIdentity,
} from '@contracts/scan-cleanup/ipc';
import type {TScanCleanupOutputHalf} from '@contracts/scan-cleanup/domain';
import type {IScanCleanupPlacementAnchor} from '@contracts/scan-cleanup/nativeProtocolV3';
import {
    decodeBoundedScanCleanupString,
    decodeScanCleanupPageNumber,
    SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
    SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_CLUSTERS,
    SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_SAMPLES,
} from '@contracts/scan-cleanup/inputLimits';

function decodeFiniteNumber(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`invalid scan-cleanup ${label}`);
    }
    return value;
}

function decodeNormalizedSummaryNumber(value: unknown, label: string) {
    const decoded = decodeFiniteNumber(value, label);
    if (decoded < 0 || decoded > 1) {
        throw new Error(`invalid scan-cleanup ${label}`);
    }
    return decoded;
}

function decodeSummaryAnchor(value: unknown): IScanCleanupPlacementAnchor {
    if (
        !isRecord(value)
        || Object.keys(value).some(key => key !== 'yNormalized')
    ) {
        throw new Error('invalid scan-cleanup placement anchor summary sample anchor');
    }
    const yNormalized = decodeNormalizedSummaryNumber(
        value.yNormalized,
        'placement anchor summary sample anchor y',
    );
    return {yNormalized};
}

function decodeScanCleanupOutputHalf(value: unknown): TScanCleanupOutputHalf {
    if (value === 'full' || value === 'left' || value === 'right') {
        return value;
    }
    throw new Error('invalid scan-cleanup placement anchor summary sample half');
}

function decodeScanCleanupPlacementAnchorSummaryIdentity(
    value: unknown,
): IScanCleanupPlacementAnchorSummaryIdentity {
    if (
        !isRecord(value)
        || Object.keys(value).some(key => ![
            'documentRevision',
            'detectionSignature',
            'calibrationSignature',
        ].includes(key))
    ) {
        throw new Error('invalid scan-cleanup placement anchor summary identity');
    }
    return {
        documentRevision: decodeBoundedScanCleanupString(
            value.documentRevision,
            'placement anchor summary document revision',
            SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
        ),
        detectionSignature: decodeBoundedScanCleanupString(
            value.detectionSignature,
            'placement anchor summary detection signature',
            SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
        ),
        calibrationSignature: decodeBoundedScanCleanupString(
            value.calibrationSignature,
            'placement anchor summary calibration signature',
            SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
        ),
    };
}

export function decodeScanCleanupPlacementAnchorSummary(
    value: unknown,
): IScanCleanupPlacementAnchorSummary {
    if (
        !isRecord(value)
        || value.schemaVersion !== 1
        || !Number.isSafeInteger(value.sampleCount)
        || Number(value.sampleCount) < 0
        || !Array.isArray(value.clusters)
        || value.clusters.length > SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_CLUSTERS
        || !Array.isArray(value.samples)
        || value.samples.length > SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_SAMPLES
    ) {
        throw new Error('invalid scan-cleanup placement anchor summary');
    }
    const referenceHeightPoints = decodeFiniteNumber(
        value.referenceHeightPoints,
        'placement anchor summary reference height',
    );
    if (referenceHeightPoints < 0) {
        throw new Error('invalid scan-cleanup placement anchor summary reference height');
    }
    const toleranceNormalized = decodeNormalizedSummaryNumber(
        value.toleranceNormalized,
        'placement anchor summary tolerance',
    );
    const topEdgeNormalized = decodeNormalizedSummaryNumber(
        value.topEdgeNormalized,
        'placement anchor summary top edge',
    );
    const identity = decodeScanCleanupPlacementAnchorSummaryIdentity(value.identity);
    const clusters = value.clusters.map((cluster, index) => {
        if (
            !isRecord(cluster)
            || Object.keys(cluster).some(key => ![
                'startNormalized',
                'endNormalized',
                'valueNormalized',
            ].includes(key))
        ) {
            throw new Error(`invalid scan-cleanup placement anchor summary cluster ${String(index)}`);
        }
        const startNormalized = decodeNormalizedSummaryNumber(
            cluster.startNormalized,
            'placement anchor summary cluster start',
        );
        const endNormalized = decodeNormalizedSummaryNumber(
            cluster.endNormalized,
            'placement anchor summary cluster end',
        );
        const valueNormalized = decodeNormalizedSummaryNumber(
            cluster.valueNormalized,
            'placement anchor summary cluster value',
        );
        if (
            endNormalized < startNormalized
            || valueNormalized < startNormalized
            || valueNormalized > endNormalized
        ) {
            throw new Error('invalid scan-cleanup placement anchor summary cluster');
        }
        return {
            startNormalized,
            endNormalized,
            valueNormalized,
        };
    });
    const samples = value.samples.map((sample, index) => {
        if (
            !isRecord(sample)
            || Object.keys(sample).some(key => ![
                'pageNumber',
                'half',
                'yNormalized',
                'anchor',
            ].includes(key))
        ) {
            throw new Error(`invalid scan-cleanup placement anchor summary sample ${String(index)}`);
        }
        const half = decodeScanCleanupOutputHalf(sample.half);
        return {
            pageNumber: decodeScanCleanupPageNumber(
                sample.pageNumber,
                'placement anchor summary sample page number',
            ),
            half,
            yNormalized: decodeNormalizedSummaryNumber(
                sample.yNormalized,
                'placement anchor summary sample y',
            ),
            anchor: decodeSummaryAnchor(sample.anchor),
        };
    });
    return {
        schemaVersion: 1,
        sampleCount: Number(value.sampleCount),
        referenceHeightPoints,
        toleranceNormalized,
        topEdgeNormalized,
        identity,
        clusters,
        samples,
    };
}
