import { readFile } from 'node:fs/promises';
import { delay } from 'es-toolkit/promise';
import type {
    JSHandle,
    Page,
} from 'puppeteer-core';
import {
    afterEach, describe, expect, it,
} from 'vitest';
import {
    createMultiPageTextFixturePdf,
    readPdfMetadataWithQpdf,
    readPdfTextAnnotationRecords,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    startElectronE2ESession, type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    clickVisibleAnnotationControl,
    createCanonicalTextBoxWithPointer,
    createStickyNoteWithPointer,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    goToPageViaToolbar,
    openAnnotationsTab,
    openDocumentSidebarTab,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    activatePaneByTab,
    splitActiveTabFromTabMenu,
} from '@tests/e2e/electron/helpers/workspaceTabs';
import {
    getLatestAutomationEventId,
    waitForAutomationEvent,
    type IWorkspaceExposeProbeWindow,
} from '@tests/e2e/electron/helpers/workspaceExpose';

// Issue #845, owner-approved design R5: Split shows one document in two views.
// The views share annotations, undo, dirty state and save; each keeps its own
// page, scroll position and zoom. Every action below is trusted mouse or
// keyboard input, and every check reads what a person sees in a pane: the
// status bar, the tab, the page layout, the rendered annotation, the
// annotations list, a dialog, and finally the saved bytes.

const TIMEOUT_MS = 240_000;
const SETTLE_TIMEOUT_MS = 20_000;
// Behavior contract R3: the anchor stays put within device-pixel rounding.
const ANCHOR_TOLERANCE_PX = 1;

interface IPoint {
    x: number;
    y: number;
}

interface IPaneView {
    showsStart: boolean;
    active: boolean;
    /** The window's status bar belongs to the active pane; other panes read null. */
    statusPath: string | null;
    saveDotLabel: string | null;
    /** Rendered width of the page at the viewport center: the pane's zoom as a person sees it. */
    pageWidthPx: number | null;
    tabLabel: string | null;
    tabDirty: boolean;
    centerPage: number | null;
    centerOffsetPx: number | null;
    renderedTexts: string[];
    listedTexts: string[];
}

let session: IElectronE2ESession | null = null;

afterEach(async () => {
    await session?.stop({preserveArtifacts: true});
    session = null;
});

function paneSelector(paneId: string) {
    return `.editor-pane[data-editor-pane-id="${paneId}"]`;
}

async function centerOf(page: Page, selector: string): Promise<IPoint> {
    const point = await page.$eval(selector, (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
            ? {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            }
            : null;
    });
    if (!point) {
        throw new Error(`${selector} has no visible box`);
    }
    return point;
}

async function click(page: Page, selector: string, button: 'left' | 'right' = 'left') {
    const point = await centerOf(page, selector);
    await page.mouse.click(point.x, point.y, {button});
}

async function clickHandle(page: Page, handle: JSHandle<HTMLElement | null | undefined>) {
    const point = await page.evaluate((element) => {
        const rect = element?.getBoundingClientRect();
        return rect
            ? {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            }
            : null;
    }, handle);
    await handle.dispose();
    if (!point) {
        throw new Error('The control to click disappeared');
    }
    await page.mouse.click(point.x, point.y);
}

/** Clicks a control once it rests where a pointer reaches it; an opening panel still moves it. */
async function clickSteadyControl(page: Page, selector: string) {
    await page.waitForFunction((target: string) => new Promise<boolean>((resolve) => {
        const read = () => {
            const rect = document.querySelector(target)?.getBoundingClientRect();
            return rect && rect.width > 0 && rect.height > 0 ? `${rect.left},${rect.top},${rect.width},${rect.height}` : null;
        };
        const first = read();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(first !== null && read() === first)));
    }), {timeout: SETTLE_TIMEOUT_MS}, selector);
    await clickVisibleAnnotationControl(page, selector);
}

async function clickVisible(page: Page, find: () => HTMLElement | null) {
    const handle = await page.waitForFunction(find, {timeout: SETTLE_TIMEOUT_MS});
    await clickHandle(page, handle);
}

async function clickToolbarButton(page: Page, label: string) {
    const handle = await page.waitForFunction((name: string) => Array.from(
        document.querySelectorAll<HTMLButtonElement>('#editor-global-toolbar-host button[aria-label]'),
    ).find((button) => {
        const ariaLabel = button.getAttribute('aria-label') ?? '';
        if ((ariaLabel !== name && !ariaLabel.startsWith(`${name} (`)) || button.disabled) {
            return false;
        }
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return rect.width > 0 && rect.height > 0 && hit !== null && button.contains(hit);
    }) ?? null, {timeout: SETTLE_TIMEOUT_MS}, label);
    await clickHandle(page, handle);
}

async function paneIds(page: Page) {
    return page.$$eval('.editor-pane', panes => panes.map(pane => (pane as HTMLElement).dataset.editorPaneId ?? ''));
}



function readPaneView(page: Page, paneId: string): Promise<IPaneView> {
    return page.$eval(paneSelector(paneId), (pane) => {
        const textOf = (element: Element | null | undefined) => element?.textContent?.replace(/[\u200B\uFEFF]/gu, '').trim() ?? null;
        const viewport = pane.querySelector<HTMLElement>('#pdf-viewer');
        const viewportRect = viewport?.getBoundingClientRect() ?? null;
        const centerY = viewportRect ? viewportRect.top + viewportRect.height / 2 : 0;
        const centerPage = viewportRect
            ? Array.from(pane.querySelectorAll<HTMLElement>('#pdf-viewer .page_container[data-page]')).find((container) => {
                const rect = container.getBoundingClientRect();
                return rect.height > 0 && rect.top <= centerY && rect.bottom >= centerY;
            }) ?? null
            : null;
        const tab = pane.querySelector<HTMLElement>('.tab.is-active[data-tab-id]');
        const active = pane.classList.contains('is-active');
        const status = document.querySelector('#editor-global-status-host');
        return {
            showsStart: Array.from(pane.querySelectorAll<HTMLElement>('.start-open-panel'))
                .some(panel => panel.getBoundingClientRect().width > 0),
            active,
            statusPath: active ? textOf(status?.querySelector('.status-bar-path')) || null : null,
            saveDotLabel: active ? status?.querySelector('.status-save-dot-button')?.getAttribute('aria-label') ?? null : null,
            pageWidthPx: centerPage ? centerPage.getBoundingClientRect().width : null,
            tabLabel: textOf(tab?.querySelector('.tab-label')),
            tabDirty: tab?.classList.contains('is-dirty') ?? false,
            centerPage: centerPage ? Number(centerPage.dataset.page) : null,
            centerOffsetPx: centerPage ? centerY - centerPage.getBoundingClientRect().top : null,
            renderedTexts: Array.from(pane.querySelectorAll('.pdf-annotation-editor-layer [data-annotation-kind="text-box"]'))
                .map(element => textOf(element) ?? '').filter(Boolean),
            listedTexts: Array.from(pane.querySelectorAll('.notes-list .note-item'))
                .map(element => textOf(element) ?? '').filter(Boolean),
        };
    });
}

/** Waits until the pane shows what `accept` requires, then returns that view. */
async function waitForPaneView(
    page: Page,
    paneId: string,
    label: string,
    accept: (view: IPaneView) => boolean,
) {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let view = await readPaneView(page, paneId);
    while (!accept(view) && Date.now() < deadline) {
        await delay(100);
        view = await readPaneView(page, paneId);
    }
    if (!accept(view)) {
        throw new Error(`${label}: ${JSON.stringify(view)}`);
    }
    return view;
}

/** Like waitForPaneView, once the view has also stopped moving. */
async function waitForSteadyPaneView(
    page: Page,
    paneId: string,
    label: string,
    accept: (view: IPaneView) => boolean,
) {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let previous = await waitForPaneView(page, paneId, label, accept);
    while (Date.now() < deadline) {
        // Two readings a painted frame apart: a scroll still in flight moves between them.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const view = await waitForPaneView(page, paneId, label, accept);
        if (view.centerPage === previous.centerPage && view.centerOffsetPx === previous.centerOffsetPx) {
            return view;
        }
        previous = view;
    }
    throw new Error(`${label}: the view did not come to rest: ${JSON.stringify(previous)}`);
}

interface IPlacement {
    centerPage: number | null;
    centerOffsetPx: number | null;
    pageWidthPx: number | null;
}

function placementOf(view: IPaneView): IPlacement {
    return {
        centerPage: view.centerPage,
        centerOffsetPx: view.centerOffsetPx,
        pageWidthPx: view.pageWidthPx,
    };
}

function sameWidth(left: number | null, right: number | null) {
    return left !== null && right !== null && Math.abs(left - right) <= ANCHOR_TOLERANCE_PX;
}

function keepsPlacement(view: IPaneView, placement: IPlacement) {
    return view.centerPage === placement.centerPage
        && sameWidth(view.pageWidthPx, placement.pageWidthPx)
        && view.centerOffsetPx !== null
        && placement.centerOffsetPx !== null
        && Math.abs(view.centerOffsetPx - placement.centerOffsetPx) <= ANCHOR_TOLERANCE_PX;
}

function containsAll(texts: string[], expected: string[]) {
    return expected.every(text => texts.some(candidate => candidate.includes(text)));
}

function containsNone(texts: string[], unexpected: string[]) {
    return unexpected.every(text => texts.every(candidate => !candidate.includes(text)));
}

function countSaveEvents(page: Page, afterEventId: number) {
    return page.evaluate((after: number) => (window as IWorkspaceExposeProbeWindow).__evbTestApi?.getAutomationEvents?.()
        .filter(event => event.type === 'save-committed' && event.id > after).length ?? 0, afterEventId);
}

// At least one step, so the view has a custom zoom that a narrower pane keeps
// (a fit mode re-fits when the pane width changes, behavior contract R3).
async function zoomInUntilPageFillsViewport(page: Page, paneId: string) {
    for (let step = 0; step < 12; step += 1) {
        const fills = step > 0 && await page.$eval(paneSelector(paneId), (pane) => {
            const viewport = pane.querySelector<HTMLElement>('#pdf-viewer');
            const firstPage = pane.querySelector<HTMLElement>('#pdf-viewer .page_container[data-page]');
            return Boolean(viewport && firstPage
                && firstPage.getBoundingClientRect().height > viewport.getBoundingClientRect().height * 1.2);
        });
        if (fills) {
            return;
        }
        const before = await readPaneView(page, paneId);
        await clickToolbarButton(page, 'Zoom In');
        await waitForPaneView(page, paneId, 'Zoom In enlarges the page', view => (
            (view.pageWidthPx ?? 0) > (before.pageWidthPx ?? Infinity) + ANCHOR_TOLERANCE_PX
        ));
    }
    throw new Error('Zoom In never made a page taller than the viewport');
}

/**
 * Undoes a text box edit from the active view. As in a single view, that is
 * two transactions: the first empties the box, the second removes it.
 */
async function undoTextBoxEdit(page: Page, activePane: string, otherPane: string, text: string) {
    const before = await readPaneView(page, activePane);
    await clickToolbarButton(page, 'Undo');
    await waitForPaneView(page, activePane, `the first undo empties the ${text} box`, view => (
        containsNone(view.listedTexts, [text]) && view.listedTexts.length === before.listedTexts.length
    ));
    await clickToolbarButton(page, 'Undo');
    for (const paneId of [
        activePane,
        otherPane,
    ]) {
        await waitForPaneView(page, paneId, `the second undo removes the ${text} box from ${paneId}`, view => (
            containsNone(view.renderedTexts, [text]) && view.listedTexts.length === before.listedTexts.length - 1
        ));
    }
}

/** Numbers every page of the active pane's document through its Pages panel. */
async function numberPagesWithPrefix(page: Page, paneId: string, prefix: string) {
    await openDocumentSidebarTab(page, 'Pages');
    const prefixInput = `${paneSelector(paneId)} #page-label-prefix-input`;
    const disclosure = `${paneSelector(paneId)} .pdf-sidebar-pages-disclosure`;
    if (await page.$eval(disclosure, button => button.getAttribute('aria-expanded')) !== 'true') {
        await clickSteadyControl(page, disclosure);
    }
    await clickSteadyControl(page, prefixInput);
    await page.waitForFunction((selector: string) => document.activeElement === document.querySelector(selector), {timeout: SETTLE_TIMEOUT_MS}, prefixInput);
    // Replace whatever prefix the field still shows.
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type(prefix);
    await page.waitForFunction((selector: string, expected: string) => document.querySelector<HTMLInputElement>(selector)?.value === expected, {timeout: SETTLE_TIMEOUT_MS}, prefixInput, prefix);
    await clickSteadyControl(page, `${paneSelector(paneId)} .pdf-sidebar-pages-primary-button`);
    await waitForPaneView(page, paneId, 'numbering the pages leaves unsaved changes', view => view.tabDirty);
}

async function readVisibleToasts(page: Page) {
    return page.$$eval('.app-toast', toasts => toasts
        .filter(toast => toast.getBoundingClientRect().width > 0)
        .map(toast => (toast as HTMLElement).innerText.trim()));
}

describe('shared PDF split', () => {
    it('shows one document in two views with shared edits, undo, dirty state and save, and separate placement', async () => {
        const stamp = Date.now();
        const pdfPath = await createMultiPageTextFixturePdf(`shared-pdf-split-${stamp}.pdf`, 6);
        session = await startElectronE2ESession(`e2e-shared-pdf-split-${stamp}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        const {page} = session;
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);

        // The source view reads page 2, zoomed in until a page is taller than
        // the viewport so the page at the viewport center is unambiguous.
        const [sourcePane] = await paneIds(page);
        await zoomInUntilPageFillsViewport(page, sourcePane!);
        await goToPageViaToolbar(page, 2);
        const atPageTop = await waitForSteadyPaneView(page, sourcePane!, 'source view reads page 2', view => view.centerPage === 2);
        // It reads partway down that page: Split keeps the reading point, not only the page (T4).
        const sourceViewport = await centerOf(page, `${paneSelector(sourcePane!)} #pdf-viewer`);
        await page.mouse.move(sourceViewport.x, sourceViewport.y);
        await page.mouse.wheel({deltaY: 120});
        const sourceView = await waitForSteadyPaneView(page, sourcePane!, 'source view reads further down page 2', view => (
            view.centerPage === 2
            && (view.centerOffsetPx ?? 0) > (atPageTop.centerOffsetPx ?? 0) + 40
        ));

        // Split Right shows the same document at the source's page and zoom.
        await splitActiveTabFromTabMenu(page, 'right');
        const [
            leftPane,
            rightPane,
        ] = await paneIds(page);
        expect(leftPane).toBe(sourcePane);
        const sourcePlacement = placementOf(await waitForPaneView(page, leftPane!, 'the source view keeps page 2 through the split', view => (
            view.centerPage === 2 && sameWidth(view.pageWidthPx, sourceView.pageWidthPx)
        )));
        const splitView = await waitForPaneView(page, rightPane!, `Split Right must show the source document at its reading point (source center ${String(sourceView.centerOffsetPx)}px into page 2)`, view => (
            !view.showsStart
            && view.statusPath === sourceView.statusPath
            && view.tabLabel === sourceView.tabLabel
            && view.centerPage === 2
            && view.centerOffsetPx !== null
            && sourceView.centerOffsetPx !== null
            && Math.abs(view.centerOffsetPx - sourceView.centerOffsetPx) <= ANCHOR_TOLERANCE_PX
        ));
        expect(sameWidth(splitView.pageWidthPx, sourcePlacement.pageWidthPx), `split page width ${String(splitView.pageWidthPx)} vs source ${String(sourcePlacement.pageWidthPx)}`).toBe(true);

        // An edit made in either view appears in both, and both views are dirty.
        const rightText = `SPLIT-RIGHT-${stamp}`;
        const leftText = `SPLIT-LEFT-${stamp}`;
        await createCanonicalTextBoxWithPointer(page, rightText, {
            x: 0.3,
            y: 0.3,
        }, 2);
        await waitForPaneView(page, leftPane!, 'right edit renders in the left view', view => (
            containsAll(view.renderedTexts, [rightText]) && view.tabDirty
        ));
        await waitForPaneView(page, rightPane!, 'right view is dirty after its edit', view => (
            view.tabDirty && view.saveDotLabel === 'Save changes'
        ));
        await activatePaneByTab(page, leftPane!);
        await createCanonicalTextBoxWithPointer(page, leftText, {
            x: 0.6,
            y: 0.6,
        }, 2);
        await waitForPaneView(page, rightPane!, 'left edit renders in the right view', view => (
            containsAll(view.renderedTexts, [
                rightText,
                leftText,
            ])
        ));
        // Placing the text box scrolled the left view to its page; from here
        // on that is the placement it must keep.
        const leftPlacement = placementOf(await readPaneView(page, leftPane!));
        expect(leftPlacement.centerPage).toBe(2);

        // The views diverge: the right view moves to page 4 and zooms in again.
        await activatePaneByTab(page, rightPane!);
        await openAnnotationsTab(page);
        await goToPageViaToolbar(page, 4);
        const rightBeforeZoom = await readPaneView(page, rightPane!);
        await clickToolbarButton(page, 'Zoom In');
        const rightView = await waitForPaneView(page, rightPane!, 'right view zooms on its own', view => (
            view.centerPage === 4 && (view.pageWidthPx ?? 0) > (rightBeforeZoom.pageWidthPx ?? Infinity) + ANCHOR_TOLERANCE_PX
        ));
        const rightPlacement = placementOf(rightView);
        expect(sameWidth(rightPlacement.pageWidthPx, leftPlacement.pageWidthPx)).toBe(false);
        await waitForPaneView(page, leftPane!, 'left view keeps its page and zoom while the right view moves', view => (
            keepsPlacement(view, leftPlacement)
        ));

        // Undo in the right view removes the left view's edit from both.
        await undoTextBoxEdit(page, rightPane!, leftPane!, leftText);
        await waitForPaneView(page, leftPane!, 'undo from the right view keeps the right edit on the left', view => (
            containsAll(view.renderedTexts, [rightText]) && containsAll(view.listedTexts, [rightText])
        ));
        await waitForPaneView(page, rightPane!, 'undo from the right view keeps the right view in place', view => (
            containsAll(view.listedTexts, [rightText]) && keepsPlacement(view, rightPlacement)
        ));

        // Undo in the left view removes the right view's edit from both.
        await activatePaneByTab(page, leftPane!);
        await undoTextBoxEdit(page, leftPane!, rightPane!, rightText);
        await waitForPaneView(page, rightPane!, 'undo from the left view leaves the right list empty in place', view => (
            view.listedTexts.length === 0 && keepsPlacement(view, rightPlacement)
        ));
        const afterUndo = await waitForPaneView(page, leftPane!, 'undo from the left view leaves the left view empty in place', view => (
            view.renderedTexts.length === 0 && view.listedTexts.length === 0 && keepsPlacement(view, leftPlacement)
        ));
        expect((await readPaneView(page, rightPane!)).tabDirty).toBe(afterUndo.tabDirty);

        // New edits from both views, then Save from the right view writes once.
        const savedLeftText = `SAVED-LEFT-${stamp}`;
        const savedRightText = `SAVED-RIGHT-${stamp}`;
        await createCanonicalTextBoxWithPointer(page, savedLeftText, {
            x: 0.4,
            y: 0.4,
        }, 2);
        await activatePaneByTab(page, rightPane!);
        await createCanonicalTextBoxWithPointer(page, savedRightText, {
            x: 0.4,
            y: 0.4,
        }, 4);
        await waitForPaneView(page, leftPane!, 'left view lists the right view edit on page 4', view => (
            view.tabDirty && containsAll(view.renderedTexts, [savedLeftText]) && containsAll(view.listedTexts, [savedRightText])
        ));
        const leftBeforeSave = placementOf(await readPaneView(page, leftPane!));
        const rightBeforeSave = placementOf(await readPaneView(page, rightPane!));

        const saveBaseline = await getLatestAutomationEventId(page);
        await clickToolbarButton(page, 'Save');
        await waitForAutomationEvent(page, 'save-committed', {
            afterEventId: saveBaseline,
            path: pdfPath,
            timeoutMs: 60_000,
        });
        for (const paneId of [
            leftPane!,
            rightPane!,
        ]) {
            await waitForPaneView(page, paneId, 'both views are saved', view => (
                !view.tabDirty && (!view.active || view.saveDotLabel === 'All changes saved')
            ));
        }
        await waitForPaneView(page, leftPane!, 'left view keeps its place through Save', view => keepsPlacement(view, leftBeforeSave));
        await waitForPaneView(page, rightPane!, 'right view keeps its place through Save', view => keepsPlacement(view, rightBeforeSave));
        expect(await readVisibleToasts(page)).toEqual([]);
        expect(await countSaveEvents(page, saveBaseline), 'one Save writes the file once').toBe(1);

        const savedBytes = await readFile(pdfPath);
        const savedTexts = (await readPdfTextAnnotationRecords(pdfPath)).map(record => record.contents);
        expect(savedTexts).toEqual(expect.arrayContaining([
            savedLeftText,
            savedRightText,
        ]));
        expect(savedTexts).not.toEqual(expect.arrayContaining([leftText]));
        expect(savedTexts).not.toEqual(expect.arrayContaining([rightText]));
        await readPdfMetadataWithQpdf(pdfPath);

        // Closing one view keeps the document, with its unsaved edit, in the other.
        const unsavedText = `UNSAVED-${stamp}`;
        await activatePaneByTab(page, leftPane!);
        await createCanonicalTextBoxWithPointer(page, unsavedText, {
            x: 0.7,
            y: 0.25,
        }, 2);
        await waitForPaneView(page, rightPane!, 'right view is dirty after the left edit', view => view.tabDirty);
        const listedBeforeClose = [
            savedLeftText,
            savedRightText,
            unsavedText,
        ];
        await waitForPaneView(page, leftPane!, 'the left comments list shows every comment before the right view closes', view => (
            containsAll(view.listedTexts, listedBeforeClose)
        ));
        await click(page, `${paneSelector(rightPane!)} .tab.is-active[data-tab-id] .tab-close`);
        await page.waitForFunction(() => document.querySelectorAll('.editor-pane').length === 1, {timeout: SETTLE_TIMEOUT_MS});
        expect(await page.$$eval('[role="dialog"]', dialogs => dialogs.length), 'closing one view asks nothing').toBe(0);
        await waitForPaneView(page, leftPane!, 'the remaining view keeps the document and its unsaved edit', view => (
            !view.showsStart
            && view.statusPath === sourceView.statusPath
            && view.tabDirty
            && containsAll(view.renderedTexts, [
                savedLeftText,
                unsavedText,
            ])
            // Sweep #845 item 5: its comments list keeps every comment too.
            && containsAll(view.listedTexts, listedBeforeClose)
            && view.centerPage === leftPlacement.centerPage
            && sameWidth(view.pageWidthPx, leftPlacement.pageWidthPx)
        ));

        // Closing the last view asks the normal unsaved-changes question.
        await click(page, `${paneSelector(leftPane!)} .tab.is-active[data-tab-id] .tab-close`);
        await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
            .some(dialog => dialog.textContent?.includes('Close tab with unsaved changes?')), {timeout: SETTLE_TIMEOUT_MS});
        await clickVisible(page, () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button'))
            .find(button => button.textContent?.trim() === 'Discard changes') ?? null);
        await waitForPaneView(page, leftPane!, 'discarding the last view closes the document', view => view.showsStart);
        expect(await readFile(pdfPath)).toEqual(savedBytes);
    }, TIMEOUT_MS);

    it('saves page labels numbered in one view from the other view', async () => {
        const stamp = Date.now();
        const pdfPath = await createMultiPageTextFixturePdf(`shared-pdf-split-labels-${stamp}.pdf`, 6);
        session = await startElectronE2ESession(`e2e-shared-pdf-split-labels-${stamp}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        const {page} = session;
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await splitActiveTabFromTabMenu(page, 'right');
        const [
            leftPane,
            rightPane,
        ] = await paneIds(page);
        await waitForPaneView(page, rightPane!, 'Split Right shows the document', view => !view.showsStart && view.centerPage !== null);

        // The left view numbers every page P-1, P-2, ...
        await activatePaneByTab(page, leftPane!);
        await numberPagesWithPrefix(page, leftPane!, 'P-');

        // Using the right view keeps the numbering, and its Save writes it.
        await activatePaneByTab(page, rightPane!);
        await waitForPaneView(page, rightPane!, 'the right view in use still has the unsaved numbering', view => (
            view.active && view.tabDirty && view.saveDotLabel === 'Save changes'
        ));
        const saveBaseline = await getLatestAutomationEventId(page);
        await clickToolbarButton(page, 'Save');
        await waitForAutomationEvent(page, 'save-committed', {
            afterEventId: saveBaseline,
            path: pdfPath,
            timeoutMs: 60_000,
        });
        const metadata = await readPdfMetadataWithQpdf(pdfPath);
        expect(metadata.pagelabels.map(label => label.label?.['/P'])).toContain('u:P-');
    }, TIMEOUT_MS);

    it('saves from the new view page labels numbered before the split', async () => {
        const stamp = Date.now();
        const pdfPath = await createMultiPageTextFixturePdf(`shared-pdf-split-labels-before-${stamp}.pdf`, 6);
        session = await startElectronE2ESession(`e2e-shared-pdf-split-labels-before-${stamp}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        const {page} = session;
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        const [sourcePane] = await paneIds(page);
        await numberPagesWithPrefix(page, sourcePane!, 'Q-');

        // The new view is in use before its own PDF.js document has loaded.
        await splitActiveTabFromTabMenu(page, 'right');
        const [
            , rightPane,
        ] = await paneIds(page);
        await waitForPaneView(page, rightPane!, 'the new view shows the document with the unsaved numbering', view => (
            !view.showsStart && view.centerPage !== null && view.active && view.tabDirty && view.saveDotLabel === 'Save changes'
        ));
        const saveBaseline = await getLatestAutomationEventId(page);
        await clickToolbarButton(page, 'Save');
        await waitForAutomationEvent(page, 'save-committed', {
            afterEventId: saveBaseline,
            path: pdfPath,
            timeoutMs: 60_000,
        });
        const metadata = await readPdfMetadataWithQpdf(pdfPath);
        expect(metadata.pagelabels.map(label => label.label?.['/P'])).toContain('u:Q-');
    }, TIMEOUT_MS);

    it('keeps page labels edited after a save when the other view is used, with their undo', async () => {
        const stamp = Date.now();
        const pdfPath = await createMultiPageTextFixturePdf(`shared-pdf-split-labels-after-save-${stamp}.pdf`, 6);
        session = await startElectronE2ESession(`e2e-shared-pdf-split-labels-after-save-${stamp}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        const {page} = session;
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await splitActiveTabFromTabMenu(page, 'right');
        const [
            leftPane,
            rightPane,
        ] = await paneIds(page);
        await waitForPaneView(page, rightPane!, 'Split Right shows the document', view => !view.showsStart && view.centerPage !== null);

        // Number the pages and save: the save writes them without reloading either view.
        await activatePaneByTab(page, leftPane!);
        await numberPagesWithPrefix(page, leftPane!, 'P-');
        let saveBaseline = await getLatestAutomationEventId(page);
        await clickToolbarButton(page, 'Save');
        await waitForAutomationEvent(page, 'save-committed', {
            afterEventId: saveBaseline,
            path: pdfPath,
            timeoutMs: 60_000,
        });
        await waitForPaneView(page, leftPane!, 'the save leaves the document clean', view => !view.tabDirty);

        // Number them again, then use the other view.
        await numberPagesWithPrefix(page, leftPane!, 'R-');
        await activatePaneByTab(page, rightPane!);
        await waitForPaneView(page, rightPane!, 'the other view in use keeps the unsaved numbering', view => (
            view.active && view.tabDirty && view.saveDotLabel === 'Save changes'
        ));

        // Its undo goes back to the saved numbering and its redo forward again.
        await clickToolbarButton(page, 'Undo');
        await waitForPaneView(page, rightPane!, 'undo returns to the saved numbering', view => !view.tabDirty);
        await clickToolbarButton(page, 'Redo');
        await waitForPaneView(page, rightPane!, 'redo brings the new numbering back', view => view.tabDirty);

        saveBaseline = await getLatestAutomationEventId(page);
        await clickToolbarButton(page, 'Save');
        await waitForAutomationEvent(page, 'save-committed', {
            afterEventId: saveBaseline,
            path: pdfPath,
            timeoutMs: 60_000,
        });
        const metadata = await readPdfMetadataWithQpdf(pdfPath);
        expect(metadata.pagelabels.map(label => label.label?.['/P'])).toContain('u:R-');
    }, TIMEOUT_MS);

    it('opens one editor for a note, in the view that opened it', async () => {
        const stamp = Date.now();
        const pdfPath = await createMultiPageTextFixturePdf(`shared-pdf-split-note-${stamp}.pdf`, 3);
        session = await startElectronE2ESession(`e2e-shared-pdf-split-note-${stamp}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        const {page} = session;
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await splitActiveTabFromTabMenu(page, 'right');
        const [
            leftPane,
            rightPane,
        ] = await paneIds(page);
        await waitForPaneView(page, rightPane!, 'Split Right shows the document', view => !view.showsStart && view.centerPage !== null);
        await activatePaneByTab(page, leftPane!);

        const noteText = `SPLIT-NOTE-${stamp}`;
        await createStickyNoteWithPointer(page, noteText, {
            x: 0.4,
            y: 0.3,
        }, 1);
        const readNoteWindows = () => page.evaluate((left: string, right: string) => ({
            left: document.querySelectorAll(`.editor-pane[data-editor-pane-id="${left}"] .note-window`).length,
            right: document.querySelectorAll(`.editor-pane[data-editor-pane-id="${right}"] .note-window`).length,
            focusedInLeft: Boolean(document.activeElement?.closest(`.editor-pane[data-editor-pane-id="${left}"]`)),
        }), leftPane!, rightPane!);
        await page.waitForSelector(`${paneSelector(leftPane!)} .note-window`, {timeout: SETTLE_TIMEOUT_MS});
        expect(await readNoteWindows()).toMatchObject({
            left: 1,
            right: 0,
        });

        // Typing more keeps the focus in the left view's editor.
        await click(page, `${paneSelector(leftPane!)} .note-window textarea.note-window__textarea`);
        await page.keyboard.type(' more');
        expect(await readNoteWindows()).toEqual({
            left: 1,
            right: 0,
            focusedInLeft: true,
        });

        // Dragging the window moves the one editor there is, within its pane.
        const titleSelector = `${paneSelector(leftPane!)} .note-window .note-window__title-main`;
        const before = await centerOf(page, titleSelector);
        await page.mouse.move(before.x, before.y);
        await page.mouse.down();
        await page.mouse.move(before.x - 20, before.y + 60, {steps: 6});
        await page.mouse.up();
        await page.waitForFunction((selector: string, y: number) => {
            const rect = document.querySelector(selector)?.getBoundingClientRect();
            return Boolean(rect && rect.top + rect.height / 2 > y + 20);
        }, {timeout: SETTLE_TIMEOUT_MS}, titleSelector, before.y);
        expect(await readNoteWindows()).toMatchObject({
            left: 1,
            right: 0,
        });
    }, TIMEOUT_MS);

    it('prints from one dialog that offers the invoking view\'s current page', async () => {
        const stamp = Date.now();
        const pdfPath = await createMultiPageTextFixturePdf(`shared-pdf-split-print-${stamp}.pdf`, 6);
        session = await startElectronE2ESession(`e2e-shared-pdf-split-print-${stamp}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        const {page} = session;
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await splitActiveTabFromTabMenu(page, 'right');
        const [
            leftPane,
            rightPane,
        ] = await paneIds(page);
        await waitForPaneView(page, rightPane!, 'Split Right shows the document', view => !view.showsStart && view.centerPage !== null);
        await goToPageViaToolbar(page, 5);
        await waitForPaneView(page, rightPane!, 'the right view reads page 5', view => view.centerPage === 5);
        await activatePaneByTab(page, leftPane!);
        await goToPageViaToolbar(page, 2);
        await waitForPaneView(page, leftPane!, 'the left view reads page 2', view => view.centerPage === 2);

        await clickToolbarButton(page, 'Print');
        await page.waitForSelector('[role="dialog"] [role="radio"][value="current"]', {
            timeout: SETTLE_TIMEOUT_MS,
            visible: true,
        });
        const dialogs = await page.$$eval('[role="dialog"]', elements => elements
            .filter(element => element.getBoundingClientRect().width > 0)
            .map(element => (element.textContent ?? '').replace(/\s+/gu, ' ')));
        expect(dialogs).toHaveLength(1);
        expect(dialogs[0]).toContain('Current page (2)');
    }, TIMEOUT_MS);
});
