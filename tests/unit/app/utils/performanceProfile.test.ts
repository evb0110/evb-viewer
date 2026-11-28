import {afterEach, describe, expect, it, vi} from 'vitest';
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
    PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT,
    PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY,
    PDF_SETTLED_MAX_CANVAS_PIXELS_LOW_TIER,
    PDF_SETTLED_MAX_CANVAS_PIXELS_WORKSTATION,
    PDF_THUMBNAIL_CONCURRENCY_DEFAULT,
    PDF_THUMBNAIL_CONCURRENCY_LOW_PROFILE,
    PDF_THUMBNAIL_CONCURRENCY_WORKSTATION,
    detectBrowserEngine,
    resolveBrowserEstimatedMemoryGiB,
    resolvePerformanceProfile,
} from '@app/utils/performanceProfile';
import {resolveOpenPathSecondaryPerformancePolicy} from '@app/utils/resolveOpenPathSecondaryPerformancePolicy';
import {resolvePdfRenderPerformancePolicy} from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';

const MEBIBYTE = 1024 * 1024;

vi.mock('@app/utils/electronPlatformBridge', () => ({getRawElectronPlatformApi: () => undefined}));
vi.mock('@app/utils/browserSettingsPersistence', () => ({readBrowserPerformanceModeSnapshot: () => 'auto'}));

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('resolvePerformanceProfile', () => {
    it('retains the startup choice independently of the detected or host tier', () => {
        expect(
            resolvePerformanceProfile({
                performanceMode: 'auto',
                tier: 'low',
            }),
        ).toMatchObject({
            performanceMode: 'auto',
            tier: 'low',
        });
        expect(
            resolvePerformanceProfile({
                performanceMode: 'low',
                tier: 'low',
            }),
        ).toMatchObject({
            performanceMode: 'low',
            tier: 'low',
        });
        expect(resolvePerformanceProfile({})).toMatchObject({performanceMode: 'auto'});
    });

    it('treats a desktop browser that reports no memory as medium, not low', () => {
        const medium = {
            tier: 'medium',
            mobile: false,
            lowMemory: false,
            lowCpu: false,
            pdfBufferPages: 2,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_DEFAULT,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_DEFAULT,
            thumbnailBaseConcurrency: PDF_THUMBNAIL_CONCURRENCY_DEFAULT,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT,
        };
        expect(resolvePerformanceProfile({hardwareConcurrency: 8})).toMatchObject(medium);
        expect(resolvePerformanceProfile({})).toMatchObject(medium);
    });

    it('classifies small browsers as low on evidence of few cores, little memory or a mobile device', () => {
        expect(resolvePerformanceProfile({hardwareConcurrency: 2}).tier).toBe('low');
        expect(
            resolvePerformanceProfile({
                deviceMemory: 4,
                hardwareConcurrency: 8,
            }).tier,
        ).toBe('low');
        expect(
            resolvePerformanceProfile({
                deviceMemory: 8,
                hardwareConcurrency: 8,
                mobile: true,
            }),
        ).toMatchObject({
            tier: 'low',
            mobile: true,
        });
    });

    it.each([
        {
            name: 'iPhone Safari',
            userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
            maxTouchPoints: 5,
            mobile: true,
        },
        {
            name: 'iPadOS Safari',
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
            maxTouchPoints: 5,
            mobile: true,
        },
        {
            name: 'macOS Safari',
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
            maxTouchPoints: 0,
            mobile: false,
        },
    ])('reads $name from the browser navigator', ({userAgent, maxTouchPoints, mobile}) => {
        vi.stubGlobal('window', {});
        vi.stubGlobal('document', {});
        vi.stubGlobal('navigator', {
            userAgent,
            maxTouchPoints,
            hardwareConcurrency: 8,
        });

        expect(resolvePerformanceProfile()).toMatchObject({
            mobile,
            tier: mobile ? 'low' : 'medium',
        });
    });

    it('differentiates deviceMemory === undefined (Firefox vs WebKit) from deviceMemory <= 4', () => {
        const firefoxDesktopUa = 'Mozilla/5.0 (X11; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0';
        const safariMacUa =
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
        const safariIosUa =
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
        const chromeDesktopUa = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

        expect(detectBrowserEngine(firefoxDesktopUa)).toBe('firefox');
        expect(detectBrowserEngine(safariMacUa)).toBe('webkit');
        expect(detectBrowserEngine(safariIosUa)).toBe('webkit');
        expect(detectBrowserEngine(chromeDesktopUa)).toBe('chromium');
        expect(detectBrowserEngine(undefined)).toBe('unknown');

        // High-core Firefox desktop omits deviceMemory and scales to high tier (8 GiB estimate).
        expect(
            resolvePerformanceProfile({
                hardwareConcurrency: 16,
                userAgent: firefoxDesktopUa,
            }),
        ).toMatchObject({
            tier: 'high',
            mobile: false,
            lowMemory: false,
            lowCpu: false,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY,
        });
        // Explicit mobile Firefox user agent without an explicit mobile flag still resolves as mobile low tier.
        expect(
            resolvePerformanceProfile({
                hardwareConcurrency: 8,
                userAgent: 'Mozilla/5.0 (Android 15; Mobile; rv:136.0) Gecko/136.0 Firefox/136.0',
            }),
        ).toMatchObject({
            tier: 'low',
            mobile: true,
        });
        expect(resolveBrowserEstimatedMemoryGiB({hardwareConcurrency: 16, userAgent: firefoxDesktopUa})).toBe(8);
        expect(resolveBrowserEstimatedMemoryGiB({hardwareConcurrency: 4, userAgent: firefoxDesktopUa})).toBe(6);

        // High-core macOS Safari omits deviceMemory: avoids low tier (not throttled to 4 GiB / 1-render mode)
        // while staying at medium tier (6 GiB estimate) to protect WebKit's tighter linear-memory/canvas ceiling.
        expect(
            resolvePerformanceProfile({
                hardwareConcurrency: 16,
                userAgent: safariMacUa,
            }),
        ).toMatchObject({
            tier: 'medium',
            lowMemory: false,
            lowCpu: false,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_DEFAULT,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT,
        });
        expect(resolveBrowserEstimatedMemoryGiB({hardwareConcurrency: 16, userAgent: safariMacUa})).toBe(6);

        // Mobile WebKit, low-CPU Firefox, and explicit deviceMemory <= 4 stay constrained.
        expect(resolveBrowserEstimatedMemoryGiB({hardwareConcurrency: 6, userAgent: safariIosUa})).toBe(4);
        expect(resolveBrowserEstimatedMemoryGiB({hardwareConcurrency: 2, userAgent: firefoxDesktopUa})).toBe(4);
        expect(resolvePerformanceProfile({hardwareConcurrency: 2, userAgent: firefoxDesktopUa}).tier).toBe('low');
        expect(resolveBrowserEstimatedMemoryGiB({deviceMemory: 4, hardwareConcurrency: 16, userAgent: chromeDesktopUa})).toBe(4);
        expect(resolveBrowserEstimatedMemoryGiB({deviceMemory: 8, hardwareConcurrency: 16, userAgent: chromeDesktopUa})).toBe(8);
    });

    it('does not classify the server by its own CPUs while rendering without a document', () => {
        vi.stubGlobal('navigator', {
            userAgent: 'Node.js/26',
            hardwareConcurrency: 2,
        });

        expect(resolvePerformanceProfile()).toMatchObject({
            tier: 'medium',
            mobile: false,
        });
    });

    it('keeps full counts on capable hardware and raises the settled canvas budget', () => {
        expect(
            resolvePerformanceProfile({
                deviceMemory: 8,
                hardwareConcurrency: 8,
            }),
        ).toMatchObject({
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
        expect(
            resolvePerformanceProfile({
                deviceMemory: 8,
                hardwareConcurrency: 8,
                totalMemoryBytes: 8 * 1024 ** 3,
            }),
        ).toMatchObject({
            tier: 'low',
            lowMemory: true,
            lowCpu: true,
            pdfBufferPages: 1,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_LOW_CPU,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_LOW_MEMORY,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_LOW_TIER,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY,
        });
    });

    it('scales render, prefetch, proxy, thumbnail, and raster budgets upward on workstations', () => {
        expect(
            resolvePerformanceProfile({
                deviceMemory: 8,
                hardwareConcurrency: 24,
                totalMemoryBytes: 32 * 1024 ** 3,
            }),
        ).toMatchObject({
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
                gpu_compositing: 'disabled_software',
                rasterization: 'disabled_software',
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
                gpu_compositing: 'enabled',
                rasterization: 'enabled',
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
        expect(
            resolvePerformanceProfile({
                hardwareConcurrency: 8,
                totalMemoryBytes: 64 * 1024 ** 3,
            }),
        ).toMatchObject({
            tier: 'high',
            pdfBufferPages: 2,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_DEFAULT,
            maxCachedPdfPages: PDF_PAGE_PROXY_CACHE_DEFAULT,
            thumbnailBaseConcurrency: PDF_THUMBNAIL_CONCURRENCY_DEFAULT,
            settledMaxCanvasPixels: PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY,
            maxBufferCanvasPixels: PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT,
        });
    });

    it("keeps a browser in Chrome's top memory bucket at medium when it has few cores", () => {
        expect(
            resolvePerformanceProfile({
                deviceMemory: 8,
                hardwareConcurrency: 4,
            }).tier,
        ).toBe('medium');
    });

    it('gives a low-memory browser with enough CPU cores the canonical low table', () => {
        expect(
            resolvePerformanceProfile({
                deviceMemory: 4,
                hardwareConcurrency: 8,
            }),
        ).toMatchObject({
            tier: 'low',
            lowMemory: true,
            lowCpu: true,
            pdfBufferPages: 1,
            concurrentPdfRenders: PDF_RENDER_CONCURRENCY_LOW_CPU,
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
    ])('uses the exact canonical $tier table', ({tier, expected}) => {
        expect(
            resolvePerformanceProfile({
                tier,
                hardwareConcurrency: 8,
                totalMemoryBytes: 16 * 1024 ** 3,
            }),
        ).toEqual({
            performanceMode: 'auto',
            mobile: false,
            ...expected,
        });
    });

    it('applies the existing workstation uplift only to a high canonical tier', () => {
        const environment = {
            hardwareConcurrency: 24,
            totalMemoryBytes: 32 * 1024 ** 3,
        };

        expect(
            resolvePerformanceProfile({
                ...environment,
                tier: 'high',
            }),
        ).toEqual({
            performanceMode: 'auto',
            mobile: false,
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
        expect(
            resolvePerformanceProfile({
                ...environment,
                tier: 'medium',
            }),
        ).toEqual({
            performanceMode: 'auto',
            mobile: false,
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

    it.each([
        ['low', 1, 2 ** 24],
        ['medium', 3, 2 ** 25],
        ['high', 3, 2 ** 26],
    ] as const)(
        'maps the manual browser %s override directly to its tier',
        (performanceMode, concurrentPdfRenders, settledMaxCanvasPixels) => {
            expect(
                resolvePerformanceProfile({
                    performanceMode,
                    deviceMemory: 4,
                    hardwareConcurrency: 8,
                }),
            ).toMatchObject({
                performanceMode,
                tier: performanceMode,
                concurrentPdfRenders,
                settledMaxCanvasPixels,
            });
        },
    );
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
                inactiveDjvuLeasePolicy: 'release-immediately',
            },
        },
        {
            profile: resolvePerformanceProfile({hardwareConcurrency: 8}),
            expected: {
                eagerAnnotationNameReadMaxBytes: 16 * MEBIBYTE,
                interactiveAnnotationNameReadMaxBytes: 64 * MEBIBYTE,
                maxInMemoryPdfBytes: 16 * MEBIBYTE,
                maxDjvuJsDesktopSourceBytes: 96 * MEBIBYTE,
                inactiveDjvuLeasePolicy: 'warm-grace',
            },
        },
    ])('resolves the complete $profile.tier profile policy', ({profile, expected}) => {
        expect(resolveOpenPathSecondaryPerformancePolicy(profile)).toEqual(expected);
    });
});
