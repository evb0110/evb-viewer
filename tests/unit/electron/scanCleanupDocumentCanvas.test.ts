import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    TScanCleanupLayoutByPage,
} from '@contracts/electronApiScanCleanup';
import {
    addScanCleanupDocumentCanvasObservedPage,
    addScanCleanupDocumentCanvasPage,
    createScanCleanupDocumentCanvasAccumulator,
    fitScanCleanupMarginAxisPx,
    isScanCleanupPaperLargerThanCanvas,
    orientScanCleanupInsetsToPageSpace,
    resolveMatchedCanvasResamplePages,
    resolveScanCleanupCanvasFitScale,
    resolveScanCleanupCanvasGridAtDpi,
    resolveScanCleanupDocumentCanvasRenderDpi,
    resolveScanCleanupDocumentCanvas,
    resolveScanCleanupDocumentCanvasFromAccumulator,
    resolveScanCleanupDroppedMatchWarningEvent,
    resolveScanCleanupMatchedCanvasPlacement,
    resolveScanCleanupOutputPaperPixels,
    resolveScanCleanupOutputPageRect,
    resolveScanCleanupPageCanvasBox,
    resolveScanCleanupProvisionalDocumentCanvas,
    resolveScanCleanupUnclassifiedPages,
    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
    placeScanCleanupCanvasBox,
} from '@evb/scan-cleanup/core/policy/documentCanvas';
import {resolveScanCleanupPlacementOffset} from '@contracts/scanCleanupPageOverrides';
import {
    parsePdfInfoPageGeometry,
    parsePdfPageSizesPayload,
    type IPdfPageSize,
} from '@electron/pdf/pdfPageSizes';
import {resolveSuspiciousCropBoxPageSizes} from '@evb/scan-cleanup/core/pdfPageSizes';

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'bw',
    readingOrder: 'ltr',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckle: true,
    skipBlankPages: false,
    pageOverrides: {},
};

function page(value: Partial<IPdfPageSize> & Pick<IPdfPageSize, 'pageNumber'>): IPdfPageSize {
    return {
        xPoints: 0,
        yPoints: 0,
        widthPoints: 612,
        heightPoints: 792,
        rotation: 0,
        ...value,
    };
}

function override(value: Partial<IScanCleanupPageOverride>): IScanCleanupPageOverride {
    return {
        rotationDegrees: 0,
        layoutOverride: 'auto',
        excluded: false,
        manualSplit: null,
        ...value,
    };
}

// A landscape sheet carrying two book pages, which is what a spread scan is.
const spread = page({
    pageNumber: 1,
    widthPoints: 1_224,
    heightPoints: 792,
});

describe('scan cleanup document canvas', () => {
    describe('bounded accumulator', () => {
        it('keeps an all-unknown or partially observed document on whole sheets', () => {
            const pages = [
                page({
                    pageNumber: 1,
                    widthPoints: 400,
                    heightPoints: 200,
                }),
                page({
                    pageNumber: 2,
                    widthPoints: 200,
                    heightPoints: 200,
                }),
            ];
            const accumulator = createScanCleanupDocumentCanvasAccumulator();
            for (const pageSize of pages) {
                addScanCleanupDocumentCanvasPage(accumulator, pageSize, options);
            }

            const legacyCanvas = resolveScanCleanupDocumentCanvas(pages, 150, options, {});
            expect(resolveScanCleanupDocumentCanvasFromAccumulator(
                accumulator,
                150,
                options,
            )).toEqual(legacyCanvas);

            addScanCleanupDocumentCanvasObservedPage(
                accumulator,
                pages[0]!,
                options,
                'two-page-spread',
            );
            expect(resolveScanCleanupDocumentCanvasFromAccumulator(
                accumulator,
                150,
                options,
            )).toEqual(legacyCanvas);
        });
    });

    it.each([
        0,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
    ])('falls back to output dimensions for an invalid intrinsic width (%s)', intrinsicRasterWidthPx => {
        expect(resolveScanCleanupMatchedCanvasPlacement({
            outputWidthPx: 100,
            outputHeightPx: 80,
            intrinsicRasterWidthPx,
            intrinsicRasterHeightPx: 40,
            placementOffsetXPx: 0,
            placementOffsetYPx: 0,
        })).toMatchObject({
            intrinsicRasterWidthPx: 100,
            intrinsicRasterHeightPx: 40,
            matchScaleX: 1,
            matchScaleY: 2,
        });
    });

    it.each([
        0,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
    ])('falls back to output dimensions for an invalid intrinsic height (%s)', intrinsicRasterHeightPx => {
        expect(resolveScanCleanupMatchedCanvasPlacement({
            outputWidthPx: 100,
            outputHeightPx: 80,
            intrinsicRasterWidthPx: 50,
            intrinsicRasterHeightPx,
            placementOffsetXPx: 0,
            placementOffsetYPx: 0,
        })).toMatchObject({
            intrinsicRasterWidthPx: 50,
            intrinsicRasterHeightPx: 80,
            matchScaleX: 2,
            matchScaleY: 1,
        });
    });

    it.each([
        0,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
    ])('falls back to output dimensions for an invalid matched content width (%s)', matchedCanvasContentWidthPx => {
        expect(resolveScanCleanupMatchedCanvasPlacement({
            outputWidthPx: 100,
            outputHeightPx: 80,
            matchedCanvasContentWidthPx,
            matchedCanvasContentHeightPx: 40,
            intrinsicRasterWidthPx: 50,
            intrinsicRasterHeightPx: 40,
            placementOffsetXPx: 0,
            placementOffsetYPx: 0,
        })).toMatchObject({
            contentWidthPx: 100,
            contentHeightPx: 40,
            matchScaleX: 2,
            matchScaleY: 1,
        });
    });

    it('uses one fractional placement owner for every lossless alignment', () => {
        const content = {
            x: 10,
            y: 20,
            width: 100,
            height: 50,
        };
        const targetWidth = 121.5;
        const targetHeight = 81.5;
        const availableWidth = targetWidth - content.width;
        const availableHeight = targetHeight - content.height;

        const expectations = [
            [
                'top-left',
                {
                    offset: {
                        x: 0,
                        y: 0,
                    },
                    box: {
                        x: 10,
                        y: -11.5,
                    },
                },
            ],
            [
                'top-center',
                {
                    offset: {
                        x: 10.75,
                        y: 0,
                    },
                    box: {
                        x: -0.75,
                        y: -11.5,
                    },
                },
            ],
            [
                'top-right',
                {
                    offset: {
                        x: 21.5,
                        y: 0,
                    },
                    box: {
                        x: -11.5,
                        y: -11.5,
                    },
                },
            ],
            [
                'center-left',
                {
                    offset: {
                        x: 0,
                        y: 15.75,
                    },
                    box: {
                        x: 10,
                        y: 4.25,
                    },
                },
            ],
            [
                'center',
                {
                    offset: {
                        x: 10.75,
                        y: 15.75,
                    },
                    box: {
                        x: -0.75,
                        y: 4.25,
                    },
                },
            ],
            [
                'center-right',
                {
                    offset: {
                        x: 21.5,
                        y: 15.75,
                    },
                    box: {
                        x: -11.5,
                        y: 4.25,
                    },
                },
            ],
            [
                'bottom-left',
                {
                    offset: {
                        x: 0,
                        y: 31.5,
                    },
                    box: {
                        x: 10,
                        y: 20,
                    },
                },
            ],
            [
                'bottom-center',
                {
                    offset: {
                        x: 10.75,
                        y: 31.5,
                    },
                    box: {
                        x: -0.75,
                        y: 20,
                    },
                },
            ],
            [
                'bottom-right',
                {
                    offset: {
                        x: 21.5,
                        y: 31.5,
                    },
                    box: {
                        x: -11.5,
                        y: 20,
                    },
                },
            ],
        ] as const;

        // Every horizontal and vertical choice is pinned with fractional free
        // space. The box result is the exact lossless assembler currency,
        // including the bottom-left y reflection.
        for (const [
            alignment,
            expected,
        ] of expectations) {
            expect(resolveScanCleanupPlacementOffset(
                availableWidth,
                availableHeight,
                alignment,
            )).toEqual(expected.offset);
            expect(placeScanCleanupCanvasBox(
                content,
                targetWidth,
                targetHeight,
                alignment,
            )).toEqual({
                ...expected.box,
                width: targetWidth,
                height: targetHeight,
            });
        }
    });

    it('aligns a quarter-turned page to the edge the request names', () => {
        // A 200x100 pt canvas presented through a page that a reader turns a
        // quarter clockwise: the page's own box is 100 pt across and 200 pt
        // down, and its content is 60x40 in that box. `top-center` asks for the
        // top of the sheet the reader holds, which is the page's own left edge.
        const content = {
            x: 0,
            y: 0,
            width: 60,
            height: 40,
        };
        const placed = placeScanCleanupCanvasBox(content, 100, 200, 'top-center', undefined, 90);
        // Flush against the presented top: no page-space left inset at all.
        expect(placed.x).toBe(0);
        // And centred across the presented width, which is the page's own
        // vertical axis: 200 - 40 free, half of it below the content.
        expect(placed.y).toBe(-80);

        // The same request on an unturned page keeps its long-standing answer,
        // so orientation is the only thing this adds.
        expect(placeScanCleanupCanvasBox(content, 100, 200, 'top-center')).toEqual({
            x: -20,
            y: -160,
            width: 100,
            height: 200,
        });
    });

    it('samples the canvas rectangle on the grid the sidecar rebuilds', () => {
        // 142.08 pt is 296.00000000000006 px at 150 DPI. The sidecar rounds,
        // so the page carries 296 px; a consumer that ceils presents a canvas
        // one pixel wider than the page it stands for.
        expect(resolveScanCleanupCanvasGridAtDpi({
            widthPoints: 142.08,
            heightPoints: 213.12,
        }, 150)).toEqual({
            widthPx: 296,
            heightPx: 444,
        });
        // A rectangle too fine for one whole pixel is still a grid.
        expect(resolveScanCleanupCanvasGridAtDpi({
            widthPoints: 0.01,
            heightPoints: 0.01,
        }, 150)).toEqual({
            widthPx: 1,
            heightPx: 1,
        });
    });

    it('fits a margin pair onto one canvas axis under a single policy', () => {
        // A pair that still leaves the canvas some content is delivered
        // exactly as it was requested.
        expect(fitScanCleanupMarginAxisPx(30, 20, 100)).toEqual([
            30,
            20,
        ]);
        // A pair that meets the canvas exactly is already too much: the
        // canvas keeps one content pixel, and the reduction is split by the
        // ratio the request asked for, so an off-centre request stays
        // off-centre.
        expect(fitScanCleanupMarginAxisPx(60, 40, 100)).toEqual([
            59,
            40,
        ]);
        expect(fitScanCleanupMarginAxisPx(300, 100, 100)).toEqual([
            74,
            25,
        ]);
        // A canvas with room for nothing but its content pixel carries no
        // margin at all rather than a negative one.
        expect(fitScanCleanupMarginAxisPx(5, 5, 1)).toEqual([
            0,
            0,
        ]);
        // Nothing requested is nothing to reduce, whatever the axis measures.
        expect(fitScanCleanupMarginAxisPx(0, 0, 0)).toEqual([
            0,
            0,
        ]);
    });

    it('calls paper larger than its canvas only past the shared grid', () => {
        const canvas = {
            widthPoints: 612,
            heightPoints: 792,
            widthPx: 1_275,
            heightPx: 1_650,
        };
        // A half sheet is exactly the half-sheet canvas, and a sheet measured
        // through a raster that rounds is still that sheet.
        expect(isScanCleanupPaperLargerThanCanvas(canvas, {
            widthPoints: 612,
            heightPoints: 792,
        })).toBe(false);
        expect(isScanCleanupPaperLargerThanCanvas(canvas, {
            widthPoints: 612.4,
            heightPoints: 792,
        })).toBe(false);
        // The bound is one whole grid pixel, because that is the most a
        // rectangle can move by being rounded onto this grid. Paper a pixel
        // wider is still the sheet the grid rounded; paper past that pixel is
        // reported, so a rounding change that could move a rectangle further
        // fails here rather than silently widening the tolerance.
        expect(isScanCleanupPaperLargerThanCanvas(canvas, {
            widthPoints: 612.47,
            heightPoints: 792,
        })).toBe(false);
        expect(isScanCleanupPaperLargerThanCanvas(canvas, {
            widthPoints: 612.5,
            heightPoints: 792,
        })).toBe(true);
        // Paper the canvas genuinely cannot hold is reported.
        expect(isScanCleanupPaperLargerThanCanvas(canvas, {
            widthPoints: 792,
            heightPoints: 612,
        })).toBe(true);
    });

    it('reads the geometry evb-pdf-page-ops reports', () => {
        expect(parsePdfPageSizesPayload({pages: [{
            pageNumber: 1,
            xPoints: 10,
            yPoints: 20,
            widthPoints: 180,
            heightPoints: 80,
            widthInches: 2.5,
            heightInches: 80 / 72,
            rotation: 90,
        }]})).toEqual([{
            pageNumber: 1,
            xPoints: 10,
            yPoints: 20,
            widthPoints: 180,
            heightPoints: 80,
            rotation: 90,
        }]);
    });

    it('keeps verified full-page raster metadata from evb-pdf-page-ops', () => {
        expect(parsePdfPageSizesPayload({pages: [{
            pageNumber: 1,
            xPoints: 0,
            yPoints: 0,
            widthPoints: 439.6,
            heightPoints: 670,
            rotation: 0,
            dominantImageWidthPx: 2198,
            dominantImageHeightPx: 3350,
            dominantImageWidthPoints: 439.6,
            dominantImageHeightPoints: 670,
        }]})).toEqual([expect.objectContaining({
            dominantImageWidthPx: 2198,
            dominantImageHeightPx: 3350,
            dominantImageWidthPoints: 439.6,
            dominantImageHeightPoints: 670,
        })]);
    });

    it('rejects geometry a page cannot have', () => {
        expect(() => parsePdfPageSizesPayload({pages: [{
            pageNumber: 1,
            widthPoints: 0,
            heightPoints: 80,
        }]})).toThrow(/invalid geometry/u);
        expect(() => parsePdfPageSizesPayload({})).toThrow(/no pages/u);
        expect(() => parsePdfPageSizesPayload({pages: []})).toThrow(/no pages/u);
    });

    it('requires one exact page-size record for every page', () => {
        const geometry = (pageNumber: unknown) => ({
            pageNumber,
            widthPoints: 612,
            heightPoints: 792,
        });

        for (const pageNumber of [
            undefined,
            0,
            -1,
            1.5,
            3,
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            expect(() => parsePdfPageSizesPayload({pages: [
                geometry(pageNumber),
                geometry(2),
            ]})).toThrow(/invalid page number/u);
        }
        expect(() => parsePdfPageSizesPayload({pages: [
            geometry(1),
            geometry(1),
        ]})).toThrow(/duplicate geometry/u);
        expect(parsePdfPageSizesPayload({pages: [
            geometry(2),
            geometry(1),
        ]}).map(value => value.pageNumber)).toEqual([
            1,
            2,
        ]);
    });

    it.each([
        [
            1.5,
            2,
        ],
        [
            1,
            1,
        ],
        [
            1,
            3,
        ],
        [
            2,
            3,
        ],
    ])('rejects non-canonical page numbering %j', (firstPageNumber, secondPageNumber) => {
        expect(() => parsePdfPageSizesPayload({pages: [
            {
                pageNumber: firstPageNumber,
                widthPoints: 612,
                heightPoints: 792,
            },
            {
                pageNumber: secondPageNumber,
                widthPoints: 612,
                heightPoints: 792,
            },
        ]})).toThrow(/invalid page numbering/u);
    });

    it('accepts shuffled complete page numbering and returns canonical order', () => {
        expect(parsePdfPageSizesPayload({pages: [
            {
                pageNumber: 2,
                widthPoints: 400,
                heightPoints: 500,
            },
            {
                pageNumber: 1,
                widthPoints: 612,
                heightPoints: 792,
            },
        ]}).map(pageSize => pageSize.pageNumber)).toEqual([
            1,
            2,
        ]);
    });

    it('accepts shuffled pdfinfo records and returns canonical order', () => {
        // Poppler is free to print the pages in any order; the decoder is the
        // owner that answers 1..N, so the seams downstream never sort.
        expect(parsePdfInfoPageGeometry([
            'Pages:           2',
            'Page    2 size:  400 x 500 pts',
            'Page    2 rot:   90',
            'Page    1 size:  612 x 792 pts (letter)',
            'Page    1 rot:   0',
        ].join('\n')).map(pageSize => pageSize.pageNumber)).toEqual([
            1,
            2,
        ]);
    });

    it('reads the same geometry out of pdfinfo when page-ops is unavailable', () => {
        // The page view Poppler renders with -cropbox, at the precision pdfinfo
        // prints it, plus the rotation the page is presented under.
        expect(parsePdfInfoPageGeometry([
            'Pages:           2',
            'Page    1 size:  595.276 x 841.89 pts (A4)',
            'Page    1 rot:   0',
            'Page    2 size:  400 x 500 pts',
            'Page    2 rot:   90',
        ].join('\n'))).toEqual([
            {
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 595.276,
                heightPoints: 841.89,
                rotation: 0,
            },
            {
                pageNumber: 2,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 400,
                heightPoints: 500,
                rotation: 90,
            },
        ]);
    });

    it('uses MediaBox geometry only for a suspicious landscape CropBox', () => {
        const parsed = parsePdfInfoPageGeometry([
            'Pages:           3',
            'Page    1 size:  358.816 x 425.609 pts',
            'Page    1 rot:   0',
            'Page    1 MediaBox:      0.00     0.00   841.89   633.89',
            'Page    1 CropBox:     411.63   122.85   770.44   548.46',
            'Page    2 size:  760 x 560 pts',
            'Page    2 rot:   0',
            'Page    2 MediaBox:      0.00     0.00   800.00   600.00',
            'Page    2 CropBox:      20.00    20.00   780.00   580.00',
            'Page    3 size:  760 x 560 pts',
            'Page    3 rot:   0',
            'Page    3 MediaBox:      0.00     0.00   800.00   600.00',
            'Page    3 CropBox:      20.00    20.00   780.00   580.00',
        ].join('\n'));
        const resolved = resolveSuspiciousCropBoxPageSizes(parsed);

        expect(resolved[0]).toMatchObject({
            xPoints: 0,
            yPoints: 0,
            widthPoints: 841.89,
            heightPoints: 633.89,
            mediaWidthPoints: 841.89,
            mediaHeightPoints: 633.89,
        });
        expect(resolved[1]).toMatchObject({
            widthPoints: 760,
            heightPoints: 560,
        });
    });

    it('refuses a pdfinfo answer that is missing a page', () => {
        // A canvas is the largest rectangle the document carries, so a page
        // whose geometry is missing could be the one that decides it.
        expect(() => parsePdfInfoPageGeometry([
            'Pages:           2',
            'Page    1 size:  612 x 792 pts (letter)',
            'Page    1 rot:   0',
        ].join('\n'))).toThrow(/no geometry for page 2/u);
        expect(() => parsePdfInfoPageGeometry('Page    1 size:  612 x 792 pts')).toThrow(/no page count/u);
    });

    it('takes the rectangle a rotated page is actually presented on', () => {
        // A landscape scan stored as a rotated portrait page is landscape to
        // the reader, and that is the frame the preview and the output carry.
        expect(resolveScanCleanupDocumentCanvas([
            page({pageNumber: 1}),
            page({
                pageNumber: 2,
                rotation: 90,
            }),
        ], 150, options)).toEqual({
            widthPoints: 792,
            heightPoints: 612,
            widthPx: 1650,
            heightPx: 1275,
        });
    });

    it('places every matched page on the largest rectangle a uniform document carries', () => {
        // The ordinary scan: one paper size throughout, and the canvas is that
        // page — not a width from one page and a height from another.
        expect(resolveScanCleanupDocumentCanvas([
            page({pageNumber: 1}),
            page({pageNumber: 2}),
            page({pageNumber: 3}),
        ], 150, options)).toEqual({
            widthPoints: 612,
            heightPoints: 792,
            widthPx: 1275,
            heightPx: 1650,
        });
    });

    it('takes an actual page of a mixed-size document rather than inventing one', () => {
        // A4 beside a letter page: the canvas is the larger *actual* rectangle
        // and the other page is scaled onto it, rather than a width from one
        // page and a height from another that no page in the document has.
        expect(resolveScanCleanupDocumentCanvas([
            page({
                pageNumber: 1,
                widthPoints: 612,
                heightPoints: 792,
            }),
            page({
                pageNumber: 2,
                widthPoints: 595,
                heightPoints: 842,
            }),
        ], 72, options)).toEqual({
            widthPoints: 595,
            heightPoints: 842,
            widthPx: 595,
            heightPx: 842,
        });
    });

    it('separates a document without a canvas from a document without pages', () => {
        // Both quality paths drop matching on a document that answers no
        // rectangle, and both report it with this condition: a run that quietly
        // stops matching writes exactly the pages of differing size the setting
        // exists to prevent.
        const dropped = resolveScanCleanupDroppedMatchWarningEvent([
            page({pageNumber: 1}),
            page({pageNumber: 2}),
        ], options);
        // The condition is the code; the sentence it becomes is pinned once,
        // beside the formatter that owns it.
        expect(dropped).toEqual({code: 'matched-canvas-dropped'});
        // Except when the user took every page off the sheet. That document has
        // no canvas because it produces nothing, which is what was asked for.
        expect(resolveScanCleanupDroppedMatchWarningEvent([
            page({pageNumber: 1}),
            page({pageNumber: 2}),
        ], {
            ...options,
            pageOverrides: {
                '1': override({excluded: true}),
                '2': override({excluded: true}),
            },
        })).toBeNull();
        // One page still on the sheet is still a document worth reporting.
        expect(resolveScanCleanupDroppedMatchWarningEvent([
            page({pageNumber: 1}),
            page({pageNumber: 2}),
        ], {
            ...options,
            pageOverrides: {'1': override({excluded: true})},
        })).not.toBeNull();
    });

    it('answers the same rectangle whatever order the pages arrive in', () => {
        const pages = [
            page({
                pageNumber: 1,
                widthPoints: 595,
                heightPoints: 842,
            }),
            page({
                pageNumber: 2,
                widthPoints: 612,
                heightPoints: 792,
            }),
        ];

        expect(resolveScanCleanupDocumentCanvas(pages, 150, options))
            .toEqual(resolveScanCleanupDocumentCanvas([...pages].reverse(), 150, options));
    });

    it('keeps a Letter document Letter-sized', () => {
        // Margins are laid out inside the sheet and a rotation override turns
        // the page within it, so neither is an input here: a default 5 mm
        // margin can no longer turn 612x792 into 640x820, and a quarter turn
        // can no longer square it to 792x792.
        expect(resolveScanCleanupDocumentCanvas([
            page({pageNumber: 1}),
            page({pageNumber: 2}),
        ], 150, options)).toEqual({
            widthPoints: 612,
            heightPoints: 792,
            widthPx: 1275,
            heightPx: 1650,
        });
    });

    it('renders the canvas on the grid the run uses, so every page shares one DPI', () => {
        const preview = resolveScanCleanupDocumentCanvas([page({pageNumber: 1})], 150, options);
        const final = resolveScanCleanupDocumentCanvas([page({pageNumber: 1})], 400, options);

        expect(preview).toEqual({
            widthPoints: 612,
            heightPoints: 792,
            widthPx: 1275,
            heightPx: 1650,
        });
        // The same rectangle, at the resolution the run renders with.
        expect(final?.widthPoints).toBe(preview?.widthPoints);
        expect(final?.heightPoints).toBe(preview?.heightPoints);
        expect(final?.widthPx).toBe(Math.round(612 / 72 * 400));
        expect(final?.heightPx).toBe(Math.round(792 / 72 * 400));
    });

    it('rounds the grid the way the renderer does, so a page that fits is not resampled', () => {
        // Poppler turns a page rectangle into pixels by rounding up, so a
        // canvas that rounded down would be a pixel narrower than the raster of
        // the very page it was measured from — and every page of the document
        // would be resampled to recover that pixel.
        const canvas = resolveScanCleanupDocumentCanvas([page({
            pageNumber: 1,
            widthPoints: 100.5,
            heightPoints: 200.8,
        })], 150, options);

        expect(canvas).toMatchObject({
            widthPx: 210,
            heightPx: 419,
        });
    });

    it('lowers the shared grid rather than exceeding the guardrails a page has', () => {
        const canvas = resolveScanCleanupDocumentCanvas([page({
            pageNumber: 1,
            widthPoints: 3_000,
            heightPoints: 4_000,
        })], 1_200, options);

        expect(canvas?.widthPoints).toBe(3_000);
        expect(canvas?.heightPoints).toBe(4_000);
        // A bilevel document is normalized onto the bilevel budget, and the
        // grid the plan carries is the grid the engine validates: `maxPixels`
        // is a limit the area may reach and never pass, so no allowance for
        // the row and column rounding up adds is available here.
        expect(canvas!.widthPx * canvas!.heightPx).toBeLessThanOrEqual(160_000_000);
        // Still the same shape, so nothing is distorted by the clamp.
        expect(canvas!.widthPx / canvas!.heightPx).toBeCloseTo(3 / 4, 3);
    });

    it('keeps a mixed normal and absurd-paper document inside the engine budget', () => {
        const canvas = resolveScanCleanupDocumentCanvas([
            page({pageNumber: 1}),
            page({
                pageNumber: 2,
                widthPoints: 4_766.9,
                heightPoints: 6_355.86,
            }),
        ], 600, {
            ...options,
            outputMode: 'auto',
        });

        expect(canvas).not.toBeNull();
        expect(canvas!.widthPx * canvas!.heightPx).toBeLessThanOrEqual(80_000_000);
        // The final consumer reconstructs its canvas from the page DPI, so
        // prove the capped DPI reproduces a grid that is safe too.
        const cappedDpi = resolveScanCleanupDocumentCanvasRenderDpi(600, canvas);
        expect(resolveScanCleanupDocumentCanvasRenderDpi(72, canvas)).toBe(cappedDpi);
        const reconstructedWidth = Math.round(canvas!.widthPoints / 72 * cappedDpi);
        const reconstructedHeight = Math.round(canvas!.heightPoints / 72 * cappedDpi);
        expect(reconstructedWidth * reconstructedHeight).toBeLessThanOrEqual(80_000_000);
        expect(reconstructedWidth).toBeLessThanOrEqual(40_000);
        expect(reconstructedHeight).toBeLessThanOrEqual(40_000);
    });

    it('holds the rounded grid inside the pixel budget for the paper that lands on it exactly', () => {
        // The paper sizes whose rounded grid used to land just past the budget:
        // both axes rounded up, and 7522x10637 is 11,514 pixels past the 80M a
        // continuous-tone page is allowed. The native engine rejects the run at
        // `validate_canvas` rather than trimming, so the plan has to fit.
        const papers = [
            // A4 at 1200 dpi.
            {
                widthPoints: 595.276,
                heightPoints: 841.89,
                renderDpi: 1_200,
            },
            // Letter at 1200 dpi.
            {
                widthPoints: 612,
                heightPoints: 792,
                renderDpi: 1_200,
            },
            // A2 at 600 dpi.
            {
                widthPoints: 1_191,
                heightPoints: 1_684,
                renderDpi: 600,
            },
        ];

        for (const paper of papers) {
            const canvas = resolveScanCleanupDocumentCanvas([page({
                pageNumber: 1,
                widthPoints: paper.widthPoints,
                heightPoints: paper.heightPoints,
            })], paper.renderDpi, {
                ...options,
                outputMode: 'color',
            });

            expect(canvas!.widthPx * canvas!.heightPx).toBeLessThanOrEqual(80_000_000);
            // Trimming spends at most the pixel rounding added, so the grid is
            // still the paper's shape at the paper's own size.
            expect(canvas!.widthPx).toBeGreaterThanOrEqual(1);
            expect(canvas!.heightPx).toBeGreaterThanOrEqual(1);
            expect(canvas!.widthPx / canvas!.heightPx)
                .toBeCloseTo(paper.widthPoints / paper.heightPoints, 3);
            expect(canvas!.widthPoints).toBe(paper.widthPoints);
            expect(canvas!.heightPoints).toBe(paper.heightPoints);
        }
    });

    it('never rounds the shared grid past the largest dimension the engine accepts', () => {
        // A page long and thin enough that the dimension guardrail, not the
        // pixel budget, is what bounds it: the resolution lands exactly on the
        // limit, and rounding a rectangle up from exactly the limit is the one
        // way a plan measured to fit produces a grid that does not.
        const canvas = resolveScanCleanupDocumentCanvas([page({
            pageNumber: 1,
            widthPoints: 2_419,
            heightPoints: 71,
        })], 1_200, options);

        expect(canvas?.widthPx).toBe(40_000);
        expect(canvas!.widthPx).toBeLessThanOrEqual(40_000);
        expect(canvas!.heightPx).toBeLessThanOrEqual(40_000);
    });

    it('sizes the shared grid by the budget the document can actually be rendered under', () => {
        const pages = [page({
            pageNumber: 1,
            widthPoints: 3_000,
            heightPoints: 4_000,
        })];
        const bilevel = resolveScanCleanupDocumentCanvas(pages, 1_200, options);
        const automatic = resolveScanCleanupDocumentCanvas(pages, 1_200, {
            ...options,
            outputMode: 'auto',
        });
        const oneColourPage = resolveScanCleanupDocumentCanvas([
            ...pages,
            page({pageNumber: 2}),
        ], 1_200, {
            ...options,
            pageOverrides: {'2': override({outputModeOverride: 'color'})},
        });

        // A page the engine may resolve to colour cannot be rendered on the
        // bilevel grid, so the shared canvas takes the continuous-tone budget
        // whenever the document can produce one — and only then.
        expect(automatic!.widthPx * automatic!.heightPx).toBeLessThanOrEqual(80_000_000);
        expect(bilevel!.widthPx).toBeGreaterThan(automatic!.widthPx);
        expect(oneColourPage!.widthPx).toBe(automatic!.widthPx);
    });

    describe('spreads', () => {
        it('keeps logical paper size independent of an off-center cutter region', () => {
            expect(resolveScanCleanupOutputPaperPixels({
                half: 'left',
                inputWidthPx: 2_203,
                inputHeightPx: 1_573,
                rotationDegrees: 0,
            })).toEqual({
                widthPx: 1_101.5,
                heightPx: 1_573,
            });
            expect(resolveScanCleanupOutputPaperPixels({
                half: 'right',
                inputWidthPx: 2_203,
                inputHeightPx: 1_573,
                rotationDegrees: 90,
            })).toEqual({
                widthPx: 786.5,
                heightPx: 2_203,
            });
        });

        it('measures the half sheet a split spread actually produces', () => {
            // Two book pages on one sheet become two pages of half its width.
            // Measuring the sheet would put each half on a canvas it fills
            // halfway and double the width of the document.
            expect(resolveScanCleanupDocumentCanvas([spread], 150, {
                ...options,
                layoutMode: 'force-two-page',
            })).toEqual({
                widthPoints: 612,
                heightPoints: 792,
                widthPx: 1275,
                heightPx: 1650,
            });
        });

        it('measures a page kept from a spread as the half sheet it is', () => {
            expect(resolveScanCleanupDocumentCanvas([spread], 150, {
                ...options,
                pageOverrides: {'1': override({layoutOverride: 'keep-left'})},
            })).toMatchObject({
                widthPoints: 612,
                heightPoints: 792,
            });
            expect(resolveScanCleanupDocumentCanvas([spread], 150, {
                ...options,
                pageOverrides: {'1': override({manualSplit: {
                    xNormalized: 0.5,
                    rotationDegrees: 0,
                }})},
            })).toMatchObject({
                widthPoints: 612,
                heightPoints: 792,
            });
        });

        it('measures an automatic page from the layout the caller has observed', () => {
            const pages = [
                spread,
                page({
                    pageNumber: 2,
                    widthPoints: 1_224,
                    heightPoints: 792,
                }),
            ];
            const detectedSpreads: TScanCleanupLayoutByPage = {
                '1': 'two-page-spread',
                '2': 'two-page-spread',
            };

            expect(resolveScanCleanupDocumentCanvas(pages, 150, options, detectedSpreads))
                .toMatchObject({
                    widthPoints: 612,
                    heightPoints: 792,
                });
            // A sheet that carries one page keeps the whole sheet.
            expect(resolveScanCleanupDocumentCanvas(pages, 150, options, {
                '1': 'single-uncut-page',
                '2': 'single-uncut-page',
            })).toMatchObject({
                widthPoints: 1_224,
                heightPoints: 792,
            });
        });

        it('keeps the whole sheet for a page detection has not classified', () => {
            const pages = [
                spread,
                page({
                    pageNumber: 2,
                    widthPoints: 1_224,
                    heightPoints: 792,
                }),
            ];

            // Nothing is known: no page is assumed to be cut, which never
            // shrinks anyone's content.
            expect(resolveScanCleanupDocumentCanvas(pages, 150, options, {}))
                .toMatchObject({widthPoints: 1_224});
            // One page came back a spread and the other has not come back at
            // all. Taking the first page's answer for the second would halve
            // the rectangle on the strength of a classification that says
            // nothing about it — and every page of the document that is not a
            // spread would then be placed at half the document's scale. The
            // sheet is measured as the sheet it is; a page that later turns
            // out to be a spread is padded, never shrunk, and the run reports
            // that it had to measure that way.
            expect(resolveScanCleanupDocumentCanvas(pages, 150, options, {'1': 'two-page-spread'}))
                .toMatchObject({widthPoints: 1_224});
            expect(resolveScanCleanupUnclassifiedPages(pages, options, {'1': 'two-page-spread'}))
                .toEqual([2]);
            // Detection settled: every page speaks for itself and there is
            // nothing left to report.
            expect(resolveScanCleanupUnclassifiedPages(pages, options, {
                '1': 'two-page-spread',
                '2': 'single-uncut-page',
            })).toEqual([]);
        });

        it('builds a provisional preview canvas only from pages whose layout is known', () => {
            const pages = [
                spread,
                page({
                    pageNumber: 2,
                    widthPoints: 1_224,
                    heightPoints: 792,
                }),
                page({
                    pageNumber: 3,
                    widthPoints: 1_224,
                    heightPoints: 792,
                }),
            ];

            expect(resolveScanCleanupProvisionalDocumentCanvas(pages, 150, options, {}))
                .toBeNull();
            expect(resolveScanCleanupProvisionalDocumentCanvas(
                pages,
                150,
                options,
                {'1': 'two-page-spread'},
            )).toMatchObject({
                widthPoints: 612,
                heightPoints: 792,
            });
            // An interim single-page outlier cannot resize every known spread
            // leaf. A tie is resolved by the earliest observed cohort, and a
            // later spread makes that cohort the clear document majority.
            expect(resolveScanCleanupProvisionalDocumentCanvas(
                pages,
                150,
                options,
                {
                    '1': 'two-page-spread',
                    '2': 'single-uncut-page',
                },
            )).toMatchObject({
                widthPoints: 612,
                heightPoints: 792,
            });
            expect(resolveScanCleanupProvisionalDocumentCanvas(
                pages,
                150,
                options,
                {
                    '1': 'two-page-spread',
                    '2': 'single-uncut-page',
                    '3': 'two-page-spread',
                },
            )).toMatchObject({
                widthPoints: 612,
                heightPoints: 792,
            });
            // Once reconciliation is complete, a genuine single page is hard
            // evidence and the authoritative mixed-document canvas grows.
            expect(resolveScanCleanupProvisionalDocumentCanvas(
                pages,
                150,
                options,
                {
                    '1': 'two-page-spread',
                    '2': 'single-uncut-page',
                    '3': 'two-page-spread',
                },
                true,
            )).toMatchObject({
                widthPoints: 1_224,
                heightPoints: 792,
            });
            // A manual single-page choice is already authoritative while
            // automatic reconciliation is still running.
            expect(resolveScanCleanupProvisionalDocumentCanvas(
                pages,
                150,
                {
                    ...options,
                    pageOverrides: {'2': override({layoutOverride: 'single'})},
                },
                {
                    '1': 'two-page-spread',
                    '3': 'two-page-spread',
                },
            )).toMatchObject({
                widthPoints: 1_224,
                heightPoints: 792,
            });
            // Explicit layout is evidence before detection starts.
            expect(resolveScanCleanupProvisionalDocumentCanvas(pages, 150, {
                ...options,
                layoutMode: 'force-two-page',
            })).toMatchObject({
                widthPoints: 612,
                heightPoints: 792,
            });
        });

        it('reports nothing for pages that never needed a classification', () => {
            const pages = [
                spread,
                page({
                    pageNumber: 2,
                    widthPoints: 1_224,
                    heightPoints: 792,
                }),
            ];

            // A document whose layout the user chose outright, and a page they
            // excluded, are not pages waiting on detection.
            expect(resolveScanCleanupUnclassifiedPages(pages, {
                ...options,
                layoutMode: 'force-two-page',
            }, {})).toEqual([]);
            expect(resolveScanCleanupUnclassifiedPages(pages, {
                ...options,
                pageOverrides: {'2': override({excluded: true})},
            }, {'1': 'single-uncut-page'})).toEqual([]);
        });

        it('puts a spread half and a page scanned on its own on the same rectangle', () => {
            // The same book scanned two ways: spreads plus a cover sheet that
            // carries a single page. Both produce the same paper.
            expect(resolveScanCleanupDocumentCanvas([
                spread,
                page({
                    pageNumber: 2,
                    widthPoints: 612,
                    heightPoints: 792,
                }),
            ], 150, options, {
                '1': 'two-page-spread',
                '2': 'single-uncut-page',
            })).toMatchObject({
                widthPoints: 612,
                heightPoints: 792,
            });
        });

        it('divides the presented width, not the stored one', () => {
            // A spread stored as a rotated portrait page is a landscape sheet
            // to the reader, and it is cut along the width the reader sees.
            expect(resolveScanCleanupOutputPageRect(page({
                pageNumber: 1,
                widthPoints: 792,
                heightPoints: 1_224,
                rotation: 90,
            }), 2)).toEqual({
                widthPoints: 612,
                heightPoints: 792,
            });
        });
    });

    it('measures the whole document even when a run cleans part of it', () => {
        const pages = [
            page({
                pageNumber: 1,
                widthPoints: 612,
                heightPoints: 792,
            }),
            page({
                pageNumber: 2,
                widthPoints: 842,
                heightPoints: 1_191,
            }),
        ];

        // The largest page is excluded, so it is not on the sheet and does not
        // decide its size.
        expect(resolveScanCleanupDocumentCanvas(pages, 72, {
            ...options,
            pageOverrides: {'2': override({excluded: true})},
        })).toMatchObject({
            widthPoints: 612,
            heightPoints: 792,
        });
        // A page the run was not asked to clean still belongs to the document,
        // so cleaning one page produces a page of the same size a full run
        // would have produced. The scope is not an input here at all.
        expect(resolveScanCleanupDocumentCanvas(pages, 72, options)).toMatchObject({
            widthPoints: 842,
            heightPoints: 1_191,
        });
    });

    it('answers null for a document whose geometry cannot be read', () => {
        expect(resolveScanCleanupDocumentCanvas([], 150, options)).toBeNull();
        expect(resolveScanCleanupDocumentCanvas([page({pageNumber: 1})], 0, options)).toBeNull();
        // And for one that produces no pages at all.
        expect(resolveScanCleanupDocumentCanvas([page({pageNumber: 1})], 150, {
            ...options,
            pageOverrides: {'1': override({excluded: true})},
        })).toBeNull();
    });

    it('answers null for paper no page can be normalized onto', () => {
        // Geometry that measured as nothing, or as a number at all: the
        // rectangle it answers is one the sidecar rejects outright, and a run
        // that hands it over fails instead of cleaning the document. The
        // caller already knows what to do with no canvas — drop matching, say
        // so, and clean every page at its own size.
        const unusable = [
            {
                widthPoints: 0,
                heightPoints: 792,
            },
            {
                widthPoints: 612,
                heightPoints: 0,
            },
            {
                widthPoints: -612,
                heightPoints: 792,
            },
            {
                widthPoints: Number.NaN,
                heightPoints: 792,
            },
            {
                widthPoints: 612,
                heightPoints: Number.POSITIVE_INFINITY,
            },
        ];
        for (const geometry of unusable) {
            expect(resolveScanCleanupDocumentCanvas([page({
                pageNumber: 1,
                ...geometry,
            })], 150, options)).toBeNull();
        }
        // A rectangle so small the grid rounds to a pixel is still paper, and
        // the smallest grid the engine accepts is one pixel.
        expect(resolveScanCleanupDocumentCanvas([page({
            pageNumber: 1,
            widthPoints: 0.0001,
            heightPoints: 0.0001,
        })], 150, options)).toEqual({
            widthPoints: 0.0001,
            heightPoints: 0.0001,
            widthPx: 1,
            heightPx: 1,
        });
    });

    it('turns the canvas back into the page space split-pages writes', () => {
        const canvas = {
            widthPoints: 612,
            heightPoints: 792,
            widthPx: 1275,
            heightPx: 1650,
        };

        expect(resolveScanCleanupPageCanvasBox(canvas, page({pageNumber: 1}), 0)).toEqual({
            widthPoints: 612,
            heightPoints: 792,
        });
        // A page presented rotated carries an unrotated box with the axes
        // swapped, so it still displays as the canvas.
        expect(resolveScanCleanupPageCanvasBox(canvas, page({
            pageNumber: 1,
            rotation: 270,
        }), 0)).toEqual({
            widthPoints: 792,
            heightPoints: 612,
        });
        // The user's own rotation lands on top of the document's.
        expect(resolveScanCleanupPageCanvasBox(canvas, page({
            pageNumber: 1,
            rotation: 90,
        }), 90)).toEqual({
            widthPoints: 612,
            heightPoints: 792,
        });
    });

    it('turns visual margin directions back with the matched canvas', () => {
        const margins = {
            left: 1,
            top: 2,
            right: 3,
            bottom: 4,
        };

        expect(orientScanCleanupInsetsToPageSpace(margins, 0)).toEqual(margins);
        expect(orientScanCleanupInsetsToPageSpace(margins, 90)).toEqual({
            left: 2,
            top: 3,
            right: 4,
            bottom: 1,
        });
        expect(orientScanCleanupInsetsToPageSpace(margins, 180)).toEqual({
            left: 3,
            top: 4,
            right: 1,
            bottom: 2,
        });
        expect(orientScanCleanupInsetsToPageSpace(margins, 270)).toEqual({
            left: 4,
            top: 1,
            right: 2,
            bottom: 3,
        });
    });

    it('measures the scale paper needs to become the canvas', () => {
        const canvas = {
            widthPoints: 612,
            heightPoints: 792,
        };

        // Paper that is the canvas needs no scaling at all.
        expect(resolveScanCleanupCanvasFitScale(canvas, {
            widthPoints: 612,
            heightPoints: 792,
        })).toBe(1);
        // The same original scanned at half the resolution arrives as a
        // half-size page, and is doubled onto the document.
        expect(resolveScanCleanupCanvasFitScale(canvas, {
            widthPoints: 306,
            heightPoints: 396,
        })).toBe(2);
        // Aspect ratio is preserved: the axis that would overrun decides.
        expect(resolveScanCleanupCanvasFitScale(canvas, {
            widthPoints: 306,
            heightPoints: 792,
        })).toBe(1);
    });

    describe('lossless pages that cannot keep their pixels', () => {
        const losslessOptions = {
            ...options,
            preserveOriginalQuality: true,
        };
        const mixedScale = [
            page({pageNumber: 1}),
            page({
                pageNumber: 2,
                widthPoints: 306,
                heightPoints: 396,
            }),
        ];

        it('names the raster pages a matched document would have to re-render', () => {
            expect(resolveMatchedCanvasResamplePages(
                mixedScale,
                [
                    1,
                    2,
                ],
                losslessOptions,
                SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
                new Set([
                    1,
                    2,
                ]),
                true,
            )).toEqual([2]);
            // A page with no raster of its own is placed by a content
            // transform, at any scale, without being re-rendered.
            expect(resolveMatchedCanvasResamplePages(
                mixedScale,
                [
                    1,
                    2,
                ],
                losslessOptions,
                SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
                new Set([1]),
                true,
            )).toEqual([]);
        });

        it('keeps a spread document lossless, because its halves are the canvas', () => {
            // Measured as sheets, every half of this document would look like a
            // page at half the document's scale and the whole run would be
            // re-rendered for nothing.
            expect(resolveMatchedCanvasResamplePages(
                [
                    spread,
                    page({
                        pageNumber: 2,
                        widthPoints: 1_224,
                        heightPoints: 792,
                    }),
                ],
                [
                    1,
                    2,
                ],
                {
                    ...losslessOptions,
                    layoutMode: 'force-two-page',
                },
                SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
                new Set([
                    1,
                    2,
                ]),
                true,
            )).toEqual([]);
        });

        it('treats every page as a raster page when it cannot be detected', () => {
            expect(resolveMatchedCanvasResamplePages(
                mixedScale,
                [
                    1,
                    2,
                ],
                losslessOptions,
                SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
                new Set<number>(),
                false,
            )).toEqual([2]);
        });

        it('rejects page geometry that is not in document order', () => {
            // The canvas rectangle is order-independent, but the per-page
            // lookup here is positional: a full-length shuffled array would
            // measure page 1 against page 2's paper and silently name the
            // wrong pages for re-rendering.
            expect(() => resolveMatchedCanvasResamplePages(
                [...mixedScale].reverse(),
                [
                    1,
                    2,
                ],
                losslessOptions,
                SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
                new Set([
                    1,
                    2,
                ]),
                true,
            )).toThrow(
                'Scan cleanup matched canvas resample planning received page geometry out of document order: expected page 1 at index 0, received page 2',
            );
        });
    });
});
