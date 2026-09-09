import {
    describe,
    expect,
    it,
} from 'vitest';
import {buildScanCleanupSourceMrcForegroundPdfMatrix} from '@evb/scan-cleanup/core/buildScanCleanupSourceMrcForegroundPdfMatrix';
import {
    sourceMrcForegroundPdfMatrix,
    type IRenderedCleanupOutputPage,
} from '@evb/scan-cleanup/core/assembleCompactScanCleanupPages';

function output(overrides: Partial<IRenderedCleanupOutputPage['metadata']> = {}) {
    return {
        sourcePageNumber: 1,
        path: '/cleaned.png',
        dpi: 300,
        resolvedOutputMode: 'mixed' as const,
        metadata: {
            inputWidthPx: 1_000,
            inputHeightPx: 1_000,
            outputWidthPx: 1_000,
            outputHeightPx: 1_000,
            intrinsicRasterWidthPx: 1_100,
            intrinsicRasterHeightPx: 1_000,
            matchedCanvasContentWidthPx: 1_100,
            matchedCanvasContentHeightPx: 1_000,
            canvasWidthPx: 1_000,
            canvasHeightPx: 1_000,
            placementOffsetXPx: 0,
            placementOffsetYPx: 0,
            matchedCanvasIntrinsicOverflowLeftPx: 80,
            matchedCanvasIntrinsicOverflowRightPx: 20,
            matchedCanvasIntrinsicOverflowTopPx: 20,
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
            dewarpMapping: null,
            ...overrides,
        },
    } as IRenderedCleanupOutputPage;
}

describe('scan-cleanup source MRC geometry', () => {
    it('subtracts clipped intrinsic overflow before placing a preserved foreground', () => {
        const matrix = sourceMrcForegroundPdfMatrix(
            output(),
            {
                backgroundDpi: 100,
                backgroundPath: '/background.ppm',
                foregroundDpi: 300,
                foregroundHeight: 1_000,
                foregroundPath: '/foreground.jp2',
                foregroundWidth: 1_000,
                selectionMaskDecode: 'default',
                selectionMaskPath: '/selection.jb2e',
            },
            100,
            100,
        );

        expect(matrix).toEqual([
            100,
            -0,
            -0,
            100,
            -8,
            2,
        ]);
    });

    it('applies independent matched-canvas x and y scales', () => {
        const rendered = output({
            inputWidthPx: 800,
            inputHeightPx: 600,
            intrinsicRasterWidthPx: 400,
            intrinsicRasterHeightPx: 300,
            matchedCanvasContentWidthPx: 600,
            matchedCanvasContentHeightPx: 600,
            canvasWidthPx: 600,
            canvasHeightPx: 600,
            matchedCanvasIntrinsicOverflowLeftPx: 0,
            matchedCanvasIntrinsicOverflowTopPx: 0,
        });
        const matrix = buildScanCleanupSourceMrcForegroundPdfMatrix(
            rendered.metadata,
            {
                backgroundDpi: 100,
                backgroundPath: '/background.ppm',
                foregroundDpi: 300,
                foregroundHeight: 300,
                foregroundPath: '/foreground.jp2',
                foregroundWidth: 400,
                selectionMaskDecode: 'default',
                selectionMaskPath: '/selection.jb2e',
            },
            600,
            600,
        );

        expect(matrix).toEqual([
            1_200,
            -0,
            -0,
            1_200,
            0,
            -600,
        ]);
    });

    it('combines placement offsets with clipped intrinsic overflow', () => {
        const rendered = output({
            intrinsicRasterWidthPx: 1_000,
            intrinsicRasterHeightPx: 1_000,
            matchedCanvasContentWidthPx: 1_000,
            matchedCanvasContentHeightPx: 1_000,
            placementOffsetXPx: 50,
            placementOffsetYPx: 70,
            matchedCanvasIntrinsicOverflowLeftPx: 20,
            matchedCanvasIntrinsicOverflowTopPx: 30,
        });
        const matrix = buildScanCleanupSourceMrcForegroundPdfMatrix(
            rendered.metadata,
            {
                backgroundDpi: 100,
                backgroundPath: '/background.ppm',
                foregroundDpi: 300,
                foregroundHeight: 1_000,
                foregroundPath: '/foreground.jp2',
                foregroundWidth: 1_000,
                selectionMaskDecode: 'default',
                selectionMaskPath: '/selection.jb2e',
            },
            100,
            100,
        );

        expect(matrix).toEqual([
            100,
            -0,
            -0,
            100,
            3,
            -4,
        ]);
    });

    it('converts source pixels through non-unit page-to-canvas ratios', () => {
        const rendered = output({
            inputWidthPx: 1_000,
            inputHeightPx: 800,
            outputWidthPx: 1_000,
            outputHeightPx: 800,
            intrinsicRasterWidthPx: 1_000,
            intrinsicRasterHeightPx: 800,
            matchedCanvasContentWidthPx: 1_000,
            matchedCanvasContentHeightPx: 800,
            canvasWidthPx: 2_000,
            canvasHeightPx: 1_600,
            matchedCanvasIntrinsicOverflowLeftPx: 0,
            matchedCanvasIntrinsicOverflowTopPx: 0,
        });
        const matrix = buildScanCleanupSourceMrcForegroundPdfMatrix(
            rendered.metadata,
            {
                backgroundDpi: 100,
                backgroundPath: '/background.ppm',
                foregroundDpi: 300,
                foregroundHeight: 800,
                foregroundPath: '/foreground.jp2',
                foregroundWidth: 1_000,
                selectionMaskDecode: 'default',
                selectionMaskPath: '/selection.jb2e',
            },
            400,
            240,
        );

        expect(matrix).toEqual([
            200,
            -0,
            -0,
            120,
            0,
            120,
        ]);
    });
});
