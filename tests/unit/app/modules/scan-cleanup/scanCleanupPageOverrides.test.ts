import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IScanCleanupOptions,
    TScanCleanupOutputHalf,
} from '@contracts/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {createScanCleanupDetectionSignature} from '@contracts/scan-cleanup/createScanCleanupDetectionSignature';
import {
    createScanCleanupPageOverride,
    estimateScanCleanupOutputPages,
    getScanCleanupPageOverride,
    resolveScanCleanupPageLayout,
    resolveScanCleanupMarginsMm,
    resolveScanCleanupOutputPlacement,
    resolveScanCleanupPlacementAnchors,
    resolveScanCleanupPlacementOffset,
    setScanCleanupPageOverride,
    shouldShowScanCleanupOutputEstimate,
} from '@contracts/scanCleanupPageOverrides';

describe('scan cleanup page overrides', () => {
    it('keeps detection settings stable across an options serialization boundary', () => {
        const options: IScanCleanupOptions = {
            preserveOriginalQuality: false,
            layoutMode: 'auto',
            outputMode: 'bw',
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
            readingOrder: 'ltr',
            skipBlankPages: false,
            pageOverrides: {},
            pageOverrideDefaults: createScanCleanupPageOverride({excluded: true}),
        };
        const serializedOptions = JSON.parse(JSON.stringify(options)) as IScanCleanupOptions;

        expect(createScanCleanupDetectionSignature(serializedOptions))
            .toBe(createScanCleanupDetectionSignature(options));
        expect(options.pageOverrides).toEqual({});
    });

    it('estimates a million-page scalar exclusion without expanding page state', () => {
        const pageOverrides = {};
        const pageOverrideDefaults = createScanCleanupPageOverride({excluded: true});

        expect(estimateScanCleanupOutputPages(1_000_000, {
            layoutMode: 'auto',
            pageOverrides,
            pageOverrideDefaults,
        }, new Map())).toEqual({
            exact: true,
            outputPages: 0,
        });
        expect(Object.keys(pageOverrides)).toHaveLength(0);
    });

    it('merges sparse page values over stable defaults and removes reset entries', () => {
        const overrides = {};
        expect(getScanCleanupPageOverride(overrides, requirePageNumber(3), undefined)).toEqual({
            rotationDegrees: 0,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
        });
        setScanCleanupPageOverride(overrides, requirePageNumber(3), createScanCleanupPageOverride({
            rotationDegrees: 90,
            manualSplit: {
                xNormalized: 0.5,
                rotationDegrees: 0,
            },
        }));
        expect(getScanCleanupPageOverride(overrides, requirePageNumber(3), undefined)).toMatchObject({
            rotationDegrees: 90,
            manualSplit: {
                xNormalized: 0.5,
                rotationDegrees: 0,
            },
        });
        setScanCleanupPageOverride(overrides, requirePageNumber(3), createScanCleanupPageOverride());
        expect(overrides).toEqual({});
    });

    it('preserves and resets a per-page manual deskew angle', () => {
        const overrides = {};
        setScanCleanupPageOverride(overrides, requirePageNumber(2), createScanCleanupPageOverride({manualSkewDegrees: -2.3}));
        expect(getScanCleanupPageOverride(overrides, requirePageNumber(2), undefined).manualSkewDegrees).toBe(-2.3);

        setScanCleanupPageOverride(overrides, requirePageNumber(2), createScanCleanupPageOverride());
        expect(overrides).toEqual({});
    });

    it('maps authoritative layout overrides onto document defaults', () => {
        expect(resolveScanCleanupPageLayout('auto', 'spread')).toBe('force-two-page');
        expect(resolveScanCleanupPageLayout('force-two-page', 'single')).toBe('force-single');
        expect(resolveScanCleanupPageLayout('auto', 'keep-right')).toBe('keep-right');
        expect(resolveScanCleanupPageLayout('force-single', 'auto')).toBe('force-single');
    });

    it('resolves per-output placement over the document default', () => {
        const override = createScanCleanupPageOverride({placementOverrides: {right: 'bottom-right'}});
        expect(resolveScanCleanupOutputPlacement('top-left', override, 'left')).toBe('top-left');
        expect(resolveScanCleanupOutputPlacement('top-left', override, 'right')).toBe('bottom-right');
    });

    it('normalizes equal margin overrides away and preserves asymmetric overrides', () => {
        const documentMargins = {
            leftMm: 5,
            topMm: 5,
            rightMm: 5,
            bottomMm: 5,
        };
        const overrides = {};
        setScanCleanupPageOverride(overrides, requirePageNumber(3), createScanCleanupPageOverride({marginsMm: {...documentMargins}}), documentMargins);
        expect(overrides).toEqual({});

        const asymmetricMargins = {
            leftMm: 2,
            topMm: 4,
            rightMm: 6,
            bottomMm: 8,
        };
        setScanCleanupPageOverride(overrides, requirePageNumber(3), createScanCleanupPageOverride({marginsMm: asymmetricMargins}), documentMargins);
        expect(resolveScanCleanupMarginsMm(documentMargins, getScanCleanupPageOverride(overrides, requirePageNumber(3), undefined)))
            .toEqual(asymmetricMargins);
    });

    it('accounts exactly for exclusions and forced output counts', () => {
        const classifications = new Map([
            [
                1,
                'two-page-spread' as const,
            ],
            [
                4,
                'single-uncut-page' as const,
            ],
        ]);
        const pageOverrides = {
            '2': createScanCleanupPageOverride({excluded: true}),
            '3': createScanCleanupPageOverride({layoutOverride: 'spread'}),
            '4': createScanCleanupPageOverride({layoutOverride: 'keep-left'}),
        };
        expect(estimateScanCleanupOutputPages(4, {
            layoutMode: 'auto',
            pageOverrides,
        }, classifications)).toEqual({
            exact: true,
            outputPages: 5,
        });
    });

    it('marks the estimate approximate when blank pages may be removed', () => {
        expect(estimateScanCleanupOutputPages(2, {
            layoutMode: 'force-single',
            pageOverrides: {},
            skipBlankPages: true,
        }, new Map())).toEqual({
            exact: false,
            outputPages: 2,
        });
    });

    it('hides an automatic estimate until it has classification evidence', () => {
        const options = {
            layoutMode: 'auto' as const,
            pageOverrides: {},
        };
        expect(shouldShowScanCleanupOutputEstimate(3, options, new Map())).toBe(false);
        expect(shouldShowScanCleanupOutputEstimate(3, options, new Map([[
            1,
            'single-uncut-page' as const,
        ]]))).toBe(true);
        expect(shouldShowScanCleanupOutputEstimate(3, {
            ...options,
            layoutMode: 'force-two-page',
        }, new Map())).toBe(true);
    });

    it('shows exact counts when overrides fully determine every included page', () => {
        const pageOverrides = {
            '1': createScanCleanupPageOverride({layoutOverride: 'spread'}),
            '2': createScanCleanupPageOverride({excluded: true}),
        };
        expect(shouldShowScanCleanupOutputEstimate(2, {
            layoutMode: 'auto',
            pageOverrides,
        }, new Map())).toBe(true);
        expect(estimateScanCleanupOutputPages(2, {
            layoutMode: 'auto',
            pageOverrides,
        }, new Map())).toEqual({
            exact: true,
            outputPages: 2,
        });
    });
});

describe('scan cleanup ink placement', () => {
    function sample(pageNumber: number, half: TScanCleanupOutputHalf, yNormalized: number) {
        return {
            pageNumber: requirePageNumber(pageNumber),
            half,
            yNormalized,
        };
    }

    function resolvedTops(samples: Array<ReturnType<typeof sample>>, tolerance: number) {
        return [...resolveScanCleanupPlacementAnchors(samples, tolerance).entries()]
            .sort(([left], [right]) => left - right)
            .map(([
                pageNumber,
                anchors,
            ]): [number, Record<string, number>] => [
                pageNumber,
                Object.fromEntries(Object.entries(anchors).map(([
                    half,
                    anchor,
                ]) => [
                    half,
                    anchor.yNormalized,
                ])),
            ]);
    }

    it('answers nothing for a document without ink evidence', () => {
        expect(resolveScanCleanupPlacementAnchors([], 0.02)).toEqual(new Map());
    });

    it('prints a lone page at the top margin: there is nothing to keep it relative to', () => {
        expect(resolveScanCleanupPlacementAnchors([sample(1, 'full', 0.11)], 0.02))
            .toEqual(new Map([[
                1,
                {full: {yNormalized: 0}},
            ]]));
    });

    it('keeps every output on its own ink when paper cannot be measured (tolerance 0)', () => {
        expect(resolvedTops([
            sample(1, 'full', 0.5),
            sample(2, 'full', 0.5),
            sample(3, 'full', 0.75),
            sample(4, 'full', 0.625),
        ], 0)).toEqual([
            [
                1,
                {full: 0},
            ],
            [
                2,
                {full: 0},
            ],
            [
                3,
                {full: 0.25},
            ],
            [
                4,
                {full: 0.125},
            ],
        ]);
    });

    it('snaps pages that agree within the tolerance onto the cluster median', () => {
        expect(resolvedTops([
            sample(1, 'full', 0.1),
            sample(2, 'full', 0.12),
            sample(3, 'full', 0.13),
            sample(4, 'full', 0.4),
        ], 0.05)).toEqual([
            [
                1,
                {full: 0},
            ],
            [
                2,
                {full: 0},
            ],
            [
                3,
                {full: 0},
            ],
            [
                4,
                {full: expect.closeTo(0.28, 10)},
            ],
        ]);
    });

    it('splits a run that drifts past the tolerance instead of chaining', () => {
        expect(resolvedTops([
            sample(1, 'full', 0.1),
            sample(2, 'full', 0.14),
            sample(3, 'full', 0.18),
            sample(4, 'full', 0.1),
        ], 0.05)).toEqual([
            [
                1,
                {full: 0},
            ],
            [
                2,
                {full: 0},
            ],
            [
                3,
                {full: expect.closeTo(0.08, 10)},
            ],
            [
                4,
                {full: 0},
            ],
        ]);
    });

    it('measures every output from the top edge enough of the document shares', () => {
        // Two title-page outputs start higher than the running head every
        // other page carries. They are real ink, but they are not the book's
        // top edge: they print at the top margin and the running heads stay
        // there too, instead of every text page dropping by the difference.
        const runningHeads = Array.from({length: 40}, (_, index) => sample(
            index + 3,
            index % 2 === 0 ? 'left' : 'right',
            0.06 + (index % 3) * 0.001,
        ));
        const tops = resolvedTops([
            sample(1, 'left', 0.02),
            sample(1, 'right', 0.021),
            sample(2, 'left', 0.06),
            sample(2, 'right', 0.3),
            ...runningHeads,
        ], 0.01);
        expect(tops[0]).toEqual([
            1,
            {
                left: 0,
                right: 0,
            },
        ]);
        expect(tops[1]).toEqual([
            2,
            {
                left: 0,
                right: expect.closeTo(0.239, 10),
            },
        ]);
        expect(tops.slice(2).every(([
            , anchors,
        ]) => Object.values(anchors).every(top => top === 0))).toBe(true);
    });

    it('lets the highest position be the top edge when no position has enough support', () => {
        expect(resolvedTops([
            sample(1, 'full', 0.3),
            sample(2, 'full', 0.1),
            sample(3, 'full', 0.2),
        ], 0.01)).toEqual([
            [
                1,
                {full: expect.closeTo(0.2, 10)},
            ],
            [
                2,
                {full: 0},
            ],
            [
                3,
                {full: expect.closeTo(0.1, 10)},
            ],
        ]);
    });

    it('clusters versos and rectos together: a book has one top margin', () => {
        expect(resolvedTops([
            sample(1, 'left', 0.1),
            sample(1, 'right', 0.11),
            sample(2, 'left', 0.3),
            sample(2, 'right', 0.11),
        ], 0.02)).toEqual([
            [
                1,
                {
                    left: 0,
                    right: 0,
                },
            ],
            [
                2,
                {
                // Measured from the shared median, 0.11, not from its own verso.
                    left: expect.closeTo(0.19, 10),
                    right: 0,
                },
            ],
        ]);
    });

    it('resolves the same anchors whatever order the evidence arrived in', () => {
        const samples = [
            sample(4, 'full', 0.13),
            sample(1, 'full', 0.1),
            sample(3, 'full', 0.32),
            sample(2, 'full', 0.11),
        ];
        const expected = resolveScanCleanupPlacementAnchors(samples, 0.05);
        expect(resolveScanCleanupPlacementAnchors([...samples].reverse(), 0.05))
            .toEqual(expected);
        expect(resolveScanCleanupPlacementAnchors([
            samples[2]!,
            samples[0]!,
            samples[3]!,
            samples[1]!,
        ], 0.05)).toEqual(expected);
    });

    it('places content at its anchor inside the free space, centred horizontally', () => {
        expect(resolveScanCleanupPlacementOffset(100, 200, 'ink', {
            anchor: {yNormalized: 0.25},
            contentHeight: 100,
        })).toEqual({
            x: 50,
            y: 75,
        });
    });

    it('never lets an anchor push content past the requested margins', () => {
        expect(resolveScanCleanupPlacementOffset(100, 200, 'ink', {
            anchor: {yNormalized: 1},
            contentHeight: 100,
        })).toEqual({
            x: 50,
            y: 200,
        });
        expect(resolveScanCleanupPlacementOffset(100, 200, 'ink', {
            anchor: {yNormalized: 0},
            contentHeight: 100,
        })).toEqual({
            x: 50,
            y: 0,
        });
    });

    it('falls back to top-center when a page has no resolved anchor', () => {
        expect(resolveScanCleanupPlacementOffset(100, 200, 'ink'))
            .toEqual(resolveScanCleanupPlacementOffset(100, 200, 'top-center'));
    });
});
