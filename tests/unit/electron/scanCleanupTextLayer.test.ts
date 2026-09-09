import {
    buildScanCleanupTextLayerPlan,
    resolveScanCleanupTextLayerInstruction,
} from '@evb/scan-cleanup/core/sourceTextLayer';
import type {IRenderedCleanupOutputPage} from '@evb/scan-cleanup/core/assembleCompactScanCleanupPages';
import type {IPdfPageSize} from '@evb/scan-cleanup/core/types';
import {
    describe,
    expect,
    it,
} from 'vitest';

const pageSize: IPdfPageSize = {
    pageNumber: 1,
    xPoints: 0,
    yPoints: 0,
    widthPoints: 200,
    heightPoints: 120,
    rotation: 0,
};

function output(
    overrides: Partial<IRenderedCleanupOutputPage['metadata']> = {},
): IRenderedCleanupOutputPage {
    return {
        sourcePageNumber: 1,
        path: '/cleaned.png',
        dpi: 360,
        resolvedOutputMode: 'bw',
        metadata: {
            outputWidthPx: 1_000,
            outputHeightPx: 600,
            canvasWidthPx: 1_000,
            canvasHeightPx: 600,
            layoutClassification: 'single-uncut-page',
            skewApplied: false,
            inputWidthPx: 1_000,
            inputHeightPx: 600,
            placementOffsetXPx: 0,
            placementOffsetYPx: 0,
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
            rotationDegrees: 0,
            ...overrides,
        },
    };
}

describe('scan-cleanup source text layer', () => {
    it('maps unchanged source user space onto the cleaned page', () => {
        const instruction = resolveScanCleanupTextLayerInstruction(output(), 0, pageSize);

        expect(instruction).not.toBeNull();
        expect(instruction!.sourcePageIndex).toBe(0);
        expect(instruction!.outputPageIndex).toBe(0);
        expect(instruction!.matrix).toEqual([
            1,
            0,
            0,
            1,
            0,
            0,
        ]);
    });

    it('includes native crop translation and matched-canvas placement', () => {
        const instruction = resolveScanCleanupTextLayerInstruction(output({
            outputWidthPx: 800,
            outputHeightPx: 500,
            canvasWidthPx: 500,
            canvasHeightPx: 300,
            matchedCanvasTargetWidthPoints: 100,
            matchedCanvasTargetHeightPoints: 60,
            matchedCanvasContentWidthPx: 400,
            matchedCanvasContentHeightPx: 250,
            placementOffsetXPx: 50,
            placementOffsetYPx: 25,
            forwardTransform: {matrix: [
                [
                    1,
                    0,
                    -100,
                ],
                [
                    0,
                    1,
                    -50,
                ],
                [
                    0,
                    0,
                    1,
                ],
            ]},
        }), 3, pageSize);

        expect(instruction!.matrix).toEqual([
            0.5,
            0,
            0,
            0.5,
            0,
            0,
        ]);
        expect(instruction!.outputPageIndex).toBe(3);
    });

    it('uses the intrinsic raster extent for matched grayscale geometry', () => {
        const instruction = resolveScanCleanupTextLayerInstruction(output({
            outputWidthPx: 845,
            outputHeightPx: 507,
            intrinsicRasterWidthPx: 1_000,
            intrinsicRasterHeightPx: 600,
            canvasWidthPx: 1_000,
            canvasHeightPx: 600,
            matchedCanvasContentWidthPx: 845,
            matchedCanvasContentHeightPx: 507,
        }), 0, pageSize);

        expect(instruction!.matrix[0]).toBeCloseTo(0.845, 12);
        expect(instruction!.matrix[3]).toBeCloseTo(0.845, 12);
    });

    it('keeps source text registered when a white left fold tail is clipped', () => {
        const instruction = resolveScanCleanupTextLayerInstruction(output({
            outputWidthPx: 1_000,
            outputHeightPx: 600,
            intrinsicRasterWidthPx: 1_100,
            intrinsicRasterHeightPx: 600,
            canvasWidthPx: 1_000,
            canvasHeightPx: 600,
            matchedCanvasContentWidthPx: 1_100,
            matchedCanvasContentHeightPx: 600,
            matchedCanvasIntrinsicOverflowLeftPx: 80,
            placementOffsetXPx: 0,
        }), 0, pageSize);

        expect(instruction!.matrix).toEqual([
            1,
            0,
            0,
            1,
            -16,
            0,
        ]);
    });

    it('keeps source text vertically registered with glyphs after top headroom is trimmed', () => {
        const instruction = resolveScanCleanupTextLayerInstruction(output({
            outputWidthPx: 1_000,
            outputHeightPx: 600,
            intrinsicRasterWidthPx: 1_000,
            intrinsicRasterHeightPx: 600,
            canvasWidthPx: 1_000,
            canvasHeightPx: 600,
            matchedCanvasContentWidthPx: 1_000,
            matchedCanvasContentHeightPx: 600,
            matchedCanvasIntrinsicOverflowTopPx: 80,
            placementOffsetYPx: 0,
        }), 0, pageSize);

        // The raster materializer discards 80 source rows. The same 16-point
        // translation moves selectable text onto the glyphs in the output PDF.
        expect(instruction!.matrix).toEqual([
            1,
            0,
            0,
            1,
            0,
            16,
        ]);
    });

    it('keeps cropped source text registered when content alignment moves the raster', () => {
        const instruction = resolveScanCleanupTextLayerInstruction(output({
            outputWidthPx: 800,
            outputHeightPx: 500,
            canvasWidthPx: 500,
            canvasHeightPx: 300,
            matchedCanvasTargetWidthPoints: 100,
            matchedCanvasTargetHeightPoints: 60,
            matchedCanvasContentWidthPx: 400,
            matchedCanvasContentHeightPx: 250,
            placementOffsetXPx: 70,
            placementOffsetYPx: 35,
            forwardTransform: {matrix: [
                [
                    1,
                    0,
                    -100,
                ],
                [
                    0,
                    1,
                    -50,
                ],
                [
                    0,
                    0,
                    1,
                ],
            ]},
        }), 0, pageSize);

        expect(instruction!.matrix).toEqual([
            0.5,
            0,
            0,
            0.5,
            4,
            -2,
        ]);
    });

    it('marks split halves for semantic filtering without changing affine singles', () => {
        const left = resolveScanCleanupTextLayerInstruction(output({
            half: 'left',
            layoutClassification: 'two-page-spread',
            outputWidthPx: 500,
            canvasWidthPx: 500,
        }), 0, pageSize);
        const right = resolveScanCleanupTextLayerInstruction(output({
            half: 'right',
            layoutClassification: 'two-page-spread',
            outputWidthPx: 500,
            canvasWidthPx: 500,
            forwardTransform: {matrix: [
                [
                    1,
                    0,
                    -500,
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
        }), 1, pageSize);

        expect(left).toMatchObject({
            matrix: [
                1,
                0,
                0,
                1,
                0,
                0,
            ],
            filterToOutputPage: true,
        });
        expect(right).toMatchObject({
            matrix: [
                1,
                0,
                0,
                1,
                -100,
                0,
            ],
            filterToOutputPage: true,
        });
        expect(resolveScanCleanupTextLayerInstruction(output(), 2, pageSize))
            .not.toHaveProperty('filterToOutputPage');
    });

    it('maps PDF page rotation and cleanup rotation through the same affine', () => {
        const cleanupRotated = resolveScanCleanupTextLayerInstruction(output({
            inputWidthPx: 1_000,
            inputHeightPx: 600,
            outputWidthPx: 600,
            outputHeightPx: 1_000,
            canvasWidthPx: 600,
            canvasHeightPx: 1_000,
            rotationDegrees: 90,
        }), 0, pageSize);
        const sourceRotated = resolveScanCleanupTextLayerInstruction(output({
            inputWidthPx: 600,
            inputHeightPx: 1_000,
            outputWidthPx: 600,
            outputHeightPx: 1_000,
            canvasWidthPx: 600,
            canvasHeightPx: 1_000,
        }), 0, {
            ...pageSize,
            rotation: 90,
        });

        const clockwise = [
            0,
            -1,
            1,
            0,
            0,
            200,
        ];
        expect(cleanupRotated!.matrix).toEqual(clockwise);
        expect(sourceRotated!.matrix).toEqual(clockwise);
    });

    it('reports non-affine pages and leaves source-preserved OCR alone', () => {
        const dewarped = output({
            forwardTransform: null,
            dewarpMapping: {
                columns: 2,
                rows: 2,
                outputOrigin: {
                    x: 0,
                    y: 0,
                },
                outputWidth: 1_000,
                outputHeight: 600,
                outputToSource: [],
                sourceToOutput: [],
            },
        });
        const preserved = {
            ...output(),
            sourcePageNumber: 2,
            preservedSource: {
                reason: 'auto-color-compact-layered-no-raster-change' as const,
                sourcePageIndex: 1,
                rotationQuarterTurns: 0,
                cropRect: {
                    x: 0,
                    y: 0,
                    width: 200,
                    height: 120,
                },
                contentTransform: {
                    scale: 1,
                    translateX: 0,
                    translateY: 0,
                },
            },
        };

        expect(buildScanCleanupTextLayerPlan([
            dewarped,
            preserved,
        ], [
            pageSize,
            {
                ...pageSize,
                pageNumber: 2,
            },
        ])).toEqual({
            pages: [],
            skippedNonAffine: [1],
            alreadyPreserved: [2],
        });
    });

    it('rejects page geometry that is not in document order', () => {
        expect(() => buildScanCleanupTextLayerPlan([output()], [
            {
                ...pageSize,
                pageNumber: 2,
            },
            pageSize,
        ])).toThrow(
            'Scan cleanup text layer planning received page geometry out of document order: expected page 1 at index 0, received page 2',
        );
    });
});
