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
import { createCanonicalTextBoxWithPointer } from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    goToPageViaToolbar,
    openAnnotationsTab,
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

async function zoomInUntilPageFillsViewport(page: Page, paneId: string) {
    for (let step = 0; step < 12; step += 1) {
        const fills = await page.$eval(paneSelector(paneId), (pane) => {
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
        const sourceView = await waitForPaneView(page, sourcePane!, 'source view reads page 2', view => view.centerPage === 2);
        const sourcePlacement = placementOf(sourceView);

        // Split Right shows the same document at the source's page and zoom.
        await splitActiveTabFromTabMenu(page, 'right');
        const [
            leftPane,
            rightPane,
        ] = await paneIds(page);
        expect(leftPane).toBe(sourcePane);
        const splitView = await waitForPaneView(page, rightPane!, 'Split Right must show the source document in the new pane', view => (
            !view.showsStart
            && view.statusPath === sourceView.statusPath
            && view.tabLabel === sourceView.tabLabel
            && view.centerPage === 2
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
        expect(sameWidth(rightPlacement.pageWidthPx, sourcePlacement.pageWidthPx)).toBe(false);
        await waitForPaneView(page, leftPane!, 'left view keeps its page and zoom while the right view moves', view => (
            keepsPlacement(view, sourcePlacement)
        ));

        // Undo in the right view removes the left view's edit from both.
        await clickToolbarButton(page, 'Undo');
        await waitForPaneView(page, leftPane!, 'undo from the right view removes the left edit on the left', view => (
            containsAll(view.renderedTexts, [rightText]) && containsNone(view.renderedTexts, [leftText])
        ));
        await waitForPaneView(page, rightPane!, 'undo from the right view removes the left edit from its list', view => (
            containsAll(view.listedTexts, [rightText]) && containsNone(view.listedTexts, [leftText])
            && keepsPlacement(view, rightPlacement)
        ));

        // Undo in the left view removes the right view's edit from both.
        await activatePaneByTab(page, leftPane!);
        await clickToolbarButton(page, 'Undo');
        await waitForPaneView(page, rightPane!, 'undo from the left view removes the right edit from the right list', view => (
            containsNone(view.listedTexts, [
                rightText,
                leftText,
            ]) && keepsPlacement(view, rightPlacement)
        ));
        const afterUndo = await waitForPaneView(page, leftPane!, 'undo from the left view removes the right edit on the left', view => (
            containsNone(view.renderedTexts, [
                rightText,
                leftText,
            ]) && keepsPlacement(view, sourcePlacement)
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
        await delay(1_000);
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
            && view.centerPage === sourcePlacement.centerPage
            && sameWidth(view.pageWidthPx, sourcePlacement.pageWidthPx)
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
});
