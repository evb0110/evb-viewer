import {
    describe,
    expect,
    it,
} from 'vitest';
import {cast} from '@tests/helpers/cast';
import {requirePageNumber} from '@contracts/pageNumbers';
import { getCurrentSpreadRenderedBoundsFromDom } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/getCurrentSpreadRenderedBoundsFromDom';
import { resolvePageBoundedHorizontalScroll } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/resolvePageBoundedHorizontalScroll';

function createDomPage(options: {
    page: number;
    left: number;
    width: number;
    buffered?: boolean;
}) {
    return cast<HTMLElement>({
        classList: {contains: (className: string) => options.buffered === true
                && className === 'page_container--buffered'},
        clientWidth: options.width,
        dataset: {page: String(options.page)},
        getBoundingClientRect: () => ({
            left: options.left,
            width: options.width,
        }),
        offsetLeft: options.left,
        offsetWidth: options.width,
    });
}

describe('resolvePageBoundedHorizontalScroll', () => {
    it('falls back from buffered DOM spread bounds', () => {
        const bufferedPage = createDomPage({
            page: 1,
            left: 20,
            width: 1_200,
            buffered: true,
        });
        const container = cast<HTMLElement>({
            getBoundingClientRect: () => ({left: 0}),
            querySelector: (selector: string) => selector === '.page_container[data-page="1"]'
                ? bufferedPage
                : null,
            scrollLeft: 0,
        });

        expect(getCurrentSpreadRenderedBoundsFromDom({
            container,
            pageNumber: requirePageNumber(1),
            viewMode: 'single',
            totalPages: 1,
        })).toBeNull();
    });

    it('locks horizontal scroll to the active page when the page fits the viewport', () => {
        const result = resolvePageBoundedHorizontalScroll({
            scrollLeft: 1200,
            viewportWidth: 1982,
            pageLeft: 20,
            pageWidth: 1942,
            margin: 20,
        });

        expect(result).toEqual({
            minScrollLeft: 0,
            maxScrollLeft: 0,
            scrollLeft: 0,
            shouldLock: true,
        });
    });

    it('bounds horizontal scroll to the small overflow of a slightly wider active page', () => {
        const result = resolvePageBoundedHorizontalScroll({
            scrollLeft: 1200,
            viewportWidth: 1982,
            pageLeft: 20,
            pageWidth: 1955,
            margin: 20,
        });

        expect(result).toEqual({
            minScrollLeft: 0,
            maxScrollLeft: 13,
            scrollLeft: 13,
            shouldLock: false,
        });
    });

    it('keeps panning inside a genuinely wide active page bounded by that page, not the document', () => {
        const result = resolvePageBoundedHorizontalScroll({
            scrollLeft: 5000,
            viewportWidth: 1000,
            pageLeft: 20,
            pageWidth: 1400,
            margin: 20,
        });

        expect(result).toEqual({
            minScrollLeft: 0,
            maxScrollLeft: 440,
            scrollLeft: 440,
            shouldLock: false,
        });
    });

    it('centers a narrower active page instead of preserving unrelated document scroll', () => {
        const result = resolvePageBoundedHorizontalScroll({
            scrollLeft: 900,
            viewportWidth: 1000,
            pageLeft: 250,
            pageWidth: 500,
            margin: 20,
        });

        expect(result).toEqual({
            minScrollLeft: 0,
            maxScrollLeft: 0,
            scrollLeft: 0,
            shouldLock: true,
        });
    });
});
