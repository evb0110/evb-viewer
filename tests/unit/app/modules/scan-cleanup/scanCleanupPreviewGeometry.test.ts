import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import type {
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewResult,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    completePreviewImageSwap,
    createPreviewImageSwap,
    loadPreviewImageSwap,
    queuePreviewImageSwap,
} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewImages';
import {
    expandPreviewRectByMargins,
    measurePreviewContentBoxContainment,
    scanCleanupAnalysisWidth,
    scanCleanupCutterRatio,
    scanCleanupCutterXFromRatio,
    transformPreviewContentBox,
    transformPreviewSourceHalfRectUnclamped,
} from '@app/modules/scan-cleanup/geometry/coordinates';
import {
    resolvePreviewFitPlacement,
    resolvePreviewOutputFitSizes,
    resolvePreviewOutputFitRects,
    resolvePreviewPlaceholderViewportFrame,
    resolvePreviewSpreadCutterCenter,
    resolvePreviewViewportFrame,
    type IScanCleanupPreviewFitPlacement,
} from '@app/modules/scan-cleanup/geometry/viewport';
import {
    resolvePreviewMetadataPlacement,
    toPreviewSourceCropStyle,
    toPreviewStyleRect,
} from '@app/modules/scan-cleanup/geometry/placement';
import {useScanCleanupViewportFrame} from '@app/modules/scan-cleanup/composables/useScanCleanupViewportFrame';
import {createScanCleanupPreviewPrefetcher} from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewPrefetcher';

function metadata(overrides: Partial<IScanCleanupPreviewMetadata> = {}): IScanCleanupPreviewMetadata {
    return {
        canvasScope: 'page',
        half: 'full',
        layoutClassification: 'single-uncut-page',
        layoutConfidence: 0.9,
        sourceRegion: {
            xPx: 100,
            yPx: 20,
            widthPx: 400,
            heightPx: 600,
        },
        contentBox: {
            xPx: 10,
            yPx: 30,
            widthPx: 200,
            heightPx: 300,
        },
        appliedMargins: {
            leftPx: 15,
            topPx: 15,
            rightPx: 15,
            bottomPx: 15,
        },
        outputWidthPx: 230,
        outputHeightPx: 330,
        canvasWidthPx: 230,
        canvasHeightPx: 330,
        placementOffsetXPx: 0,
        placementOffsetYPx: 0,
        cutterXPx: null,
        inputWidthPx: 600,
        inputHeightPx: 640,
        rotationDegrees: 0,
        resamplePasses: 1,
        forwardTransform: {matrix: [
            [
                1,
                0,
                -100,
            ],
            [
                0,
                1,
                -20,
            ],
            [
                0,
                0,
                1,
            ],
        ]},
        warnings: [],
        ...overrides,
    };
}

function previewResult(outputMetadata: IScanCleanupPreviewMetadata, pixel = 1): IScanCleanupPreviewResult {
    return {
        pageNumber: requirePageNumber(1),
        totalPages: 1,
        rawImageData: new Uint8Array([pixel]),
        rawWidthPx: 600,
        rawHeightPx: 640,
        pageMetadata: {
            canvasScope: 'page',
            layoutClassification: outputMetadata.layoutClassification,
            layoutConfidence: outputMetadata.layoutConfidence,
            cutterXPx: null,
            rotationDegrees: outputMetadata.rotationDegrees,
            excluded: false,
            blankOutputsSkipped: 0,
            tier1Verdict: outputMetadata.layoutClassification,
            reconciled: false,
            clusterAgreement: 0,
        },
        outputs: [{
            imageData: new Uint8Array([pixel]),
            metadata: outputMetadata,
        }],
    };
}

describe('scan cleanup preview geometry', () => {
    it('uses each native canvas as the viewport paper frame', () => {
        const first = metadata({
            half: 'left',
            outputWidthPx: 210,
            outputHeightPx: 300,
            canvasWidthPx: 240,
            canvasHeightPx: 350,
        });
        const second = metadata({
            half: 'right',
            outputWidthPx: 180,
            outputHeightPx: 260,
            canvasWidthPx: 220,
            canvasHeightPx: 340,
        });
        const frame = resolvePreviewViewportFrame([
            first,
            second,
        ]);

        expect(frame).toEqual([
            {
                half: 'left',
                width: 240,
                height: 350,
            },
            {
                half: 'right',
                width: 220,
                height: 340,
            },
        ]);
    });

    it('uses the source-page aspect and a single placeholder until classification is known', () => {
        expect(resolvePreviewPlaceholderViewportFrame(600, 900, undefined, 0)).toEqual([{
            half: 'full',
            width: 600,
            height: 900,
        }]);
        expect(resolvePreviewPlaceholderViewportFrame(600, 900, 'two-page-spread', 90)).toEqual([
            {
                half: 'left',
                width: 450,
                height: 600,
            },
            {
                half: 'right',
                width: 450,
                height: 600,
            },
        ]);
    });

    it('revokes a replaced blob only after its replacement loaded and completed the pixel crossfade', () => {
        const revoke = vi.fn();
        let swap = queuePreviewImageSwap(createPreviewImageSwap('blob:old'), 'blob:new', revoke);

        expect(swap).toMatchObject({
            currentUrl: 'blob:old',
            incomingUrl: 'blob:new',
        });
        expect(revoke).not.toHaveBeenCalled();

        swap = loadPreviewImageSwap(swap, 'blob:new');
        expect(swap).toMatchObject({
            currentUrl: 'blob:new',
            outgoingUrl: 'blob:old',
        });
        expect(revoke).not.toHaveBeenCalled();

        swap = completePreviewImageSwap(swap, 'blob:new', revoke);
        expect(revoke).toHaveBeenCalledOnce();
        expect(revoke).toHaveBeenCalledWith('blob:old');
        expect(swap.outgoingUrl).toBe('');
    });

    it('maps the half-local detected content box through the source-to-output affine', () => {
        expect(transformPreviewContentBox(metadata())).toEqual({
            xPx: 10,
            yPx: 30,
            widthPx: 200,
            heightPx: 300,
        });
    });

    it('keeps a negative half-local content origin when the crop begins outside the half', () => {
        expect(transformPreviewContentBox(metadata({
            half: 'right',
            sourceRegion: {
                xPx: 500,
                yPx: 0,
                widthPx: 400,
                heightPx: 600,
            },
            contentBox: {
                xPx: -20,
                yPx: 30,
                widthPx: 200,
                heightPx: 300,
            },
            forwardTransform: {matrix: [
                [
                    1,
                    0,
                    -470,
                ],
                [
                    0,
                    1,
                    -20,
                ],
                [
                    0,
                    0,
                    1,
                ],
            ]},
        }))).toEqual({
            xPx: 10,
            yPx: 10,
            widthPx: 200,
            heightPx: 300,
        });
    });

    it('measures fractional source-box overrun before the overlay clamp', () => {
        const fractional = metadata({
            sourceRegion: {
                xPx: 0,
                yPx: 0,
                widthPx: 200,
                heightPx: 300,
            },
            contentBox: {
                xPx: -0.25,
                yPx: 0.25,
                widthPx: 200.5,
                heightPx: 299.5,
            },
            outputWidthPx: 200,
            outputHeightPx: 300,
            forwardTransform: {matrix: [
                [
                    1,
                    0,
                    0,
                ],
                [
                    0,
                    1,
                    0,
                ],
                [
                    0,
                    0,
                    1,
                ],
            ]},
        });

        expect(transformPreviewSourceHalfRectUnclamped(fractional, fractional.contentBox)).toEqual({
            xPx: -0.25,
            yPx: 0.25,
            widthPx: 200.5,
            heightPx: 299.5,
        });
        expect(measurePreviewContentBoxContainment(fractional)).toMatchObject({
            contained: false,
            edgeOverrunPx: {
                left: 0.25,
                top: 0,
                right: 0.25,
                bottom: 0,
            },
        });
    });

    it('measures containment through a rotation matrix', () => {
        const rotated = metadata({
            sourceRegion: {
                xPx: 0,
                yPx: 0,
                widthPx: 100,
                heightPx: 100,
            },
            contentBox: {
                xPx: 10,
                yPx: 20,
                widthPx: 30,
                heightPx: 40,
            },
            outputWidthPx: 100,
            outputHeightPx: 100,
            forwardTransform: {matrix: [
                [
                    0,
                    -1,
                    100,
                ],
                [
                    1,
                    0,
                    0,
                ],
                [
                    0,
                    0,
                    1,
                ],
            ]},
        });

        expect(measurePreviewContentBoxContainment(rotated)).toEqual({
            contained: true,
            containment: 1,
            edgeOverrunPx: {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
        });
    });

    it('returns null containment when native affine metadata is unavailable', () => {
        expect(measurePreviewContentBoxContainment(metadata({forwardTransform: null}))).toBeNull();
    });

    it('round-trips asymmetric native margins through the lossless overlay geometry', () => {
        const content = {
            xPx: 40,
            yPx: 60,
            widthPx: 180,
            heightPx: 260,
        };
        const margins = {
            leftPx: 7,
            topPx: 11,
            rightPx: 17,
            bottomPx: 23,
        };
        const overlay = expandPreviewRectByMargins(content, margins);

        expect(overlay).toEqual({
            xPx: 33,
            yPx: 49,
            widthPx: 204,
            heightPx: 294,
        });
        expect({
            xPx: overlay.xPx + margins.leftPx,
            yPx: overlay.yPx + margins.topPx,
            widthPx: overlay.widthPx - margins.leftPx - margins.rightPx,
            heightPx: overlay.heightPx - margins.topPx - margins.bottomPx,
        }).toEqual(content);
    });

    it('uses explicit native canvas and placement metadata verbatim', () => {
        const nativeMetadata = metadata({
            outputWidthPx: 210,
            outputHeightPx: 300,
            canvasWidthPx: 230,
            canvasHeightPx: 330,
            placementOffsetXPx: 20,
            placementOffsetYPx: 30,
        });
        const placement = resolvePreviewMetadataPlacement(nativeMetadata);
        expect(placement).toEqual({
            canvasWidthPx: 230,
            canvasHeightPx: 330,
            contentWidthPx: 210,
            contentHeightPx: 300,
            left: 20,
            top: 30,
            scaleX: 1,
            scaleY: 1,
        });
        expect(toPreviewStyleRect({
            xPx: 0,
            yPx: 0,
            widthPx: 210,
            heightPx: 300,
        }, placement)).toEqual({
            left: `${20 / 230 * 100}%`,
            top: `${30 / 330 * 100}%`,
            width: `${210 / 230 * 100}%`,
            height: `${300 / 330 * 100}%`,
        });
    });

    it('does not apply canvas insets to intrinsic rasters that already contain their margins', () => {
        const intrinsicMetadata = metadata({
            outputWidthPx: 230,
            outputHeightPx: 330,
            canvasWidthPx: 230,
            canvasHeightPx: 330,
        });

        expect(resolvePreviewMetadataPlacement(intrinsicMetadata)).toMatchObject({
            left: 0,
            top: 0,
        });
    });

    it('keeps a clipped intrinsic fold tail outside the preview canvas', () => {
        const intrinsicMetadata = metadata({
            half: 'right',
            outputWidthPx: 1_100,
            outputHeightPx: 600,
            canvasWidthPx: 1_000,
            canvasHeightPx: 600,
            matchedCanvasContentWidthPx: 1_100,
            matchedCanvasContentHeightPx: 600,
            matchedCanvasIntrinsicOverflowLeftPx: 80,
            placementOffsetXPx: 0,
        });

        expect(resolvePreviewMetadataPlacement(intrinsicMetadata)).toMatchObject({
            contentWidthPx: 1_100,
            left: -80,
            scaleX: 1,
        });
    });

    it('clips the same fold-edge columns that native final materialization excludes', () => {
        const clippedMetadata = metadata({
            outputWidthPx: 500,
            matchedCanvasContentWidthPx: 1_000,
            foldClipLeftPx: 120,
            foldClipRightPx: 80,
        });

        expect(toPreviewSourceCropStyle(clippedMetadata)).toEqual({clipPath: 'inset(0 8% 0 12%)'});
    });

    it('keeps trimmed top headroom outside the preview in native placement branches', () => {
        const trimmedMetadata = metadata({
            outputWidthPx: 1_000,
            outputHeightPx: 600,
            canvasWidthPx: 1_000,
            canvasHeightPx: 600,
            matchedCanvasContentWidthPx: 1_000,
            matchedCanvasContentHeightPx: 600,
            matchedCanvasIntrinsicOverflowTopPx: 80,
            placementOffsetYPx: 0,
        });

        expect(resolvePreviewMetadataPlacement(trimmedMetadata)).toMatchObject({top: -80});
    });

    it('presents a page the document scaled up at the size the final run will write', () => {
        // The page is half the document's paper, so the sidecar reports the box
        // it belongs in and the renderer scales the raster it rendered into it,
        // instead of showing it a quarter the size of every other page.
        const scaledMetadata = metadata({
            outputWidthPx: 105,
            outputHeightPx: 150,
            canvasWidthPx: 230,
            canvasHeightPx: 330,
            matchedCanvasContentWidthPx: 210,
            matchedCanvasContentHeightPx: 300,
            placementOffsetXPx: 10,
            placementOffsetYPx: 15,
        });
        const placement = resolvePreviewMetadataPlacement(scaledMetadata);

        expect(placement).toMatchObject({
            contentWidthPx: 210,
            contentHeightPx: 300,
            scaleX: 2,
            scaleY: 2,
        });
        // The raster fills the box the document normalized it into...
        expect(toPreviewStyleRect({
            xPx: 0,
            yPx: 0,
            widthPx: 105,
            heightPx: 150,
        }, placement)).toEqual({
            left: `${10 / 230 * 100}%`,
            top: `${15 / 330 * 100}%`,
            width: `${210 / 230 * 100}%`,
            height: `${300 / 330 * 100}%`,
        });
        // ...and so does every overlay measured in that raster's own pixels.
        expect(toPreviewStyleRect({
            xPx: 5,
            yPx: 10,
            widthPx: 50,
            heightPx: 60,
        }, placement)).toEqual({
            left: `${(10 + 10) / 230 * 100}%`,
            top: `${(20 + 15) / 330 * 100}%`,
            width: `${100 / 230 * 100}%`,
            height: `${120 / 330 * 100}%`,
        });
    });

    it('measures each axis from the content box side it belongs to', () => {
        // The main process rounds each side of the content box to a whole
        // canvas pixel on its own, so the two ratios differ by that rounding.
        // A single ratio taken from the width would put the bottom of the page
        // a pixel away from the box the page is actually drawn in.
        const roundedMetadata = metadata({
            outputWidthPx: 101,
            outputHeightPx: 143,
            canvasWidthPx: 202,
            canvasHeightPx: 286,
            matchedCanvasContentWidthPx: 202,
            matchedCanvasContentHeightPx: 285,
            placementOffsetXPx: 0,
            placementOffsetYPx: 1,
        });
        const placement = resolvePreviewMetadataPlacement(roundedMetadata);

        expect(placement.scaleX).toBe(202 / 101);
        expect(placement.scaleY).toBe(285 / 143);
        // The raster's own rect fills exactly the box the metadata reports,
        // on both axes.
        expect(toPreviewStyleRect({
            xPx: 0,
            yPx: 0,
            widthPx: 101,
            heightPx: 143,
        }, placement)).toEqual({
            left: '0%',
            top: `${1 / 286 * 100}%`,
            width: '100%',
            height: `${285 / 286 * 100}%`,
        });
        // And the bottom edge of a rect that reaches the raster's last row
        // still lands on the bottom of that box rather than past it.
        const bottom = toPreviewStyleRect({
            xPx: 0,
            yPx: 142,
            widthPx: 101,
            heightPx: 1,
        }, placement);
        expect(Number.parseFloat(String(bottom.top)) + Number.parseFloat(String(bottom.height)))
            .toBeCloseTo((1 + 285) / 286 * 100, 10);
    });

    it('changes the frozen-frame signature for paper geometry but not pixel-only refreshes', async () => {
        const initialMetadata = metadata({
            outputWidthPx: 430,
            outputHeightPx: 630,
            canvasWidthPx: 460,
            canvasHeightPx: 660,
            placementOffsetXPx: 15,
            placementOffsetYPx: 15,
        });
        const result = shallowRef<IScanCleanupPreviewResult | null>(previewResult(initialMetadata));
        const activeDrag = ref(false);
        const scope = effectScope();
        const viewport = scope.run(() => useScanCleanupViewportFrame({
            activeDrag,
            fitAreaSizes: {full: {
                left: 0,
                top: 0,
                width: 800,
                height: 800,
            }},
            matchPageSize: () => true,
            requestedPage: () => 1,
            result: () => result.value,
        }))!;
        const initialSignature = viewport.signature.value;

        result.value = previewResult({...initialMetadata}, 2);
        await nextTick();
        expect(viewport.signature.value).toBe(initialSignature);

        result.value = previewResult({
            ...initialMetadata,
            outputWidthPx: 530,
            outputHeightPx: 730,
        }, 3);
        await nextTick();
        const intrinsicSignature = viewport.signature.value;
        expect(intrinsicSignature).not.toBe(initialSignature);

        result.value = previewResult({
            ...initialMetadata,
            outputWidthPx: 530,
            outputHeightPx: 730,
            canvasWidthPx: 560,
            canvasHeightPx: 760,
        }, 4);
        await nextTick();
        expect(viewport.signature.value).not.toBe(intrinsicSignature);
        expect(viewport.frame.value.outputs.full).toEqual({
            width: 560,
            height: 760,
        });
        scope.stop();
    });

    it('round-trips a rotated manual cutter through preview coordinates', () => {
        const analysisWidth = scanCleanupAnalysisWidth({rotationDegrees: 90}, 1200, 800);
        expect(analysisWidth).toBe(800);
        const sourceX = 317;
        const ratio = scanCleanupCutterRatio(sourceX, analysisWidth);
        expect(scanCleanupCutterXFromRatio(ratio, analysisWidth)).toBeCloseTo(sourceX, 8);
    });

    it('maps a source cutter into the fitted source image instead of the full stage', () => {
        const placement = resolvePreviewFitPlacement(800, 600, 1200, 1800);
        expect(placement).toEqual({
            width: 400,
            height: 600,
            left: 200,
            top: 0,
        });
        expect(placement.left + placement.width * scanCleanupCutterRatio(600, 1200)).toBe(400);
    });

    it.each([
        {
            label: 'narrow',
            areas: [
                {
                    width: 180,
                    height: 520,
                },
                {
                    width: 180,
                    height: 520,
                },
            ],
        },
        {
            label: 'wide',
            areas: [
                {
                    width: 620,
                    height: 340,
                },
                {
                    width: 620,
                    height: 340,
                },
            ],
        },
    ])('preserves the exact canvas ratio in a $label editor', ({areas}) => {
        const canvases = [
            {
                width: 500,
                height: 800,
            },
            {
                width: 500,
                height: 800,
            },
        ];
        const rendered = resolvePreviewOutputFitSizes(areas, canvases);
        expect(rendered).toHaveLength(2);
        expect(rendered[0]!.width / rendered[0]!.height).toBe(500 / 800);
        expect(rendered[1]).toEqual(rendered[0]);
    });

    it('places a symmetric spread cutter at the exact rendered-box gap center', () => {
        const areas = [
            {
                left: 0,
                top: 0,
                width: 390,
                height: 600,
            },
            {
                left: 410,
                top: 0,
                width: 390,
                height: 600,
            },
        ];
        const canvases = [
            {
                width: 500,
                height: 800,
            },
            {
                width: 500,
                height: 800,
            },
        ];
        const renderedBoxes = resolvePreviewOutputFitRects(areas, canvases);

        expect(renderedBoxes).toEqual([
            {
                left: 7.5,
                top: 0,
                width: 375,
                height: 600,
            },
            {
                left: 417.5,
                top: 0,
                width: 375,
                height: 600,
            },
        ]);
        expect(resolvePreviewSpreadCutterCenter(renderedBoxes.filter(
            (box): box is IScanCleanupPreviewFitPlacement => 'left' in box && 'top' in box,
        ))).toBe(400);
    });

    it('keeps a prefetch that finishes after navigation superseded it, and starts no more', async () => {
        const prefetchResult = Promise.withResolvers<{pageNumber: number}>();
        const preview = vi.fn((request: {pageNumber: number}) => request.pageNumber === 2
            ? prefetchResult.promise
            : Promise.resolve({pageNumber: request.pageNumber}));
        const store = vi.fn();
        const prefetcher = createScanCleanupPreviewPrefetcher({
            isCached: () => false,
            preview,
            store,
        });
        prefetcher.schedule([
            {
                key: 'page-2',
                request: {pageNumber: 2},
            },
            {
                key: 'page-3',
                request: {pageNumber: 3},
            },
        ]);
        expect(preview).toHaveBeenCalledTimes(1);

        prefetcher.supersede();
        prefetchResult.resolve({pageNumber: 2});
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

        // The page is already rendered and the cache key names its content, so
        // keeping it costs nothing and re-rendering it costs a whole preview.
        expect(store).toHaveBeenCalledTimes(1);
        expect(store).toHaveBeenCalledWith('page-2', {pageNumber: 2});
        // The rest of the superseded queue still never starts.
        expect(preview).toHaveBeenCalledTimes(1);
    });

});
