// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
} from 'vitest';
import { hasPointerMovedPastThreshold } from '@app/modules/pdf-viewer/engine/pdf-shape-overlay-interactions/hasPointerMovedPastThreshold';




describe('pdfShapeOverlayInteractions', () => {

    it('uses pixel movement when deciding whether a drag should start', () => {
        expect(hasPointerMovedPastThreshold(
            {
                clientX: 100,
                clientY: 200,
            },
            {
                clientX: 103,
                clientY: 203,
            },
            5,
        )).toBe(false);

        expect(hasPointerMovedPastThreshold(
            {
                clientX: 100,
                clientY: 200,
            },
            {
                clientX: 106,
                clientY: 200,
            },
            5,
        )).toBe(true);
    });
});
