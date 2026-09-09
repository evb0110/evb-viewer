import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {
    existsSync,
    realpathSync,
} from 'node:fs';
import type * as nodeFs from 'fs';
import type {
    INativeScanCleanupManifestV3,
    INativeScanCleanupOutputV3,
    IScanCleanupNormalizedZonePolygon,
    IScanCleanupOptions,
    TNativeScanCleanupOperation,
    TNativeScanCleanupRenderMode,
    TScanCleanupCanvasScope,
} from '@contracts/electronApiScanCleanup';
import {
    buildGeometryOnlyNativeScanCleanupManifest,
    buildRunnableNativeScanCleanupManifest,
    serializeNativeScanCleanupOptions,
    type IScanCleanupManifestPageInput,
} from '@evb/scan-cleanup/core/policy/buildNativeScanCleanupManifest';
import {assertNativeScanCleanupManifestGeometry} from '@evb/scan-cleanup/core/policy/assertNativeScanCleanupManifestGeometry';
import {assertScanCleanupPathWithinCanonicalRoot} from '@evb/scan-cleanup/core/assertScanCleanupPathWithinRoot';
import {resolveEffectiveScanCleanupOptions} from '@evb/scan-cleanup/core/policy/effectiveOptions';
import {ScanCleanupContractError} from '@evb/scan-cleanup/core/errors';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const {realpathSyncCalls} = vi.hoisted(() => ({realpathSyncCalls: [] as string[]}));

// The builder resolves paths through `fs`, and a spy cannot be installed on an
// ESM namespace. Recording the real implementation's arguments is what makes
// "the root is canonicalized once per manifest" observable.
vi.mock('fs', async importOriginal => {
    const actual = await importOriginal<typeof nodeFs>();
    const realpathSync = (...args: Parameters<typeof actual.realpathSync>) => {
        realpathSyncCalls.push(String(args[0]));
        return actual.realpathSync(...args);
    };
    return {
        ...actual,
        realpathSync: Object.assign(realpathSync, actual.realpathSync),
    };
});

const fixtureDirectory = resolve('native/scan-cleanup/tests/fixtures/protocol');

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'auto',
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
    readingOrder: 'ltr',
    skipBlankPages: false,
    pageOverrides: {},
};

interface IGoldenCase {
    name: string;
    operation: TNativeScanCleanupOperation;
    renderMode: TNativeScanCleanupRenderMode;
    canvasScope: TScanCleanupCanvasScope;
    qualityPath: 'raster' | 'lossless';
    withOutput: boolean;
}

const cases: IGoldenCase[] = [
    {
        name: 'preview-raster-v3.json',
        operation: 'render',
        renderMode: 'preview',
        canvasScope: 'page',
        qualityPath: 'raster',
        withOutput: true,
    },
    {
        name: 'detect-all-v3.json',
        operation: 'analyze',
        renderMode: 'preview',
        canvasScope: 'page',
        qualityPath: 'raster',
        withOutput: false,
    },
    {
        name: 'raster-final-v3.json',
        operation: 'render',
        renderMode: 'final',
        canvasScope: 'document',
        qualityPath: 'raster',
        withOutput: true,
    },
    {
        name: 'lossless-final-v3.json',
        operation: 'analyze',
        renderMode: 'final',
        canvasScope: 'document',
        qualityPath: 'lossless',
        withOutput: false,
    },
];

describe('native scan-cleanup manifest builder', () => {
    it('keeps manual crops out of automatic page-plan evidence but retains them for rendering', () => {
        const manualContentBoxes = {right: {
            xNormalized: 0.55,
            yNormalized: 0.1,
            widthNormalized: 0.35,
            heightNormalized: 0.8,
            rotationDegrees: 0 as const,
        }};
        const optionsWithManualCrop: IScanCleanupOptions = {
            ...options,
            pageOverrides: {'1': {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
                manualContentBoxes,
            }},
        };
        const page = {
            inputPath: '/fixtures/input/page-1.png',
            pageNumber: 1,
            dpi: 150,
            pageMetadataPath: '/fixtures/output/page-1.json',
        };
        const pagePlan = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'analyze',
            analysisPurpose: 'page-plan',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: 'raster',
            options: optionsWithManualCrop,
            pages: [page],
        });
        const preview = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: 'raster',
            options: optionsWithManualCrop,
            pages: [{
                ...page,
                outputs: [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                }],
            }],
        });

        expect(pagePlan.pages[0]?.options.manualContentBoxes).toEqual({});
        expect(preview.pages[0]?.options.manualContentBoxes).toEqual(manualContentBoxes);
    });

    it('preflights a heterogeneous 392-page geometry ledger and names the exact bad page', () => {
        const rotations = [
            0,
            90,
            180,
            270,
        ] as const;
        const pageOverrides = Object.fromEntries(Array.from({length: 392}, (_, index) => {
            const pageNumber = index + 1;
            return [
                String(pageNumber),
                {
                    rotationDegrees: rotations[index % rotations.length]!,
                    layoutOverride: 'auto' as const,
                    excluded: false,
                    manualSplit: null,
                },
            ];
        }));
        const manifest = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options: {
                ...options,
                pageOverrides,
            },
            pages: Array.from({length: 392}, (_, index) => {
                const pageNumber = index + 1;
                const rotationDegrees = rotations[index % rotations.length]!;
                const xNormalized = (index % 7) / 100;
                const yNormalized = (index % 11) / 100;
                return {
                    inputPath: `/fixtures/input/page-${String(pageNumber)}.png`,
                    pageNumber,
                    dpi: 300,
                    automaticContentBoxes: {full: {
                        xNormalized,
                        yNormalized,
                        widthNormalized: 1 - xNormalized,
                        heightNormalized: 1 - yNormalized,
                        rotationDegrees,
                    }},
                    pageMetadataPath: `/fixtures/output/page-${String(pageNumber)}.json`,
                };
            }),
        });

        expect(() => assertNativeScanCleanupManifestGeometry(manifest)).not.toThrow();
        manifest.pages[336]!.options.automaticContentBoxes = {right: {
            xNormalized: 0.72,
            yNormalized: 0.1,
            widthNormalized: 0.29,
            heightNormalized: 0.8,
            rotationDegrees: manifest.pages[336]!.options.rotationDegrees,
        }};
        expect(() => assertNativeScanCleanupManifestGeometry(manifest))
            .toThrow('Scan cleanup page 337 has invalid automatic right content box geometry');
    });

    it('derives native layout and output mode from reusable detection evidence', () => {
        const manifest = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: 'raster',
            options,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 150,
                observedLayout: 'single-uncut-page',
                resolvedOutputMode: 'bw',
                pageMetadataPath: '/fixtures/output/page-1.json',
            }],
        });

        expect(manifest.pages[0]?.options).toMatchObject({
            layout: 'force-single',
            outputMode: 'bw',
        });
    });

    it('clamps trusted native pixel limits to the engine guardrails', () => {
        const manifest = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                resolvedOptions: {
                    maxPixels: Number.MAX_SAFE_INTEGER,
                    maxDimensionPx: Number.MAX_SAFE_INTEGER,
                },
            }],
        });

        expect(manifest.pages[0]?.options).toMatchObject({
            maxPixels: 160_000_000,
            maxDimensionPx: 40_000,
        });
        expect(() => buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                resolvedOptions: {maxPixels: Number.NaN},
            }],
        })).toThrow(ScanCleanupContractError);
    });

    it('rejects a soft-alpha output plane without a base layer', () => {
        expect(() => buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                outputs: [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                    foregroundAlphaOutputPath: '/fixtures/output/page-1-alpha.pgm',
                }],
            }],
        })).toThrow(ScanCleanupContractError);
    });

    it.each(cases)('matches the shared $name golden', async testCase => {
        const golden = JSON.parse(await readFile(resolve(fixtureDirectory, testCase.name), 'utf8')) as INativeScanCleanupManifestV3;
        const manifest = buildGeometryOnlyNativeScanCleanupManifest({
            operation: testCase.operation,
            renderMode: testCase.renderMode,
            canvasScope: testCase.canvasScope,
            ...(testCase.operation === 'render' && testCase.canvasScope === 'document'
                ? {documentCanvas: {
                    widthPx: 2_550,
                    heightPx: 3_300,
                    widthPoints: 612,
                    heightPoints: 792,
                }}
                : {}),
            qualityPath: testCase.qualityPath,
            ...(testCase.name === 'raster-final-v3.json'
                ? {documentCanvas: {
                    widthPoints: 612,
                    heightPoints: 792,
                    widthPx: 2_550,
                    heightPx: 3_300,
                }}
                : {}),
            options: testCase.name === 'preview-raster-v3.json'
                ? {
                    ...options,
                    matchPageSize: false,
                }
                : options,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 300,
                ...(testCase.name === 'preview-raster-v3.json'
                    ? {renderCrop: {
                        xNormalized: 0.25,
                        yNormalized: 0.2,
                        widthNormalized: 0.5,
                        heightNormalized: 0.4,
                        rotationDegrees: 0 as const,
                    }}
                    : {}),
                pageMetadataPath: '/fixtures/output/page-1.json',
                outputs: testCase.withOutput ? [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                    ...(testCase.renderMode === 'final'
                        ? {
                            bilevelOutputPath: '/fixtures/output/page-1.pbm',
                            backgroundOutputPath: '/fixtures/output/page-1-background.png',
                            foregroundMaskOutputPath: '/fixtures/output/page-1-mask.pbm',
                        }
                        : {}),
                }] : [],
            }],
        });
        expect(manifest).toEqual(golden);
    });

    it('omits additive option keys when they only repeat legacy-derived defaults', () => {
        for (const despeckle of [
            false,
            true,
        ]) {
            const manifest = buildGeometryOnlyNativeScanCleanupManifest({
                operation: 'analyze',
                renderMode: 'preview',
                canvasScope: 'page',
                qualityPath: 'raster',
                options: {
                    ...options,
                    despeckle,
                },
                pages: [{
                    inputPath: '/fixtures/input/page-1.png',
                    pageNumber: 1,
                    dpi: 300,
                    pageMetadataPath: '/fixtures/output/page-1.json',
                }],
            });

            expect(manifest.pages[0]?.options).not.toHaveProperty('despeckleLevel');
            expect(manifest.pages[0]?.options).not.toHaveProperty('manualZones');
        }
    });

    it('includes additive option keys when they carry new behavior', () => {
        const polygon: IScanCleanupNormalizedZonePolygon = {
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
                    xNormalized: 0.9,
                    yNormalized: 0.9,
                },
            ],
            rotationDegrees: 0,
        };
        const effective = resolveEffectiveScanCleanupOptions({
            options: {
                ...options,
                outputMode: 'mixed',
                pageOverrides: {'1': {
                    rotationDegrees: 0,
                    layoutOverride: 'auto',
                    excluded: false,
                    manualSplit: null,
                    manualZones: {
                        picture: [],
                        fill: [polygon],
                    },
                }},
            },
            pageOverride: {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
                manualSkewDegrees: -2.3,
                manualZones: {
                    picture: [],
                    fill: [polygon],
                },
            },
            dpi: 300,
            qualityPath: 'raster',
            experimental: {
                autoDewarp: true,
                autoDewarpDepth: 1.8,
            },
        });
        const serialized = serializeNativeScanCleanupOptions({
            ...effective,
            despeckleLevel: 'aggressive',
        });

        expect(serialized.despeckleLevel).toBe('aggressive');
        expect(serialized.manualZones).toEqual({
            picture: [],
            fill: [polygon],
        });
        expect(serialized.outputMode).toBe('mixed');
        expect(serialized.manualSkewDegrees).toBe(-2.3);
        expect(serialized.experimental.autoDewarpDepth).toBe(1.8);
    });

    it('matches the populated shared manifest golden', async () => {
        const picturePolygon: IScanCleanupNormalizedZonePolygon = {
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
                    xNormalized: 0.9,
                    yNormalized: 0.9,
                },
            ],
            rotationDegrees: 0,
        };
        const fillPolygon: IScanCleanupNormalizedZonePolygon = {
            points: [
                {
                    xNormalized: 0.2,
                    yNormalized: 0.2,
                },
                {
                    xNormalized: 0.4,
                    yNormalized: 0.2,
                },
                {
                    xNormalized: 0.4,
                    yNormalized: 0.4,
                },
            ],
            rotationDegrees: 0,
        };
        const populatedOptions: IScanCleanupOptions = {
            ...options,
            outputMode: 'mixed',
            pageOverrides: {'1': {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
                manualZones: {
                    picture: [{
                        polygon: picturePolygon,
                        layer: 'painter2',
                    }],
                    fill: [fillPolygon],
                },
            }},
        };
        const manifest = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            documentCanvas: {
                widthPoints: 420.25,
                heightPoints: 612.5,
                widthPx: 1751,
                heightPx: 2552,
            },
            options: populatedOptions,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                outputs: [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                    bilevelOutputPath: '/fixtures/output/page-1.pbm',
                    backgroundOutputPath: '/fixtures/output/page-1-background.png',
                    foregroundMaskOutputPath: '/fixtures/output/page-1-mask.pbm',
                }],
            }],
        });
        manifest.pages[0]!.options = serializeNativeScanCleanupOptions({
            ...resolveEffectiveScanCleanupOptions({
                options: populatedOptions,
                pageOverride: populatedOptions.pageOverrides['1']!,
                dpi: 300,
                qualityPath: 'raster',
            }),
            despeckleLevel: 'aggressive',
        });
        const golden = JSON.parse(await readFile(
            resolve(fixtureDirectory, 'populated-raster-v3.json'),
            'utf8',
        )) as INativeScanCleanupManifestV3;

        expect(manifest).toEqual(golden);
    });

    it('threads an optional document prior only onto its target preview page', () => {
        const documentPrior = {
            dominantLayout: 'two-page-spread' as const,
            cutterRatioMedian: 0.535,
            clusterDims: {
                widthPx: 1200,
                heightPx: 871,
            },
            agreementStrength: 0.88,
        };
        const manifest = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'analyze',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: 'raster',
            options,
            pages: [
                {
                    inputPath: '/fixtures/input/page-1.png',
                    pageNumber: 1,
                    dpi: 150,
                    pageMetadataPath: '/fixtures/output/page-1.json',
                    documentPrior,
                },
                {
                    inputPath: '/fixtures/input/page-2.png',
                    pageNumber: 2,
                    dpi: 150,
                    pageMetadataPath: '/fixtures/output/page-2.json',
                },
            ],
        });

        expect(manifest.pages[0]?.documentPrior).toEqual(documentPrior);
        expect(manifest.pages[1]).not.toHaveProperty('documentPrior');
    });

    it('carries an explicit physical document canvas while canvas scope stays page-local', () => {
        const manifest = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'preview',
            canvasScope: 'page',
            documentCanvas: {
                widthPoints: 420.25,
                heightPoints: 612.5,
                widthPx: 1751,
                heightPx: 2552,
            },
            qualityPath: 'raster',
            options,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 150,
                pageMetadataPath: '/fixtures/output/page-1.json',
                outputs: [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                }],
            }],
        });

        expect(manifest).toMatchObject({
            canvasScope: 'page',
            documentCanvas: {
                widthPoints: 420.25,
                heightPoints: 612.5,
                widthPx: 1751,
                heightPx: 2552,
            },
        });
    });

    it('ships resolved ink anchors per page and names the page whose anchor is unusable', () => {
        const build = (anchorY: number) => buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options: {
                ...options,
                matchPageSize: true,
                pageAlignment: 'ink',
            },
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 4,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                placementAnchors: {
                    full: {yNormalized: anchorY},
                    left: {yNormalized: 0.1},
                },
                outputs: [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                }],
            }],
        });

        const manifest = build(0.125);
        expect(manifest.pages[0]?.options.placementAnchors).toEqual({
            full: {yNormalized: 0.125},
            left: {yNormalized: 0.1},
        });
        expect(() => assertNativeScanCleanupManifestGeometry(manifest)).not.toThrow();
        expect(() => assertNativeScanCleanupManifestGeometry(build(1.5)))
            .toThrow('Scan cleanup page 4 has invalid full placement anchor');
        expect(() => assertNativeScanCleanupManifestGeometry(build(Number.NaN)))
            .toThrow('Scan cleanup page 4 has invalid full placement anchor');
    });

    it('reports the host memory the sidecar cannot read for itself, and omits it when unknown', () => {
        const build = (hostMemoryBytes?: number) => buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            ...(hostMemoryBytes === undefined ? {} : {hostMemoryBytes}),
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                outputs: [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                }],
            }],
        });

        expect(build(34_359_738_368).hostMemoryBytes).toBe(34_359_738_368);
        expect(build()).not.toHaveProperty('hostMemoryBytes');
        expect(build(0)).not.toHaveProperty('hostMemoryBytes');
    });

    it('bounds an explicit streamed-raster lookahead and omits it for replayable inputs', () => {
        const build = (rasterWindow?: number) => buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            ...(rasterWindow === undefined ? {} : {rasterWindow}),
            pages: [{
                inputPath: '/fixtures/input/page-1.ppm',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                outputs: [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                }],
            }],
        });

        expect(build(3).rasterWindow).toBe(3);
        expect(build(99).rasterWindow).toBe(16);
        expect(build()).not.toHaveProperty('rasterWindow');
    });

    it('bounds the staged Analyze window and only declares a peak alongside it', () => {
        const build = (stagedInputWindow?: number, stagedInputPeakPixels?: number) =>
            buildGeometryOnlyNativeScanCleanupManifest({
                operation: 'analyze',
                analysisPurpose: 'page-plan',
                renderMode: 'preview',
                canvasScope: 'page',
                qualityPath: 'raster',
                options,
                ...(stagedInputWindow === undefined ? {} : {stagedInputWindow}),
                ...(stagedInputPeakPixels === undefined ? {} : {stagedInputPeakPixels}),
                pages: [{
                    inputPath: '/fixtures/input/page-1.png',
                    pageNumber: 1,
                    dpi: 150,
                    pageMetadataPath: '/fixtures/output/page-1.json',
                    outputs: [],
                }],
            });

        expect(build(4, 2_317_034).stagedInputWindow).toBe(4);
        expect(build(4, 2_317_034).stagedInputPeakPixels).toBe(2_317_034);
        // The sidecar enforces the same ceilings, so the producer can never ask
        // for a residency or a pool larger than the protocol admits. The
        // maxima themselves pass through untouched, and the first value above
        // each one is what the clamp starts answering for.
        expect(build(16, 1_000_000_000).stagedInputWindow).toBe(16);
        expect(build(16, 1_000_000_000).stagedInputPeakPixels).toBe(1_000_000_000);
        expect(build(17, 1_000_000_001).stagedInputWindow).toBe(16);
        expect(build(17, 1_000_000_001).stagedInputPeakPixels).toBe(1_000_000_000);
        expect(build(99, 5_000_000_000).stagedInputWindow).toBe(16);
        expect(build(99, 5_000_000_000).stagedInputPeakPixels).toBe(1_000_000_000);
        // Below the floor a window would promise a residency that cannot serve
        // a single lease, so the smallest window the sidecar can work against
        // is what a zero or negative request becomes.
        expect(build(0).stagedInputWindow).toBe(1);
        expect(build(-4).stagedInputWindow).toBe(1);
        // A window without a peak is the ordinary case for a producer that has
        // not measured its largest page yet; the sidecar falls back to its own
        // pool sizing rather than being denied the lease protocol.
        expect(build(4).stagedInputWindow).toBe(4);
        expect(build(4)).not.toHaveProperty('stagedInputPeakPixels');
        // A declared peak without a window would size a pool for a residency
        // nobody promised to keep.
        expect(build(undefined, 2_317_034)).not.toHaveProperty('stagedInputPeakPixels');
        expect(build()).not.toHaveProperty('stagedInputWindow');
    });
});

describe('runnable native scan-cleanup manifest path containment', () => {
    let temporaryDirectory = '';
    let siblingSentinel = '';
    let root = '';
    let canonicalRoot = '';
    let outside = '';

    const runnable = (pages: Parameters<typeof buildRunnableNativeScanCleanupManifest>[0]['pages'], allowedPathRoot = root) => buildRunnableNativeScanCleanupManifest({
        operation: 'render',
        renderMode: 'final',
        canvasScope: 'document',
        qualityPath: 'raster',
        options,
        allowedPathRoot,
        pages,
    });

    const page = (inputPath: string, outputPath: string) => ({
        inputPath,
        pageNumber: 1,
        dpi: 300,
        pageMetadataPath: join(root, 'page-1.json'),
        outputs: [{
            outputPath,
            metadataPath: join(root, 'page-1-output.json'),
        }],
    });

    beforeAll(async () => {
        temporaryDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-root-boundary-'));
        // A sibling of the minted directory. Teardown that walks up from a path
        // inside the fixture instead of removing the minted directory itself
        // would take this too, and with it whatever else lives in the OS temp
        // root.
        siblingSentinel = await mkdtemp(join(tmpdir(), 'scan-cleanup-root-boundary-sentinel-'));
        root = join(temporaryDirectory, 'root');
        outside = join(temporaryDirectory, 'outside');
        await mkdir(root);
        await mkdir(outside);
        await mkdir(join(root, 'nested'));
        canonicalRoot = realpathSync(root);
        await writeFile(join(root, 'input.png'), 'input');
        await writeFile(join(outside, 'secret.png'), 'secret');
        await symlink(join(outside, 'secret.png'), join(root, 'input-link.png'));
        await symlink(join(root, 'input.png'), join(root, 'inside-link.png'));
        await symlink(outside, join(root, 'escape-dir'));
        await symlink(join(outside, 'missing.png'), join(root, 'dangling.png'));
    });

    afterAll(async () => {
        if (temporaryDirectory !== '') {
            await rm(temporaryDirectory, {
                recursive: true,
                force: true,
            });
            expect(existsSync(temporaryDirectory)).toBe(false);
        }
        if (siblingSentinel !== '') {
            expect(existsSync(siblingSentinel)).toBe(true);
            await rm(siblingSentinel, {
                recursive: true,
                force: true,
            });
        }
    });

    it('accepts an existing input and a missing output below a real directory', () => {
        expect(() => runnable([page(join(root, 'input.png'), join(root, 'nested/output.png'))])).not.toThrow();
    });

    it('accepts a symlink that resolves back inside the root', () => {
        expect(() => runnable([page(join(root, 'inside-link.png'), join(root, 'nested/output.png'))])).not.toThrow();
    });

    it('rejects an existing input symlink that points outside the root', () => {
        expect(() => runnable([page(join(root, 'input-link.png'), join(root, 'nested/output.png'))]))
            .toThrow(ScanCleanupContractError);
    });

    it('rejects a missing output below a directory symlinked outside the root', () => {
        expect(() => runnable([page(join(root, 'input.png'), join(root, 'escape-dir/output.png'))]))
            .toThrow(ScanCleanupContractError);
    });

    it('rejects a dangling symlink segment', () => {
        expect(() => runnable([page(join(root, 'dangling.png'), join(root, 'nested/output.png'))]))
            .toThrow(/unresolved symlink/u);
    });

    it('rejects a lexical parent-directory escape', () => {
        expect(() => runnable([page(join(root, 'input.png'), join(root, '../outside/output.png'))]))
            .toThrow(ScanCleanupContractError);
    });

    it('rejects a relative candidate path and a relative root', () => {
        expect(() => runnable([page('input.png', join(root, 'nested/output.png'))]))
            .toThrow(/must be an absolute path/u);
        expect(() => runnable(
            [page(join(root, 'input.png'), join(root, 'nested/output.png'))],
            'relative-root',
        )).toThrow(/must be an absolute path/u);
    });

    it('rejects a root that does not exist or is not a directory', () => {
        expect(() => runnable(
            [page(join(root, 'input.png'), join(root, 'nested/output.png'))],
            join(root, 'no-such-root'),
        )).toThrow(/allowed root does not exist/u);
        expect(() => runnable(
            [page(join(root, 'input.png'), join(root, 'nested/output.png'))],
            join(root, 'input.png'),
        )).toThrow(/allowed root is not a directory/u);
    });

    it('treats a canonical root alias such as /var and /private/var as the same root', () => {
        // On macOS the OS temp directory is reached through a symlinked /var.
        // The uncanonicalized spelling and its canonical form describe the same
        // directory, and both must accept the same paths.
        expect(() => runnable(
            [page(join(root, 'input.png'), join(root, 'nested/output.png'))],
            canonicalRoot,
        )).not.toThrow();
        expect(() => runnable(
            [page(join(canonicalRoot, 'input.png'), join(canonicalRoot, 'nested/output.png'))],
            root,
        )).not.toThrow();
    });

    // Path coverage is proved against what the builder actually emits rather
    // than against a second list of field names kept in this file: every path
    // the manifest carries is located at runtime, and each one is then made to
    // escape on its own.
    const region = {
        xPx: 0,
        yPx: 0,
        widthPx: 16,
        heightPx: 16,
    };
    const detailPlan = (
        baseMetadataPath: string,
        baseRasterPath: string,
        baseCleanedRasterPath: string,
    ) => ({
        baseMetadataPath,
        baseRasterPath,
        baseCleanedRasterPath,
        sourceCrop: region,
        fullSourceWidthPx: 32,
        fullSourceHeightPx: 32,
        scale: 1,
        renderRegion: region,
        sampledRegion: region,
    });

    /** Dotted trail of every `*Path` string reachable from `value`. */
    const pathTrails = (value: unknown, trail = ''): string[] => {
        if (Array.isArray(value)) {
            return value.flatMap((entry, index) => pathTrails(entry, `${trail}.${String(index)}`));
        }
        if (value === null || typeof value !== 'object') {
            return [];
        }
        return Object.entries(value).flatMap(([
            key,
            entry,
        ]) => {
            const fieldTrail = trail === '' ? key : `${trail}.${key}`;
            return key.endsWith('Path') && typeof entry === 'string'
                ? [fieldTrail]
                : pathTrails(entry, fieldTrail);
        });
    };

    const setByTrail = (target: unknown, trail: string, value: string) => {
        const segments = trail.split('.');
        let cursor = target as Record<string, unknown>;
        for (const segment of segments.slice(0, -1)) {
            cursor = cursor[segment] as Record<string, unknown>;
        }
        cursor[segments.at(-1)!] = value;
    };

    // Every optional slot filled at once, so the emitted manifest names the
    // complete current path inventory.
    const fullyPopulatedPage = (): IScanCleanupManifestPageInput => ({
        inputPath: join(root, 'input.png'),
        analysisInputPath: join(root, 'input.png'),
        analysisDpi: 150,
        trustedForegroundMaskPath: join(root, 'input.png'),
        trustedMrcBackgroundPath: join(root, 'input.png'),
        pageNumber: 1,
        dpi: 300,
        pageMetadataPath: join(root, 'page-1.json'),
        outputs: [{
            outputPath: join(root, 'nested/output.png'),
            metadataPath: join(root, 'page-1-output.json'),
            bilevelOutputPath: join(root, 'nested/output.pbm'),
            backgroundOutputPath: join(root, 'nested/output-background.png'),
            foregroundMaskOutputPath: join(root, 'nested/output-mask.pbm'),
            foregroundAlphaOutputPath: join(root, 'nested/output-alpha.pgm'),
            pictureMaskOutputPath: join(root, 'nested/output-picture-mask.pbm'),
            tonePreservationAlphaOutputPath: join(root, 'nested/output-tone.pgm'),
        }],
        detailRenderPlan: detailPlan(
            join(root, 'inside-link.png'),
            join(root, 'inside-link.png'),
            join(root, 'inside-link.png'),
        ),
    });

    it('emits no path the builder input does not already own', () => {
        const page = fullyPopulatedPage();
        const manifest = runnable([page]);

        expect(pathTrails(manifest).toSorted()).toEqual(
            pathTrails(page).map(trail => `pages.0.${trail}`).toSorted(),
        );
    });

    it.each(pathTrails(fullyPopulatedPage()))(
        'judges %s by the same root as the page input',
        trail => {
            const accepted = fullyPopulatedPage();
            setByTrail(accepted, trail, join(root, 'inside-link.png'));
            expect(() => runnable([accepted])).not.toThrow();

            const escaping = fullyPopulatedPage();
            setByTrail(escaping, trail, join(root, 'input-link.png'));
            expect(() => runnable([escaping])).toThrow(ScanCleanupContractError);
        },
    );

    it('refuses a manifest that carries a path no field descriptor claimed', () => {
        const page = fullyPopulatedPage();
        // A slot the builder does not know about still reaches the wire,
        // because outputs are copied verbatim from caller input. It must not
        // pass unjudged just because no descriptor names it.
        const outputWithFutureSlot: INativeScanCleanupOutputV3 & {futureOutputPath: string} = {
            ...page.outputs![0]!,
            futureOutputPath: join(root, 'nested/future.png'),
        };
        page.outputs = [outputWithFutureSlot];

        expect(() => runnable([page]))
            .toThrow('manifest field pages.0.outputs.0.futureOutputPath was not checked against the allowed root');
        expect(() => buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            pages: [page],
        })).not.toThrow();
    });

    it('refuses an unclaimed path slot that repeats a path checked elsewhere', () => {
        const page = fullyPopulatedPage();
        // The very string a descriptor cleared for `outputPath`. Coverage is
        // owned per emitted field trail, so an unknown slot cannot inherit the
        // verdict a judged slot earned for the same value.
        const outputWithFutureSlot: INativeScanCleanupOutputV3 & {futureOutputPath: string} = {
            ...page.outputs![0]!,
            futureOutputPath: page.outputs![0]!.outputPath,
        };
        page.outputs = [outputWithFutureSlot];

        expect(() => runnable([page]))
            .toThrow('manifest field pages.0.outputs.0.futureOutputPath was not checked against the allowed root');
    });

    it('canonicalizes the allowed root once for a whole manifest', () => {
        // Every path sits below `nested`, so the root itself is resolved only
        // when the manifest canonicalizes it, once, rather than again for each
        // field the way a per-call check would.
        const nestedPage = (pageNumber: number) => ({
            ...fullyPopulatedPage(),
            pageNumber,
            inputPath: join(root, 'nested/input.png'),
            analysisInputPath: join(root, 'nested/analysis.png'),
            trustedForegroundMaskPath: join(root, 'nested/mask.pbm'),
            trustedMrcBackgroundPath: join(root, 'nested/background.png'),
            pageMetadataPath: join(root, `nested/page-${String(pageNumber)}.json`),
            outputs: [{
                ...fullyPopulatedPage().outputs![0]!,
                metadataPath: join(root, `nested/page-${String(pageNumber)}-output.json`),
            }],
            detailRenderPlan: detailPlan(
                join(root, 'nested/base.json'),
                join(root, 'nested/base.png'),
                join(root, 'nested/base-cleaned.png'),
            ),
        });
        realpathSyncCalls.length = 0;
        runnable([
            nestedPage(1),
            nestedPage(2),
        ]);

        expect(realpathSyncCalls.filter(candidate => candidate === root)).toEqual([root]);
        // Two pages of paths were still judged, so the single root resolution
        // is reuse rather than skipped work.
        expect(realpathSyncCalls.filter(candidate => candidate === join(root, 'nested')).length)
            .toBeGreaterThan(1);
    });

    it('names the allowed root in root failures and the field in candidate failures', () => {
        const validPage = page(join(root, 'input.png'), join(root, 'nested/output.png'));
        const missingRoot = join(root, 'no-such-root');

        expect(() => runnable([validPage], missingRoot))
            .toThrow(`allowed root does not exist: ${missingRoot}`);
        expect(() => runnable([validPage], join(root, 'input.png')))
            .toThrow(`allowed root is not a directory: ${join(root, 'input.png')}`);
        expect(() => runnable([validPage], 'relative-root'))
            .toThrow('allowed root must be an absolute path: relative-root');

        // A candidate that cannot be canonicalized names its own field: it is
        // the manifest path that failed, not the configured root.
        expect(() => runnable([page(join(root, 'dangling.png'), join(root, 'nested/output.png'))]))
            .toThrow('page 1 input path contains an unresolved symlink');
        expect(() => runnable([page(join(root, 'input.png'), join(root, 'escape-dir/output.png'))]))
            .toThrow('page 1 output 0 output path is outside its allowed root');
        expect(() => runnable([page(join(root, 'input.png'), 'output.png')]))
            .toThrow('page 1 output 0 output path must be an absolute path');
    });

    it('rejects a root object the canonicalizer never issued', () => {
        expect(() => assertScanCleanupPathWithinCanonicalRoot(
            join(root, 'input.png'),
            {
                configuredPath: root,
                canonicalPath: canonicalRoot,
            },
            'forged root path',
        )).toThrow('forged root path was judged against a root that was never canonicalized');
    });


    it('keeps geometry-only placeholders out of path validation and matches the runnable assembly', () => {
        const placeholderPages = [{
            inputPath: '',
            pageNumber: 1,
            dpi: 300,
            pageMetadataPath: '',
        }];
        expect(() => buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            pages: placeholderPages,
        })).not.toThrow();

        const realPages = [page(join(root, 'input.png'), join(root, 'nested/output.png'))];
        expect(runnable(realPages)).toEqual(buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            pages: realPages,
        }));
    });
});
