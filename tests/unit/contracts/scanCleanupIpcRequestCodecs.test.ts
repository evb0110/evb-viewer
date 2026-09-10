import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodeDetectionArgs,
    decodeDocumentPrior,
    decodeOwnedJobId,
    decodePreviewArgs,
    decodeScanCleanupPageOverrides,
    decodeSourcePageMetadata,
    decodeStartArgs,
} from '@contracts/scan-cleanup/ipcRequestCodecs';
import {
    createScanCleanupInputBudget,
    SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
    SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES,
    SCAN_CLEANUP_INPUT_MAX_PATH_BYTES,
    SCAN_CLEANUP_INPUT_MAX_VERTICES,
    SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_POLYGON,
    SCAN_CLEANUP_INPUT_MAX_ZONES,
    SCAN_CLEANUP_INPUT_MAX_ZONES_PER_PAGE,
    SCAN_CLEANUP_LEGACY_STORAGE_MAX_BYTES,
} from '@contracts/scan-cleanup/inputLimits';
import {
    decodeScanCleanupSettingsReadRequest,
    decodeScanCleanupSettingsUpdateRequest,
} from '@contracts/scanCleanupSettings';

const request = {
    sourcePdfPath: '/tmp/source.pdf',
    ownerId: 'owner-1',
    documentRevision: 'revision-1',
    options: {
        preserveOriginalQuality: false,
        layoutMode: 'auto',
        outputMode: 'bw',
        readingOrder: 'ltr',
        thickness: 0,
        crop: true,
        matchPageSize: true,
        pageAlignment: 'top-center',
        marginsMm: {
            leftMm: 5,
            topMm: 5,
            rightMm: 5,
            bottomMm: 5,
        },
        despeckle: true,
        skipBlankPages: false,
        pageOverrides: {},
    },
    layoutByPage: {'12': 'single-uncut-page'},
    pagePlanEvidenceByPage: {'12': {
        pageNumber: 12,
        rotationDegrees: 0,
        layoutClassification: 'single-uncut-page',
        automaticSplit: {
            xNormalized: 0.48,
            rotationDegrees: 0,
        },
        outputs: {full: {
            contentBox: {
                xNormalized: 0.1,
                yNormalized: 0.2,
                widthNormalized: 0.7,
                heightNormalized: 0.6,
                rotationDegrees: 0,
            },
            detectedSkewDegrees: -0.2,
            textToneDiagnostics: {
                applied: true,
                rule: 'applied',
                textLineCount: 24,
                textInkPixels: 12_400,
                pictureFraction: 0,
                outsideMidtoneFraction: 0.04,
                outsideMidtoneLargestComponentFraction: 0.002,
                outsideMidtoneLargestComponentWidthFraction: 0.9,
                outsideMidtoneLargestComponentHeightFraction: 0.01,
                inkAnchor: 133,
                blackPoint: 96.05263157894737,
                slope: 1.623931623931624,
            },
        }},
    }},
};

const triangle = {
    points: [
        {
            xNormalized: 0.1,
            yNormalized: 0.1,
        },
        {
            xNormalized: 0.9,
            yNormalized: 0.1,
        },
        {
            xNormalized: 0.5,
            yNormalized: 0.9,
        },
    ],
    rotationDegrees: 0,
};

function pageOverride(manualZones: unknown = undefined) {
    return {
        rotationDegrees: 0,
        layoutOverride: 'auto',
        excluded: false,
        manualSplit: null,
        ...(manualZones === undefined ? {} : {manualZones}),
    };
}

function requestWithOverrides(pageOverrides: Record<string, unknown>) {
    return {
        ...request,
        options: {
            ...request.options,
            pageOverrides,
        },
    };
}

describe('scan-cleanup IPC request codecs', () => {
    it('decodes a detected page plan on preview requests', () => {
        const pagePlanEvidence = request.pagePlanEvidenceByPage['12'];
        const decoded = decodePreviewArgs([{
            ...request,
            requestId: 'preview-12',
            pageNumber: 12,
            layoutDetectionComplete: true,
            pagePlanEvidence,
        }])[0];
        expect(decoded.pagePlanEvidence).toEqual(pagePlanEvidence);
        expect(decoded.layoutDetectionComplete).toBe(true);
        expect(() => decodePreviewArgs([{
            ...request,
            requestId: 'preview-12',
            pageNumber: 11,
            pagePlanEvidence,
        }])).toThrow('page-plan evidence');
        expect(() => decodePreviewArgs([{
            ...request,
            requestId: 'preview-12',
            pageNumber: 12,
            layoutDetectionComplete: 'yes',
        }])).toThrow('preview request');
    });

    it('decodes typed automatic page-plan evidence', () => {
        expect(decodeStartArgs([request])[0].pagePlanEvidenceByPage).toEqual(
            request.pagePlanEvidenceByPage,
        );
    });

    it('rejects string and unsafe numeric source metadata instead of coercing it', () => {
        const metadata = {
            pageNumber: 12,
            xPoints: 0,
            yPoints: 0,
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0,
        };
        expect(() => decodeSourcePageMetadata({
            ...metadata,
            rotation: '90',
        })).toThrow('source page metadata');
        expect(() => decodeSourcePageMetadata({
            ...metadata,
            widthPoints: Number.MAX_SAFE_INTEGER + 1,
        })).toThrow('source page metadata');
    });

    it('rejects unsafe finite document-prior dimensions and medians', () => {
        const validPrior = () => ({
            dominantLayout: 'single-uncut-page' as const,
            cutterRatioMedian: null,
            clusterDims: {
                widthPx: 1_000,
                heightPx: 2_000,
            },
            agreementStrength: 0.8,
            strokeWidthMedianPx: 2,
            xHeightMedianPx: 12,
        });
        const unsafePriors = [
            {
                ...validPrior(),
                clusterDims: {
                    ...validPrior().clusterDims,
                    widthPx: Number.MAX_SAFE_INTEGER + 1,
                },
            },
            {
                ...validPrior(),
                clusterDims: {
                    ...validPrior().clusterDims,
                    heightPx: Number.MAX_SAFE_INTEGER + 1,
                },
            },
            {
                ...validPrior(),
                strokeWidthMedianPx: Number.MAX_SAFE_INTEGER + 1,
            },
            {
                ...validPrior(),
                xHeightMedianPx: Number.MAX_SAFE_INTEGER + 1,
            },
        ];
        for (const unsafePrior of unsafePriors) {
            expect(() => decodeDocumentPrior(unsafePrior)).toThrow('document prior');
        }
    });

    it('rejects non-numeric rotations in page plans, overrides, and nested geometry', () => {
        for (const rotationDegrees of [
            '0',
            null,
        ]) {
            expect(() => decodeStartArgs([{
                ...request,
                pagePlanEvidenceByPage: {'12': {
                    ...request.pagePlanEvidenceByPage['12'],
                    rotationDegrees,
                    automaticSplit: undefined,
                    outputs: {full: {detectedSkewDegrees: 0}},
                }},
            }])).toThrow('page-plan evidence');

            expect(() => decodeStartArgs([requestWithOverrides({'12': {
                ...pageOverride(),
                rotationDegrees,
            }})])).toThrow('page override');

            expect(() => decodeStartArgs([{
                ...request,
                pagePlanEvidenceByPage: {'12': {
                    ...request.pagePlanEvidenceByPage['12'],
                    automaticSplit: {
                        ...request.pagePlanEvidenceByPage['12'].automaticSplit,
                        rotationDegrees,
                    },
                }},
            }])).toThrow('automatic split rotation');
        }
    });

    it('rejects manual split positions outside the safe cutter interval', () => {
        for (const xNormalized of [0, 0.019, 0.981, 1]) {
            expect(() => decodeStartArgs([requestWithOverrides({'12': {
                ...pageOverride(),
                manualSplit: {xNormalized, rotationDegrees: 0},
            }})])).toThrow('safe cutter interval');
        }
        for (const xNormalized of [0.02, 0.5, 0.98]) {
            expect(() => decodeStartArgs([requestWithOverrides({'12': {
                ...pageOverride(),
                manualSplit: {xNormalized, rotationDegrees: 0},
            }})])).not.toThrow();
        }
    });

    it('carries one scalar page override default beside sparse page entries', () => {
        const pageOverrideDefaults = {
            rotationDegrees: 90,
            layoutOverride: 'auto',
            excluded: true,
            manualSplit: null,
        } as const;
        const decoded = decodeStartArgs([{
            ...request,
            options: {
                ...request.options,
                pageOverrideDefaults,
            },
        }])[0];

        expect(decoded.options.pageOverrideDefaults).toEqual(pageOverrideDefaults);
        expect(decoded.options.pageOverrides).toEqual({});
    });

    it('decodes resolved ink placement anchors on preview and start requests', () => {
        const placementAnchors = {
            left: {yNormalized: 0.08},
            right: {yNormalized: 0.12},
        };
        expect(decodePreviewArgs([{
            ...request,
            requestId: 'preview-12',
            pageNumber: 12,
            placementAnchors,
        }])[0].placementAnchors).toEqual(placementAnchors);
        expect(decodeStartArgs([{
            ...request,
            placementAnchorsByPage: {'12': placementAnchors},
        }])[0].placementAnchorsByPage).toEqual({'12': placementAnchors});
        expect(decodePreviewArgs([{
            ...request,
            requestId: 'preview-12',
            pageNumber: 12,
        }])[0].placementAnchors).toBeUndefined();
        expect(decodeStartArgs([request])[0].placementAnchorsByPage).toBeUndefined();
    });

    it('decodes a bounded document-wide ink placement summary', () => {
        const placementAnchorSummary = {
            schemaVersion: 1 as const,
            sampleCount: 20_001,
            referenceHeightPoints: 792,
            toleranceNormalized: 0.014,
            topEdgeNormalized: 0.1,
            clusters: [{
                startNormalized: 0.1,
                endNormalized: 0.101,
                valueNormalized: 0.1005,
            }],
            samples: [
                {
                    pageNumber: 1,
                    half: 'full' as const,
                    yNormalized: 0.1,
                    anchor: {yNormalized: 0},
                },
                {
                    pageNumber: 10_001,
                    half: 'full' as const,
                    yNormalized: 0.3,
                    anchor: {yNormalized: 0.2},
                },
                {
                    pageNumber: 20_001,
                    half: 'full' as const,
                    yNormalized: 0.2,
                    anchor: {yNormalized: 0.1},
                },
            ],
        };
        expect(decodeStartArgs([{
            ...request,
            placementAnchorSummary,
        }])[0].placementAnchorSummary).toEqual(placementAnchorSummary);
        for (const malformed of [
            {
                ...placementAnchorSummary,
                schemaVersion: 2,
            },
            {
                ...placementAnchorSummary,
                topEdgeNormalized: 2,
            },
            {
                ...placementAnchorSummary,
                clusters: Array.from({length: 257}, () => placementAnchorSummary.clusters[0]),
            },
            {
                ...placementAnchorSummary,
                samples: [{
                    ...placementAnchorSummary.samples[0],
                    anchor: {yNormalized: Number.NaN},
                }],
            },
        ]) {
            expect(() => decodeStartArgs([{
                ...request,
                placementAnchorSummary: malformed,
            }])).toThrow('placement anchor summary');
        }
    });

    it('rejects placement anchors that are unbounded, mistyped, or carry extra keys', () => {
        const anchor = {yNormalized: 0.5};
        for (const placementAnchors of [
            {full: {yNormalized: 1.5}},
            {full: {yNormalized: Number.NaN}},
            {full: {
                ...anchor,
                xNormalized: 0.5,
            }},
            {full: {}},
            {middle: anchor},
            {full: 0.5},
            [anchor],
        ]) {
            expect(() => decodePreviewArgs([{
                ...request,
                requestId: 'preview-12',
                pageNumber: 12,
                placementAnchors,
            }])).toThrow();
            expect(() => decodeStartArgs([{
                ...request,
                placementAnchorsByPage: {'12': placementAnchors},
            }])).toThrow();
        }
        expect(() => decodeStartArgs([{
            ...request,
            placementAnchorsByPage: {'0': {full: anchor}},
        }])).toThrow('placement anchor map');
    });

    it('rejects stale-key and out-of-bounds automatic evidence', () => {
        expect(() => decodeStartArgs([{
            ...request,
            pagePlanEvidenceByPage: {'11': request.pagePlanEvidenceByPage['12']},
        }])).toThrow('page-plan evidence');
        expect(() => decodeStartArgs([{
            ...request,
            pagePlanEvidenceByPage: {'12': {
                ...request.pagePlanEvidenceByPage['12'],
                outputs: {full: {contentBox: {
                    ...request.pagePlanEvidenceByPage['12'].outputs.full.contentBox,
                    widthNormalized: 1,
                }}},
            }},
        }])).toThrow('content box');
        expect(() => decodeStartArgs([{
            ...request,
            pagePlanEvidenceByPage: {'12': {
                ...request.pagePlanEvidenceByPage['12'],
                automaticSplit: {
                    xNormalized: 1.2,
                    rotationDegrees: 0,
                },
            }},
        }])).toThrow('automatic split');
    });

    it('rejects incomplete or internally inconsistent text-tone evidence', () => {
        const evidence = request.pagePlanEvidenceByPage['12'].outputs.full.textToneDiagnostics;
        expect(() => decodeStartArgs([{
            ...request,
            pagePlanEvidenceByPage: {'12': {
                ...request.pagePlanEvidenceByPage['12'],
                outputs: {full: {
                    ...request.pagePlanEvidenceByPage['12'].outputs.full,
                    textToneDiagnostics: {
                        ...evidence,
                        outsideMidtoneLargestComponentHeightFraction: 1.1,
                    },
                }},
            }},
        }])).toThrow('text tone');
        expect(() => decodeStartArgs([{
            ...request,
            pagePlanEvidenceByPage: {'12': {
                ...request.pagePlanEvidenceByPage['12'],
                outputs: {full: {
                    ...request.pagePlanEvidenceByPage['12'].outputs.full,
                    textToneDiagnostics: {
                        ...evidence,
                        applied: false,
                    },
                }},
            }},
        }])).toThrow('text tone');
    });

    it('allows high page numbers while keeping page-key validation canonical', () => {
        const highPageKey = String(SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES + 1);
        expect(decodeStartArgs([requestWithOverrides({[highPageKey]: pageOverride()})])[0]
            .options.pageOverrides).toHaveProperty(highPageKey);
        expect(decodeStartArgs([{
            ...request,
            layoutByPage: {[highPageKey]: 'single-uncut-page'},
            sourcePageNumbers: [SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES + 1],
        }])[0].sourcePageNumbers).toEqual([SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES + 1]);
        expect(decodeStartArgs([{
            ...request,
            sourcePageRange: {
                startPageNumber: SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES + 1,
                endPageNumber: SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES + 1,
            },
        }])[0].sourcePageRange).toEqual({
            startPageNumber: SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES + 1,
            endPageNumber: SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES + 1,
        });
    });

    it('rejects malformed page keys across page-indexed payloads', () => {
        for (const key of [
            '01',
            String(Number.MAX_SAFE_INTEGER + 1),
        ]) {
            expect(() => decodeStartArgs([requestWithOverrides({[key]: pageOverride()})]))
                .toThrow('page override number');
            expect(() => decodeStartArgs([{
                ...request,
                layoutByPage: {[key]: 'single-uncut-page'},
            }])).toThrow('layout classifications');
        }
    });

    it('reuses deep override validation for start, preview, detection, and settings updates', () => {
        const invalidOptions = {
            ...request.options,
            pageOverrides: {'01': pageOverride()},
        };
        const preview = {
            ...request,
            requestId: 'preview-1',
            pageNumber: 1,
            options: invalidOptions,
        };
        const detection = {
            sourcePdfPath: request.sourcePdfPath,
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            options: invalidOptions,
        };

        expect(() => decodeStartArgs([{
            ...request,
            options: invalidOptions,
        }]))
            .toThrow('page override number');
        expect(() => decodePreviewArgs([preview])).toThrow('page override number');
        expect(() => decodeDetectionArgs([detection])).toThrow('page override number');
        expect(() => decodeScanCleanupSettingsUpdateRequest({document: {
            sourceSha256: 'a'.repeat(64),
            patch: {overrides: invalidOptions.pageOverrides},
        }})).toThrow('page override number');
    });

    it('bounds and NUL-rejects paths, revisions, owner IDs, request IDs, and job IDs', () => {
        const preview = {
            ...request,
            requestId: 'preview-1',
            pageNumber: 1,
        };
        const detection = {
            sourcePdfPath: request.sourcePdfPath,
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            options: request.options,
        };
        expect(() => decodePreviewArgs([{
            ...preview,
            requestId: 'x'.repeat(SCAN_CLEANUP_INPUT_MAX_ID_BYTES + 1),
        }])).toThrow('request id');
        expect(() => decodePreviewArgs([{
            ...preview,
            ownerId: 'owner\0suffix',
        }])).toThrow('owner id');
        expect(() => decodeDetectionArgs([{
            ...detection,
            documentRevision: 'revision\0suffix',
        }])).toThrow('document revision');
        expect(() => decodeStartArgs([{
            ...request,
            sourcePdfPath: `/${'x'.repeat(SCAN_CLEANUP_INPUT_MAX_PATH_BYTES)}`,
        }])).toThrow('source PDF path');
        expect(() => decodeOwnedJobId([
            'job\0suffix',
            {
                ownerId: 'owner',
                documentRevision: 'revision',
            },
        ])).toThrow('job id');
    });

    it('accepts convex, concave, and either-winding simple polygons', () => {
        const concavePoints = [
            {
                xNormalized: 0.1,
                yNormalized: 0.1,
            },
            {
                xNormalized: 0.9,
                yNormalized: 0.1,
            },
            {
                xNormalized: 0.5,
                yNormalized: 0.5,
            },
            {
                xNormalized: 0.9,
                yNormalized: 0.9,
            },
            {
                xNormalized: 0.1,
                yNormalized: 0.9,
            },
        ];
        for (const points of [
            triangle.points,
            [...triangle.points].reverse(),
            concavePoints,
        ]) {
            expect(() => decodeStartArgs([requestWithOverrides({'1': pageOverride({
                picture: [],
                fill: [{
                    points,
                    rotationDegrees: 0,
                }],
            })})])).not.toThrow();
        }
    });

    it('rejects duplicate, degenerate, intersecting, and overlapping polygons', () => {
        const invalidPolygons = [
            [
                triangle.points[0],
                triangle.points[1],
                triangle.points[0],
            ],
            [
                {
                    xNormalized: 0,
                    yNormalized: 0,
                },
                {
                    xNormalized: 1,
                    yNormalized: 0,
                },
                {
                    xNormalized: 1,
                    yNormalized: 1e-13,
                },
            ],
            [
                {
                    xNormalized: 0,
                    yNormalized: 0,
                },
                {
                    xNormalized: 1,
                    yNormalized: 1,
                },
                {
                    xNormalized: 0,
                    yNormalized: 1,
                },
                {
                    xNormalized: 0.8,
                    yNormalized: 0,
                },
            ],
            [
                {
                    xNormalized: 0,
                    yNormalized: 0,
                },
                {
                    xNormalized: 1,
                    yNormalized: 0,
                },
                {
                    xNormalized: 1,
                    yNormalized: 1,
                },
                {
                    xNormalized: 0.25,
                    yNormalized: 1,
                },
                {
                    xNormalized: 0.25,
                    yNormalized: 0,
                },
                {
                    xNormalized: 0.75,
                    yNormalized: 0,
                },
                {
                    xNormalized: 0.75,
                    yNormalized: 0.75,
                },
                {
                    xNormalized: 0,
                    yNormalized: 0.75,
                },
            ],
        ];
        for (const points of invalidPolygons) {
            expect(() => decodeStartArgs([requestWithOverrides({'1': pageOverride({
                picture: [],
                fill: [{
                    points,
                    rotationDegrees: 0,
                }],
            })})])).toThrow(/duplicate|near-zero|intersecting|overlapping/u);
        }
    });

    it('applies zone, vertex, and legacy-storage caps at settings IPC boundaries', () => {
        expect(() => decodeScanCleanupSettingsUpdateRequest({document: {
            sourceSha256: 'a'.repeat(64),
            patch: {overrides: {'1': pageOverride({
                picture: [],
                fill: Array.from({length: SCAN_CLEANUP_INPUT_MAX_ZONES_PER_PAGE + 1}, () => triangle),
            })}},
        }})).toThrow('too many scan-cleanup manual zones');
        const tooManyVertices = Array.from({length: SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_POLYGON + 1}, (_unused, index) => {
            const radians = index * Math.PI * 2 / (SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_POLYGON + 1);
            return {
                xNormalized: 0.5 + 0.4 * Math.cos(radians),
                yNormalized: 0.5 + 0.4 * Math.sin(radians),
            };
        });
        expect(() => decodeScanCleanupSettingsUpdateRequest({document: {
            sourceSha256: 'a'.repeat(64),
            patch: {overrides: {'1': pageOverride({
                picture: [],
                fill: [{
                    points: tooManyVertices,
                    rotationDegrees: 0,
                }],
            })}},
        }})).toThrow('fill zone');
        expect(() => decodeScanCleanupSettingsReadRequest({legacyStorage: {
            settingsRaw: 'x'.repeat(SCAN_CLEANUP_LEGACY_STORAGE_MAX_BYTES + 1),
            documentOverridesRaw: null,
        }})).toThrow('byte limit');
    });

    it('enforces aggregate page, zone, and vertex budgets across decoded overrides', () => {
        const pageBudget = createScanCleanupInputBudget();
        pageBudget.pages = SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES;
        expect(() => decodeScanCleanupPageOverrides({'1': pageOverride()}, pageBudget))
            .toThrow('too many scan-cleanup page overrides');

        const zoneBudget = createScanCleanupInputBudget();
        zoneBudget.zones = SCAN_CLEANUP_INPUT_MAX_ZONES;
        expect(() => decodeScanCleanupPageOverrides({'1': pageOverride({
            picture: [],
            fill: [triangle],
        })}, zoneBudget)).toThrow('too many scan-cleanup manual zones');

        const vertexBudget = createScanCleanupInputBudget();
        vertexBudget.vertices = SCAN_CLEANUP_INPUT_MAX_VERTICES - 2;
        expect(() => decodeScanCleanupPageOverrides({'1': pageOverride({
            picture: [],
            fill: [triangle],
        })}, vertexBudget)).toThrow('too many scan-cleanup manual-zone vertices');
    });
});
