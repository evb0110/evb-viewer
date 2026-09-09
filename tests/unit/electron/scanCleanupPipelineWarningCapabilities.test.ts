import {
    describe,
    expect,
    it,
} from 'vitest';
import type {TScanCleanupWarningEvent} from '@contracts/electronApiScanCleanup';
import {createEmptyScanCleanupSummary} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {formatScanCleanupWarningEvent} from '@evb/scan-cleanup/core/policy/scanCleanupWarningEvents';
import {reportScanCleanupNativeWarnings} from '@evb/scan-cleanup/core/runScanCleanupConversion';

const nativeWarningEvent = {code: 'matched-canvas-margins-reduced'} satisfies TScanCleanupWarningEvent;

describe('scan cleanup pipeline warning capabilities', () => {
    it.each([
        false,
        true,
    ])('always reports native warning strings and gates structured events (%s)', (structuredWarningEventsSupported) => {
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
            {structuredWarningEventsSupported},
            new Set(),
            message => reported.push(message),
        );

        expect(reported).toContain('Page 1: Deskew was skipped because the native page had no usable content box');
        expect(summary.warningEvents).toEqual(structuredWarningEventsSupported
            ? [{
                event: nativeWarningEvent,
                pageNumber: 1,
                half: 'full',
            }]
            : []);
        if (structuredWarningEventsSupported) {
            expect(reported).toContain(formatScanCleanupWarningEvent(nativeWarningEvent, 1));
        } else {
            expect(reported).not.toContain(formatScanCleanupWarningEvent(nativeWarningEvent, 1));
        }
    });
});
