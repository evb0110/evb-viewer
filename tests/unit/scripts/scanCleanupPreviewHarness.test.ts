import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    compareMetrics,
    independentReaderScale,
    independentReaderWrongCalibrationOffset,
    weightAgreementViolations,
    weightUniformity,
} from '@scripts/diagnostics/scan-cleanup-preview-harness.mjs';

interface IBitmap {
    data: Uint8Array;
    height: number;
    width: number;
}

function textBitmap(wordWidths: readonly [number, number, number, number]): IBitmap {
    const width = 96;
    const height = 64;
    const data = new Uint8Array(width * height).fill(255);
    const lineTops = [
        8,
        36,
    ];
    const wordPositions = [
        8,
        28,
    ];
    for (const [
        index,
        wordWidth,
    ] of wordWidths.entries()) {
        const lineTop = lineTops[Math.floor(index / 2)]!;
        const left = wordPositions[index % 2]!;
        for (let y = lineTop; y < lineTop + 8; y += 1) {
            for (let x = left; x < left + wordWidth; x += 1) {
                data[y * width + x] = 0;
            }
        }
    }
    return {
        data,
        height,
        width,
    };
}

describe('scan cleanup preview weight agreement', () => {
    it('maps cropped native output into the matched canvas before reading ink', () => {
        expect(independentReaderScale({
            canvasHeightPx: 120,
            canvasWidthPx: 160,
            matchedCanvasContentHeightPx: 46,
            matchedCanvasContentWidthPx: 100,
            outputHeightPx: 103,
            outputWidthPx: 226,
        }, 160, 121)).toEqual({
            x: 100 / 226,
            y: 121 / 120 * 46 / 103,
        });
    });

    it('converts the wrong-calibration offset into final raster pixels', () => {
        expect(independentReaderWrongCalibrationOffset(100, 320, 160)).toBe(160);
        expect(independentReaderWrongCalibrationOffset(20, 100, 400)).toBe(40);
    });

    it('accepts the measured RGB-camera preview residual', () => {
        const comparison = compareMetrics(
            {
                lineMaxMinRatio: 1.2148,
                wordRunMedianPx: 3.3244,
                wordVariancePx: 0.2172,
                wordVarianceProxy: 0.0653,
            },
            {
                lineMaxMinRatio: 1.1494,
                wordRunMedianPx: 3.9334,
                wordVariancePx: 0.1355,
                wordVarianceProxy: 0.0344,
            },
        );

        expect(comparison).toMatchObject({
            measurable: true,
            lineRatioDeviation: 0.0569,
            wordVarianceResidualPx: 0.0817,
            wordVarianceDeviation: 0.0208,
            weightDeviation: 0.0569,
        });
        expect(comparison.weightDeviation).toBeLessThanOrEqual(0.15);
    });

    it('rejects a real two-word weight divergence', () => {
        const preview = weightUniformity(textBitmap([
            4,
            10,
            4,
            10,
        ]));
        const final = weightUniformity(textBitmap([
            4,
            4,
            4,
            4,
        ]));
        const comparison = compareMetrics(preview, final);

        expect(preview).toMatchObject({
            lineCount: 2,
            wordCount: 4,
        });
        expect(final).toMatchObject({
            lineCount: 2,
            wordCount: 4,
        });
        expect(comparison.weightDeviation).toBeGreaterThan(0.15);
        expect(weightAgreementViolations(comparison)).toEqual(['preview-final-weight-agreement']);
    });
});
