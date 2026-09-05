import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { renderPdfCanvasFidelityMetrics } from '@tests/helpers/renderPdfCanvasFidelityMetrics';

const fixtures = [
    {
        file: 'generated-text.pdf',
        expected: {
            dark: 0.00418,
            ink: 0.01147,
            luminance: {
                max: 253.922,
                min: 253.822,
            },
            textItems: 6,
        },
    },
    {
        file: 'freetext-lifecycle-test.pdf',
        expected: {
            dark: 0.00448,
            // PDF.js 5.7.304's forked text rendering changes the anti-aliased
            // edge coverage for this fixture. Keep the measured value pinned.
            ink: 0.00769,
            luminance: {
                max: 253.945,
                min: 253.818,
            },
            textItems: 3,
        },
    },
    {
        file: 'test-scanned.pdf',
        expected: {
            dark: 0.01040,
            ink: 0.01284,
            luminance: {
                max: 252.259,
                min: 252.159,
            },
            textItems: 0,
        },
    },
] as const;

describe('PDF canvas fidelity corpus', () => {
    for (const fixture of fixtures) {
        it(`renders ${fixture.file} at its matched physical scale`, async () => {
            const metrics = await renderPdfCanvasFidelityMetrics(resolve(
                process.cwd(),
                'tests/fixtures/electron',
                fixture.file,
            ));

            expect(metrics.width).toBe(612);
            expect(metrics.height).toBe(792);
            expect(metrics.textItemCount).toBe(fixture.expected.textItems);
            expect(metrics.inkPixelRatio).toBeCloseTo(fixture.expected.ink, 3);
            expect(metrics.darkPixelRatio).toBeCloseTo(fixture.expected.dark, 3);
            expect(metrics.meanLuminance).toBeGreaterThanOrEqual(fixture.expected.luminance.min);
            expect(metrics.meanLuminance).toBeLessThanOrEqual(fixture.expected.luminance.max);
        });
    }
});
