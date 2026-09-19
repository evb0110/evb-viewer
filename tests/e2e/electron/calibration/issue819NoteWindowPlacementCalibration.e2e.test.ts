import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type { Page } from 'puppeteer-core';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import { createMultiPageTextFixturePdf } from '@tests/e2e/electron/helpers/fixtures';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import { createStickyNoteWithPointer } from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import { readViewerInvariantReport } from '@tests/e2e/electron/helpers/viewerInvariants';
import {
    calibrationRunDirectory,
    findCalibrationPage,
    readCalibrationGeometry,
    recordCalibrationObservation,
} from '@tests/e2e/electron/calibration/calibrationEvidence';

/**
 * Issue 819 has two faces. Face A says an open note window ends up over the
 * toolbar, the tab bar and the sidebar after a scroll away, a scroll back and
 * one toolbar zoom. Face B says a sidebar toggle in fit height moves the anchor
 * page sideways while the window stays where it is.
 *
 * The window clips itself to its pane, so face A needs the painted area and a
 * picture, not a layout box. Face B is a movement comparison that clipping
 * cannot explain. Both are driven with trusted input on the current revision.
 */
const CASE_NAME = 'issue819-note-window-placement';
const FIXTURE_PAGE_COUNT = 12;
const OPEN_TIMEOUT_MS = 60_000;
const WINDOW_WIDTH_PX = 1_180;
const WINDOW_HEIGHT_PX = 820;
const WHEEL_DELTA_PX = 2_400;

const sessionFixture = createElectronE2ESessionFixture({sessionName: 'e2e-calibration-issue819'});

async function readNoteWindowPlacement(page: Page) {
    return evaluateInPage(page, () => {
        const toRect = (element: Element) => {
            const rect = element.getBoundingClientRect();
            return {
                height: rect.height,
                left: rect.left,
                top: rect.top,
                width: rect.width,
            };
        };
        const noteWindow = document.querySelector<HTMLElement>('.note-window');
        if (!noteWindow) {
            return null;
        }
        const style = window.getComputedStyle(noteWindow);
        const rect = toRect(noteWindow);
        const chrome = [
            '#editor-global-toolbar-host',
            '.tab-bar',
            '.sidebar-wrapper',
            '.status-bar',
        ].flatMap(selector => [...document.querySelectorAll<HTMLElement>(selector)].map(element => ({
            name: selector,
            rect: toRect(element),
        })));
        // What a reader can act on: the control has to be the element the
        // window manager hands a click at that point.
        const probeControl = (selector: string) => {
            const control = noteWindow.querySelector<HTMLElement>(selector);
            if (!control) {
                return null;
            }
            const controlRect = toRect(control);
            const point = {
                x: Math.round(controlRect.left + controlRect.width / 2),
                y: Math.round(controlRect.top + controlRect.height / 2),
            };
            const hit = document.elementFromPoint(point.x, point.y);
            return {
                hitIsControl: Boolean(hit && (hit === control || control.contains(hit))),
                hitTag: hit?.tagName.toLowerCase() ?? null,
                point,
                rect: controlRect,
            };
        };
        return {
            chrome,
            clipPath: style.clipPath,
            closeButton: probeControl('.note-window__close'),
            rect,
            textarea: probeControl('.note-window__textarea'),
        };
    });
}

async function settleAndObserve(page: Page, label: string) {
    const report = await readViewerInvariantReport(page, {documentWellFormed: true});
    const geometry = await readCalibrationGeometry(page);
    const placement = await readNoteWindowPlacement(page);
    await page.screenshot({path: join(calibrationRunDirectory(), `${CASE_NAME}-${label}.png`)});
    return {
        anchorPage: findCalibrationPage(geometry, 1),
        label,
        noteWindowSurface: report.violations
            .filter(violation => violation.id.startsWith('A2'))
            .map(violation => violation.evidence),
        placement,
        report,
        windowRect: geometry.noteWindows[0]?.rect ?? null,
    };
}

async function wheelViewport(page: Page, deltaY: number) {
    const geometry = await readCalibrationGeometry(page);
    const point = {
        x: Math.round(geometry.viewportRect.left + geometry.viewportRect.width * 0.85),
        y: Math.round(geometry.viewportRect.top + geometry.viewportRect.height * 0.6),
    };
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel({deltaY});
    await readViewerInvariantReport(page, {documentWellFormed: true});
}

describe('calibration: issue 819, where an open note window ends up', () => {
    it('measures what is painted over the chrome and what moves on a sidebar toggle', async () => {
        const session = sessionFixture.getSession();
        const { page } = session;

        const fixture = await createMultiPageTextFixturePdf(`calibration-issue819-${Date.now()}.pdf`, FIXTURE_PAGE_COUNT);
        await openPdfInApp(page, fixture, OPEN_TIMEOUT_MS);
        await waitForViewerInteractive(page, OPEN_TIMEOUT_MS);
        await session.command('windowResize', [
            WINDOW_WIDTH_PX,
            WINDOW_HEIGHT_PX,
        ]);
        await waitForFunctionInPage(page, (expectedWidth: number) => (
            Math.abs(window.innerWidth - expectedWidth) < 2
        ), {timeout: 20_000}, WINDOW_WIDTH_PX);

        await createStickyNoteWithPointer(page, 'issue 819 note', {
            x: 0.4,
            y: 0.3,
        }, 1);
        await waitForFunctionInPage(page, () => document.querySelector('.note-window') !== null, {timeout: 30_000});

        // Face A: away, back, and one toolbar zoom.
        await wheelViewport(page, WHEEL_DELTA_PX);
        await wheelViewport(page, -WHEEL_DELTA_PX);
        await clickVisibleToolbarButton(page, 'Zoom In');
        const faceA = await settleAndObserve(page, 'faceA-after-zoom-in');

        // Face B: fit height, then the sidebar toggle.
        await clickVisibleToolbarButton(page, 'Fit Height');
        const beforeToggle = await settleAndObserve(page, 'faceB-before-sidebar-toggle');
        await clickVisibleToolbarButton(page, 'Toggle Sidebar');
        const afterToggle = await settleAndObserve(page, 'faceB-after-sidebar-toggle');

        const anchorDelta = beforeToggle.anchorPage && afterToggle.anchorPage
            ? {
                x: afterToggle.anchorPage.rect.left - beforeToggle.anchorPage.rect.left,
                y: afterToggle.anchorPage.rect.top - beforeToggle.anchorPage.rect.top,
            }
            : null;
        const windowDelta = beforeToggle.windowRect && afterToggle.windowRect
            ? {
                x: afterToggle.windowRect.left - beforeToggle.windowRect.left,
                y: afterToggle.windowRect.top - beforeToggle.windowRect.top,
            }
            : null;

        recordCalibrationObservation(CASE_NAME, {
            faceA,
            faceB: {
                afterToggle,
                anchorDelta,
                beforeToggle,
                windowDelta,
            },
        });

        expect(faceA.placement).not.toBeNull();
    });
});
