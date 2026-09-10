import {
    describe,
    expect,
    it,
} from 'vitest';
import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import {createScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {
    resolveEffectiveScanCleanupOptions,
    resolveScanCleanupCanvasPageDpi,
    resolveScanCleanupDocumentGuardrail,
    resolveScanCleanupPlannedDpi,
    resolveScanCleanupRequestedRenderDpi,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'bw',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 1,
        topMm: 2,
        rightMm: 3,
        bottomMm: 4,
    },
    despeckle: true,
    readingOrder: 'ltr',
    skipBlankPages: false,
    pageOverrides: {},
};

function resolve(pageOverride = createScanCleanupPageOverride()) {
    return resolveEffectiveScanCleanupOptions({
        options,
        pageOverride,
        dpi: 300,
        qualityPath: 'raster',
    });
}

describe('effective scan cleanup options', () => {
    it('keeps measured source rasters on their native grid and floors only synthesized binary pages', () => {
        expect(resolveScanCleanupRequestedRenderDpi({
            sourceDpi: 200,
            outputCarriesBinaryLayer: true,
            sourceRasterDetected: true,
        })).toBe(200);
        expect(resolveScanCleanupRequestedRenderDpi({
            sourceDpi: 300,
            outputCarriesBinaryLayer: true,
            sourceRasterDetected: true,
        })).toBe(300);
        expect(resolveScanCleanupRequestedRenderDpi({
            sourceDpi: 360,
            outputCarriesBinaryLayer: true,
            sourceRasterDetected: true,
        })).toBe(360);
        expect(resolveScanCleanupRequestedRenderDpi({
            sourceDpi: 200,
            outputCarriesBinaryLayer: true,
            sourceRasterDetected: false,
        })).toBe(600);
        expect(resolveScanCleanupRequestedRenderDpi({
            sourceDpi: 720,
            outputCarriesBinaryLayer: true,
            sourceRasterDetected: false,
        })).toBe(720);
        expect(resolveScanCleanupRequestedRenderDpi({
            sourceDpi: 200,
            outputCarriesBinaryLayer: false,
            sourceRasterDetected: false,
        })).toBe(200);
    });

    it('keeps a detected raster on one document canvas grid in every run scope', () => {
        const input = {
            configuredMode: 'auto' as const,
            sourceDpi: 360,
            sourceRasterDetected: true,
            guardrail: {
                dpi: 360,
                width: 2_200,
                height: 3_350,
            },
        };

        expect(resolveScanCleanupCanvasPageDpi(input)).toBe(360);
        expect(resolveScanCleanupCanvasPageDpi({...input})).toBe(360);
    });

    it('budgets uniform renders from physical page geometry, including rotated anisotropic sources', () => {
        const guardrail = resolveScanCleanupDocumentGuardrail(
            {
                dpi: 600,
                width: 9_600,
                height: 4_800,
            },
            600,
            {
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 1_152,
                heightPoints: 1_152,
                rotation: 90,
            },
        );

        expect(guardrail).toEqual({
            dpi: 72,
            width: 1_152,
            height: 1_152,
        });
        expect(resolveScanCleanupPlannedDpi({
            sourceDpi: 600,
            outputCarriesBinaryLayer: true,
            sourceRasterDetected: true,
            maxPixels: 60_000_000,
            guardrail,
        })).toMatchObject({
            requestedRenderDpi: 600,
            dpi: 484,
        });
    });

    it('reuses only non-destructive observed layout labels while preserving explicit page choices', () => {
        expect(resolveEffectiveScanCleanupOptions({
            options,
            pageOverride: createScanCleanupPageOverride(),
            dpi: 300,
            observedLayout: 'single-uncut-page',
            qualityPath: 'raster',
        }).layout).toBe('force-single');
        expect(resolveEffectiveScanCleanupOptions({
            options,
            pageOverride: createScanCleanupPageOverride({layoutOverride: 'spread'}),
            dpi: 300,
            observedLayout: 'single-uncut-page',
            qualityPath: 'raster',
        }).layout).toBe('force-two-page');
        expect(resolveEffectiveScanCleanupOptions({
            options,
            pageOverride: createScanCleanupPageOverride(),
            dpi: 300,
            observedLayout: 'two-page-spread',
            qualityPath: 'raster',
        }).layout).toBe('auto');
        expect(resolveEffectiveScanCleanupOptions({
            options,
            pageOverride: createScanCleanupPageOverride(),
            dpi: 300,
            observedLayout: 'two-page-spread',
            automaticSplit: {
                xNormalized: 0.47,
                rotationDegrees: 0,
            },
            qualityPath: 'raster',
        })).toMatchObject({
            layout: 'force-two-page',
            automaticSplit: {
                xNormalized: 0.47,
                rotationDegrees: 0,
            },
        });
        expect(resolveEffectiveScanCleanupOptions({
            options,
            pageOverride: createScanCleanupPageOverride(),
            dpi: 300,
            observedLayout: 'page-with-offcut',
            qualityPath: 'raster',
        }).layout).toBe('auto');
        expect(resolveEffectiveScanCleanupOptions({
            options,
            pageOverride: createScanCleanupPageOverride(),
            dpi: 300,
            observedLayout: 'page-with-offcut',
            automaticSplit: {
                xNormalized: 0.08,
                rotationDegrees: 0,
            },
            qualityPath: 'raster',
        })).toMatchObject({
            layout: 'page-with-offcut',
            automaticSplit: {
                xNormalized: 0.08,
                rotationDegrees: 0,
            },
        });
    });

    it('maps the existing despeckle boolean to the native level contract', () => {
        expect(resolve().despeckleLevel).toBe('normal');
        expect(resolveEffectiveScanCleanupOptions({
            options: {
                ...options,
                despeckle: false,
            },
            pageOverride: createScanCleanupPageOverride(),
            dpi: 300,
            qualityPath: 'raster',
        }).despeckleLevel).toBe('off');
    });

    it('passes advanced raster controls through to the native options', () => {
        const effective = resolveEffectiveScanCleanupOptions({
            options: {
                ...options,
                binarization: 'wolf',
                normalizeIllumination: false,
                despeckleLevel: 'aggressive',
                autoDewarp: true,
                autoDewarpDepth: 1.8,
            },
            pageOverride: createScanCleanupPageOverride({manualSkewDegrees: -2.3}),
            dpi: 300,
            qualityPath: 'raster',
            experimental: {
                autoDewarp: true,
                autoDewarpDepth: 1.8,
            },
        });

        expect(effective).toMatchObject({
            binarization: 'wolf',
            normalizeIllumination: false,
            despeckle: true,
            despeckleLevel: 'aggressive',
            manualSkewDegrees: -2.3,
            experimental: {
                autoDewarp: true,
                autoDewarpDepth: 1.8,
            },
        });
    });

    it('keeps bw as policy default while passing mixed mode and manual zones through', () => {
        expect(resolve().outputMode).toBe('bw');
        expect(resolve().manualZones).toEqual({
            picture: [],
            fill: [],
        });
        const polygon = {
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
            rotationDegrees: 0 as const,
        };
        const effective = resolveEffectiveScanCleanupOptions({
            options: {
                ...options,
                outputMode: 'mixed',
            },
            pageOverride: createScanCleanupPageOverride({manualZones: {
                picture: [{
                    polygon,
                    layer: 'painter2',
                }],
                fill: [polygon],
            }}),
            dpi: 300,
            qualityPath: 'raster',
        });
        expect(effective.outputMode).toBe('mixed');
        expect(effective.despeckleLevel).toBe('normal');
        expect(effective.manualZones).toEqual({
            picture: [{
                polygon,
                layer: 'painter2',
            }],
            fill: [polygon],
        });
    });

    it('passes auto through and gives a concrete page override precedence', () => {
        expect(resolveEffectiveScanCleanupOptions({
            options: {
                ...options,
                outputMode: 'auto',
            },
            pageOverride: createScanCleanupPageOverride(),
            dpi: 300,
            qualityPath: 'raster',
        }).outputMode).toBe('auto');

        expect(resolveEffectiveScanCleanupOptions({
            options: {
                ...options,
                outputMode: 'auto',
            },
            pageOverride: createScanCleanupPageOverride({outputModeOverride: 'grayscale'}),
            dpi: 300,
            qualityPath: 'raster',
        }).outputMode).toBe('grayscale');
    });

    it('matches native raster limits to the combiner payload depth', () => {
        const resolveMode = (resolvedOutputMode: 'bw' | 'grayscale' | 'color' | 'mixed') =>
            resolveEffectiveScanCleanupOptions({
                options,
                pageOverride: createScanCleanupPageOverride(),
                dpi: 300,
                resolvedOutputMode,
                qualityPath: 'raster',
            }).maxPixels;

        expect(resolveMode('bw')).toBe(160_000_000);
        expect(resolveMode('grayscale')).toBe(80_000_000);
        expect(resolveMode('color')).toBe(80_000_000);
        expect(resolveMode('mixed')).toBe(80_000_000);
    });

    it('passes asymmetric document margins through unchanged', () => {
        expect(resolve().margins).toEqual(options.marginsMm);
    });

    it('gives a page margin override precedence over document margins', () => {
        const pageMargins = {
            leftMm: 8,
            topMm: 7,
            rightMm: 6,
            bottomMm: 5,
        };
        expect(resolve(createScanCleanupPageOverride({marginsMm: pageMargins})).margins)
            .toEqual(pageMargins);
    });

    it('composes crop, manual content, and margins with automatic dewarp', () => {
        const effective = resolveEffectiveScanCleanupOptions({
            options,
            pageOverride: createScanCleanupPageOverride({manualContentBoxes: {full: {
                xNormalized: 0.1,
                yNormalized: 0.1,
                widthNormalized: 0.8,
                heightNormalized: 0.8,
                rotationDegrees: 0,
            }}}),
            dpi: 300,
            qualityPath: 'raster',
            experimental: {autoDewarp: true},
        });

        expect(effective.cropContent).toBe(true);
        expect(effective.manualContentBoxes).toEqual({full: {
            xNormalized: 0.1,
            yNormalized: 0.1,
            widthNormalized: 0.8,
            heightNormalized: 0.8,
            rotationDegrees: 0,
        }});
        expect(effective.margins).toEqual(options.marginsMm);
        expect(effective.experimental.autoDewarp).toBe(true);
    });

    it('keeps preserve-original-quality analysis free of raster normalization', () => {
        const effective = resolveEffectiveScanCleanupOptions({
            options,
            pageOverride: createScanCleanupPageOverride(),
            dpi: 300,
            qualityPath: 'lossless',
            experimental: {autoDewarp: true},
        });

        expect(effective.normalizeIllumination).toBe(false);
        expect(effective.binarization).toBe('auto');
        expect(effective.despeckle).toBe(false);
        expect(effective.despeckleLevel).toBe('off');
        expect(effective.experimental.autoDewarp).toBe(false);
        expect(effective.experimental.autoDewarpDepth).toBeUndefined();
    });
});
