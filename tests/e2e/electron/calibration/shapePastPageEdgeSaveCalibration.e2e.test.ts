import {
    describe,
    expect,
    it,
} from 'vitest';
import { getErrorMessage } from '@contracts/getErrorMessage';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    createMultiPageTextFixturePdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    saveViaVisibleToolbar,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import { clickAnnotationTool } from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import { observeRendererErrors } from '@tests/e2e/electron/helpers/rendererErrorObservation';
import { readViewerInvariantReport } from '@tests/e2e/electron/helpers/viewerInvariants';
import { recordCalibrationObservation } from '@tests/e2e/electron/calibration/calibrationEvidence';

/**
 * Calibration case 3 for ccd6c1c3e "keep shapes drawn past the page edge
 * saveable", held out from the design of the invariant checker. The reported
 * failure is a task outcome, not a geometry rule: after a shape was released
 * below the page, every later save of that document failed.
 *
 * The run therefore observes the outcome a person cares about, the saved bytes,
 * and separately records what the screen-level checker and the renderer error
 * surfaces said while it happened.
 */
const CASE_NAME = 'case3-shape-past-page-edge-save';
const FIXTURE_PAGE_COUNT = 3;
const OPEN_TIMEOUT_MS = 60_000;
const SAVE_TIMEOUT_MS = 25_000;
const PAST_PAGE_EDGE_PX = 40;

const sessionFixture = createElectronE2ESessionFixture({sessionName: 'e2e-calibration-shape-save'});

interface IDragPoints {
    endX: number;
    endY: number;
    pageBottom: number;
    startX: number;
    startY: number;
}

async function resolveEditorLayerDrag(
    page: Parameters<typeof evaluateInPage>[0],
    pastEdgePx: number,
): Promise<IDragPoints> {
    const points = await evaluateInPage(page, (overshoot: number) => {
        const layer = document.querySelector<SVGElement>(
            '.editor-pane.is-active .workspace-host .page_container[data-page="1"] .pdf-annotation-editor-layer',
        );
        if (!layer) {
            return null;
        }
        const rect = layer.getBoundingClientRect();
        const maxY = window.innerHeight - 12;
        const endY = Math.min(rect.bottom + overshoot, maxY);
        return {
            endX: rect.left + rect.width * 0.7,
            endY,
            pageBottom: rect.bottom,
            startX: rect.left + rect.width * 0.4,
            startY: rect.top + rect.height * 0.75,
        };
    }, pastEdgePx);
    if (!points) {
        throw new Error('The editor layer of page 1 is not mounted');
    }
    if (points.endY <= points.pageBottom + 8) {
        throw new Error(`The drag cannot reach past the page edge: bottom ${points.pageBottom}, end ${points.endY}`);
    }
    return points;
}

async function readDrawnShapeGeometry(page: Parameters<typeof evaluateInPage>[0]) {
    return evaluateInPage(page, () => [...document.querySelectorAll<SVGElement>(
        '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind="shape"]',
    )].map((entity) => {
        const layer = entity.closest<SVGElement>('.pdf-annotation-editor-layer');
        const layerRect = layer?.getBoundingClientRect() ?? null;
        const rect = entity.getBoundingClientRect();
        return {
            annotationId: entity.getAttribute('data-annotation-id'),
            normalizedBottom: layerRect && layerRect.height > 0
                ? (rect.bottom - layerRect.top) / layerRect.height
                : null,
            outsidePage: entity.getAttribute('data-outside-page'),
        };
    }));
}

async function attemptSave(page: Parameters<typeof evaluateInPage>[0], label: string) {
    const startedAt = Date.now();
    try {
        const event = await saveViaVisibleToolbar(page, SAVE_TIMEOUT_MS);
        return {
            committed: true,
            elapsedMs: Date.now() - startedAt,
            failure: null,
            label,
            path: String(event.detail.path ?? ''),
        };
    } catch (error) {
        return {
            committed: false,
            elapsedMs: Date.now() - startedAt,
            failure: getErrorMessage(error),
            label,
            path: '',
        };
    }
}

describe('calibration: a shape drawn past the page edge stays saveable', () => {
    it('records whether the first and every later save of the document still commit', async () => {
        const { page } = sessionFixture.getSession();

        const fixture = await createMultiPageTextFixturePdf(`calibration-shape-save-${Date.now()}.pdf`, FIXTURE_PAGE_COUNT);
        await openPdfInApp(page, fixture, OPEN_TIMEOUT_MS);
        await waitForViewerInteractive(page, OPEN_TIMEOUT_MS);
        await clickVisibleToolbarButton(page, 'Fit Height');
        await readViewerInvariantReport(page, {documentWellFormed: true});

        const observer = await observeRendererErrors(page);

        // A rectangle released below the page, with the pointer captured by the
        // editor layer, exactly as a person overshoots the page edge.
        await clickAnnotationTool(page, 'Rectangle');
        const drag = await resolveEditorLayerDrag(page, PAST_PAGE_EDGE_PX);
        await page.mouse.move(drag.startX, drag.startY);
        await page.mouse.down();
        await page.mouse.move(drag.endX, drag.endY, {steps: 10});
        await page.mouse.up();
        await clickAnnotationTool(page, 'Select');
        await waitForFunctionInPage(page, () => document.querySelector(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="shape"]',
        ) !== null, {timeout: 20_000});

        const overshootShapes = await readDrawnShapeGeometry(page);
        const afterDraw = await readViewerInvariantReport(page, {documentWellFormed: true});
        const firstSave = await attemptSave(page, 'save after the overshooting shape');
        const savedAfterFirst = firstSave.committed ? await readPdfAnnotationSummary(fixture) : null;

        // The next ordinary edit, and the save a person would expect to work
        // whatever happened to the previous one.
        await clickAnnotationTool(page, 'Rectangle');
        const inside = await evaluateInPage(page, () => {
            const layer = document.querySelector<SVGElement>(
                '.editor-pane.is-active .workspace-host .page_container[data-page="1"] .pdf-annotation-editor-layer',
            );
            if (!layer) {
                return null;
            }
            const rect = layer.getBoundingClientRect();
            return {
                endX: rect.left + rect.width * 0.45,
                endY: rect.top + rect.height * 0.35,
                startX: rect.left + rect.width * 0.25,
                startY: rect.top + rect.height * 0.2,
            };
        });
        if (!inside) {
            throw new Error('The editor layer of page 1 is not mounted for the second edit');
        }
        await page.mouse.move(inside.startX, inside.startY);
        await page.mouse.down();
        await page.mouse.move(inside.endX, inside.endY, {steps: 8});
        await page.mouse.up();
        await clickAnnotationTool(page, 'Select');
        await waitForFunctionInPage(page, () => document.querySelectorAll(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="shape"]',
        ).length >= 2, {timeout: 20_000});

        const secondSave = await attemptSave(page, 'save after a later ordinary edit');
        const savedAfterSecond = secondSave.committed ? await readPdfAnnotationSummary(fixture) : null;
        const errors = await observer.collect();
        observer.dispose();
        const afterSaves = await readViewerInvariantReport(page, {documentWellFormed: true});

        recordCalibrationObservation(CASE_NAME, {
            afterDrawReport: afterDraw,
            afterSavesReport: afterSaves,
            drag: {
                endY: drag.endY,
                pageBottom: drag.pageBottom,
                pastEdgePx: drag.endY - drag.pageBottom,
            },
            errors,
            firstSave,
            overshootShapes,
            savedAfterFirst,
            savedAfterSecond,
            secondSave,
        });

        expect({
            first: firstSave.committed,
            second: secondSave.committed,
        }).toStrictEqual({
            first: true,
            second: true,
        });
        expect(savedAfterSecond?.bySubtype.Square ?? 0).toBe(2);
    });
});
