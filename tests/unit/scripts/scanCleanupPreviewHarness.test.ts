import {
    mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {omit} from 'es-toolkit';
import {DEFAULT_SCAN_CLEANUP_PREFERENCES} from '@contracts/scan-cleanup/scanCleanupSettings';
import {requirePageNumber} from '@contracts/pageNumbers';
import {createFileBackedScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/fileBackedResultStore';
import {
    createScanCleanupDetectionCacheKey, writeScanCleanupDetectionCacheStore,
} from '@scripts/scanCleanupDetectionCache';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    compareMetrics,
    loadDetection,
    independentReaderScale,
    independentReaderWrongCalibrationOffset,
    measureOverlayContainment,
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
    it('counts an ink pixel whose cell intersects a subpixel overlay edge', () => {
        const bitmap = {
            data: (() => {
                const data = new Uint8Array(2 * 100).fill(255);
                data[0] = 0;
                return data;
            })(),
            height: 100,
            width: 2,
        };

        expect(measureOverlayContainment(
            bitmap,
            {
                bottom: 1,
                left: 0,
                right: 1,
                top: 0.51,
            },
            0.01,
            0.03,
        )).toMatchObject({
            containment: 1,
            pass: true,
        });
    });

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

    it('rejects uniform threefold thickening on the same raster grid', () => {
        const original = weightUniformity(textBitmap([
            4,
            4,
            4,
            4,
        ]));
        const thickened = weightUniformity(textBitmap([
            12,
            12,
            12,
            12,
        ]));
        expect(weightAgreementViolations(compareMetrics(original, original))).toEqual([]);
        expect(weightAgreementViolations(compareMetrics(original, thickened)))
            .toEqual(['preview-final-weight-agreement']);
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


describe('preview oracle detection cache', () => {
    it('reads selected pages from a valid 1025-page descriptor and rejects a missing cache', async () => {
        const root = await mkdtemp(join(tmpdir(), 'preview-cache-'));
        const source = join(root, 'source.pdf');
        const options = {
            ...omit(DEFAULT_SCAN_CLEANUP_PREFERENCES, ['firstRunGuidanceDismissed']),
            outputMode: 'auto' as const,
            pageOverrides: {},
        };
        const tools = {
            pdftoppm: process.execPath,
            scanCleanup: process.execPath,
        };
        await writeFile(source, 'source identity');
        const key = await createScanCleanupDetectionCacheKey(source, options, {
            pdftoppmBinaryPath: tools.pdftoppm,
            scanCleanupBinaryPath: tools.scanCleanup,
        });
        const store = await createFileBackedScanCleanupDetectionResultStore({
            rootDir: root,
            pageCount: 1025,
        });
        try {
            for (let page = 1; page <= 1025; page++) {
                await store.append({
                    pageNumber: requirePageNumber(page),
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                    cutterXPx: null,
                    documentPrior: null,
                    tier1Verdict: 'single-uncut-page',
                    reconciled: true,
                    clusterAgreement: 1,
                });
            }
            await writeScanCleanupDetectionCacheStore(join(root, 'cache'), key, store);
            const detection = await loadDetection({
                source,
                detectionCache: join(root, 'cache'),
            }, tools);
            try {
                expect(detection.resultStore.pageCount).toBe(1025);
                expect((await detection.resultStore.getPage(1025))?.pageNumber).toBe(1025);
                expect(detection).not.toHaveProperty('results');
            } finally {
                await detection.resultStore.close();
            }
            await expect(loadDetection({
                source,
                detectionCache: join(root, 'missing'),
            }, tools)).rejects.toThrow();
        } finally {
            await store.close();
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });
});
