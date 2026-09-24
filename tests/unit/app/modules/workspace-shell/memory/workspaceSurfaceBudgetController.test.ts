import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createWorkspaceSurfaceBudgetController,
    estimateCanvasSurfaceBytes,
} from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';
import {
    DOCUMENT_SOURCE_INACTIVE_LEASE_GRACE_MS,
    shouldRetainInactiveDocumentPageSourceLease,
} from '@app/modules/workspace-shell/viewers/useDocumentPageSourceRuntime';
import { resolvePerformanceProfile } from '@app/utils/performanceProfile';
import { resolveOpenPathSecondaryPerformancePolicy } from '@app/utils/resolveOpenPathSecondaryPerformancePolicy';

describe('workspace surface budget controller', () => {
    it.each([
        [
            'medium',
            'healthy',
            true,
        ],
        [
            'high',
            'guarded',
            true,
        ],
        [
            'low',
            'healthy',
            false,
        ],
        [
            'medium',
            'moderate',
            false,
        ],
        [
            'medium',
            'critical',
            false,
        ],
        [
            'medium',
            'emergency',
            false,
        ],
        [
            'medium',
            'post-crash-safe-mode',
            false,
        ],
    ] as const)('plans inactive DjVu residency for %s tier under %s pressure', (
        tier,
        pressure,
        expected,
    ) => {
        const policy = resolveOpenPathSecondaryPerformancePolicy(resolvePerformanceProfile({tier}));
        expect(shouldRetainInactiveDocumentPageSourceLease(
            policy.inactiveDjvuLeasePolicy === 'warm-grace',
            pressure,
        )).toEqual(expected);
    });

    it('retains the inactive current page for exactly 1.5 seconds', () => {
        expect(DOCUMENT_SOURCE_INACTIVE_LEASE_GRACE_MS).toBe(1_500);
    });

    it('accounts and releases every decoded surface category', () => {
        const controller = createWorkspaceSurfaceBudgetController(10_000);
        const categories = [
            'pdf-page-canvas',
            'pdf-annotation-canvas',
            'pdf-thumbnail-canvas',
            'djvu-preview',
        ] as const;
        for (const category of categories) {
            controller.reserve({
                scopeId: `surface:${category}`,
                category,
                bytes: 100,
            });
        }

        expect(controller.getSnapshot()).toMatchObject({
            reservedBytes: 400,
            leaseCount: 4,
            reservedBytesByCategory: Object.fromEntries(categories.map(category => [
                category,
                100,
            ])),
        });
        for (const category of categories) controller.releaseScope(`surface:${category}`);
        expect(controller.getSnapshot()).toMatchObject({
            reservedBytes: 0,
            leaseCount: 0,
        });
    });

    it('accounts surface leases by category and scope and releases idempotently', () => {
        const controller = createWorkspaceSurfaceBudgetController(1_000);
        const first = controller.reserve({
            scopeId: 'viewer-a',
            category: 'pdf-page-canvas',
            bytes: 400,
        });
        controller.reserve({
            scopeId: 'viewer-b',
            category: 'pdf-thumbnail-canvas',
            bytes: 150,
        });

        expect(controller.getSnapshot()).toMatchObject({
            maxBytes: 1_000,
            reservedBytes: 550,
            leaseCount: 2,
            reservedBytesByCategory: {
                'pdf-page-canvas': 400,
                'pdf-thumbnail-canvas': 150,
            },
        });

        first.release();
        first.release();
        controller.releaseScope('viewer-b');
        expect(controller.getSnapshot()).toMatchObject({
            reservedBytes: 0,
            leaseCount: 0,
        });
    });

    it('keeps scope and individual lease release idempotent when cleanup paths overlap', () => {
        const controller = createWorkspaceSurfaceBudgetController(1_000);
        const lease = controller.reserve({
            scopeId: 'viewer',
            category: 'pdf-page-canvas',
            bytes: 400,
        });

        controller.releaseScope('viewer');
        lease.release();

        expect(controller.getSnapshot()).toMatchObject({
            reservedBytes: 0,
            leaseCount: 0,
        });
    });

    it('rejects a provisional reservation when protected surfaces exhaust the budget', () => {
        const controller = createWorkspaceSurfaceBudgetController(1_000);
        controller.reserve({
            scopeId: 'visible',
            category: 'pdf-page-canvas',
            bytes: 800,
            canEvict: () => false,
        });

        const rejected = controller.tryReserve({
            scopeId: 'pending',
            category: 'pdf-page-canvas',
            bytes: 300,
            canEvict: () => false,
        });

        expect(rejected).toBeNull();
        expect(controller.getSnapshot()).toMatchObject({
            reservedBytes: 800,
            leaseCount: 1,
        });
    });

    it('does not evict live surfaces when a provisional reservation cannot fit', () => {
        const controller = createWorkspaceSurfaceBudgetController(1_000);
        const evicted: string[] = [];
        controller.reserve({
            scopeId: 'thumbnail',
            category: 'pdf-thumbnail-canvas',
            bytes: 400,
            evict: () => evicted.push('thumbnail'),
        });

        const rejected = controller.tryReserve({
            scopeId: 'oversized',
            category: 'pdf-page-canvas',
            bytes: 1_200,
            canEvict: () => false,
        });

        expect(rejected).toBeNull();
        expect(evicted).toEqual([]);
        expect(controller.getSnapshot()).toMatchObject({
            reservedBytes: 400,
            leaseCount: 1,
        });
    });

    it('admits a provisional reservation after reclaiming a lower-priority surface', () => {
        const controller = createWorkspaceSurfaceBudgetController(1_000);
        const evicted: string[] = [];
        controller.reserve({
            scopeId: 'thumbnail',
            category: 'pdf-thumbnail-canvas',
            bytes: 400,
            evict: () => evicted.push('thumbnail'),
        });
        controller.reserve({
            scopeId: 'visible',
            category: 'pdf-page-canvas',
            bytes: 400,
            canEvict: () => false,
        });

        const admitted = controller.tryReserve({
            scopeId: 'pending',
            category: 'pdf-page-canvas',
            bytes: 400,
            canEvict: () => false,
            priority: 100,
        });

        expect(admitted).not.toBeNull();
        expect(evicted).toEqual(['thumbnail']);
        expect(controller.getSnapshot().reservedBytes).toBe(800);
    });

    it('counts canvas backing stores at four bytes per physical pixel', () => {
        expect(estimateCanvasSurfaceBytes({
            width: 1200,
            height: 800,
        })).toBe(3_840_000);
        expect(estimateCanvasSurfaceBytes({
            width: 0,
            height: 800,
        })).toBe(0);
    });

    it('evicts low-priority reclaimable surfaces as the live pressure budget contracts', () => {
        const controller = createWorkspaceSurfaceBudgetController(1_000);
        const evicted: string[] = [];
        controller.reserve({
            scopeId: 'thumb',
            category: 'pdf-thumbnail-canvas',
            bytes: 300,
            priority: 0,
            evict: () => evicted.push('thumb'),
        });
        controller.reserve({
            scopeId: 'visible',
            category: 'pdf-page-canvas',
            bytes: 300,
            priority: 100,
            evict: () => evicted.push('visible'),
            canEvict: () => false,
        });

        controller.setPressureLevel('critical');

        expect(evicted).toEqual(['thumb']);
        expect(controller.getSnapshot()).toMatchObject({
            effectiveMaxBytes: 500,
            pressureLevel: 'critical',
            reservedBytes: 300,
        });
    });

    it('promotes a completed lease without reallocating it or allowing later demotion', () => {
        const controller = createWorkspaceSurfaceBudgetController(1_000);
        const evicted: string[] = [];
        const promoted = controller.reserve({
            scopeId: 'promoted',
            category: 'djvu-preview',
            bytes: 300,
            priority: 10,
            evict: () => evicted.push('promoted'),
        });
        controller.reserve({
            scopeId: 'nearby',
            category: 'djvu-preview',
            bytes: 300,
            priority: 50,
            evict: () => evicted.push('nearby'),
        });

        promoted.promotePriority?.(100);
        promoted.promotePriority?.(20);
        controller.setPressureLevel('critical');

        expect(evicted).toEqual(['nearby']);
        expect(controller.getSnapshot()).toMatchObject({
            leaseCount: 1,
            reservedBytes: 300,
        });
    });

    it('updates a live lease priority in both directions as residency changes', () => {
        const controller = createWorkspaceSurfaceBudgetController(1_000);
        const evicted: string[] = [];
        const changing = controller.reserve({
            scopeId: 'changing',
            category: 'djvu-preview',
            bytes: 300,
            priority: 100,
            evict: () => evicted.push('changing'),
        });
        controller.reserve({
            scopeId: 'stable',
            category: 'pdf-page-canvas',
            bytes: 300,
            priority: 50,
            evict: () => evicted.push('stable'),
        });

        changing.setPriority?.(10);
        controller.setPressureLevel('critical');

        expect(evicted).toEqual(['changing']);
        expect(controller.getSnapshot()).toMatchObject({
            leaseCount: 1,
            reservedBytes: 300,
        });
    });

    it('reconciles reservations that become evictable after admission across all surface categories', () => {
        const controller = createWorkspaceSurfaceBudgetController(500);
        const categories = [
            'pdf-page-canvas',
            'pdf-annotation-canvas',
            'pdf-thumbnail-canvas',
            'djvu-preview',
        ] as const;
        let allowEviction = false;
        const evicted: string[] = [];
        for (const category of categories) {
            controller.reserve({
                scopeId: category,
                category,
                bytes: 150,
                canEvict: () => allowEviction,
                evict: () => evicted.push(category),
            });
        }
        expect(controller.getSnapshot().reservedBytes).toBe(600);

        allowEviction = true;
        expect(controller.enforceBudget()).toBe(true);
        expect(evicted).toEqual(['pdf-page-canvas']);
        expect(controller.getSnapshot().reservedBytes).toBe(450);
    });
});
