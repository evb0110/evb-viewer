import {describe, expect, it} from 'vitest';
import {
    decodeHostResourceProfileSnapshot,
    resolveDocumentSavePerformanceTier,
    resolveDetectedHostResourceTier,
    resolveEffectiveHostResourceTier,
    usesSoftwareCanvasRendering,
} from '@contracts/hostResourceProfile';

const GIB = 1024 ** 3;

describe('host resource profile contract', () => {
    it('detects software fallback only on canonical canvas rendering features', () => {
        expect(
            usesSoftwareCanvasRendering({
                '2d_canvas': 'enabled',
                gpu_compositing: 'disabled_software',
                rasterization: 'enabled',
            }),
        ).toBe(true);
        expect(
            usesSoftwareCanvasRendering({
                '2d_canvas': 'enabled',
                gpu_compositing: 'enabled',
                rasterization: 'enabled',
                webgl: 'disabled_software',
            }),
        ).toBe(false);
    });

    it.each([
        [0, 16 * GIB, 'medium'],
        [8, 0, 'medium'],
        [-1, 16 * GIB, 'medium'],
        [8, -1, 'medium'],
        [Number.NaN, 16 * GIB, 'medium'],
        [8, Number.NaN, 'medium'],
        [8, 8 * GIB, 'low'],
        [2, 64 * GIB, 'low'],
        [4, 12 * GIB, 'low'],
        [8, 8 * GIB + 1, 'medium'],
        [5, 12 * GIB, 'medium'],
        [4, 12 * GIB + 1, 'medium'],
        [8, 16 * GIB, 'high'],
        [8, 16 * GIB - 1, 'medium'],
        [7, 16 * GIB, 'medium'],
    ])('resolves %s logical CPUs and %s RAM bytes to %s', (logicalCpus, totalRamBytes, expectedTier) => {
        expect(
            resolveDetectedHostResourceTier({
                logicalCpus,
                totalRamBytes,
            }),
        ).toBe(expectedTier);
    });

    it.each([
        ['low', 'auto', 'low'],
        ['medium', 'auto', 'medium'],
        ['high', 'auto', 'high'],
        ['high', 'low', 'low'],
        ['low', 'medium', 'medium'],
        ['medium', 'high', 'high'],
    ] as const)('resolves detected %s with mode %s to %s', (detectedTier, performanceMode, expectedTier) => {
        expect(resolveEffectiveHostResourceTier(detectedTier, performanceMode)).toBe(expectedTier);
    });

    it.each([
        ['low', 'low'],
        ['medium', 'balanced'],
        ['high', 'high'],
    ] as const)('maps host tier %s to document-save tier %s', (hostTier, expectedTier) => {
        expect(resolveDocumentSavePerformanceTier(hostTier)).toBe(expectedTier);
    });

    it('decodes exact automatic and manual snapshots', () => {
        const automatic = {
            logicalCpus: 8,
            totalRamBytes: 16 * GIB,
            safeMode: false,
            gpuStatus: {
                gpu_compositing: 'enabled',
                webgl: 'disabled_software',
            },
            detectedTier: 'high',
            performanceMode: 'auto',
            tier: 'high',
        };
        const manual = {
            ...automatic,
            performanceMode: 'low',
            tier: 'low',
        };

        expect(decodeHostResourceProfileSnapshot(automatic)).toEqual(automatic);
        expect(decodeHostResourceProfileSnapshot(manual)).toEqual(manual);
        expect(
            decodeHostResourceProfileSnapshot({
                logicalCpus: 0,
                totalRamBytes: 0,
                safeMode: true,
                detectedTier: 'medium',
                performanceMode: 'auto',
                tier: 'medium',
            }),
        ).toEqual({
            logicalCpus: 0,
            totalRamBytes: 0,
            safeMode: true,
            detectedTier: 'medium',
            performanceMode: 'auto',
            tier: 'medium',
        });
    });

    it.each([
        {detectedTier: 'future'},
        {performanceMode: 'future'},
        {tier: 'future'},
        {logicalCpus: -1},
        {totalRamBytes: -1},
        {logicalCpus: 1.5},
        {totalRamBytes: Number.POSITIVE_INFINITY},
        {safeMode: 'false'},
        {gpuStatus: {webgl: 1}},
        {detectedTier: 'medium'},
        {tier: 'medium'},
        {
            performanceMode: 'low',
            tier: 'high',
        },
    ])('rejects an invalid snapshot override $0', (override) => {
        expect(
            decodeHostResourceProfileSnapshot({
                logicalCpus: 8,
                totalRamBytes: 16 * GIB,
                safeMode: false,
                gpuStatus: {webgl: 'enabled'},
                detectedTier: 'high',
                performanceMode: 'auto',
                tier: 'high',
                ...override,
            }),
        ).toBeNull();
    });
});
