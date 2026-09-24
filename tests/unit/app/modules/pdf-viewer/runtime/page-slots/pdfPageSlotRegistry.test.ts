import {
    describe,
    expect,
    it,
} from 'vitest';
import { createPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';

describe('createPdfPageSlotRegistry', () => {
    it('isolates an incoming feature owner from stale outgoing cleanup', () => {
        const registry = createPdfPageSlotRegistry();
        const outgoing = registry.createOwner('pdf:old');
        const incoming = registry.createOwner('djvu:new');

        incoming.markMounted(7);
        outgoing.markMounted(7);
        outgoing.markUnmounted(7);
        outgoing.dispose();

        expect(incoming.isMounted(7)).toBe(true);
        incoming.markUnmounted(7);
        expect(incoming.isMounted(7)).toBe(false);
    });
});
