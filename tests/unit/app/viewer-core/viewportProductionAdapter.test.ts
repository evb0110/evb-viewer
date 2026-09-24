import { requirePageNumber } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { createProductionViewportAdapter } from '@tests/helpers/viewer-core/createProductionViewportAdapter';

describe('viewportSimulation production seams', () => {

    it('I10/I11 production render state clears replaced pixels through a failed successor', () => {
        const {renderState} = createProductionViewportAdapter();
        renderState.renderedPages.add(requirePageNumber(56));
        renderState.beginRender(requirePageNumber(56), 2, 9, 'document-1', 1);
        renderState.markRenderFailed(requirePageNumber(56), 2, 9);

        expect(renderState.renderedPages.has(requirePageNumber(56))).toBe(false);
        expect(renderState.getSlot(requirePageNumber(56))).toMatchObject({
            job: 'failed',
            visual: 'none',
        });
    });

    it('I13 production geometry mounts a bounded local window at page 500', () => {
        const adapter = createProductionViewportAdapter();
        const window = adapter.resolveWindow({
            currentPage: 500,
            scrollTop: 499 * 1_010,
            totalPages: 928,
        });

        expect(window?.pageNumbers).toContain(500);
        expect(window?.pageNumbers.length).toBeLessThanOrEqual(7);
        expect(window?.pageNumbers).not.toContain(1);
    });
});
