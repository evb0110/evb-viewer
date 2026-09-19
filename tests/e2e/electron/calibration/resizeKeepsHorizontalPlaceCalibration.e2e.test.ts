import {
    describe,
    expect,
    it,
} from 'vitest';
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
import {
    readCalibrationGeometry,
    recordCalibrationObservation,
} from '@tests/e2e/electron/calibration/calibrationEvidence';

/**
 * Calibration case 2 for 12647dbc9 "retain horizontal page padding during
 * resize", held out from the design of the invariant checker. The user-visible
 * symptom was a zoomed page jumping sideways when the window was resized, so
 * the question this run answers is whether anything the project already runs
 * notices that jump.
 *
 * The zoom and the resize are driven through the real UI and the real window.
 * The horizontal pan is setup: a real horizontal wheel when the viewer takes
 * one, and a scroller write when it does not, recorded either way.
 */
const CASE_NAME = 'case2-resize-keeps-horizontal-place';
const FIXTURE_PAGE_COUNT = 6;
const OPEN_TIMEOUT_MS = 60_000;
const START_WIDTH_PX = 1_180;
const START_HEIGHT_PX = 820;
const RESIZED_WIDTH_PX = 900;
const MAX_ZOOM_CLICKS = 8;
const REQUIRED_HORIZONTAL_RANGE_PX = 120;
const HORIZONTAL_PAN_PX = 160;

const sessionFixture = createElectronE2ESessionFixture({sessionName: 'e2e-calibration-resize'});

async function readContentSize(page: Parameters<typeof evaluateInPage>[0]) {
    return evaluateInPage(page, () => ({
        height: window.innerHeight,
        width: window.innerWidth,
    }));
}

async function readToolbarPageFromScreen(page: Parameters<typeof evaluateInPage>[0]) {
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

describe('calibration: a window resize keeps the place of a zoomed page', () => {
    it('records what the existing checks say about a horizontal jump on resize', async () => {
        const session = sessionFixture.getSession();
        const { page } = session;

        const fixture = await createMultiPageTextFixturePdf(`calibration-resize-${Date.now()}.pdf`, FIXTURE_PAGE_COUNT);
        await openPdfInApp(page, fixture, OPEN_TIMEOUT_MS);
        await waitForViewerInteractive(page, OPEN_TIMEOUT_MS);

        const originalSize = await readContentSize(page);
        await session.command('windowResize', [
            START_WIDTH_PX,
            START_HEIGHT_PX,
        ]);
        await waitForFunctionInPage(page, (expectedWidth: number) => (
            Math.abs(window.innerWidth - expectedWidth) < 2
        ), {timeout: 20_000}, START_WIDTH_PX);

        // Zoom through the real toolbar until the page is wider than the pane.
        let zoomClicks = 0;
        let geometry = await readCalibrationGeometry(page);
        while (geometry.horizontalScrollRange < REQUIRED_HORIZONTAL_RANGE_PX && zoomClicks < MAX_ZOOM_CLICKS) {
            await clickVisibleToolbarButton(page, 'Zoom In');
            zoomClicks += 1;
            await readViewerInvariantReport(page, {documentWellFormed: true});
            geometry = await readCalibrationGeometry(page);
        }
        if (geometry.horizontalScrollRange < REQUIRED_HORIZONTAL_RANGE_PX) {
            throw new Error(`The zoomed page never overflowed the pane: range ${geometry.horizontalScrollRange}px`);
        }

        // Pan sideways so the reading position is not at a horizontal edge,
        // where a clamp would hide the projection error.
        const viewportCentre = {
            x: Math.round(geometry.viewportRect.left + geometry.viewportRect.width / 2),
            y: Math.round(geometry.viewportRect.top + geometry.viewportRect.height / 2),
        };
        await page.mouse.move(viewportCentre.x, viewportCentre.y);
        await page.mouse.wheel({deltaX: HORIZONTAL_PAN_PX});
        await readViewerInvariantReport(page, {documentWellFormed: true});
        let panned = await readCalibrationGeometry(page);
        const panPath = panned.scrollLeft > 4 ? 'trusted-wheel' : 'scroller-write';
        if (panPath === 'scroller-write') {
            await evaluateInPage(page, (offset: number) => {
                const viewport = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host [data-document-viewer-chassis-viewport],'
                    + ' .editor-pane.is-active .workspace-host .pdfViewer',
                );
                if (viewport) {
                    viewport.scrollLeft = offset;
                }
            }, HORIZONTAL_PAN_PX);
            await readViewerInvariantReport(page, {documentWellFormed: true});
            panned = await readCalibrationGeometry(page);
        }

        const before = await readViewerInvariantReport(page, {documentWellFormed: true});
        const geometryBefore = await readCalibrationGeometry(page);
        const toolbarPageBefore = await readToolbarPageFromScreen(page);

        // The operation under test: a real window resize, as a person dragging
        // the window edge produces.
        await session.command('windowResize', [
            RESIZED_WIDTH_PX,
            START_HEIGHT_PX,
        ]);
        await waitForFunctionInPage(page, (expectedWidth: number) => (
            Math.abs(window.innerWidth - expectedWidth) < 2
        ), {timeout: 20_000}, RESIZED_WIDTH_PX);

        const after = await readViewerInvariantReport(page, {documentWellFormed: true});
        const geometryAfter = await readCalibrationGeometry(page);
        const toolbarPageAfter = await readToolbarPageFromScreen(page);

        const pageWidth = geometryAfter.pages[0]?.rect.width ?? 0;
        const documentXBefore = geometryBefore.documentXAtViewportCentre;
        const documentXAfter = geometryAfter.documentXAtViewportCentre;
        const horizontalJumpPx = documentXBefore !== null && documentXAfter !== null
            ? (documentXAfter - documentXBefore) * pageWidth
            : null;

        const options = {
            checkpoint: 'after a real window resize of a zoomed page',
            documentWellFormed: true,
            requirePresent: {pageIndicator: true as const},
            requireRan: ['R1-toolbar-page-visible' as const],
        };
        let verdict: {
            failure: string | null;
            violationIds: string[];
        };
        try {
            evaluateViewerInvariantCheckpoint(after, options);
            verdict = {
                failure: null,
                violationIds: after.violations.map(violation => violation.id),
            };
        } catch (error) {
            verdict = {
                failure: getErrorMessage(error),
                violationIds: after.violations.map(violation => violation.id),
            };
        }

        recordCalibrationObservation(CASE_NAME, {
            existingChecks: {
                invariantVerdict: verdict,
                toolbarPageAfter,
                toolbarPageBefore,
                toolbarPageUnchanged: toolbarPageAfter === toolbarPageBefore,
            },
            geometryAfter,
            geometryBefore,
            groundTruth: {
                documentXAfter,
                documentXBefore,
                horizontalJumpPx,
                pageWidth,
                scrollLeftAfter: geometryAfter.scrollLeft,
                scrollLeftBefore: geometryBefore.scrollLeft,
            },
            panPath,
            reportAfter: after,
            reportBefore: before,
            zoomClicks,
            zoomText: geometryAfter.zoomText,
        });

        await session.command('windowResize', [
            originalSize.width,
            originalSize.height,
        ]);

        // What the project already checks after a resize, and nothing more:
        // whether a horizontal jump is observed at all is the finding this run
        // records rather than asserts.
        expect(verdict.failure).toBeNull();
        expect(toolbarPageAfter).toBe(toolbarPageBefore);
    });
});
