// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    runDocumentViewerActivationPresentation,
    waitForDocumentViewerVisibleLayout,
} from '@app/modules/document-viewer/lifecycle/documentViewerActivationPresentation';

describe('document viewer activation presentation', () => {
    it('measures only after visible layout and reconciles after the measurement patch', async () => {
        let width = 0;
        const element = document.createElement('div');
        Object.defineProperty(element, 'clientWidth', {get: () => width});
        Object.defineProperty(element, 'clientHeight', {get: () => width});
        const order: string[] = [];

        const restored = await runDocumentViewerActivationPresentation({
            isCurrent: () => true,
            waitForVisibleLayout: () => waitForDocumentViewerVisibleLayout(
                () => element,
                {
                    isCurrent: () => true,
                    nextLayoutOpportunity: async () => {
                        order.push('layout');
                        width = 800;
                    },
                },
            ),
            measure: () => order.push(`measure:${String(width)}`),
            nextRenderTick: async () => { order.push('patch'); },
            reconcile: async () => { order.push('reconcile'); },
        });

        expect(restored).toBe(true);
        expect(order).toEqual([
            'layout',
            'measure:800',
            'patch',
            'reconcile',
        ]);
    });

    it('fences reconciliation when activation is invalidated while waiting for layout', async () => {
        const element = document.createElement('div');
        let current = true;
        const reconcile = vi.fn();

        const restored = await runDocumentViewerActivationPresentation({
            isCurrent: () => current,
            waitForVisibleLayout: () => waitForDocumentViewerVisibleLayout(
                () => element,
                {
                    isCurrent: () => current,
                    nextLayoutOpportunity: async () => { current = false; },
                },
            ),
            measure: vi.fn(),
            reconcile,
        });

        expect(restored).toBe(false);
        expect(reconcile).not.toHaveBeenCalled();
    });
});
