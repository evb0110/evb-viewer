import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    captureDocumentZoomAnchor,
    resolveDocumentZoomAnchorScroll,
    resolveRetainedDocumentZoomAnchor,
} from '@app/modules/document-viewer/zoomAnchor';

describe('document zoom anchor', () => {
    it('preserves the page-relative viewport center across reflow', () => {
        const viewport = {
            clientHeight: 400,
            clientWidth: 500,
            scrollLeft: 0,
            scrollTop: 600,
        };
        const anchor = captureDocumentZoomAnchor(viewport, [
            {
                top: 16,
                width: 400,
                height: 1_000,
            },
            {
                top: 1_032,
                width: 400,
                height: 1_000,
            },
        ]);
        expect(anchor).toMatchObject({
            pageIndex: 0,
            yRatio: 0.784,
        });

        const restored = resolveDocumentZoomAnchorScroll(viewport, [
            {
                top: 16,
                width: 800,
                height: 2_000,
            },
            {
                top: 2_032,
                width: 800,
                height: 2_000,
            },
        ], anchor);
        expect(restored).toEqual({
            left: 150,
            top: 1_384,
        });
        expect(viewport.scrollTop).toBe(600);
        expect(viewport.scrollLeft).toBe(0);
    });

    it('retains a latent anchor when a narrow viewport clamps its scroll', () => {
        const layouts = [{
            top: 20,
            width: 300,
            height: 400,
        }];
        const retained = {
            pageIndex: 0,
            xRatio: 0.5,
            yRatio: 0.8,
        };
        const viewport = {
            clientHeight: 600,
            clientWidth: 360,
            scrollHeight: 440,
            scrollLeft: 0,
            scrollTop: 0,
            scrollWidth: 360,
        };

        expect(resolveRetainedDocumentZoomAnchor(viewport, layouts, retained)).toBe(retained);
        viewport.scrollTop = 20;
        viewport.scrollHeight = 800;
        expect(resolveRetainedDocumentZoomAnchor(viewport, layouts, retained)).not.toBe(retained);
    });

    it('preserves a pointer-relative point on a page with an explicit surface offset', () => {
        const viewport = {
            clientHeight: 400,
            clientWidth: 500,
            scrollLeft: 500,
            scrollTop: 600,
        };
        const anchor = captureDocumentZoomAnchor(viewport, [{
            left: 300,
            top: 16,
            width: 400,
            height: 1_000,
        }], {
            x: 100,
            y: 100,
        });

        expect(anchor).toMatchObject({
            pageIndex: 0,
            viewportX: 100,
            viewportXRatio: 0.2,
            viewportY: 100,
            viewportYRatio: 0.25,
            xRatio: 0.75,
            yRatio: 0.684,
        });
        viewport.clientHeight = 388;
        expect(resolveDocumentZoomAnchorScroll(viewport, [{
            left: 600,
            top: 16,
            width: 800,
            height: 2_000,
        }], anchor)).toEqual({
            left: 1_100,
            top: 1_284,
        });
    });

    it('clamps a retained pointer position when the viewport shrinks around it', () => {
        const viewport = {
            clientHeight: 400,
            clientWidth: 500,
            scrollLeft: 500,
            scrollTop: 600,
        };
        const anchor = captureDocumentZoomAnchor(viewport, [{
            left: 300,
            top: 16,
            width: 400,
            height: 1_000,
        }], {
            x: 480,
            y: 390,
        });
        viewport.clientWidth = 300;
        viewport.clientHeight = 200;

        expect(resolveDocumentZoomAnchorScroll(viewport, [{
            left: 600,
            top: 16,
            width: 800,
            height: 2_000,
        }], anchor)).toEqual({
            left: 1_660,
            top: 1_764,
        });
    });

    it('anchors the visible page explicitly when single-page layouts overlap', () => {
        const viewport = {
            clientHeight: 400,
            clientWidth: 500,
            scrollLeft: 0,
            scrollTop: 0,
        };
        const anchor = captureDocumentZoomAnchor(viewport, [
            {
                left: 50,
                top: 16,
                width: 400,
                height: 1_000,
            },
            {
                left: 20,
                top: 16,
                width: 800,
                height: 2_000,
            },
        ], {
            x: 100,
            y: 100,
        }, 1);

        expect(anchor).toMatchObject({
            pageIndex: 1,
            xRatio: 0.1,
            yRatio: 0.042,
        });
    });

    it('does not snap a page edge to a pointer positioned in the margin', () => {
        const viewport = {
            clientHeight: 400,
            clientWidth: 1_000,
            scrollLeft: 0,
            scrollTop: 0,
        };
        const anchor = captureDocumentZoomAnchor(viewport, [{
            left: 300,
            top: 16,
            width: 400,
            height: 1_000,
        }], {
            x: 100,
            y: 100,
        });

        expect(anchor?.xRatio).toBe(-0.5);
        expect(resolveDocumentZoomAnchorScroll(viewport, [{
            left: 600,
            top: 16,
            width: 800,
            height: 2_000,
        }], anchor)).toEqual({
            left: 100,
            top: 84,
        });
    });

    it('anchors on the same page as a full scan in continuous single-column and facing layouts', () => {
        // The nearest page by a full scan: first page with the least distance.
        const scanNearest = (layouts: ReadonlyArray<{
            top: number;
            height: number
        }>, y: number) => {
            let best = 0;
            let bestDistance = Number.POSITIVE_INFINITY;
            layouts.forEach((layout, index) => {
                const bottom = layout.top + layout.height;
                const distance = y < layout.top ? layout.top - y : y > bottom ? y - bottom : 0;
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = index;
                }
            });
            return best;
        };
        let seed = 7;
        const random = () => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed / 2_147_483_648;
        };
        for (let trial = 0; trial < 300; trial += 1) {
            const facing = trial % 2 === 1;
            const gap = trial % 3 === 0 ? 0 : 16;
            const layouts: Array<{
                top: number;
                height: number;
                width: number;
                left: number
            }> = [];
            let top = 0;
            const pageCount = 1 + Math.floor(random() * 40);
            for (let index = 0; index < pageCount; index += facing ? 2 : 1) {
                const heights = [
                    200 + Math.floor(random() * 400),
                    200 + Math.floor(random() * 400),
                ];
                layouts.push({
                    top,
                    height: heights[0]!,
                    width: 300,
                    left: 0,
                });
                if (facing && index + 1 < pageCount) layouts.push({
                    top,
                    height: heights[1]!,
                    width: 300,
                    left: 320,
                });
                top += Math.max(heights[0]!, facing ? heights[1]! : 0) + gap;
            }
            for (let probe = 0; probe < 20; probe += 1) {
                const scrollTop = Math.floor(random() * (top + 400)) - 200;
                const container = {
                    clientHeight: 0,
                    clientWidth: 640,
                    scrollLeft: 0,
                    scrollTop,
                };
                expect(captureDocumentZoomAnchor(container, layouts)?.pageIndex, `trial ${trial} y ${scrollTop}`)
                    .toBe(scanNearest(layouts, scrollTop));
            }
        }
    });
});
