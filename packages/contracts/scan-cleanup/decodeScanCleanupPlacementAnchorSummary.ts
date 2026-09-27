import * as v from 'valibot';

import {requirePageNumber} from '@contracts/pageNumbers';
import {SCAN_CLEANUP_OUTPUT_HALVES} from '@contracts/scan-cleanup/domain';
import {
    SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
    SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_CLUSTERS,
    SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_SAMPLES,
} from '@contracts/scan-cleanup/inputLimits';

const finite = v.pipe(v.number(), v.finite());
const normalized = v.pipe(finite, v.minValue(0), v.maxValue(1));
const boundedIdentity = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(SCAN_CLEANUP_INPUT_MAX_ID_BYTES),
    v.check(value => value.trim().length > 0
        && !value.includes('\0')
        && new TextEncoder().encode(value).byteLength <= SCAN_CLEANUP_INPUT_MAX_ID_BYTES),
);
const placementAnchorSchema = v.strictObject({yNormalized: normalized});
const identitySchema = v.strictObject({
    documentRevision: boundedIdentity,
    detectionSignature: boundedIdentity,
    calibrationSignature: boundedIdentity,
});
const clusterSchema = v.pipe(v.strictObject({
    startNormalized: normalized,
    endNormalized: normalized,
    valueNormalized: normalized,
}), v.check(cluster => cluster.endNormalized >= cluster.startNormalized
    && cluster.valueNormalized >= cluster.startNormalized
    && cluster.valueNormalized <= cluster.endNormalized));
const sampleSchema = v.strictObject({
    pageNumber: v.pipe(v.number(), v.safeInteger(), v.minValue(1),
        v.transform(value => requirePageNumber(value))),
    half: v.picklist(SCAN_CLEANUP_OUTPUT_HALVES),
    yNormalized: normalized,
    anchor: placementAnchorSchema,
});

export const SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SCHEMA = v.message(v.object({
    schemaVersion: v.literal(1),
    sampleCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    referenceHeightPoints: v.pipe(finite, v.minValue(0)),
    toleranceNormalized: normalized,
    topEdgeNormalized: normalized,
    identity: identitySchema,
    clusters: v.pipe(v.array(clusterSchema), v.maxLength(SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_CLUSTERS), v.readonly()),
    samples: v.pipe(v.array(sampleSchema), v.maxLength(SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_SAMPLES), v.readonly()),
}), 'invalid scan-cleanup placement anchor summary');

export type IScanCleanupPlacementAnchorSummary = v.InferOutput<typeof SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SCHEMA>;
