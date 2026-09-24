import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT,
    PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY,
    PDF_BUFFER_MAX_CANVAS_PIXELS_WORKSTATION,
    PDF_BUFFER_PAGES_WORKSTATION,
    PDF_PAGE_PROXY_CACHE_DEFAULT,
    PDF_PAGE_PROXY_CACHE_LOW_MEMORY,
    PDF_PAGE_PROXY_CACHE_WORKSTATION,
    PDF_RENDER_CONCURRENCY_DEFAULT,
    PDF_RENDER_CONCURRENCY_LOW_CPU,
    PDF_RENDER_CONCURRENCY_LOW_MEMORY,
    PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY,
    PDF_SETTLED_MAX_CANVAS_PIXELS_LOW_TIER,
    PDF_SETTLED_MAX_CANVAS_PIXELS_WORKSTATION,
    PDF_THUMBNAIL_CONCURRENCY_DEFAULT,
    PDF_THUMBNAIL_CONCURRENCY_LOW_PROFILE,
    PDF_THUMBNAIL_CONCURRENCY_WORKSTATION,
    resolvePerformanceProfile,
} from '@app/utils/performanceProfile';
import { resolveOpenPathSecondaryPerformancePolicy } from '@app/utils/resolveOpenPathSecondaryPerformancePolicy';
import { resolvePdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';

const MEBIBYTE = 1024 * 1024;

describe('resolvePerformanceProfile', () => {
    it('uses the conservative low profile when memory and CPU are unknown', () => {
        expect(resolvePerformanceProfile({})).toMatchObject({
            tier: 'low',
            lowMemory: true,
            lowCpu: true,
            pdfBufferPages: 1,
            concurrentPdfRenders: 1,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_LOW_MEMORY,
            thumbnailBaseConcurrency: PDF_THUMBNAIL_CONCURRENCY_LOW_PROFILE,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_LOW_TIER,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY,
        });
        expect(PDF_RENDER_CONCURRENCY_LOW_CPU).toBe(1);
    });

    it('keeps full counts on capable hardware and raises the settled canvas budget', () => {
        expect(resolvePerformanceProfile({
            deviceMemory: 8,
            hardwareConcurrency: 8,
        })).toMatchObject({
            tier: 'high',
            lowMemory: false,
            lowCpu: false,
            pdfBufferPages: 2,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_DEFAULT,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_DEFAULT,
            thumbnailBaseConcurrency: PDF_THUMBNAIL_CONCURRENCY_DEFAULT,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT,
        });
    });

    it('does not trust clamped 8 GB deviceMemory as real high memory when total RAM is available', () => {
        expect(resolvePerformanceProfile({
            deviceMemory: 8,
            hardwareConcurrency: 8,
            totalMemoryBytes: 8 * 1024 ** 3,
        })).toMatchObject({
            tier: 'low',
            lowMemory: true,
            lowCpu: false,
            pdfBufferPages: 1,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_LOW_MEMORY,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_LOW_MEMORY,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_LOW_TIER,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY,
        });
    });

    it('scales render, prefetch, proxy, thumbnail, and raster budgets upward on workstations', () => {
        expect(resolvePerformanceProfile({
            deviceMemory: 8,
            hardwareConcurrency: 24,
            totalMemoryBytes: 32 * 1024 ** 3,
        })).toMatchObject({
            tier: 'high',
            lowMemory: false,
            lowCpu: false,
            pdfBufferPages: PDF_BUFFER_PAGES_WORKSTATION,
            concurrentPdfRenders: 6,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_WORKSTATION,
            thumbnailBaseConcurrency: PDF_THUMBNAIL_CONCURRENCY_WORKSTATION,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_WORKSTATION,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_WORKSTATION,
        });
    });

    it('caps the settled canvas for software rendering while keeping workstation prefetch budgets', () => {
        const profile = resolvePerformanceProfile({
            hardwareConcurrency: 24,
            totalMemoryBytes: 32 * 1024 ** 3,
            gpuStatus: {
                '2d_canvas': 'disabled_software',
                'gpu_compositing': 'disabled_software',
                'rasterization': 'disabled_software',
            },
        });

        expect(profile).toMatchObject({
            tier: 'high',
            lowMemory: false,
            lowCpu: true,
            pdfBufferPages: PDF_BUFFER_PAGES_WORKSTATION,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_LOW_CPU,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_WORKSTATION,
            thumbnailBaseConcurrency: PDF_THUMBNAIL_CONCURRENCY_LOW_PROFILE,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_LOW_TIER,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_WORKSTATION,
        });
        expect(resolvePdfRenderPerformancePolicy(profile).outputScaleFloor).toBe(1);
    });

    it('keeps workstation rendering enabled when canonical GPU features are hardware-backed', () => {
        const profile = resolvePerformanceProfile({
            hardwareConcurrency: 24,
            totalMemoryBytes: 32 * 1024 ** 3,
            gpuStatus: {
                '2d_canvas': 'enabled',
                'gpu_compositing': 'enabled',
                'rasterization': 'enabled',
            },
        });

        expect(profile).toMatchObject({
            tier: 'high',
            lowMemory: false,
            lowCpu: false,
            concurrentPdfRenders: 6,
            thumbnailBaseConcurrency: PDF_THUMBNAIL_CONCURRENCY_WORKSTATION,
        });
        expect(resolvePdfRenderPerformancePolicy(profile).outputScaleFloor).toBe(2);
    });

    it('requires both workstation memory and CPU before widening concurrent work', () => {
        expect(resolvePerformanceProfile({
            hardwareConcurrency: 8,
            totalMemoryBytes: 64 * 1024 ** 3,
        })).toMatchObject({
            tier: 'high',
            pdfBufferPages: 2,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_DEFAULT,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_DEFAULT,
            thumbnailBaseConcurrency: PDF_THUMBNAIL_CONCURRENCY_DEFAULT,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_WORKSTATION,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT,
        });
    });

    it('serializes PDF renders on low-CPU machines without lowering the canvas budget', () => {
        expect(resolvePerformanceProfile({
            deviceMemory: 8,
            hardwareConcurrency: 4,
        })).toMatchObject({
            tier: 'high',
            lowMemory: false,
            lowCpu: true,
            pdfBufferPages: 2,
            concurrentPdfRenders: 1,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_DEFAULT,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT,
        });
        expect(PDF_RENDER_CONCURRENCY_LOW_CPU).toBe(1);
    });

    it('reduces off-screen counts on low-memory machines with enough CPU cores', () => {
        expect(resolvePerformanceProfile({
            deviceMemory: 4,
            hardwareConcurrency: 8,
        })).toMatchObject({
            tier: 'low',
            lowMemory: true,
            lowCpu: false,
            pdfBufferPages: 1,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_LOW_MEMORY,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_LOW_MEMORY,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_LOW_TIER,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY,
        });
    });

    it.each([
        {
            tier: 'low' as const,
            expected: {
                tier: 'low',
                lowMemory: true,
                lowCpu: true,
                pdfBufferPages: 1,
                concurrentPdfRenders: 1,
                maxCachedPdfPages: 16,
                thumbnailBaseConcurrency: 1,
                settledMaxCanvasPixels: 2 ** 24,
                maxBufferCanvasPixels: 8_388_608,
            },
        },
        {
            tier: 'medium' as const,
            expected: {
                tier: 'medium',
                lowMemory: false,
                lowCpu: false,
                pdfBufferPages: 2,
                concurrentPdfRenders: 3,
                maxCachedPdfPages: 48,
                thumbnailBaseConcurrency: 2,
                settledMaxCanvasPixels: 2 ** 25,
                maxBufferCanvasPixels: 16_777_216,
            },
        },
        {
            tier: 'high' as const,
            expected: {
                tier: 'high',
                lowMemory: false,
                lowCpu: false,
                pdfBufferPages: 2,
                concurrentPdfRenders: 3,
                maxCachedPdfPages: 48,
                thumbnailBaseConcurrency: 2,
                settledMaxCanvasPixels: 2 ** 26,
                maxBufferCanvasPixels: 16_777_216,
            },
        },
    ])('uses the exact canonical $tier table', ({
        tier,
        expected,
    }) => {
        expect(resolvePerformanceProfile({
            tier,
            hardwareConcurrency: 8,
            totalMemoryBytes: 16 * 1024 ** 3,
        })).toEqual(expected);
    });

    it('applies the existing workstation uplift only to a high canonical tier', () => {
        const environment = {
            hardwareConcurrency: 24,
            totalMemoryBytes: 32 * 1024 ** 3,
        };

        expect(resolvePerformanceProfile({
            ...environment,
            tier: 'high',
        })).toEqual({
            tier: 'high',
            lowMemory: false,
            lowCpu: false,
            pdfBufferPages: 4,
            concurrentPdfRenders: 6,
            maxCachedPdfPages: 96,
            thumbnailBaseConcurrency: 4,
            settledMaxCanvasPixels: 2 ** 27,
            maxBufferCanvasPixels: 33_554_432,
        });
        expect(resolvePerformanceProfile({
            ...environment,
            tier: 'medium',
        })).toEqual({
            tier: 'medium',
            lowMemory: false,
            lowCpu: false,
            pdfBufferPages: 2,
            concurrentPdfRenders: 3,
            maxCachedPdfPages: 48,
            thumbnailBaseConcurrency: 2,
            settledMaxCanvasPixels: 2 ** 25,
            maxBufferCanvasPixels: 16_777_216,
        });
    });

    it('preserves the legacy browser auto formulas when no canonical tier is available', () => {
        expect(resolvePerformanceProfile({
            performanceMode: 'auto',
            deviceMemory: 4,
            hardwareConcurrency: 8,
        })).toEqual({
            tier: 'low',
            lowMemory: true,
            lowCpu: false,
            pdfBufferPages: 1,
            concurrentPdfRenders: 2,
            maxCachedPdfPages: 16,
            thumbnailBaseConcurrency: 1,
            settledMaxCanvasPixels: 2 ** 24,
            maxBufferCanvasPixels: 8_388_608,
        });
        expect(resolvePerformanceProfile({
            performanceMode: 'auto',
            deviceMemory: 8,
            hardwareConcurrency: 4,
        })).toEqual({
            tier: 'high',
            lowMemory: false,
            lowCpu: true,
            pdfBufferPages: 2,
            concurrentPdfRenders: 1,
            maxCachedPdfPages: 48,
            thumbnailBaseConcurrency: 1,
            settledMaxCanvasPixels: 2 ** 26,
            maxBufferCanvasPixels: 16_777_216,
        });
    });

    it.each([
        [
            'low',
            1,
            2 ** 24,
        ],
        [
            'medium',
            3,
            2 ** 25,
        ],
        [
            'high',
            3,
            2 ** 26,
        ],
    ] as const)('maps the manual browser %s override directly to its tier', (
        performanceMode,
        concurrentPdfRenders,
        settledMaxCanvasPixels,
    ) => {
        expect(resolvePerformanceProfile({
            performanceMode,
            deviceMemory: 4,
            hardwareConcurrency: 8,
        })).toMatchObject({
            tier: performanceMode,
            concurrentPdfRenders,
            settledMaxCanvasPixels,
        });
    });
});

describe('resolveOpenPathSecondaryPerformancePolicy', () => {
    it.each([
        {
            profile: resolvePerformanceProfile({
                deviceMemory: 8,
                hardwareConcurrency: 8,
            }),
            expected: {
                eagerAnnotationNameReadMaxBytes: 16 * MEBIBYTE,
                interactiveAnnotationNameReadMaxBytes: 64 * MEBIBYTE,
                maxInMemoryPdfBytes: 16 * MEBIBYTE,
                maxDjvuJsDesktopSourceBytes: 96 * MEBIBYTE,
                deferMediumHistoryBaseline: false,
                inactiveDjvuLeasePolicy: 'warm-grace',
            },
        },
        {
            profile: resolvePerformanceProfile({
                deviceMemory: 4,
                hardwareConcurrency: 8,
            }),
            expected: {
                eagerAnnotationNameReadMaxBytes: 4 * MEBIBYTE,
                interactiveAnnotationNameReadMaxBytes: 16 * MEBIBYTE,
                maxInMemoryPdfBytes: 4 * MEBIBYTE,
                maxDjvuJsDesktopSourceBytes: 24 * MEBIBYTE,
                deferMediumHistoryBaseline: true,
                inactiveDjvuLeasePolicy: 'release-immediately',
            },
        },
        {
            profile: resolvePerformanceProfile({
                deviceMemory: 8,
                hardwareConcurrency: 4,
            }),
            expected: {
                eagerAnnotationNameReadMaxBytes: 4 * MEBIBYTE,
                interactiveAnnotationNameReadMaxBytes: 16 * MEBIBYTE,
                maxInMemoryPdfBytes: 16 * MEBIBYTE,
                maxDjvuJsDesktopSourceBytes: 96 * MEBIBYTE,
                deferMediumHistoryBaseline: false,
                inactiveDjvuLeasePolicy: 'warm-grace',
            },
        },
    ])('resolves the complete $profile.tier profile policy', ({
        profile,
        expected,
    }) => {
        expect(resolveOpenPathSecondaryPerformancePolicy(profile)).toEqual(expected);
    });
});
