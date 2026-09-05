import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createThumbnailItemStyle,
    resolveThumbnailVirtualPages,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailLayout';

describe('createThumbnailItemStyle', () => {
    it('keeps the rendered row at least as tall as its virtual layout slot', () => {
        expect(createThumbnailItemStyle(412, 236)).toEqual({
            minHeight: '236px',
            transform: 'translateY(412px)',
        });
    });
});

describe('resolveThumbnailVirtualPages', () => {
    it('keeps current-page neighbors inside the active physical segment', () => {
        expect(resolveThumbnailVirtualPages(
            99,
            99,
            100,
            1,
            {
                endPage: 100,
                startPage: 98,
            },
        )).toEqual([
            98,
            99,
            100,
        ]);
    });
});
