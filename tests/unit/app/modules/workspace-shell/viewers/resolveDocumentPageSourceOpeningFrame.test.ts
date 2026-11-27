// @vitest-environment happy-dom
import {describe, expect, it, vi} from 'vitest';
import {readArrivedViewportClientSize, resolveDocumentPageSourceOpeningFrame} from '@app/modules/document-viewer/public';

const geometry = {
    documentId: '/documents/scan.djvu',
    pageNumber: 1,
    pageCount: 100,
    width: 1200,
    height: 1600,
    rotation: 0,
} as const;

describe('resolveDocumentPageSourceOpeningFrame', () => {
    it('derives the exact fit-width shell from the live chassis viewport', () => {
        const frame = resolveDocumentPageSourceOpeningFrame({
            geometry,
            viewport: {
                width: 900,
                height: 537,
            },
            zoom: 1,
            zoomMode: 'fit-width',
        });
        expect(frame?.width).toBeCloseTo(860);
        expect(frame?.height).toBeCloseTo(1146.6666666666667);
        expect(Number.parseFloat(frame?.style.width ?? '')).toBeCloseTo(860);
        expect(Number.parseFloat(frame?.style.height ?? '')).toBeCloseTo(1146.6666666666667);
    });

    it('uses the live viewport height for fit-height and the zoom policy for custom scale', () => {
        expect(
            resolveDocumentPageSourceOpeningFrame({
                geometry,
                viewport: {
                    width: 900,
                    height: 832,
                },
                zoom: 1,
                zoomMode: 'fit-height',
            })?.height,
        ).toBe(792);
        expect(
            resolveDocumentPageSourceOpeningFrame({
                geometry,
                viewport: {
                    width: 900,
                    height: 832,
                },
                zoom: 1.25,
                zoomMode: 'custom',
            })?.width,
        ).toBe(1500);
    });

    it('refuses to claim a frame without a usable live viewport', () => {
        expect(
            resolveDocumentPageSourceOpeningFrame({
                geometry,
                viewport: {
                    width: 0,
                    height: 537,
                },
                zoom: 1,
                zoomMode: 'fit-width',
            }),
        ).toBeNull();
    });
});

describe('readArrivedViewportClientSize', () => {
    // A 900x548 viewport whose stable gutter holds a 15px scrollbar.
    function createViewport(box: {
        clientHeight: number;
        scrollWidth: number;
        clientWidth?: number;
        offsetHeight?: number;
        offsetWidth?: number;
        suppressed?: boolean;
    }) {
        const viewport = document.createElement('div');
        Object.defineProperties(viewport, {
            clientHeight: {value: box.clientHeight},
            clientWidth: {value: box.clientWidth ?? 885},
            offsetHeight: {value: box.offsetHeight ?? 548},
            offsetWidth: {value: box.offsetWidth ?? 900},
            scrollWidth: {value: box.scrollWidth},
        });
        // The chassis suppresses scrolling with an inline overflow.
        if (box.suppressed ?? true) {
            viewport.style.overflow = 'hidden';
        }
        return viewport;
    }

    it("takes a wide page's horizontal scrollbar from an opening viewport that still hides overflow", () => {
        expect(
            readArrivedViewportClientSize(
                createViewport({
                    clientHeight: 548,
                    scrollWidth: 1400,
                }),
            ),
        ).toEqual({
            width: 885,
            height: 533,
        });
    });

    it('keeps the live height of a page that fits, and of a renderer that locks the horizontal axis', () => {
        expect(
            readArrivedViewportClientSize(
                createViewport({
                    clientHeight: 548,
                    scrollWidth: 885,
                }),
            ).height,
        ).toBe(548);
        expect(
            readArrivedViewportClientSize(
                createViewport({
                    clientHeight: 548,
                    scrollWidth: 1400,
                }),
                true,
            ).height,
        ).toBe(548);
    });

    it('is the live client size once the view scrolls again, whatever its overflow', () => {
        // A fit-width page a pixel wider than the box, with the axis locked by CSS: no bar.
        expect(
            readArrivedViewportClientSize(
                createViewport({
                    clientHeight: 548,
                    scrollWidth: 886,
                    suppressed: false,
                }),
            ).height,
        ).toBe(548);
        // At a fractional scale the shown bar can round a pixel thinner than the gutter.
        expect(
            readArrivedViewportClientSize(
                createViewport({
                    clientHeight: 534,
                    scrollWidth: 1400,
                    suppressed: false,
                }),
            ).height,
        ).toBe(534);
    });

    it('takes only the part of the bar not shown yet', () => {
        expect(
            readArrivedViewportClientSize(
                createViewport({
                    clientHeight: 534,
                    scrollWidth: 1400,
                }),
            ).height,
        ).toBe(533);
    });

    it('takes one bar when the gutter is stable on both edges', () => {
        const viewport = createViewport({
            clientHeight: 548,
            clientWidth: 870,
            scrollWidth: 1400,
        });
        // The test DOM computes no scrollbar-gutter; report Chromium's style for this box.
        const getComputed = vi.spyOn(window, 'getComputedStyle').mockReturnValue({
            borderBottomWidth: '0px',
            borderLeftWidth: '0px',
            borderRightWidth: '0px',
            borderTopWidth: '0px',
            getPropertyValue: (name: string) => (name === 'scrollbar-gutter' ? 'stable both-edges' : ''),
        } as unknown as CSSStyleDeclaration);
        try {
            expect(readArrivedViewportClientSize(viewport).height).toBe(533);
        } finally {
            getComputed.mockRestore();
        }
    });

    it('never returns a negative height for a viewport smaller than the bar', () => {
        expect(
            readArrivedViewportClientSize(
                createViewport({
                    clientHeight: 10,
                    offsetHeight: 10,
                    scrollWidth: 1400,
                }),
            ).height,
        ).toBe(0);
    });
});
