import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { getErrorMessage } from '@contracts/getErrorMessage';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import { createMultiPageTextFixturePdf } from '@tests/e2e/electron/helpers/fixtures';
import {
    openPdfInApp,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import { createStickyNoteWithPointer } from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    evaluateViewerInvariantCheckpoint,
    readViewerInvariantReport,
} from '@tests/e2e/electron/helpers/viewerInvariants';
import {
    calibrationRunDirectory,
    findCalibrationPage,
    readCalibrationGeometry,
    recordCalibrationObservation,
} from '@tests/e2e/electron/calibration/calibrationEvidence';

/**
 * Calibration case 1 for 069a25668 "move an open note window with its page on
 * scroll". The checker was designed with this failure in mind, so it answers
 * whether the whole path from a trusted wheel to a named violation works, not
 * whether the checker has any power on an unseen defect.
 *
 * The wheel delta is small on purpose: A2's two-observation comparison applies
 * only while the anchor page is visible in both observations.
 */
const CASE_NAME = 'case1-note-window-follows-anchor';
const FIXTURE_PAGE_COUNT = 8;
const OPEN_TIMEOUT_MS = 60_000;
const WHEEL_DOWN_DELTA_PX = 240;
const START_WIDTH_PX = 1_180;
const START_HEIGHT_PX = 820;

const sessionFixture = createElectronE2ESessionFixture({sessionName: 'e2e-calibration-note-window'});

/**
 * A wheel at a point the open note window does not cover: the window is a
 * scroller of its own, and a wheel delivered into it moves the note text
 * instead of the document, which is not the gesture this case is about.
 */
function resolveWheelPoint(geometry: Awaited<ReturnType<typeof readCalibrationGeometry>>) {
    const { viewportRect } = geometry;
    const candidates = [
        {
            x: viewportRect.left + viewportRect.width / 2,
            y: viewportRect.top + viewportRect.height / 2,
        },
        {
            x: viewportRect.left + viewportRect.width * 0.12,
            y: viewportRect.top + viewportRect.height * 0.5,
        },
        {
            x: viewportRect.left + viewportRect.width * 0.88,
            y: viewportRect.top + viewportRect.height * 0.5,
        },
    ];
    const covers = (point: {
        x: number;
        y: number;
    }) => geometry.noteWindows.some(entry => (
        point.x >= entry.rect.left
        && point.x <= entry.rect.left + entry.rect.width
        && point.y >= entry.rect.top
        && point.y <= entry.rect.top + entry.rect.height
    ));
    const chosen = candidates.find(candidate => !covers(candidate)) ?? candidates[0]!;
    return {
        covered: covers(chosen),
        shifted: chosen !== candidates[0],
        x: Math.round(chosen.x),
        y: Math.round(chosen.y),
    };
}

describe('calibration: an open note window follows its page on a real scroll', () => {
    it('reports A2-note-window-follows-anchor when the window stops following', async () => {
        const session = sessionFixture.getSession();
        const { page } = session;

        const fixture = await createMultiPageTextFixturePdf(`calibration-note-window-${Date.now()}.pdf`, FIXTURE_PAGE_COUNT);
        await openPdfInApp(page, fixture, OPEN_TIMEOUT_MS);
        await waitForViewerInteractive(page, OPEN_TIMEOUT_MS);
        await session.command('windowResize', [
            START_WIDTH_PX,
            START_HEIGHT_PX,
        ]);
        await waitForFunctionInPage(page, (expectedWidth: number) => (
            Math.abs(window.innerWidth - expectedWidth) < 2
        ), {timeout: 20_000}, START_WIDTH_PX);

        await createStickyNoteWithPointer(page, 'calibration note', {
            x: 0.4,
            y: 0.25,
        }, 1);
        await waitForFunctionInPage(page, () => document.querySelector('.note-window') !== null, {timeout: 30_000});
        const noteAnnotationId = await evaluateInPage(page, () => (
            document.querySelector('.note-window')?.getAttribute('data-annotation-id') ?? null
        ));
        if (noteAnnotationId === null) {
            throw new Error('The open note window carries no annotation id');
        }

        const before = await readViewerInvariantReport(page, {documentWellFormed: true});
        const geometryBefore = await readCalibrationGeometry(page);

        // A trusted wheel, then the contract's own Settled wait rather than a
        // separate probe, so the two observations the A2 comparison needs are
        // exactly the two this case is about.
        const wheelPoint = resolveWheelPoint(geometryBefore);
        await page.mouse.move(wheelPoint.x, wheelPoint.y);
        await page.mouse.wheel({deltaY: WHEEL_DOWN_DELTA_PX});

        const after = await readViewerInvariantReport(page, {documentWellFormed: true});
        const geometryAfter = await readCalibrationGeometry(page);
        if (geometryAfter.scrollTop <= geometryBefore.scrollTop) {
            recordCalibrationObservation(CASE_NAME, {
                geometryAfter,
                geometryBefore,
                note: 'the trusted wheel did not scroll the document',
                wheelPoint,
            });
            throw new Error(
                `The trusted wheel did not scroll the document: scrollTop ${geometryBefore.scrollTop}`
                + ` to ${geometryAfter.scrollTop} at (${wheelPoint.x}, ${wheelPoint.y})`,
            );
        }

        // Ground truth, read from the DOM without the checker: how far the
        // anchor page moved on screen and how far its window moved with it.
        const anchorBefore = findCalibrationPage(geometryBefore, 1);
        const anchorAfter = findCalibrationPage(geometryAfter, 1);
        const windowBefore = geometryBefore.noteWindows.find(entry => entry.annotationId === noteAnnotationId) ?? null;
        const windowAfter = geometryAfter.noteWindows.find(entry => entry.annotationId === noteAnnotationId) ?? null;
        const anchorDeltaTop = anchorBefore && anchorAfter ? anchorAfter.rect.top - anchorBefore.rect.top : null;
        const windowDeltaTop = windowBefore && windowAfter ? windowAfter.rect.top - windowBefore.rect.top : null;

        const options = {
            checkpoint: 'after a real wheel scroll with the anchor page still visible',
            documentWellFormed: true,
            requirePresent: {
                annotationIds: [noteAnnotationId],
                noteWindowFor: [noteAnnotationId],
                pageIndicator: true as const,
            },
            requireRan: ['A2-note-window-follows-anchor' as const],
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

        // The calibration question, separated from everything else the
        // checkpoint happens to see: did this statement run, and did it report
        // the symptom the reverted fix produces?
        const followsAnchorSkip = after.skipped.find(entry => entry.id === 'A2-note-window-follows-anchor') ?? null;
        const followsAnchorViolations = after.violations.filter(violation => (
            violation.id === 'A2-note-window-follows-anchor'
        ));

        await page.screenshot({path: join(calibrationRunDirectory(), `${CASE_NAME}-${process.env.EVB_CALIBRATION_SIDE ?? 'unlabelled'}.png`)});
        recordCalibrationObservation(CASE_NAME, {
            anchorDeltaTop,
            followsAnchorSkip,
            followsAnchorViolations,
            groundTruth: {
                anchorAfter,
                anchorBefore,
                windowAfter,
                windowBefore,
            },
            noteAnnotationId,
            reportAfter: after,
            reportBefore: before,
            scroll: {
                finalScrollTop: geometryAfter.scrollTop,
                initialScrollTop: geometryBefore.scrollTop,
            },
            standardCheckpointVerdict: verdict,
            wheelPoint,
            windowDeltaTop,
        });

        expect(after.observed.noteWindowAnnotationIds).toContain(noteAnnotationId);
        expect(followsAnchorSkip).toBeNull();
        expect(followsAnchorViolations).toStrictEqual([]);
    });
});
