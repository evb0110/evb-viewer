import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createAnchorPageWindow,
} from '@app/modules/document-viewer/virtualization/pageVirtualization';

describe('document viewer page virtualization', () => {
    it('creates fallback anchor windows clamped to document bounds', () => {
        expect(createAnchorPageWindow({
            anchorPage: 1,
            totalPages: 5,
            radiusPages: 4,
        })).toEqual({
            start: 1,
            end: 5,
        });

        expect(createAnchorPageWindow({
            anchorPage: null,
            totalPages: 5,
            radiusPages: 4,
        })).toBeNull();
    });
});
