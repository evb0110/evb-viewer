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
import {
    assertViewerInvariants,
    type IViewerInvariantException,
} from '@tests/e2e/electron/helpers/viewerInvariants';

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

/**
 * Discovered by this journey, not a weakened invariant. An open note window
 * follows its anchor page and is never clamped to the pane afterwards, so a
 * wheel scroll carries it entirely off screen while it is still open, and a
 * zoom moves it over the toolbar and the sidebar.
 * `PdfAnnotationNoteWindow.clampPosition` bounds a drag; `followPage` states
 * that scroll following is deliberately unclamped, and nothing re-clamps the
 * window afterwards. Every checkpoint that holds this exception is a place the
 * defect shows. Remove it with the fix: the scroll checkpoint asserts the
 * violation is still present, so the exception cannot outlive the bug.
 */
const UNCLAMPED_NOTE_WINDOW_DEFECT: IViewerInvariantException = {
    id: 'A2-note-window-inside-pane',
    reason: 'an open note window is never re-clamped to the pane after the page it follows moves',
};
const OPEN_NOTE_WINDOW_EXCEPTIONS = [UNCLAMPED_NOTE_WINDOW_DEFECT];

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
        });

        // A real pane resize: the controls stay reachable and the reading
        // anchor survives the relayout.
        const pageBeforeResize = await readToolbarPageFromScreen(page);
        await session.command('resize', [
            RESIZED_WIDTH_PX,
            RESIZED_HEIGHT_PX,
        ]);
        await waitForFunctionInPage(page, (expectedWidth: number) => (
            Math.abs(window.innerWidth - expectedWidth) < 2
        ), {timeout: 20_000}, RESIZED_WIDTH_PX);
        await assertViewerInvariants(page, {
            checkpoint: 'after a real window resize',
            documentWellFormed: true,
        });
        expect(await readToolbarPageFromScreen(page)).toBe(pageBeforeResize);

        // Pointer-drawn markup, then a sticky note whose window opens over the
        // page it is anchored to.
        await createTextMarkupWithPointer(page, 'Highlight', 0, 1);
        await assertViewerInvariants(page, {
            checkpoint: 'after drawing a highlight with the pointer',
            documentWellFormed: true,
        });

        await createStickyNoteWithPointer(page, 'journey note', {
            x: 0.4,
            y: 0.3,
        }, 1);
        await waitForFunctionInPage(page, () => document.querySelector('.note-window') !== null, {timeout: 30_000});
        await assertViewerInvariants(page, {
            checkpoint: 'with an open note window',
            documentWellFormed: true,
            expected: OPEN_NOTE_WINDOW_EXCEPTIONS,
        });

        // A real wheel scroll several pages down: the rendered counter has to
        // name a page the viewport actually shows, and the note window has to
        // travel with its anchor.
        const settlement = await wheelPdfViewportAndWaitForSettlement(page, WHEEL_DOWN_DELTA_PX, 30_000);
        expect(settlement.finalScrollTop).toBeGreaterThan(settlement.initialScrollTop);
        const scrolled = await assertViewerInvariants(page, {
            checkpoint: 'after a real wheel scroll down',
            documentWellFormed: true,
            expected: OPEN_NOTE_WINDOW_EXCEPTIONS,
            requireNavigationIdle: true,
        });
        expect(scrolled.tolerated.map(violation => violation.id))
            .toStrictEqual([UNCLAMPED_NOTE_WINDOW_DEFECT.id]);
        expect(await readToolbarPageFromScreen(page)).toBeGreaterThan(1);

        await wheelPdfViewportAndWaitForSettlement(page, -WHEEL_DOWN_DELTA_PX, 30_000);
        await assertViewerInvariants(page, {
            checkpoint: 'after scrolling back up',
            documentWellFormed: true,
            expected: OPEN_NOTE_WINDOW_EXCEPTIONS,
            requireNavigationIdle: true,
        });

        // Zoom through the real toolbar and back: the highlight must keep its
        // place on the page it belongs to.
        await clickVisibleToolbarButton(page, 'Zoom In');
        await assertViewerInvariants(page, {
            checkpoint: 'after zooming in through the toolbar',
            documentWellFormed: true,
            expected: OPEN_NOTE_WINDOW_EXCEPTIONS,
        });
        await clickVisibleToolbarButton(page, 'Zoom Out');
        await assertViewerInvariants(page, {
            checkpoint: 'after zooming back out',
            documentWellFormed: true,
            expected: OPEN_NOTE_WINDOW_EXCEPTIONS,
        });

        await clickVisibleToolbarButton(page, 'Fit Width');
        await assertViewerInvariants(page, {
            checkpoint: 'in fit width',
            documentWellFormed: true,
            expected: OPEN_NOTE_WINDOW_EXCEPTIONS,
        });
        await clickVisibleToolbarButton(page, 'Fit Height');
        await assertViewerInvariants(page, {
            checkpoint: 'in fit height',
            documentWellFormed: true,
            expected: OPEN_NOTE_WINDOW_EXCEPTIONS,
        });

        await clickVisibleToolbarButton(page, 'Toggle Sidebar');
        await assertViewerInvariants(page, {
            checkpoint: 'after toggling the sidebar',
            documentWellFormed: true,
            expected: OPEN_NOTE_WINDOW_EXCEPTIONS,
        });

        // A second document in its own tab, then back to the first one.
        const secondPdf = await createMultiPageTextFixturePdf('invariant-journey-second.pdf', 4);
        await openPdfInApp(page, secondPdf, OPEN_TIMEOUT_MS);
        await waitForViewerInteractive(page, OPEN_TIMEOUT_MS);
        await assertViewerInvariants(page, {
            checkpoint: 'on the second tab',
            documentWellFormed: true,
            expected: OPEN_NOTE_WINDOW_EXCEPTIONS,
        });

        await clickFirstTabOnScreen(page);
        await waitForViewerInteractive(page, OPEN_TIMEOUT_MS);
        await assertViewerInvariants(page, {
            checkpoint: 'back on the first tab',
            documentWellFormed: true,
            expected: OPEN_NOTE_WINDOW_EXCEPTIONS,
        });
    });
});
