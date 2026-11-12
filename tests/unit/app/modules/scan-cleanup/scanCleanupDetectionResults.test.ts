import {
    describe,
    expect,
    it,
} from 'vitest';
import {estimateScanCleanupOutputPages} from '@evb/scan-cleanup/core/policy/scanCleanupPagePolicy';

describe('scan cleanup detection results', () => {
    it('produces an exact estimate with detected layouts, overrides, and exclusions', () => {
        const classifications = new Map([
            [
                1,
                'two-page-spread' as const,
            ],
            [
                2,
                'single-uncut-page' as const,
            ],
            [
                3,
                'single-uncut-page' as const,
            ],
            [
                4,
                'two-page-spread' as const,
            ],
        ]);

        expect(estimateScanCleanupOutputPages(4, {
            layoutMode: 'auto',
            pageOverrides: {
                '2': {
                    rotationDegrees: 0,
                    layoutOverride: 'spread',
                    excluded: false,
                    manualSplit: null,
                },
                '4': {
                    rotationDegrees: 0,
                    layoutOverride: 'auto',
                    excluded: true,
                    manualSplit: null,
                },
            },
        }, classifications)).toEqual({
            exact: true,
            outputPages: 5,
        });
    });
});
