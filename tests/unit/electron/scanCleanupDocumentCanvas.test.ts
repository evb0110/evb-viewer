import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    TScanCleanupLayoutByPage,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    addScanCleanupDocumentCanvasObservedPage,
    addScanCleanupDocumentCanvasPage,
    createScanCleanupDocumentCanvasAccumulator,
    resolveScanCleanupCanvasFitScale,
    resolveScanCleanupDocumentCanvasRenderDpi,
    resolveScanCleanupDocumentCanvas,
    resolveScanCleanupDocumentCanvasFromAccumulator,
    resolveMatchedCanvasResamplePagesFromStore,
    resolveScanCleanupMatchedCanvasPlacement,
    resolveScanCleanupOutputPageRect,
    resolveScanCleanupProvisionalDocumentCanvas,
    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
} from '@evb/scan-cleanup/core/policy/documentCanvas';
import type {
    IPdfPageSizeStore,
    IPdfPageSize,
} from '@electron/pdf/pdfPageSizes';

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

        it('validates order and total page count while planning from a store', async () => {
            const canvas = resolveScanCleanupDocumentCanvas(
                mixedScale,
                SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
                losslessOptions,
            );
            if (canvas === null) throw new Error('expected a matched canvas');
            const createPageSizeStore = (pages: readonly IPdfPageSize[]): IPdfPageSizeStore => ({
                pageCount: 2,
                getPage: async pageNumber => pages[pageNumber - 1] ?? pages[0]!,
                readRange: async () => [...pages],
                forEachChunk: async onChunk => onChunk({
                    pageCount: 2,
                    chunkIndex: 0,
                    firstPageNumber: 1,
                    offset: 0,
                    byteLength: 0,
                    pages: [...pages],
                }),
                close: async () => undefined,
            });
            const rasterSource = {
                detected: true,
                getPageRaster: async () => ({
                    dpi: 300,
                    width: 2_550,
                    height: 3_300,
                }),
            };

            await expect(resolveMatchedCanvasResamplePagesFromStore({
                pageSizeStore: createPageSizeStore([
                    mixedScale[0]!,
                    mixedScale[1]!,
                ]),
                documentPageCount: 2,
                canvas,
                options: losslessOptions,
                rasterSource,
                rasterDetectionAvailable: true,
            })).resolves.toEqual([2]);

            await expect(resolveMatchedCanvasResamplePagesFromStore({
                pageSizeStore: createPageSizeStore([
                    mixedScale[1]!,
                    mixedScale[0]!,
                ]),
                documentPageCount: 2,
                canvas,
                options: losslessOptions,
                rasterSource,
                rasterDetectionAvailable: true,
            })).rejects.toThrow(
                'Scan cleanup page-size store returned page 2 where page 1 was expected',
            );
            await expect(resolveMatchedCanvasResamplePagesFromStore({
                pageSizeStore: createPageSizeStore([mixedScale[0]!]),
                documentPageCount: 2,
                canvas,
                options: losslessOptions,
                rasterSource,
                rasterDetectionAvailable: true,
            })).rejects.toThrow(
                'Scan cleanup page-size store returned 1 pages for 2 document pages',
            );
            await expect(resolveMatchedCanvasResamplePagesFromStore({
                pageSizeStore: createPageSizeStore([
                    mixedScale[0]!,
                    mixedScale[1]!,
                    page({pageNumber: 3}),
                ]),
                documentPageCount: 2,
                canvas,
                options: losslessOptions,
                rasterSource,
                rasterDetectionAvailable: true,
            })).rejects.toThrow(
                'Scan cleanup page-size store returned 3 pages for 2 document pages',
            );
        });
    });
});
