import {
    describe,
    expect,
    it,
} from 'vitest';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import { createMultiPageTextFixturePdf } from '@tests/e2e/electron/helpers/fixtures';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    createStickyNoteWithPointer,
    createTextMarkupWithPointer,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import { wheelPdfViewportAndWaitForSettlement } from '@tests/e2e/electron/helpers/viewerVirtualizationContract';
import {assertViewerInvariants} from '@tests/e2e/electron/helpers/viewerInvariants';

/**
 * One composed reading session, driven by trusted input for every action under
 * test, with the user-level invariants read from the screen at each meaningful
 * checkpoint rather than after every event.
 *
 * Checkpoints follow the order the defects were found in: a real window
 * resize, a click during a real wheel scroll, annotation alignment through
 * zoom, a fit-mode change, and a tab switch and back.
 */
const JOURNEY_PAGE_COUNT = 12;
const OPEN_TIMEOUT_MS = 60_000;
const WHEEL_DOWN_DELTA_PX = 2_400;
const RESIZED_WIDTH_PX = 1_180;
const RESIZED_HEIGHT_PX = 820;

const sessionFixture = createElectronE2ESessionFixture({sessionName: 'e2e-viewer-invariants'});

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

async function readZoomTextFromScreen(page: Parameters<typeof evaluateInPage>[0]) {
    return evaluateInPage(page, () => (
        document.querySelector('#editor-global-toolbar-host .zoom-controls-display-value')
            ?.textContent?.trim() ?? null
    ));
}

/** Overlay ids the editor layer currently draws, in the order it draws them. */
async function readDrawnAnnotationIds(page: Parameters<typeof evaluateInPage>[0]) {
    return evaluateInPage(page, () => [...document.querySelectorAll(
        '.pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind]',
    )].map(entity => entity.getAttribute('data-annotation-id') ?? ''));
}

async function clickFirstTabOnScreen(page: Parameters<typeof evaluateInPage>[0]) {
    const point = await evaluateInPage(page, () => {
        const tab = document.querySelector('[data-tab-id]');
        if (!tab) {
            return null;
        }
        const rect = tab.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    });
    if (!point) {
        throw new Error('The tab bar rendered no tab to click');
    }
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
}

describe('viewer invariant journey', () => {
    it('holds the user-level viewer invariants through a composed reading session', async () => {
        const session = sessionFixture.getSession();
        const { page } = session;

        const firstPdf = await createMultiPageTextFixturePdf('invariant-journey.pdf', JOURNEY_PAGE_COUNT);
        await openPdfInApp(page, firstPdf, OPEN_TIMEOUT_MS);
        await waitForViewerInteractive(page, OPEN_TIMEOUT_MS);
        await assertViewerInvariants(page, {
            checkpoint: 'document open and laid out',
            documentWellFormed: true,
            requirePresent: {pageIndicator: true},
            requireRan: [
                'R1-toolbar-page-visible',
                'C2-renderer-diagnostics-clean',
            ],
        });

        // A real pane resize: the controls stay reachable and the reading
        // anchor survives the relayout.
        const pageBeforeResize = await readToolbarPageFromScreen(page);
        await session.command('windowResize', [
            RESIZED_WIDTH_PX,
            RESIZED_HEIGHT_PX,
        ]);
        await waitForFunctionInPage(page, (expectedWidth: number) => (
            Math.abs(window.innerWidth - expectedWidth) < 2
        ), {timeout: 20_000}, RESIZED_WIDTH_PX);
        await assertViewerInvariants(page, {
            checkpoint: 'after a real window resize',
            documentWellFormed: true,
            requirePresent: {pageIndicator: true},
            requireRan: ['R1-toolbar-page-visible'],
        });
        expect(await readToolbarPageFromScreen(page)).toBe(pageBeforeResize);

        // Pointer-drawn markup, then a sticky note whose window opens over the
        // page it is anchored to. Both are the reader's work: from here on the
        // journey requires them to still be there, because it never deletes
        // them, and the checker cannot tell a deletion from a disappearance.
        await createTextMarkupWithPointer(page, 'Highlight', 0, 1);
        const highlightAnnotationId = (await readDrawnAnnotationIds(page))[0] ?? null;
        if (highlightAnnotationId === null) {
            throw new Error('The pointer-drawn highlight produced no annotation overlay');
        }
        await assertViewerInvariants(page, {
            checkpoint: 'after drawing a highlight with the pointer',
            documentWellFormed: true,
            requirePresent: {
                annotationIds: [highlightAnnotationId],
                pageIndicator: true,
            },
            requireRan: ['A1-annotation-page-containment'],
        });

        await createStickyNoteWithPointer(page, 'journey note', {
            x: 0.4,
            y: 0.3,
        }, 1);
        await waitForFunctionInPage(page, () => document.querySelector('.note-window') !== null, {timeout: 30_000});
        const noteAnnotationId = await evaluateInPage(page, () => (
            document.querySelector('.note-window')?.getAttribute('data-annotation-id') ?? null
        ));
        if (noteAnnotationId === null) {
            throw new Error('The open note window carries no annotation id to name in an exception');
        }
        // Everything the reader made, required at every later checkpoint where
        // the page that holds it is on screen.
        const createdWork = {
            annotationIds: [
                highlightAnnotationId,
                noteAnnotationId,
            ],
            noteWindowFor: [noteAnnotationId],
            pageIndicator: true,
        } as const;
        await assertViewerInvariants(page, {
            checkpoint: 'with an open note window',
            documentWellFormed: true,
            requirePresent: createdWork,
            requireRan: [
                'A1-annotation-page-containment',
                'A2-note-window-over-chrome',
            ],
        });

        // A real wheel scroll several pages down: the rendered counter has to
        // name a page the viewport actually shows. Once the note's anchor page
        // leaves the viewport, the connected note remains open but hidden per
        // ADR 0007; the placement check still runs at this checkpoint.
        const settlement = await wheelPdfViewportAndWaitForSettlement(page, WHEEL_DOWN_DELTA_PX, 30_000);
        expect(settlement.finalScrollTop).toBeGreaterThan(settlement.initialScrollTop);
        // No `requirePresent` for the annotations here: their page is
        // virtualized away on purpose, so their absence is the viewer working.
        const scrolled = await assertViewerInvariants(page, {
            checkpoint: 'after a real wheel scroll down',
            documentWellFormed: true,
            requireNavigationIdle: true,
            requirePresent: {pageIndicator: true},
            requireRan: [
                'R1-toolbar-page-visible',
                'A2-note-window-over-chrome',
            ],
        });
        expect(scrolled.unresolved).toEqual([]);
        expect(await readToolbarPageFromScreen(page)).toBeGreaterThan(1);

        await wheelPdfViewportAndWaitForSettlement(page, -WHEEL_DOWN_DELTA_PX, 30_000);
        await assertViewerInvariants(page, {
            checkpoint: 'after scrolling back up',
            documentWellFormed: true,
            requireNavigationIdle: true,
            requirePresent: createdWork,
            requireRan: [
                'R1-toolbar-page-visible',
                'A1-annotation-page-containment',
                'A1-annotation-normalized-drift',
            ],
        });

        // Zoom through the real toolbar and back with the anchor page on
        // screen: the highlight must keep its place on the page it belongs to,
        // and the note window must stay on the document area.
        // The window's layout box reaches over the toolbar and the sidebar
        // here, and its own clip path paints none of it there, which is why
        // this checkpoint expects no violation: see
        // `.devkit/methodology/findings/calibration.md`.
        await clickVisibleToolbarButton(page, 'Zoom In');
        await assertViewerInvariants(page, {
            checkpoint: 'after zooming in through the toolbar',
            documentWellFormed: true,
            requirePresent: createdWork,
            requireRan: [
                'A1-annotation-normalized-drift',
                'A2-note-window-over-chrome',
            ],
        });
        await clickVisibleToolbarButton(page, 'Zoom Out');
        await assertViewerInvariants(page, {
            checkpoint: 'after zooming back out',
            documentWellFormed: true,
            requirePresent: createdWork,
            requireRan: ['A1-annotation-normalized-drift'],
        });

        await clickVisibleToolbarButton(page, 'Fit Width');
        await assertViewerInvariants(page, {
            checkpoint: 'in fit width',
            documentWellFormed: true,
            requirePresent: createdWork,
            requireRan: [
                'L1-fit-mode-scroll-range',
                'A1-annotation-normalized-drift',
            ],
        });
        await clickVisibleToolbarButton(page, 'Fit Height');
        await assertViewerInvariants(page, {
            checkpoint: 'in fit height',
            documentWellFormed: true,
            requirePresent: createdWork,
            requireRan: ['A1-annotation-normalized-drift'],
        });

        await clickVisibleToolbarButton(page, 'Toggle Sidebar');
        await assertViewerInvariants(page, {
            checkpoint: 'after toggling the sidebar',
            documentWellFormed: true,
            requirePresent: createdWork,
            requireRan: [
                'A1-annotation-normalized-drift',
                'A2-note-window-follows-anchor',
            ],
        });

        // T1: what the first tab shows before the journey works elsewhere.
        const firstTabPage = await readToolbarPageFromScreen(page);
        const firstTabZoom = await readZoomTextFromScreen(page);

        // A second document in its own tab, then back to the first one.
        const secondPdf = await createMultiPageTextFixturePdf('invariant-journey-second.pdf', 4);
        await openPdfInApp(page, secondPdf, OPEN_TIMEOUT_MS);
        await waitForViewerInteractive(page, OPEN_TIMEOUT_MS);
        await assertViewerInvariants(page, {
            checkpoint: 'on the second tab',
            documentWellFormed: true,
            requirePresent: {pageIndicator: true},
            requireRan: ['R1-toolbar-page-visible'],
        });

        await clickFirstTabOnScreen(page);
        await waitForViewerInteractive(page, OPEN_TIMEOUT_MS);
        await assertViewerInvariants(page, {
            checkpoint: 'back on the first tab',
            documentWellFormed: true,
            requirePresent: createdWork,
            requireRan: [
                'R1-toolbar-page-visible',
                'A1-annotation-page-containment',
            ],
        });
        // T1: the other tab's work did not move this one.
        expect(await readToolbarPageFromScreen(page)).toBe(firstTabPage);
        expect(await readZoomTextFromScreen(page)).toBe(firstTabZoom);
    });
});
