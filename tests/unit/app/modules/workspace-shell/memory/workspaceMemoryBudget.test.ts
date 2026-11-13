import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveWorkspaceMemoryBudget,
    resolveWorkspaceMemoryDeviceTier,
} from '@app/modules/document-viewer/runtime/workspaceMemoryBudget';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

describe('workspace memory budget', () => {
    it('derives device tiers from the existing performance profile inputs', () => {
        expect(resolveWorkspaceMemoryBudget({ environment: {
            totalMemoryBytes: 4 * GIB,
            hardwareConcurrency: 4,
        } })).toMatchObject({
            deviceTier: 'low',
            maxCachedPdfPagesPerViewer: 16,
            maxWarmViewers: 2,
        });

        expect(resolveWorkspaceMemoryBudget({
            environment: {
                totalMemoryBytes: 32 * GIB,
                hardwareConcurrency: 8,
            },
            pressure: { level: 'moderate' },
        })).toMatchObject({
            deviceTier: 'high',
            maxCachedPdfPagesPerViewer: 48,
            maxWarmViewers: 4,
            pressureLevel: 'moderate',
        });
    });

    it.each([
        {
            tier: 'low' as const,
            maxWarmViewers: 2,
            maxCachedPdfPagesPerViewer: 16,
            maxEstimatedWorkspaceBytes: 768 * MIB,
            reclaimTargetBytes: 128 * MIB,
        },
        {
            tier: 'medium' as const,
            maxWarmViewers: 3,
            maxCachedPdfPagesPerViewer: 48,
            maxEstimatedWorkspaceBytes: 1536 * MIB,
            reclaimTargetBytes: 256 * MIB,
        },
        {
            tier: 'high' as const,
            maxWarmViewers: 5,
            maxCachedPdfPagesPerViewer: 48,
            maxEstimatedWorkspaceBytes: 3072 * MIB,
            reclaimTargetBytes: 512 * MIB,
        },
    ])('keeps the existing $tier numeric base', ({
        tier,
        ...expected
    }) => {
        expect(resolveWorkspaceMemoryBudget({environment: { tier }})).toMatchObject({
            deviceTier: tier,
            ...expected,
        });
    });

    it('derives bounded raster and free-memory reserves from physical memory', () => {
        expect(resolveWorkspaceMemoryBudget({environment: { totalMemoryBytes: 4 * GIB }})).toMatchObject({
            maxRasterSurfaceBytes: 0.24 * GIB,
            systemFreeReserveBytes: 1 * GIB,
        });
        expect(resolveWorkspaceMemoryBudget({environment: {
            totalMemoryBytes: 64 * GIB,
            hardwareConcurrency: 24,
        }})).toMatchObject({
            maxRasterSurfaceBytes: 1536 * MIB,
            systemFreeReserveBytes: 4 * GIB,
        });
    });

    it('uses the canonical performance profile tier without reclassifying it', () => {
        expect(resolveWorkspaceMemoryDeviceTier({
            performanceMode: 'auto',
            tier: 'medium',
            lowMemory: false,
            lowCpu: false,
            pdfBufferPages: 2,
            concurrentPdfRenders: 3,
            maxCachedPdfPages: 48,
            thumbnailBaseConcurrency: 2,
            settledMaxCanvasPixels: 2 ** 25,
            maxBufferCanvasPixels: 16_777_216,
        })).toBe('medium');
    });

    it.each([
        {
            level: undefined,
            targetWarmViewers: 5,
        },
        {
            level: 'moderate' as const,
            targetWarmViewers: 4,
        },
        {
            level: 'critical' as const,
            targetWarmViewers: 0,
        },
    ])('adapts the warm-viewer target to $level pressure', ({
        level,
        targetWarmViewers,
    }) => {
        expect(resolveWorkspaceMemoryBudget({
            environment: {
                totalMemoryBytes: 32 * GIB,
                hardwareConcurrency: 8,
            },
            pressure: level ? {level} : undefined,
        }).targetWarmViewers).toBe(targetWarmViewers);
    });
});
