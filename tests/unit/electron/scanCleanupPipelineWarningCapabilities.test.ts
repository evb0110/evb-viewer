import {
    describe,
    expect,
    it,
} from 'vitest';
import type {TScanCleanupWarningEvent} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {createEmptyScanCleanupSummary} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {formatScanCleanupWarningEvent} from '@evb/scan-cleanup/core/policy/scanCleanupWarningEvents';
import {reportScanCleanupNativeWarnings} from '@evb/scan-cleanup/core/runScanCleanupConversion';

const nativeWarningEvent = {code: 'matched-canvas-margins-reduced'} satisfies TScanCleanupWarningEvent;

describe('scan cleanup pipeline native warnings', () => {
    it('reports native warning strings and structured events', () => {
        const summary = createEmptyScanCleanupSummary(1, []);
        const reported: string[] = [];

        reportScanCleanupNativeWarnings(
            summary,
            {
                half: 'full',
                warnings: ['Deskew was skipped because the native page had no usable content box'],
                warningEvents: [nativeWarningEvent],
            },
            1,
            new Set(),
            message => reported.push(message),
        );

        expect(reported).toContain('Page 1: Deskew was skipped because the native page had no usable content box');
        expect(summary.warningEvents).toEqual([{
            event: nativeWarningEvent,
            pageNumber: 1,
            half: 'full',
        }]);
        expect(reported).toContain(formatScanCleanupWarningEvent(nativeWarningEvent, 1));
    });
});
