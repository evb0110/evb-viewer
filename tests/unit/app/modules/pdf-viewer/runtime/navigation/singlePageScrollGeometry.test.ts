import { requirePageNumber } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getPageRowGeometry,
    getPageScrollBounds,
} from '@app/modules/pdf-viewer/runtime/navigation/singlePageScrollGeometry';

function createElementShim(shape: Record<string, unknown>): HTMLElement {
    // The geometry functions read only these layout properties and selectors.
    return Object.assign(Object.create(null), shape);
}

interface ITestPageGeometry {
    offsetLeft?: number;
    offsetTop: number;
    offsetWidth?: number;
    offsetHeight: number;
}

function createGeometryContainer(options: {
    clientHeight: number;
    clientWidth?: number;
    pages: ITestPageGeometry[];
    scrollHeight: number;
    scrollWidth?: number;
}) {
    const clientWidth = options.clientWidth ?? 100;
    const pageElements = options.pages.map((page, index) => createElementShim({
        clientHeight: page.offsetHeight,
        clientWidth: page.offsetWidth ?? clientWidth,
        dataset: { page: String(index + 1) },
        offsetHeight: page.offsetHeight,
        offsetLeft: page.offsetLeft ?? 0,
        offsetTop: page.offsetTop,
        offsetWidth: page.offsetWidth ?? clientWidth,
    }));

    const container = createElementShim({
        clientHeight: options.clientHeight,
        clientWidth,
        scrollHeight: options.scrollHeight,
        scrollWidth: options.scrollWidth ?? clientWidth,
        querySelector: (selector: string) => {
            const match = selector.match(/\.page_container\[data-page="(\d+)"\]/);
            if (!match?.[1]) {
                return null;
            }
            const pageNumber = Number.parseInt(match[1], 10);
            return pageElements[pageNumber - 1] ?? null;
        },
    });

    return {
        container,
        pageElements,
    };
}

describe('singlePageScrollGeometry', () => {
    it('uses the mounted spread row for page scroll bounds', () => {
        const { container } = createGeometryContainer({
            clientHeight: 100,
            pages: [
                {
                    offsetTop: 10,
                    offsetHeight: 70,
                },
                {
                    offsetTop: 120,
                    offsetHeight: 180,
                },
                {
                    offsetTop: 115,
                    offsetHeight: 130,
                },
            ],
            scrollHeight: 500,
        });

        expect(getPageRowGeometry({
            container,
            pageNumber: requirePageNumber(2),
            totalPages: 3,
            viewMode: 'facing',
        })).toEqual({
            top: 10,
            height: 290,
        });
        expect(getPageScrollBounds({
            container,
            pageNumber: requirePageNumber(2),
            scaledMargin: 20,
            totalPages: 3,
            viewMode: 'facing',
        })).toEqual({
            min: 0,
            max: 190,
        });
    });
});
