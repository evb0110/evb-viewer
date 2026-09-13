import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    canSyncDocumentViewportNavigationFromViewport,
    createDocumentViewportNavigationMachineState,
    getDocumentViewportNavigationStatusForSource,
    getDocumentViewportNavigationTargetPageForSource,
    getDocumentViewportNavigationTxnForSource,
    isDocumentViewportNavigationTargetCurrent,
    isDocumentViewportNavigationTxnCurrent,
    reduceDocumentViewportNavigationMachine,
} from '@app/modules/document-viewer/viewport/documentViewportNavigationMachine';

describe('document viewport navigation machine', () => {
    it('supersedes in-flight navigation with one current transaction', () => {
        const first = reduceDocumentViewportNavigationMachine(createDocumentViewportNavigationMachineState(), {
            type: 'NAVIGATE',
            source: 'paged',
            targetPage: 2,
            anchor: 'top',
        });
        const second = reduceDocumentViewportNavigationMachine(first, {
            type: 'NAVIGATE',
            source: 'paged',
            targetPage: 3,
            anchor: 'center',
        });

        expect(second).toMatchObject({
            status: 'navigating',
            targetPage: 3,
            txn: 2,
        });
        expect(isDocumentViewportNavigationTxnCurrent(second, first.txn)).toBe(false);
        expect(isDocumentViewportNavigationTxnCurrent(second, second.txn)).toBe(true);
    });

    it('keeps the target page authoritative before render settles', () => {
        const navigating = reduceDocumentViewportNavigationMachine(createDocumentViewportNavigationMachineState(0, 1), {
            type: 'NAVIGATE',
            source: 'paged',
            targetPage: 5,
        });
        const staleViewport = reduceDocumentViewportNavigationMachine(navigating, {
            type: 'VIEWPORT_CURRENT_PAGE',
            page: 1,
        });

        expect(navigating.currentPage).toBe(5);
        expect(staleViewport.currentPage).toBe(5);
    });

    it('accepts viewport current-page sync after matching render settle', () => {
        const navigating = reduceDocumentViewportNavigationMachine(createDocumentViewportNavigationMachineState(0, 1), {
            type: 'NAVIGATE',
            source: 'continuous',
            targetPage: 6,
        });
        const settling = reduceDocumentViewportNavigationMachine(navigating, {
            type: 'SCROLL_APPLIED',
            txn: navigating.txn,
            page: 6,
        });
        const idle = reduceDocumentViewportNavigationMachine(settling, {
            type: 'RENDER_SETTLED',
            txn: navigating.txn,
            page: 6,
        });
        const synced = reduceDocumentViewportNavigationMachine(idle, {
            type: 'VIEWPORT_CURRENT_PAGE',
            page: 4,
        });

        expect(idle.status).toBe('idle');
        expect(synced.currentPage).toBe(4);
    });

    it('reports source-scoped active target state', () => {
        const continuous = reduceDocumentViewportNavigationMachine(createDocumentViewportNavigationMachineState(), {
            type: 'NAVIGATE',
            source: 'continuous',
            targetPage: 12,
        });
        const settling = reduceDocumentViewportNavigationMachine(continuous, {
            type: 'SCROLL_APPLIED',
            txn: continuous.txn,
            page: 12,
        });

        expect(canSyncDocumentViewportNavigationFromViewport(settling)).toBe(false);
        expect(getDocumentViewportNavigationStatusForSource(settling, 'continuous')).toBe('settling');
        expect(getDocumentViewportNavigationStatusForSource(settling, 'search')).toBe('idle');
        expect(getDocumentViewportNavigationTargetPageForSource(settling, 'continuous')).toBe(12);
        expect(getDocumentViewportNavigationTargetPageForSource(settling, 'paged')).toBeNull();
        expect(getDocumentViewportNavigationTxnForSource(settling, 'continuous')).toBe(settling.txn);
        expect(getDocumentViewportNavigationTxnForSource(settling, 'paged')).toBeNull();
        expect(isDocumentViewportNavigationTargetCurrent(
            settling,
            'continuous',
            settling.txn,
            12,
        )).toBe(true);
    });
});
