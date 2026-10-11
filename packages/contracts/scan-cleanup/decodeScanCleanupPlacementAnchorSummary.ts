import * as v from 'valibot';

import {
    SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
    SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_CLUSTERS,
} from '@contracts/scan-cleanup/inputLimits';

const finite = v.pipe(v.number(), v.finite());
const normalized = v.pipe(finite, v.minValue(0), v.maxValue(1));
// Ink tops are fractions of the reference sheet height. A sheet taller than the
// reference measures past 1; only the anchors placed from them are canvas
// fractions bounded by 1.
const referenceFraction = v.pipe(finite, v.minValue(0));
const boundedIdentity = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(SCAN_CLEANUP_INPUT_MAX_ID_BYTES),
    v.check(value => value.trim().length > 0
        && !value.includes('\0')
        && new TextEncoder().encode(value).byteLength <= SCAN_CLEANUP_INPUT_MAX_ID_BYTES),
);
const identitySchema = v.strictObject({
    documentRevision: boundedIdentity,
    detectionSignature: boundedIdentity,
    calibrationSignature: boundedIdentity,
});
const clusterSchema = v.pipe(v.strictObject({
    startNormalized: referenceFraction,
    endNormalized: referenceFraction,
    valueNormalized: referenceFraction,
    size: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
}), v.check(cluster => cluster.endNormalized >= cluster.startNormalized
    && cluster.valueNormalized >= cluster.startNormalized
    && cluster.valueNormalized <= cluster.endNormalized));
export const SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SCHEMA = v.message(v.object({
    schemaVersion: v.literal(1),
    sampleCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    referenceHeightPoints: v.pipe(finite, v.minValue(0)),
    toleranceNormalized: normalized,
    topEdgeNormalized: referenceFraction,
    identity: identitySchema,
    clusters: v.pipe(v.array(clusterSchema), v.maxLength(SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_CLUSTERS), v.readonly()),
}), 'invalid scan-cleanup placement anchor summary');

export type IScanCleanupPlacementAnchorSummary = v.InferOutput<typeof SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SCHEMA>;
