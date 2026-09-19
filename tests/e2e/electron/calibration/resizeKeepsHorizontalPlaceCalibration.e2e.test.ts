import {
    describe,
    expect,
    it,
} from 'vitest';
import type { Page } from 'puppeteer-core';
import { getErrorMessage } from '@contracts/getErrorMessage';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import { createMultiPageTextFixturePdf } from '@tests/e2e/electron/helpers/fixtures';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    evaluateViewerInvariantCheckpoint,
    readViewerInvariantReport,
} from '@tests/e2e/electron/helpers/viewerInvariants';
import { callWorkspaceCommand } from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    findCalibrationPage,
    readCalibrationGeometry,
    recordCalibrationObservation,
} from '@tests/e2e/electron/calibration/calibrationEvidence';

/**
 * Calibration case 2 for 12647dbc9 "retain horizontal page padding during
 * resize", held out from the design of the invariant checker. The user-visible
 * symptom was a zoomed page jumping sideways when the window was resized.
 *
 * The reverted geometry loses the page track's inline padding, so the model's
 * page origin can differ from the painted one only while the viewport is
 * narrower than the page plus its margins. The run therefore resizes the real
 * window three times: with the page already overflowing the pane, across the
 * boundary where a fitting page starts to overflow, and in paged mode, and
 * records what moved on screen and what the existing checks said each time.
 */
const CASE_NAME = 'case2-resize-keeps-horizontal-place';
const FIXTURE_PAGE_COUNT = 6;
const OPEN_TIMEOUT_MS = 60_000;
const WIDE_WIDTH_PX = 1_180;
const START_HEIGHT_PX = 820;

const sessionFixture = createElectronE2ESessionFixture({sessionName: 'e2e-calibration-resize'});

async function readContentSize(page: Page) {
    return evaluateInPage(page, () => ({
        height: window.innerHeight,
        width: window.innerWidth,
    }));
}

async function readToolbarPageFromScreen(page: Page) {
    return evaluateInPage(page, () => {
        const controls = document.querySelector('#editor-global-toolbar-host .page-controls');
        const secondary = controls?.querySelector('.page-controls-current-secondary')?.textContent?.trim() ?? '';
        const primary = controls?.querySelector('.page-controls-current-primary')?.textContent?.trim() ?? '';
        const parse = (value: string) => {
            const parsed = Number.parseInt(value.replace(/[()\s]/gu, ''), 10);
            return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
        };
        return parse(secondary) ?? parse(primary);
    });
}

async function resizeWindowTo(
    session: ReturnType<typeof sessionFixture.getSession>,
    width: number,
    height: number,
) {
    await session.command('windowResize', [
        width,
        height,
    ]);
    await waitForFunctionInPage(session.page, (expectedWidth: number) => (
        Math.abs(window.innerWidth - expectedWidth) < 2
    ), {timeout: 20_000}, width);
}

/**
 * One resize of the real window, with the screen position of the reading page
 * read before and after, and the verdict of the checks the project already runs
 * at such a checkpoint.
 */
async function observeResize(
    session: ReturnType<typeof sessionFixture.getSession>,
    label: string,
    targetWidth: number,
) {
    const { page } = session;
    const before = await readViewerInvariantReport(page, {documentWellFormed: true});
    const geometryBefore = await readCalibrationGeometry(page);
    const toolbarPageBefore = await readToolbarPageFromScreen(page);

    await resizeWindowTo(session, targetWidth, START_HEIGHT_PX);

    const after = await readViewerInvariantReport(page, {documentWellFormed: true});
    const geometryAfter = await readCalibrationGeometry(page);
    const toolbarPageAfter = await readToolbarPageFromScreen(page);

    const pageBefore = findCalibrationPage(geometryBefore, 1);
    const pageAfter = findCalibrationPage(geometryAfter, 1);
    const options = {
        checkpoint: `after a real window resize: ${label}`,
        documentWellFormed: true,
        requirePresent: {pageIndicator: true as const},
        requireRan: ['R1-toolbar-page-visible' as const],
    };
    let invariantVerdict: {
        failure: string | null;
        violationIds: string[];
    };
    try {
        evaluateViewerInvariantCheckpoint(after, options);
        invariantVerdict = {
            failure: null,
            violationIds: after.violations.map(violation => violation.id),
        };
    } catch (error) {
        invariantVerdict = {
            failure: getErrorMessage(error),
            violationIds: after.violations.map(violation => violation.id),
        };
    }

    return {
        existingChecks: {
            invariantVerdict,
            toolbarPageAfter,
            toolbarPageBefore,
            toolbarPageUnchanged: toolbarPageAfter === toolbarPageBefore,
        },
        groundTruth: {
            // What a reader sees move: the page's own position on screen.
            pageLeftAfter: pageAfter?.rect.left ?? null,
            pageLeftBefore: pageBefore?.rect.left ?? null,
            pageScreenShiftPx: pageBefore && pageAfter ? pageAfter.rect.left - pageBefore.rect.left : null,
            pageWidthAfter: pageAfter?.rect.width ?? null,
            pageWidthBefore: pageBefore?.rect.width ?? null,
            scrollLeftAfter: geometryAfter.scrollLeft,
            scrollLeftBefore: geometryBefore.scrollLeft,
            viewportWidthAfter: geometryAfter.viewportRect.width,
            viewportWidthBefore: geometryBefore.viewportRect.width,
        },
        label,
        reportAfter: after,
        reportBefore: before,
        zoomText: geometryAfter.zoomText,
    };
}

describe('calibration: a window resize keeps the place of a zoomed page', () => {
    it('records what the existing checks say about a horizontal jump on resize', async () => {
        const session = sessionFixture.getSession();
        const { page } = session;

        const fixture = await createMultiPageTextFixturePdf(`calibration-resize-${Date.now()}.pdf`, FIXTURE_PAGE_COUNT);
        await openPdfInApp(page, fixture, OPEN_TIMEOUT_MS);
        await waitForViewerInteractive(page, OPEN_TIMEOUT_MS);

        const originalSize = await readContentSize(page);
        await resizeWindowTo(session, WIDE_WIDTH_PX, START_HEIGHT_PX);

        // One toolbar zoom, then a narrowing that crosses the boundary where
        // the page stops fitting the pane.
        await clickVisibleToolbarButton(page, 'Zoom In');
        await readViewerInvariantReport(page, {documentWellFormed: true});
        const fitting = await readCalibrationGeometry(page);
        const crossing = await observeResize(session, 'a zoomed page is narrowed to 760', 760);

        await resizeWindowTo(session, WIDE_WIDTH_PX, START_HEIGHT_PX);
        await clickVisibleToolbarButton(page, 'Zoom In');
        await readViewerInvariantReport(page, {documentWellFormed: true});
        const overflowing = await observeResize(session, 'an already overflowing page is narrowed to 900', 900);

        // The geometry the fix repaired also serves the paged viewport, which
        // resolves its scroll through the page track's inline padding. Paged
        // mode is setup for the resize under test, so it is switched through
        // the workspace command rather than the overflow menu.
        await resizeWindowTo(session, WIDE_WIDTH_PX, START_HEIGHT_PX);
        const pagedModeSet = await callWorkspaceCommand(page, 'handleToggleContinuousScroll');
        await readViewerInvariantReport(page, {documentWellFormed: true});
        const pagedGeometry = await readCalibrationGeometry(page);
        const paged = await observeResize(session, 'a paged zoomed page is narrowed to 860', 860);

        recordCalibrationObservation(CASE_NAME, {
            fitting: {
                horizontalScrollRange: fitting.horizontalScrollRange,
                pageWidth: findCalibrationPage(fitting, 1)?.rect.width ?? null,
                viewportWidth: fitting.viewportRect.width,
                zoomText: fitting.zoomText,
            },
            operations: [
                crossing,
                overflowing,
                paged,
            ],
            paged: {
                commandCalled: pagedModeSet.called,
                horizontalScrollRange: pagedGeometry.horizontalScrollRange,
                pageWidth: findCalibrationPage(pagedGeometry, 1)?.rect.width ?? null,
                viewportWidth: pagedGeometry.viewportRect.width,
                zoomText: pagedGeometry.zoomText,
            },
        });

        await resizeWindowTo(session, originalSize.width, originalSize.height);

        // What the project already checks after a resize, and nothing more.
        // Whether a horizontal jump is observed at all is the finding this run
        // records rather than asserts.
        expect(crossing.existingChecks.invariantVerdict.failure).toBeNull();
        expect(overflowing.existingChecks.invariantVerdict.failure).toBeNull();
        expect(paged.existingChecks.invariantVerdict.failure).toBeNull();
    });
});
