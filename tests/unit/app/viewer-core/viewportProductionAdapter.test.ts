import {
    describe,
    expect,
    it,
} from 'vitest';
import { createProductionViewportAdapter } from '@tests/helpers/viewer-core/createProductionViewportAdapter';

describe('viewportSimulation production seams', () => {
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
