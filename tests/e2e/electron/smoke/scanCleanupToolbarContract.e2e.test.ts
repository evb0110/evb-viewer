import {
    existsSync,
    statSync,
} from 'node:fs';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {
    createLargeScannedFixturePdf,
    readPdfPageSnapshots,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    isPdfCanvasInkCoverageSane,
    renderPdfCanvasFidelityMetrics,
} from '@tests/helpers/renderPdfCanvasFidelityMetrics';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    type IWorkspaceExposeProbeWindow,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    SCAN_CLEANUP_RUN_METER_SELECTOR,
    SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_SELECTOR,
    SCAN_CLEANUP_TOOLBAR_COUNT_SELECTOR,
    SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR,
} from '@contracts/scan-cleanup/toolbarSelectors';

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-toolbar-contract-${Date.now()}`});

// The packaged release verifier (scripts/release/verifyPackagedScanCleanup.ts)
// drives this exact toolbar contract over CDP, but it only executes at
// release time, so UI drift against it surfaces days later inside a release
// campaign (issue #82's tail: the #68/#70 toolbar redesign silently broke the
// counter copy and the meter's attribute shape, killing three release
// attempts). This blocking test pins the same contract against the dev app on
// every relevant change: a parseable completed/total detection counter, a
// cancellable in-flight detection, cleanup queueable while detection runs,
// and a run meter that reports the queued analysis phase.
describe('scan cleanup toolbar contract', () => {
    it('keeps the detection counter, queued cleanup, and run meter contract the release verifier relies on', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();

        // Enough pages that detection is reliably observable in flight.
        const sourcePath = await createLargeScannedFixturePdf(
            'scan-cleanup-toolbar-contract.pdf',
            6,
            0,
        );
        await openPdfInApp(session.page, sourcePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);

        await clickVisibleToolbarButton(session.page, 'Scan cleanup');
        await session.page.waitForSelector('.scan-cleanup-surface', {
            timeout: 10_000,
            visible: true,
        });

        // Detection in flight: counter exposes a completed/total pair, the
        // detection is cancellable, and the primary action stays enabled so
        // cleanup can be queued behind detection. The wait itself is the
        // assertion; it throws after 90s if the contract never holds.
        await waitForFunctionInPage(session.page, (
            expectedTotal: number,
            primaryActionSelector: string,
            toolbarCountSelector: string,
            cancelDetectionSelector: string,
        ) => {
            const action = document.querySelector<HTMLButtonElement>(
                primaryActionSelector,
            );
            const status = document.querySelector<HTMLElement>(toolbarCountSelector);
            const text = status?.getAttribute('aria-label') ?? status?.textContent ?? '';
            const match = /(\d+)\D+(\d+)/u.exec(text);
            // The meter names the analysis step (contract I4) instead of a bare
            // counter that sits at zero while page images are read.
            const detail = document.querySelector('.scan-cleanup-activity-detail')?.textContent?.trim() ?? '';
            return action?.disabled === false
                && document.querySelector(cancelDetectionSelector) !== null
                && detail.length > 0
                && match !== null
                && Number(match[2]) === expectedTotal
                && Number(match[1]) < expectedTotal;
        }, {timeout: 90_000}, 6, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR,
        SCAN_CLEANUP_TOOLBAR_COUNT_SELECTOR, SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_SELECTOR);

        // At the default window size the meter got an action button's width:
        // the count painted through the cancel button and the clock was cut
        // (#967). Every painted glyph of the phase, current count and caret
        // must sit inside the boxes that clip it and clear of the button.
        const detectionLayout = await session.page.evaluate((
            toolbarCountSelector: string,
            cancelDetectionSelector: string,
        ) => {
            const cancel = document.querySelector(cancelDetectionSelector)!.getBoundingClientRect();
            const paint = (element: Element | null) => {
                if (!element) return null;
                const range = document.createRange();
                range.selectNodeContents(element);
                const glyphs = [...range.getClientRects()].filter(rect => rect.width > 0);
                const ink = glyphs.length > 0 ? glyphs : [element.getBoundingClientRect()];
                const left = Math.min(...ink.map(rect => rect.left));
                const right = Math.max(...ink.map(rect => rect.right));
                const top = Math.min(...ink.map(rect => rect.top));
                const bottom = Math.max(...ink.map(rect => rect.bottom));
                let shown = {
                    left,
                    right,
                    top,
                    bottom,
                };
                for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                    const style = getComputedStyle(parent);
                    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
                    const box = parent.getBoundingClientRect();
                    shown = {
                        left: Math.max(shown.left, box.left),
                        right: Math.min(shown.right, box.right),
                        top: Math.max(shown.top, box.top),
                        bottom: Math.min(shown.bottom, box.bottom),
                    };
                }
                return {
                    text: element.textContent?.trim() ?? '',
                    whole: getComputedStyle(element).visibility === 'visible'
                        && right > left
                        && shown.left <= left + 0.5 && shown.right >= right - 0.5
                        && shown.top <= top + 0.5 && shown.bottom >= bottom - 0.5,
                    shownWidth: Math.max(0, shown.right - shown.left),
                    clearOfCancel: right <= cancel.left || left >= cancel.right,
                };
            };
            return {
                phase: paint(document.querySelector('.scan-cleanup-activity-phase')),
                detail: paint(document.querySelector('.scan-cleanup-activity-detail')),
                count: paint(document.querySelector(`${toolbarCountSelector} .scan-cleanup-stable-width-value`)),
                caret: paint(document.querySelector('.scan-cleanup-activity-caret')),
            };
        }, SCAN_CLEANUP_TOOLBAR_COUNT_SELECTOR, SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_SELECTOR);
        expect(detectionLayout.phase).toMatchObject({
            text: 'Analyze',
            whole: true,
            clearOfCancel: true,
        });
        expect(detectionLayout.count).toMatchObject({
            whole: true,
            clearOfCancel: true,
        });
        expect(detectionLayout.count?.text).toMatch(/^\d+ of 6 pages$/u);
        expect(detectionLayout.caret).toMatchObject({
            whole: true,
            clearOfCancel: true,
        });
        expect(detectionLayout.detail?.text.length).toBeGreaterThan(0);
        expect(detectionLayout.detail?.shownWidth).toBeGreaterThan(0);

        // The cancel button beside the meter takes a person's click and stops
        // detection; Re-detect then starts it again for the queue checks below.
        await clickAsUser(session.page, SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_SELECTOR);
        await waitForFunctionInPage(session.page, (cancelDetectionSelector: string) => {
            const redetect = document.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-redetect');
            return document.querySelector(cancelDetectionSelector) === null
                && document.querySelector('.scan-cleanup-toolbar-error') === null
                && redetect?.disabled === false;
        }, {timeout: 15_000}, SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_SELECTOR);
        await clickAsUser(session.page, '.scan-cleanup-toolbar-redetect');
        await session.page.waitForSelector(SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_SELECTOR, {timeout: 10_000});

        // Queue cleanup while detection is still running: the run meter must
        // appear and report the queued analysis phase as readable text,
        // and the primary action must remain enabled (it becomes cancel).
        await clickAsUser(session.page, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR);
        await waitForFunctionInPage(session.page, (runMeterSelector: string, primaryActionSelector: string) => {
            const meter = document.querySelector<HTMLElement>(runMeterSelector);
            const action = document.querySelector<HTMLButtonElement>(
                primaryActionSelector,
            );
            return meter !== null
                && (meter.textContent ?? '').trim().length > 0
                && action?.disabled === false;
        }, {timeout: 10_000}, SCAN_CLEANUP_RUN_METER_SELECTOR, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR);
        // A run queued behind detection continues the analysis account in the
        // same meter instead of replacing it with a new layout.
        const queuedStatus = await session.page.evaluate((runMeterSelector: string) => {
            const meter = document.querySelector<HTMLElement>(runMeterSelector);
            return {
                phase: meter?.dataset.phase ?? '',
                text: meter?.textContent?.trim() ?? '',
            };
        }, SCAN_CLEANUP_RUN_METER_SELECTOR);
        expect(queuedStatus.phase).toBe('analyze');
        expect(queuedStatus.text).toContain('Analyze');

        // Cancel the queued run: the meter clears while detection continues.
        await clickAsUser(session.page, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR);
        await waitForFunctionInPage(session.page, (runMeterSelector: string, cancelDetectionSelector: string) => (
            document.querySelector(runMeterSelector) === null
                && document.querySelector(cancelDetectionSelector) !== null
        ), {timeout: 10_000}, SCAN_CLEANUP_RUN_METER_SELECTOR, SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_SELECTOR);
        // The source-page rail paints page images; it stayed blank placeholders
        // while the workspace never marked its thumbnail list active.
        await waitForFunctionInPage(session.page, () => document.querySelectorAll(
            '.scan-thumbnail-list img, .scan-thumbnail-list canvas',
        ).length > 0, {timeout: 30_000});

        // Let detection settle, then run the same six-page document to
        // completion. The blocking contract must cover the generated PDF,
        // not only the controls that start it.
        // These post-cancellation waits total 345s (30 + 30 + 180 + 15 + 45 + 45),
        // inside the existing 360s test budget.
        await waitForFunctionInPage(session.page, (
            primaryActionSelector: string,
            cancelDetectionSelector: string,
            runMeterSelector: string,
        ) => {
            const action = document.querySelector<HTMLButtonElement>(primaryActionSelector);
            return document.querySelector(cancelDetectionSelector) === null
                && document.querySelector(runMeterSelector) === null
                && action?.disabled === false
                && (action.textContent ?? '').includes('Clean up');
        }, {timeout: 30_000}, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR,
        SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_SELECTOR, SCAN_CLEANUP_RUN_METER_SELECTOR);
        await clickAsUser(session.page, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR);
        await waitForFunctionInPage(session.page, (source: string) => {
            const active = (window as IWorkspaceExposeProbeWindow)
                .__evbTestApi
                ?.readActiveWorkspaceStateValues?.(['originalPath']);
            return typeof active?.originalPath === 'string'
                && active.originalPath !== source
                && active.originalPath.endsWith('— cleaned.pdf');
        }, {timeout: 180_000}, sourcePath);
        await waitForFunctionInPage(session.page, () => Array.from(
            document.querySelectorAll<HTMLElement>('[data-slot="title"]'),
        ).some(title => (title.textContent ?? '').trim() === 'Scan cleanup complete'), {timeout: 15_000});

        const outputState = await readWorkspaceStateValues(session.page, ['originalPath']);
        const outputPath = typeof outputState.originalPath === 'string'
            ? outputState.originalPath
            : null;
        expect(outputPath).toBeTruthy();
        expect(outputPath).not.toBe(sourcePath);
        expect(outputPath).toMatch(/— cleaned\.pdf$/u);
        expect(existsSync(outputPath!)).toBe(true);
        expect(statSync(outputPath!).size).toBeGreaterThan(0);
        expect(await readPdfPageSnapshots(outputPath!)).toEqual(
            Array.from({length: 6}, (_, index) => ({
                pageNumber: index + 1,
                rotation: 0,
                textSnippet: '',
            })),
        );
        const outputRasterMetrics = await Promise.all(
            Array.from({length: 6}, (_, index) => renderPdfCanvasFidelityMetrics(
                outputPath!,
                index + 1,
            )),
        );
        for (const [
            index,
            metrics,
        ] of outputRasterMetrics.entries()) {
            expect(
                isPdfCanvasInkCoverageSane(metrics),
                `page ${String(index + 1)} raster ink coverage`,
            ).toBe(true);
        }
    }, 360_000);
});
