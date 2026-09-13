import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveWorkspaceMemoryBudget,
    resolveWorkspaceMemoryDeviceTier,
    resolveWorkspaceMemoryReclaimPlan,
} from '@app/modules/workspace-shell/memory/workspaceMemoryBudget';
import type { IViewerReclaimCandidate } from '@app/utils/viewerResidencyPolicy';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function viewer(params: Partial<IViewerReclaimCandidate> & { viewerId: string }): IViewerReclaimCandidate {
    return {
        viewerId: params.viewerId,
        residencyState: params.residencyState ?? 'warm',
        isActive: params.isActive ?? false,
        canReclaim: params.canReclaim ?? true,
        lastActiveAt: params.lastActiveAt ?? 0,
        estimatedBytes: params.estimatedBytes,
    };
}

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

    it('selects inactive reclaim candidates deterministically when warm viewers exceed the budget', () => {
        const budget = {
            ...resolveWorkspaceMemoryBudget({ environment: {
                totalMemoryBytes: 16 * GIB,
                hardwareConcurrency: 8,
            } }),
            targetWarmViewers: 1,
            maxEstimatedWorkspaceBytes: 10 * GIB,
        };

        const plan = resolveWorkspaceMemoryReclaimPlan({
            budget,
            protectedViewerIds: ['protected-warm'],
            viewers: [
                viewer({
                    viewerId: 'active',
                    residencyState: 'active',
                    isActive: true,
                    estimatedBytes: 800 * MIB,
                }),
                viewer({
                    viewerId: 'protected-warm',
                    lastActiveAt: 1,
                    estimatedBytes: 900 * MIB,
                }),
                viewer({
                    viewerId: 'old-warm',
                    lastActiveAt: 2,
                    estimatedBytes: 100 * MIB,
                }),
                viewer({
                    viewerId: 'newer-large-warm',
                    lastActiveAt: 3,
                    estimatedBytes: 500 * MIB,
                }),
                viewer({
                    viewerId: 'newer-small-warm',
                    lastActiveAt: 4,
                    estimatedBytes: 50 * MIB,
                }),
            ],
        });

        expect(plan.warmViewerCount).toBe(4);
        expect(plan.overWarmViewerCount).toBe(3);
        expect(plan.candidates.map(candidate => candidate.viewerId)).toEqual([
            'old-warm',
            'newer-large-warm',
            'newer-small-warm',
        ]);
    });

    it('requests at least one candidate under critical pressure even before byte overflow', () => {
        const plan = resolveWorkspaceMemoryReclaimPlan({
            budget: resolveWorkspaceMemoryBudget({
                environment: {
                    totalMemoryBytes: 16 * GIB,
                    hardwareConcurrency: 8,
                },
                pressure: { level: 'critical' },
            }),
            viewers: [
                viewer({
                    viewerId: 'active',
                    residencyState: 'active',
                    isActive: true,
                    estimatedBytes: 256 * MIB,
                }),
                viewer({
                    viewerId: 'warm',
                    estimatedBytes: 128 * MIB,
                }),
            ],
        });

        expect(plan.overBudgetBytes).toBe(0);
        expect(plan.candidates.map(candidate => candidate.viewerId)).toEqual(['warm']);
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
