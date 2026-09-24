import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    collectArnoldConsoleNavLog,
    collectArnoldConsoleRenderTrace,
    collectArnoldWorkingCopyPaths,
    isArnoldOwnedFrameWithinBudget,
    isExpectedArnoldDiagnosticWarning,
    summarizeArnoldOpenTrace,
} from '@scripts/diagnostics/runArnoldPdfOpenDiagnostics';

describe('Arnold PDF-open diagnostic acceptance helpers', () => {
    it('accepts only the diagnostic warning sections intentionally promoted to warnings', () => {
        expect(isExpectedArnoldDiagnosticWarning('[pdf-render-trace] renderer-finalize-page')).toBe(true);
        expect(isExpectedArnoldDiagnosticWarning('[pdf-nav] scroll viewer')).toBe(true);
        expect(isExpectedArnoldDiagnosticWarning('[pdf-zoom-debug] zoom queue scheduled')).toBe(true);
        expect(isExpectedArnoldDiagnosticWarning('[recent-open] unexpected warning')).toBe(false);
    });

    it('derives one working-copy identity from the current source-loading route', () => {
        const workingPath = '/tmp/evb-viewer/pdf-work-1/document.pdf';
        expect(collectArnoldWorkingCopyPaths([
            {
                event: 'pdf-open-source-ready',
                payload: {path: workingPath},
            },
            {
                event: 'pdf-document-range-preload-start',
                payload: {path: workingPath},
            },
            {
                event: 'pdf-document-options-start',
                payload: {path: workingPath},
            },
            {
                event: 'pdf-document-get-document-submit',
                payload: {path: workingPath},
            },
            {
                event: 'pdf-open-capability-end',
                payload: {workingPath: '/obsolete/route.pdf'},
            },
        ])).toEqual([
            workingPath,
            workingPath,
            workingPath,
            workingPath,
        ]);
    });

    it('reconstructs render and navigation evidence when the window-scoped buffers are unavailable', () => {
        const entries = [
            {
                receivedAtMs: 321,
                text: '[2026-07-12T21:29:03.524Z] [pdf-render-trace] pdf-open-source-ready [object Object]',
                args: [
                    '[2026-07-12T21:29:03.524Z] [pdf-render-trace] pdf-open-source-ready',
                    {
                        traceAtMs: 42,
                        path: '/tmp/document.pdf',
                    },
                ],
            },
            {
                receivedAtMs: 350,
                text: '[2026-07-12T21:29:03.633Z] [pdf-nav] Workspace state changed [object Object]',
                args: [
                    '[2026-07-12T21:29:03.633Z] [pdf-nav] Workspace state changed',
                    {currentPage: 1},
                ],
            },
            {
                receivedAtMs: 400,
                text: '[unrelated] warning',
                args: [],
            },
        ];

        expect(collectArnoldConsoleRenderTrace(entries)).toEqual([{
            event: 'pdf-open-source-ready',
            payload: {
                traceAtMs: 42,
                path: '/tmp/document.pdf',
            },
        }]);
        expect(collectArnoldConsoleNavLog(entries)).toEqual([{
            message: 'Workspace state changed',
            args: [{currentPage: 1}],
            loggedAtMs: 350,
        }]);
    });

    it('keeps the 500 ms product budget against browser-presentable RAF timing', () => {
        expect(isArnoldOwnedFrameWithinBudget(500)).toBe(true);
        expect(isArnoldOwnedFrameWithinBudget(501)).toBe(false);
    });

    it('records the validation cache, PDF.js milestones, and requested bytes', () => {
        const trace = [
            [
                'viewport-session-open-requested',
                100,
                {},
            ],
            [
                'pdf-open-validate-start',
                190,
                {},
            ],
            [
                'pdf-document-get-document-submit',
                220,
                {},
            ],
            [
                'pdf-open-validate-end',
                1_000,
                {cacheResult: 'miss'},
            ],
            [
                'pdf-document-range-request',
                1_100,
                {length: 1_048_576},
            ],
            [
                'pdf-document-range-request',
                1_200,
                {length: 512},
            ],
            [
                'pdf-document-range-request',
                1_250,
                {length: -1},
            ],
            [
                'pdf-document-get-document-resolve',
                1_300,
                {},
            ],
            [
                'renderer-canvas-mounted',
                1_400,
                {},
            ],
        ].map(([
            event,
            traceAtMs,
            payload,
        ]) => ({
            event: event as string,
            payload: {
                traceAtMs: traceAtMs as number,
                ...(payload as Record<string, unknown>),
            },
        }));

        expect(summarizeArnoldOpenTrace(trace)).toEqual({
            validationCacheResult: 'miss',
            pdfjsRequestedByteTotal: 1_049_088,
            milestonesMs: {
                openingClaim: 0,
                validationStart: 90,
                validationEnd: 900,
                pdfjsSubmit: 120,
                pdfjsResolve: 1_200,
                firstPdfjsCanvas: 1_300,
            },
        });
    });
});
