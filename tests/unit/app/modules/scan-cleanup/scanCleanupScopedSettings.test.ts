import {
    describe,
    expect,
    it,
} from 'vitest';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    createScanCleanupPageOverride,
    getScanCleanupPageOverride,
    setScanCleanupPageOverride,
} from '@contracts/scanCleanupPageOverrides';
import {
    resolveScanCleanupApplyScope,
    type IScanCleanupPageRange,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupApplyScope';
import {
    resolveScanCleanupMixedValue,
    updateScanCleanupPageOverrides,
} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';
import {
    reactive,
    ref,
} from 'vue';
import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import {useScanCleanupSelection} from '@app/modules/scan-cleanup/composables/useScanCleanupSelection';
import {resolveScanCleanupMarginPatch} from '@app/modules/scan-cleanup/runtime/updateScanCleanupMargins';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';

describe('scan cleanup apply scopes', () => {
    it('keeps a million-page all scope as a scalar range token', () => {
        const scope = resolveScanCleanupApplyScope({
            leader: 500_000,
            pageCount: 1_000_000,
            selectedPages: new Set(),
        }, 'all') as IScanCleanupPageRange;
        const iterator = scope[Symbol.iterator]();

        expect(scope.kind).toBe('range');
        expect(scope.size).toBe(1_000_000);
        expect(scope.startPageNumber).toBe(1);
        expect(scope.endPageNumber).toBe(1_000_000);
        expect(iterator.next().value).toBe(1);
        expect(scope.has(1_000_000)).toBe(true);
        expect(scope.has(1_000_001)).toBe(false);
    });

    it('resolves all pages and from-here at the first and last page', () => {
        const selection = new Set([
            2,
            4,
        ]);
        expect([...resolveScanCleanupApplyScope({
            leader: 1,
            pageCount: 6,
            selectedPages: selection,
        }, 'all')]).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
        ]);
        expect([...resolveScanCleanupApplyScope({
            leader: 1,
            pageCount: 6,
            selectedPages: selection,
        }, 'from-here')]).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
        ]);
        expect([...resolveScanCleanupApplyScope({
            leader: 6,
            pageCount: 6,
            selectedPages: selection,
        }, 'from-here')]).toEqual([6]);
    });

    it('keeps only valid selected pages in natural order', () => {
        expect([...resolveScanCleanupApplyScope({
            leader: 3,
            pageCount: 5,
            selectedPages: new Set([
                5,
                0,
                3,
                8,
                1,
            ]),
        }, 'selected')]).toEqual([
            1,
            3,
            5,
        ]);
    });

    it('uses the first, last, odd, and even leader parity for every-other-page scope', () => {
        const selectedPages = new Set<number>();
        expect([...resolveScanCleanupApplyScope({
            leader: 1,
            pageCount: 6,
            selectedPages,
        }, 'every-other')]).toEqual([
            1,
            3,
            5,
        ]);
        expect([...resolveScanCleanupApplyScope({
            leader: 3,
            pageCount: 6,
            selectedPages,
        }, 'every-other')]).toEqual([
            1,
            3,
            5,
        ]);
        expect([...resolveScanCleanupApplyScope({
            leader: 4,
            pageCount: 6,
            selectedPages,
        }, 'every-other')]).toEqual([
            2,
            4,
            6,
        ]);
        expect([...resolveScanCleanupApplyScope({
            leader: 6,
            pageCount: 6,
            selectedPages,
        }, 'every-other')]).toEqual([
            2,
            4,
            6,
        ]);
    });
});

describe('scan cleanup selection override state', () => {
    it('applies an all-page override to a million-page document as one scalar', () => {
        const settings = reactive<IScanCleanupOptions>({
            preserveOriginalQuality: false,
            layoutMode: 'auto',
            outputMode: 'auto',
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
            skipBlankPages: false,
            pageOverrides: {
                '1': createScanCleanupPageOverride({
                    rotationDegrees: 90,
                    excluded: true,
                }),
                '37': createScanCleanupPageOverride({rotationDegrees: 180}),
            },
            pageOverrideDefaults: createScanCleanupPageOverride(),
        });
        const selection = useScanCleanupSelection({
            initialPage: 1,
            previewResult: () => null,
            previewTotalPages: () => 1_000_000,
            marginsLinked: ref(true),
            settings,
        });

        selection.applyLeaderOverrides('all');

        expect(Object.keys(settings.pageOverrides)).toEqual([]);
        expect(settings.pageOverrideDefaults).toMatchObject({
            rotationDegrees: 90,
            excluded: true,
        });
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(1), settings.pageOverrideDefaults, settings.marginsMm).excluded).toBe(true);
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(1_000_000), settings.pageOverrideDefaults, settings.marginsMm).rotationDegrees).toBe(90);
        const requestOptions = toPlainScanCleanupOptions(settings);
        expect(requestOptions.pageOverrideDefaults).toMatchObject({
            rotationDegrees: 90,
            excluded: true,
        });
        expect(getScanCleanupPageOverride(requestOptions.pageOverrides, requirePageNumber(1_000_000), requestOptions.pageOverrideDefaults, requestOptions.marginsMm).excluded).toBe(true);

        setScanCleanupPageOverride(
            settings.pageOverrides,
            requirePageNumber(37),
            createScanCleanupPageOverride({
                rotationDegrees: 270,
                excluded: false,
            }),
        );
        expect(Object.keys(settings.pageOverrides)).toEqual(['37']);
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(37), settings.pageOverrideDefaults, settings.marginsMm).rotationDegrees).toBe(270);
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(1_000_000), settings.pageOverrideDefaults, settings.marginsMm).excluded).toBe(true);
    });

    it('persists manual zones on the leader page and clears rotation-bound geometry after rotation', () => {
        const settings = reactive<IScanCleanupOptions>({
            preserveOriginalQuality: false,
            layoutMode: 'auto',
            outputMode: 'mixed',
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
        });
        const selection = useScanCleanupSelection({
            initialPage: 1,
            previewResult: () => null,
            previewTotalPages: () => 2,
            marginsLinked: ref(true),
            settings,
        });
        const manualZones = {
            picture: [{
                layer: 'painter2' as const,
                polygon: {
                    points: [
                        {
                            xNormalized: 0.1,
                            yNormalized: 0.2,
                        },
                        {
                            xNormalized: 0.4,
                            yNormalized: 0.2,
                        },
                        {
                            xNormalized: 0.4,
                            yNormalized: 0.6,
                        },
                        {
                            xNormalized: 0.1,
                            yNormalized: 0.6,
                        },
                    ],
                    rotationDegrees: 0 as const,
                },
            }],
            fill: [],
        };

        selection.updateCurrentManualZones(manualZones);
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(1), settings.pageOverrideDefaults, settings.marginsMm).manualZones).toEqual(manualZones);
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(2), settings.pageOverrideDefaults, settings.marginsMm).manualZones).toBeUndefined();

        selection.updatePageOverride(1, createScanCleanupPageOverride({
            rotationDegrees: 90,
            layoutOverride: 'spread',
            excluded: true,
            manualSplit: {
                xNormalized: 0.4,
                rotationDegrees: 90,
            },
            manualSkewDegrees: 1,
            manualContentBoxes: {full: {
                xNormalized: 0.1,
                yNormalized: 0.2,
                widthNormalized: 0.3,
                heightNormalized: 0.4,
                rotationDegrees: 90,
            }},
            manualZones,
        }));
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(1))).toMatchObject({
            rotationDegrees: 90,
            layoutOverride: 'spread',
            excluded: true,
            manualSplit: null,
            manualContentBoxes: {},
            manualZones: {
                picture: [],
                fill: [],
            },
        });
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(1)))
            .not.toHaveProperty('manualSkewDegrees');

        selection.updateRotation(90);
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(1), undefined)).toMatchObject({
            rotationDegrees: 90,
            manualZones: {
                picture: [],
                fill: [],
            },
        });

        selection.updateCurrentManualZones({
            picture: [],
            fill: manualZones.picture.map(zone => ({
                ...zone.polygon,
                rotationDegrees: 90,
            })),
        });
        selection.resetControlOverride('rotation', [1]);
        const resetOverride = getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(1), settings.pageOverrideDefaults, settings.marginsMm);
        expect(resetOverride.rotationDegrees).toBe(0);
        expect(resetOverride.manualZones ?? {
            picture: [],
            fill: [],
        }).toEqual({
            picture: [],
            fill: [],
        });
    });

    it('updates all four margins while linked and one margin while unlinked', () => {
        const settings = reactive<IScanCleanupOptions>({
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
        });
        const selection = useScanCleanupSelection({
            initialPage: 1,
            previewResult: () => null,
            previewTotalPages: () => 1,
            marginsLinked: ref(true),
            settings,
        });

        expect(selection.marginsLinked.value).toBe(true);
        selection.updateMargins('leftMm', 7);
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(1), settings.pageOverrideDefaults, settings.marginsMm).marginsMm).toEqual({
            leftMm: 7,
            topMm: 7,
            rightMm: 7,
            bottomMm: 7,
        });

        selection.setMarginsLinked(false);
        selection.updateMargins('topMm', 3);
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(1), settings.pageOverrideDefaults, settings.marginsMm).marginsMm).toEqual({
            leftMm: 7,
            topMm: 3,
            rightMm: 7,
            bottomMm: 7,
        });

        selection.setMarginsLinked(true);
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(1), settings.pageOverrideDefaults, settings.marginsMm).marginsMm).toEqual({
            leftMm: 3,
            topMm: 3,
            rightMm: 3,
            bottomMm: 3,
        });
    });

    it('keeps mixed output as a current-page override without changing the document mode', () => {
        const settings = reactive<IScanCleanupOptions>({
            preserveOriginalQuality: false,
            layoutMode: 'auto',
            outputMode: 'auto',
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
        });
        const selection = useScanCleanupSelection({
            initialPage: 2,
            previewResult: () => null,
            previewTotalPages: () => 3,
            marginsLinked: ref(true),
            settings,
        });

        selection.updateOutputModeOverride('mixed', [2]);

        expect(settings.outputMode).toBe('auto');
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(1), settings.pageOverrideDefaults, settings.marginsMm).outputModeOverride).toBeUndefined();
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(2), settings.pageOverrideDefaults, settings.marginsMm).outputModeOverride).toBe('mixed');
    });

    it('resolves per-side margin patches touching only the edited keys', () => {
        expect(resolveScanCleanupMarginPatch('topMm', 12)).toEqual({topMm: 12});
        expect(resolveScanCleanupMarginPatch('all', 30)).toEqual({
            leftMm: 25,
            topMm: 25,
            rightMm: 25,
            bottomMm: 25,
        });
        expect(resolveScanCleanupMarginPatch('leftMm', Number.NaN)).toEqual({});
    });

    it('detects uniform, scalar-mixed, and nested mixed values', () => {
        expect(resolveScanCleanupMixedValue([
            90,
            90,
        ])).toEqual({
            empty: false,
            mixed: false,
            value: 90,
        });
        expect(resolveScanCleanupMixedValue([
            0,
            90,
        ]).mixed).toBe(true);
        expect(resolveScanCleanupMixedValue([
            {left: {
                x: 1,
                y: 2,
            }},
            {left: {
                y: 2,
                x: 1,
            }},
        ]).mixed).toBe(false);
        expect(resolveScanCleanupMixedValue([
            {left: {
                x: 1,
                y: 2,
            }},
            {left: {
                x: 2,
                y: 2,
            }},
        ]).mixed).toBe(true);
        expect(resolveScanCleanupMixedValue([])).toEqual({
            empty: true,
            mixed: false,
            value: undefined,
        });
    });

    it('writes selection edits into the row-control store without touching document defaults', () => {
        const settings = {
            layoutMode: 'force-single' as const,
            outputMode: 'color' as const,
            pageAlignment: 'top-left' as const,
            pageOverrides: {'2': createScanCleanupPageOverride({rotationDegrees: 90})},
        };
        const documentDefaults = {
            layoutMode: settings.layoutMode,
            outputMode: settings.outputMode,
            pageAlignment: settings.pageAlignment,
        };

        updateScanCleanupPageOverrides(settings.pageOverrides, new Set([
            1,
            2,
        ]), current => ({
            ...current,
            layoutOverride: 'spread',
            excluded: true,
        }), undefined);

        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(1), undefined)).toMatchObject({
            layoutOverride: 'spread',
            excluded: true,
            rotationDegrees: 0,
        });
        expect(getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(2), undefined)).toMatchObject({
            layoutOverride: 'spread',
            excluded: true,
            rotationDegrees: 90,
        });
        expect({
            layoutMode: settings.layoutMode,
            outputMode: settings.outputMode,
            pageAlignment: settings.pageAlignment,
        }).toEqual(documentDefaults);
    });

    it('copies the leader override unchanged to a computed scope', () => {
        const overrides = {'2': createScanCleanupPageOverride({
            rotationDegrees: 180,
            layoutOverride: 'keep-right',
            manualSplit: {
                xNormalized: 0.5,
                rotationDegrees: 0,
            },
            placementOverrides: {right: 'bottom-right'},
        })};
        const leader = getScanCleanupPageOverride(overrides, requirePageNumber(2), undefined);
        const targetPages = resolveScanCleanupApplyScope({
            leader: 2,
            pageCount: 5,
            selectedPages: new Set([2]),
        }, 'every-other');
        updateScanCleanupPageOverrides(overrides, targetPages, () => leader, undefined);

        expect([...targetPages]).toEqual([
            2,
            4,
        ]);
        expect(getScanCleanupPageOverride(overrides, requirePageNumber(4), undefined)).toEqual(leader);
        expect(getScanCleanupPageOverride(overrides, requirePageNumber(1), undefined)).toEqual(createScanCleanupPageOverride());
    });
});
