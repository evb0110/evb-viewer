import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    isDocumentThumbnailWithinComfortViewport,
    resolveDocumentThumbnailRevealScrollTop,
} from '@app/modules/document-viewer/thumbnails/documentThumbnailViewport';

describe('document thumbnail viewport policy', () => {
    it('centers a distant authoritative page and does not reveal page one first', () => {
        const viewport = {
            clientHeight: 600,
            scrollHeight: 20_000,
            scrollTop: 0,
        };
        const pageEighteen = {
            top: 7_200,
            bottom: 7_580,
            height: 380,
        };

        expect(resolveDocumentThumbnailRevealScrollTop(viewport, pageEighteen)).toBe(7_090);
    });

    it('preserves a current item already inside the shared comfort region', () => {
        const viewport = {
            clientHeight: 600,
            scrollHeight: 20_000,
            scrollTop: 7_000,
        };
        const bounds = {
            top: 7_100,
            bottom: 7_480,
            height: 380,
        };

        expect(isDocumentThumbnailWithinComfortViewport(viewport, bounds)).toBe(true);
        expect(resolveDocumentThumbnailRevealScrollTop(viewport, bounds)).toBeNull();
    });

    it('moves a clipped nearby item only enough to restore the comfort inset', () => {
        const viewport = {
            clientHeight: 600,
            scrollHeight: 20_000,
            scrollTop: 7_000,
        };
        const bounds = {
            top: 6_980,
            bottom: 7_360,
            height: 380,
        };

        expect(resolveDocumentThumbnailRevealScrollTop(viewport, bounds)).toBe(6_932);
    });
});
