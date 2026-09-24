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

    it('I18 production slot readiness is abortable under adversarial mount ordering', async () => {
        const {pageSlots} = createProductionViewportAdapter();
        const stale = new AbortController();
        const latest = new AbortController();
        const staleReadiness = pageSlots.whenMounted(30, stale.signal);
        const latestReadiness = pageSlots.whenMounted(928, latest.signal);

        stale.abort();
        pageSlots.markMounted(928);

        await expect(staleReadiness).rejects.toMatchObject({name: 'AbortError'});
        await expect(latestReadiness).resolves.toBeUndefined();
        expect(pageSlots.isMounted(30)).toBe(false);
        expect(pageSlots.isMounted(928)).toBe(true);
    });
});
