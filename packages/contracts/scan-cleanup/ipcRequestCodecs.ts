import * as v from 'valibot';

import {isRecord} from '@contracts/runtimeGuards';
import {
    parsePageNumber, requirePageNumber,
} from '@contracts/pageNumbers';
import {
    parseJobId, parseRequestId,
} from '@contracts/shared';
import {
    SCAN_CLEANUP_ALIGNMENTS,
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX,
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN,
    SCAN_CLEANUP_BINARIZATION_METHODS,
    SCAN_CLEANUP_DESPECKLE_LEVELS,
    SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS,
    SCAN_CLEANUP_LAYOUT_MODES,
    SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES,
    SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES,
    SCAN_CLEANUP_OUTPUT_MODES,
    SCAN_CLEANUP_OUTPUT_MODE_SETTINGS,
    SCAN_CLEANUP_PAGE_LAYOUT_OVERRIDES,
    SCAN_CLEANUP_PAGE_ROTATIONS,
    SCAN_CLEANUP_PICTURE_ZONE_LAYERS,
    SCAN_CLEANUP_READING_ORDERS,
    SCAN_CLEANUP_TEXT_TONE_RULES,
    SCAN_CLEANUP_DOCUMENT_PRIOR_SCHEMA,
} from '@contracts/scan-cleanup/domain';
import {
    SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
    SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES,
    SCAN_CLEANUP_INPUT_MAX_PAGE_NUMBER,
    SCAN_CLEANUP_INPUT_MAX_PATH_BYTES,
    SCAN_CLEANUP_INPUT_MAX_VERTICES,
    SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_PAGE,
    SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_POLYGON,
    SCAN_CLEANUP_INPUT_MAX_ZONES,
    SCAN_CLEANUP_INPUT_MAX_ZONES_PER_PAGE,
    consumeScanCleanupPages,
    consumeScanCleanupVertices,
    consumeScanCleanupZones,
    createScanCleanupInputBudget,
} from '@contracts/scan-cleanup/inputLimits';
import {assertSimpleScanCleanupPolygon} from '@contracts/scan-cleanup/assertSimpleScanCleanupPolygon';
import {attachScanCleanupPageOverrideDefaults} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SCHEMA} from '@contracts/scan-cleanup/decodeScanCleanupPlacementAnchorSummary';
import {
    SCAN_CLEANUP_MANUAL_SPLIT_MAX,
    SCAN_CLEANUP_MANUAL_SPLIT_MIN,
    SCAN_CLEANUP_MARGIN_MAX_MM,
    SCAN_CLEANUP_NORMALIZED_BOUNDS_EPSILON,
} from '@contracts/scan-cleanup/geometry';

const finite = v.pipe(v.number(), v.finite());
const safeFinite = v.pipe(finite, v.check(value => Math.abs(value) <= Number.MAX_SAFE_INTEGER));
const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const pageNumberSchema = v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(1),
    v.maxValue(SCAN_CLEANUP_INPUT_MAX_PAGE_NUMBER),
    v.transform(value => requirePageNumber(value)),
);
const sourcePageNumberSchema = v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(1),
    v.maxValue(SCAN_CLEANUP_INPUT_MAX_PAGE_NUMBER),
);
const rotationSchema = v.picklist(SCAN_CLEANUP_PAGE_ROTATIONS);
const outputModeSchema = v.picklist(SCAN_CLEANUP_OUTPUT_MODES);
const layoutClassificationSchema = v.picklist(SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS);
const ownerTextSchema = (maxBytes: number, label: string) => v.message(v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(maxBytes),
    v.check(value => !value.includes('\0') && value.trim().length > 0
        && new TextEncoder().encode(value).byteLength <= maxBytes),
), `invalid scan-cleanup ${label}`);
const normalizedNumberSchema = v.pipe(
    finite,
    v.check(value => value >= -SCAN_CLEANUP_NORMALIZED_BOUNDS_EPSILON
        && value <= 1 + SCAN_CLEANUP_NORMALIZED_BOUNDS_EPSILON),
    // Coordinates just outside the normalized page are clipped by the existing input policy.
    v.transform(value => Math.min(1, Math.max(0, value))),
);
export const SCAN_CLEANUP_OWNER_CONTEXT_SCHEMA = v.object({
    ownerId: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'owner id'),
    documentRevision: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'document revision'),
});
const ownerContextSchema = SCAN_CLEANUP_OWNER_CONTEXT_SCHEMA;
const normalizedRectSchema = v.message(v.pipe(v.object({
    xNormalized: normalizedNumberSchema,
    yNormalized: normalizedNumberSchema,
    widthNormalized: normalizedNumberSchema,
    heightNormalized: normalizedNumberSchema,
    rotationDegrees: rotationSchema,
}), v.check(rect => rect.widthNormalized > 0
    && rect.heightNormalized > 0
    && rect.xNormalized + rect.widthNormalized <= 1 + SCAN_CLEANUP_NORMALIZED_BOUNDS_EPSILON
    && rect.yNormalized + rect.heightNormalized <= 1 + SCAN_CLEANUP_NORMALIZED_BOUNDS_EPSILON)),
'invalid scan-cleanup content box');
const normalizedPointSchema = v.object({
    xNormalized: normalizedNumberSchema,
    yNormalized: normalizedNumberSchema,
});
const placementAnchorSchema = v.strictObject({yNormalized: normalizedNumberSchema});
export const SCAN_CLEANUP_PLACEMENT_ANCHORS_SCHEMA = v.pipe(v.strictObject({
    full: v.exactOptional(placementAnchorSchema),
    left: v.exactOptional(placementAnchorSchema),
    right: v.exactOptional(placementAnchorSchema),
}), v.transform(anchors => ({
    ...(anchors.full === undefined ? {} : {full: anchors.full}),
    ...(anchors.left === undefined ? {} : {left: anchors.left}),
    ...(anchors.right === undefined ? {} : {right: anchors.right}),
})));
const placementAnchorsSchema = SCAN_CLEANUP_PLACEMENT_ANCHORS_SCHEMA;
const pageOutputSchema = v.pipe(v.object({
    contentBox: v.exactOptional(normalizedRectSchema),
    detectedSkewDegrees: v.exactOptional(v.pipe(finite,
        v.minValue(SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES),
        v.maxValue(SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES))),
    textToneDiagnostics: v.exactOptional(v.message(v.pipe(v.object({
        applied: v.boolean(),
        rule: v.picklist(SCAN_CLEANUP_TEXT_TONE_RULES),
        textLineCount: nonNegativeInteger,
        textInkPixels: nonNegativeInteger,
        pictureFraction: v.pipe(finite, v.minValue(0), v.maxValue(1)),
        outsideMidtoneFraction: v.pipe(finite, v.minValue(0), v.maxValue(1)),
        outsideMidtoneLargestComponentFraction: v.pipe(finite, v.minValue(0), v.maxValue(1)),
        outsideMidtoneLargestComponentWidthFraction: v.pipe(finite, v.minValue(0), v.maxValue(1)),
        outsideMidtoneLargestComponentHeightFraction: v.pipe(finite, v.minValue(0), v.maxValue(1)),
        inkAnchor: v.exactOptional(v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(255)))),
        blackPoint: v.exactOptional(v.nullable(finite)),
        slope: v.exactOptional(v.nullable(finite)),
    }), v.check(diagnostics => diagnostics.inkAnchor !== undefined
        && diagnostics.blackPoint !== undefined
        && diagnostics.slope !== undefined
        && diagnostics.applied === (diagnostics.rule === 'applied')
        && diagnostics.applied === (diagnostics.blackPoint !== null && diagnostics.slope !== null))),
    'invalid scan-cleanup text tone diagnostics')),
}), v.check(output => output.contentBox !== undefined
    || output.detectedSkewDegrees !== undefined
    || output.textToneDiagnostics !== undefined));
const pageOutputMapSchema = v.pipe(v.strictObject({
    full: v.exactOptional(pageOutputSchema),
    left: v.exactOptional(pageOutputSchema),
    right: v.exactOptional(pageOutputSchema),
}), v.transform(outputs => ({
    ...(outputs.full === undefined ? {} : {full: outputs.full}),
    ...(outputs.left === undefined ? {} : {left: outputs.left}),
    ...(outputs.right === undefined ? {} : {right: outputs.right}),
})));
const pageKeySchema = v.pipe(v.string(), v.check(key => {
    const parsed = parsePageNumber(Number(key));
    return parsed !== null && String(parsed) === key;
}));
const pageKey = v.message(pageKeySchema, 'invalid scan-cleanup page override number');
const layoutPageKey = v.message(pageKeySchema, 'invalid scan-cleanup layout classifications');
const sourceMetadataPageKey = v.message(pageKeySchema, 'invalid scan-cleanup source page metadata map');
const pagePlanPageKey = v.message(pageKeySchema, 'invalid scan-cleanup page-plan evidence');
const placementAnchorPageKey = v.message(pageKeySchema, 'invalid scan-cleanup placement anchor map');
const pageMapInputCap = v.check(value => !isRecord(value)
    || Object.keys(value).length <= SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES,
'too many scan-cleanup page entries');
const pageOverrideInputCaps = v.rawCheck(({
    dataset, addIssue,
}) => {
    const value = dataset.value;
    if (!isRecord(value)) return;
    const keys = Object.keys(value);
    if (keys.length > SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES) {
        addIssue({message: 'too many scan-cleanup page overrides'});
        return;
    }
    let zones = 0;
    let vertices = 0;
    for (const key of keys) {
        const override = value[key];
        if (!isRecord(override) || !isRecord(override.manualZones)) continue;
        const {
            picture, fill,
        } = override.manualZones;
        if (!Array.isArray(picture) || !Array.isArray(fill)) continue;
        zones += picture.length + fill.length;
        if (zones > SCAN_CLEANUP_INPUT_MAX_ZONES
            || picture.length + fill.length > SCAN_CLEANUP_INPUT_MAX_ZONES_PER_PAGE) {
            addIssue({message: 'too many scan-cleanup manual zones'});
            return;
        }
        for (const zones of [
            picture,
            fill,
        ]) {
            for (const zone of zones as unknown[]) {
                const polygon = isRecord(zone) && 'polygon' in zone ? zone.polygon : zone;
                if (!isRecord(polygon) || !Array.isArray(polygon.points)) continue;
                if (polygon.points.length > SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_POLYGON) {
                    addIssue({message: 'too many vertices in fill zone or picture zone'});
                    return;
                }
                vertices += polygon.points.length;
                if (vertices > SCAN_CLEANUP_INPUT_MAX_VERTICES) {
                    addIssue({message: 'too many scan-cleanup manual-zone vertices'});
                    return;
                }
            }
        }
    }
});
const pagePolygonSchema = v.message(v.pipe(v.object({
    points: v.pipe(v.array(normalizedPointSchema), v.minLength(3), v.maxLength(SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_POLYGON)),
    rotationDegrees: rotationSchema,
}), v.check(polygon => {
    try {
        assertSimpleScanCleanupPolygon(polygon.points, 'manual zone');
        return true;
    } catch {
        return false;
    }
})), 'invalid scan-cleanup manual zone polygon: duplicate, near-zero, intersecting or overlapping points');
const boundedZoneArray = v.message(v.pipe(v.unknown(), v.check(value => (
    Array.isArray(value) && value.length <= SCAN_CLEANUP_INPUT_MAX_ZONES_PER_PAGE
))), 'too many scan-cleanup manual zones');
const manualZonesSchema = v.pipe(v.object({
    picture: v.pipe(boundedZoneArray, v.array(v.object({
        polygon: pagePolygonSchema,
        layer: v.picklist(SCAN_CLEANUP_PICTURE_ZONE_LAYERS),
    }))),
    fill: v.message(v.pipe(boundedZoneArray, v.array(pagePolygonSchema)),
        'invalid scan-cleanup fill zone: too many vertices'),
}), v.check(zones => zones.picture.length + zones.fill.length <= SCAN_CLEANUP_INPUT_MAX_ZONES_PER_PAGE,
    'too many scan-cleanup manual zones'),
v.check(zones => [
    ...zones.picture.map(zone => zone.polygon),
    ...zones.fill,
]
    .reduce((count, polygon) => count + polygon.points.length, 0) <= SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_PAGE,
'too many scan-cleanup manual-zone vertices on one page'));
const marginsSchema = v.message(v.object({
    leftMm: v.pipe(finite, v.minValue(0), v.maxValue(SCAN_CLEANUP_MARGIN_MAX_MM)),
    topMm: v.pipe(finite, v.minValue(0), v.maxValue(SCAN_CLEANUP_MARGIN_MAX_MM)),
    rightMm: v.pipe(finite, v.minValue(0), v.maxValue(SCAN_CLEANUP_MARGIN_MAX_MM)),
    bottomMm: v.pipe(finite, v.minValue(0), v.maxValue(SCAN_CLEANUP_MARGIN_MAX_MM)),
}), 'invalid scan-cleanup margins');
const manualSplitSchema = v.pipe(v.object({
    xNormalized: v.message(finite, 'invalid scan-cleanup preview manual split x'),
    rotationDegrees: rotationSchema,
}), v.check(split => split.xNormalized >= SCAN_CLEANUP_MANUAL_SPLIT_MIN
    && split.xNormalized <= SCAN_CLEANUP_MANUAL_SPLIT_MAX,
'invalid scan-cleanup manual split x: outside the safe cutter interval'));
const automaticSplitSchema = v.object({
    xNormalized: v.message(normalizedNumberSchema, 'invalid scan-cleanup automatic split'),
    rotationDegrees: v.message(rotationSchema, 'invalid scan-cleanup automatic split rotation'),
});
const pageOverrideShapeSchema = v.pipe(v.object({
    rotationDegrees: v.message(rotationSchema, 'invalid scan-cleanup page override rotation'),
    layoutOverride: v.picklist(SCAN_CLEANUP_PAGE_LAYOUT_OVERRIDES),
    excluded: v.boolean(),
    manualSplit: v.nullable(manualSplitSchema),
    manualSkewDegrees: v.optional(v.pipe(finite,
        v.minValue(SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES),
        v.maxValue(SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES))),
    outputModeOverride: v.exactOptional(outputModeSchema),
    manualContentBoxes: v.exactOptional(v.pipe(v.strictObject({
        full: v.exactOptional(normalizedRectSchema),
        left: v.exactOptional(normalizedRectSchema),
        right: v.exactOptional(normalizedRectSchema),
    }), v.transform(boxes => ({
        ...(boxes.full === undefined ? {} : {full: boxes.full}),
        ...(boxes.left === undefined ? {} : {left: boxes.left}),
        ...(boxes.right === undefined ? {} : {right: boxes.right}),
    })))),
    manualZones: v.exactOptional(manualZonesSchema),
    marginsMm: v.exactOptional(marginsSchema),
    placementOverrides: v.exactOptional(v.pipe(v.strictObject({
        full: v.exactOptional(v.picklist(SCAN_CLEANUP_ALIGNMENTS)),
        left: v.exactOptional(v.picklist(SCAN_CLEANUP_ALIGNMENTS)),
        right: v.exactOptional(v.picklist(SCAN_CLEANUP_ALIGNMENTS)),
    }), v.transform(overrides => ({
        ...(overrides.full === undefined ? {} : {full: overrides.full}),
        ...(overrides.left === undefined ? {} : {left: overrides.left}),
        ...(overrides.right === undefined ? {} : {right: overrides.right}),
    })))),
}), v.check(override => (
    (override.manualSplit === null || override.manualSplit.rotationDegrees === override.rotationDegrees)
    && Object.values(override.manualContentBoxes ?? {}).every(rect => rect !== undefined && rect.rotationDegrees === override.rotationDegrees)
    && [
        ...(override.manualZones?.picture.map(zone => zone.polygon) ?? []),
        ...(override.manualZones?.fill ?? []),
    ]
        .every(polygon => polygon.rotationDegrees === override.rotationDegrees)),
'invalid scan-cleanup page override geometry'), v.transform(override => {
    const {
        manualContentBoxes, placementOverrides, ...fields
    } = override;
    return {
        ...fields,
        ...(Object.keys(manualContentBoxes ?? {}).length > 0 ? {manualContentBoxes} : {}),
        ...(Object.keys(placementOverrides ?? {}).length > 0 ? {placementOverrides} : {}),
    };
}));
export const SCAN_CLEANUP_PAGE_OVERRIDE_SCHEMA = pageOverrideShapeSchema;
export const SCAN_CLEANUP_PAGE_OVERRIDES_SCHEMA = v.pipe(v.unknown(), pageOverrideInputCaps,
    v.record(pageKey, pageOverrideShapeSchema), v.maxEntries(SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES));
const pageOverridesSchema = SCAN_CLEANUP_PAGE_OVERRIDES_SCHEMA;

const pagePlanEvidenceSchema = v.pipe(v.object({
    pageNumber: pageNumberSchema,
    rotationDegrees: v.message(rotationSchema, 'invalid scan-cleanup page-plan evidence rotation'),
    layoutClassification: layoutClassificationSchema,
    automaticSplit: v.optional(v.message(automaticSplitSchema, 'invalid scan-cleanup automatic split')),
    outputs: pageOutputMapSchema,
}), v.check(evidence => evidence.automaticSplit === undefined
    || evidence.automaticSplit.rotationDegrees === evidence.rotationDegrees,
'invalid scan-cleanup automatic split rotation'),
v.check(evidence => Object.values(evidence.outputs).every(output => output === undefined || output.contentBox === undefined
    || output.contentBox.rotationDegrees === evidence.rotationDegrees),
'invalid scan-cleanup page-plan evidence geometry'), v.transform(evidence => ({
    pageNumber: evidence.pageNumber,
    rotationDegrees: evidence.rotationDegrees,
    layoutClassification: evidence.layoutClassification,
    ...(evidence.automaticSplit === undefined ? {} : {automaticSplit: evidence.automaticSplit}),
    outputs: evidence.outputs,
})));
export const SCAN_CLEANUP_PAGE_PLAN_EVIDENCE_SCHEMA = pagePlanEvidenceSchema;
export type IScanCleanupPagePlanEvidence = v.InferOutput<typeof pagePlanEvidenceSchema>;

const sourcePageMetadataSchema = v.message(v.pipe(
    v.object({
        pageNumber: pageNumberSchema,
        xPoints: safeFinite,
        yPoints: safeFinite,
        widthPoints: v.pipe(finite, v.minValue(Number.MIN_VALUE), v.maxValue(Number.MAX_SAFE_INTEGER)),
        heightPoints: v.pipe(finite, v.minValue(Number.MIN_VALUE), v.maxValue(Number.MAX_SAFE_INTEGER)),
        rotation: v.pipe(v.number(), v.check(rotation => SCAN_CLEANUP_PAGE_ROTATIONS.some(item => item === rotation))),
        sourceDpi: v.pipe(finite, v.minValue(Number.MIN_VALUE), v.maxValue(Number.MAX_SAFE_INTEGER)),
        renderBox: v.exactOptional(v.picklist([
            'cropbox',
            'mediabox',
        ])),
        dominantImageWidthPx: v.exactOptional(v.pipe(finite, v.minValue(Number.MIN_VALUE), v.maxValue(Number.MAX_SAFE_INTEGER))),
        dominantImageHeightPx: v.exactOptional(v.pipe(finite, v.minValue(Number.MIN_VALUE), v.maxValue(Number.MAX_SAFE_INTEGER))),
        dominantImageWidthPoints: v.exactOptional(v.pipe(finite, v.minValue(Number.MIN_VALUE), v.maxValue(Number.MAX_SAFE_INTEGER))),
        dominantImageHeightPoints: v.exactOptional(v.pipe(finite, v.minValue(Number.MIN_VALUE), v.maxValue(Number.MAX_SAFE_INTEGER))),
    }),
    v.check(metadata => {
        const dimensions = [
            metadata.dominantImageWidthPx,
            metadata.dominantImageHeightPx,
            metadata.dominantImageWidthPoints,
            metadata.dominantImageHeightPoints,
        ];
        return metadata.xPoints >= 0 && metadata.yPoints >= 0
            && (dimensions.every(value => value === undefined) || dimensions.every(value => value !== undefined));
    }),
), 'invalid scan-cleanup source page metadata');
export const SCAN_CLEANUP_SOURCE_PAGE_METADATA_SCHEMA = sourcePageMetadataSchema;
export type IScanCleanupSourcePageMetadata = v.InferOutput<typeof sourcePageMetadataSchema>;

const normalizedOutputModeRecommendationsSchema = v.pipe(v.unknown(), pageMapInputCap,
    v.record(pageKey, outputModeSchema),
    v.check(values => Object.keys(values).length <= SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES));
const softAlphaRecommendationsSchema = v.pipe(v.unknown(), pageMapInputCap, v.record(pageKey, v.boolean()),
    v.check(values => Object.keys(values).length <= SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES));
export const SCAN_CLEANUP_LAYOUT_BY_PAGE_SCHEMA = v.pipe(v.unknown(), pageMapInputCap,
    v.record(layoutPageKey, v.optional(layoutClassificationSchema)),
    v.check(values => Object.keys(values).length <= SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES
        && Object.values(values).every(value => value !== undefined),
    'invalid scan-cleanup layout classifications'));
const layoutByPageSchema = SCAN_CLEANUP_LAYOUT_BY_PAGE_SCHEMA;
const sourceMetadataMapSchema = v.pipe(v.unknown(), pageMapInputCap, v.record(sourceMetadataPageKey, sourcePageMetadataSchema),
    v.maxEntries(SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES),
    v.check(values => Object.entries(values).every(([
        key,
        metadata,
    ]) => String(metadata.pageNumber) === key)));
const pagePlanMapSchema = v.pipe(v.unknown(), pageMapInputCap, v.record(pagePlanPageKey, pagePlanEvidenceSchema),
    v.maxEntries(SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES),
    v.check(values => Object.entries(values).every(([
        key,
        evidence,
    ]) => String(evidence.pageNumber) === key),
    'invalid scan-cleanup page-plan evidence'));
const documentPriorMapSchema = v.pipe(v.unknown(), pageMapInputCap, v.record(pageKey, SCAN_CLEANUP_DOCUMENT_PRIOR_SCHEMA),
    v.maxEntries(SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES));
const placementAnchorMapSchema = v.pipe(v.unknown(), pageMapInputCap, v.record(placementAnchorPageKey, placementAnchorsSchema),
    v.maxEntries(SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES));

const pageOverrideDefaultsSchema = v.exactOptional(pageOverrideShapeSchema);
const optionsInputSchema = v.object({
    preserveOriginalQuality: v.boolean(),
    layoutMode: v.picklist(SCAN_CLEANUP_LAYOUT_MODES),
    outputMode: v.picklist(SCAN_CLEANUP_OUTPUT_MODE_SETTINGS),
    binarization: v.exactOptional(v.message(v.picklist(SCAN_CLEANUP_BINARIZATION_METHODS), 'invalid scan-cleanup options')),
    normalizeIllumination: v.exactOptional(v.message(v.boolean(), 'invalid scan-cleanup options')),
    thickness: v.pipe(v.number(), v.safeInteger(), v.minValue(-5), v.maxValue(5)),
    crop: v.boolean(),
    matchPageSize: v.boolean(),
    pageAlignment: v.picklist(SCAN_CLEANUP_ALIGNMENTS),
    marginsMm: v.exactOptional(marginsSchema),
    despeckleLevel: v.exactOptional(v.picklist(SCAN_CLEANUP_DESPECKLE_LEVELS)),
    despeckle: v.exactOptional(v.boolean()),
    autoDewarp: v.exactOptional(v.message(v.boolean(), 'invalid scan-cleanup options')),
    autoDewarpDepth: v.optional(v.pipe(finite,
        v.minValue(SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN),
        v.maxValue(SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX))),
    readingOrder: v.picklist(SCAN_CLEANUP_READING_ORDERS),
    skipBlankPages: v.boolean(),
    pageOverrides: pageOverridesSchema,
    pageOverrideDefaults: pageOverrideDefaultsSchema,
});
const optionsSchema = v.pipe(optionsInputSchema,
    v.check(options => options.marginsMm !== undefined, 'invalid scan-cleanup margins'),
    v.transform(options => {
        const pageOverrides = {...options.pageOverrides};
        attachScanCleanupPageOverrideDefaults(pageOverrides, options.pageOverrideDefaults, options.marginsMm);
        return {
            ...options,
            marginsMm: options.marginsMm!,
            pageOverrides,
        };
    }));
export const SCAN_CLEANUP_OPTIONS_SCHEMA = optionsSchema;

const startRequestShapeSchema = v.pipe(v.object({
    sourcePdfPath: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_PATH_BYTES, 'source PDF path'),
    ownerId: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'owner id'),
    documentRevision: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'document revision'),
    options: optionsSchema,
    sourcePageNumbers: v.exactOptional(v.message(v.pipe(v.unknown(),
        v.check(value => !Array.isArray(value) || value.length <= SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES),
        v.array(sourcePageNumberSchema), v.minLength(1),
        v.check(pages => pages.every((page, index) => index === 0 || page > pages[index - 1]!))),
    'invalid scan-cleanup source page numbers')),
    sourcePageRange: v.exactOptional(v.pipe(v.object({
        startPageNumber: sourcePageNumberSchema,
        endPageNumber: sourcePageNumberSchema,
    }), v.check(range => range.endPageNumber >= range.startPageNumber))),
    detectionResultStoreId: v.exactOptional(ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'detection result store id')),
    outputModeRecommendations: v.exactOptional(normalizedOutputModeRecommendationsSchema),
    softAlphaForegroundRecommendations: v.exactOptional(softAlphaRecommendationsSchema),
    documentPriorByPage: v.exactOptional(documentPriorMapSchema),
    layoutByPage: v.exactOptional(layoutByPageSchema),
    sourcePageMetadataByPage: v.exactOptional(sourceMetadataMapSchema),
    pagePlanEvidenceByPage: v.exactOptional(pagePlanMapSchema),
    placementAnchorsByPage: v.exactOptional(placementAnchorMapSchema),
    placementAnchorSummary: v.exactOptional(SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SCHEMA),
}), v.check(request => !(request.sourcePageNumbers !== undefined && request.sourcePageRange !== undefined)));
export const SCAN_CLEANUP_START_REQUEST_SCHEMA = startRequestShapeSchema;

const previewRequestSchema = v.pipe(v.object({
    requestId: v.message(v.pipe(ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'request id'),
        v.check(value => parseRequestId(value) !== null),
        v.transform(value => parseRequestId(value)!)), 'invalid scan-cleanup preview request id'),
    sourcePdfPath: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_PATH_BYTES, 'source PDF path'),
    ownerId: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'owner id'),
    documentRevision: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'document revision'),
    pageNumber: pageNumberSchema,
    options: optionsSchema,
    documentPrior: v.exactOptional(SCAN_CLEANUP_DOCUMENT_PRIOR_SCHEMA),
    outputModeRecommendation: v.exactOptional(outputModeSchema),
    softAlphaForegroundRecommendation: v.exactOptional(v.boolean()),
    layoutByPage: v.exactOptional(layoutByPageSchema),
    layoutDetectionComplete: v.exactOptional(v.message(v.boolean(), 'invalid scan-cleanup preview request')),
    pagePlanEvidence: v.exactOptional(pagePlanEvidenceSchema),
    placementAnchors: v.exactOptional(placementAnchorsSchema),
    detail: v.exactOptional(v.pipe(v.object({
        viewports: v.strictObject({
            full: v.optional(normalizedRectSchema),
            left: v.optional(normalizedRectSchema),
            right: v.optional(normalizedRectSchema),
        }),
        outputMode: outputModeSchema,
    }), v.check(detail => Object.values(detail.viewports).some(viewport => viewport !== undefined),
        'invalid scan-cleanup detail preview request'))),
    visible: v.exactOptional(v.message(v.boolean(), 'invalid scan-cleanup preview request')),
}), v.check(request => request.pagePlanEvidence === undefined
    || request.pagePlanEvidence.pageNumber === request.pageNumber,
'invalid scan-cleanup page-plan evidence'));
export const SCAN_CLEANUP_PREVIEW_REQUEST_SCHEMA = previewRequestSchema;
const detectionRequestSchema = v.object({
    sourcePdfPath: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_PATH_BYTES, 'source PDF path'),
    ownerId: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'owner id'),
    documentRevision: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'document revision'),
    options: optionsSchema,
});
export const SCAN_CLEANUP_DETECTION_REQUEST_SCHEMA = detectionRequestSchema;
const placementAnchorCalibrationRequestSchema = v.object({
    sourcePdfPath: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_PATH_BYTES, 'source PDF path'),
    ownerId: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'owner id'),
    documentRevision: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'document revision'),
    detectionResultStoreId: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'detection result store id'),
    options: optionsSchema,
    pageNumber: v.exactOptional(pageNumberSchema),
});
export const SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_REQUEST_SCHEMA = placementAnchorCalibrationRequestSchema;
const previewCancelRequestSchema = v.object({
    sourcePdfPath: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_PATH_BYTES, 'source PDF path'),
    ownerId: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'owner id'),
    documentRevision: ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'document revision'),
    invalidateRawCache: v.exactOptional(v.boolean()),
    retainPages: v.exactOptional(v.message(v.pipe(v.unknown(),
        v.check(value => !Array.isArray(value) || value.length <= 16),
        v.array(sourcePageNumberSchema)), 'invalid scan-cleanup retained preview pages')),
});
export const SCAN_CLEANUP_PREVIEW_CANCEL_REQUEST_SCHEMA = previewCancelRequestSchema;
const boundedJobIdSchema = v.message(v.pipe(ownerTextSchema(SCAN_CLEANUP_INPUT_MAX_ID_BYTES, 'job id'),
    v.check(value => parseJobId(value) !== null),
    v.transform(value => parseJobId(value)!)), 'invalid scan-cleanup job id');
const ownedJobArgsSchema = v.strictTuple([
    boundedJobIdSchema,
    ownerContextSchema,
]);
export const SCAN_CLEANUP_OWNED_JOB_ARGS_SCHEMA = ownedJobArgsSchema;
export const SCAN_CLEANUP_START_ARGS_SCHEMA = v.strictTuple([startRequestShapeSchema]);
export const SCAN_CLEANUP_PREVIEW_ARGS_SCHEMA = v.strictTuple([previewRequestSchema]);
export const SCAN_CLEANUP_DETECTION_ARGS_SCHEMA = v.strictTuple([detectionRequestSchema]);
export const SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_ARGS_SCHEMA = v.strictTuple([placementAnchorCalibrationRequestSchema]);
export const SCAN_CLEANUP_PREVIEW_CANCEL_ARGS_SCHEMA = v.strictTuple([previewCancelRequestSchema]);

// Accumulate page, zone, and vertex budgets across the nested preference payload.
export function decodeScanCleanupPageOverride(value: unknown, budget = createScanCleanupInputBudget()) {
    const parsed = v.parse(pageOverrideShapeSchema, value, {abortEarly: true});
    const polygons = [
        ...(parsed.manualZones?.picture.map(zone => zone.polygon) ?? []),
        ...(parsed.manualZones?.fill ?? []),
    ];
    consumeScanCleanupZones(budget, polygons.length, 'manual zones');
    const vertices = polygons.reduce((count, polygon) => count + polygon.points.length, 0);
    if (vertices > SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_PAGE) throw new Error('too many scan-cleanup manual-zone vertices on one page');
    consumeScanCleanupVertices(budget, vertices, 'manual-zone vertices');
    return parsed;
}

export function decodeScanCleanupPageOverrides(value: unknown, budget = createScanCleanupInputBudget()) {
    const parsed = v.parse(pageOverridesSchema, value, {abortEarly: true});
    consumeScanCleanupPages(budget, Object.keys(parsed).length, 'page overrides');
    for (const override of Object.values(parsed)) {
        const polygons = [
            ...(override.manualZones?.picture.map(zone => zone.polygon) ?? []),
            ...(override.manualZones?.fill ?? []),
        ];
        consumeScanCleanupZones(budget, polygons.length, 'manual zones');
        const vertices = polygons.reduce((count, polygon) => count + polygon.points.length, 0);
        if (vertices > SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_PAGE) throw new Error('too many scan-cleanup manual-zone vertices on one page');
        consumeScanCleanupVertices(budget, vertices, 'manual-zone vertices');
    }
    return parsed;
}

export type TScanCleanupOwnerContext = v.InferOutput<typeof ownerContextSchema>;
export type TScanCleanupStartRequest = v.InferOutput<typeof startRequestShapeSchema>;
export type TScanCleanupPreviewRequest = v.InferOutput<typeof previewRequestSchema>;
export type TScanCleanupDetectionRequest = v.InferOutput<typeof detectionRequestSchema>;
export type TScanCleanupPlacementAnchorCalibrationRequest = v.InferOutput<typeof placementAnchorCalibrationRequestSchema>;
export type TScanCleanupPreviewCancelRequest = v.InferOutput<typeof previewCancelRequestSchema>;
export type TScanCleanupPlacementAnchor = v.InferOutput<typeof placementAnchorSchema>;
