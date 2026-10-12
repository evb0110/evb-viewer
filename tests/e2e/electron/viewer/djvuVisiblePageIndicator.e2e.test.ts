import {
    copyFileSync, mkdtempSync, writeFileSync,
} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join, resolve,
} from 'node:path';
import {
    describe, expect, it, onTestFinished,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openDjvuInApp, waitForDjvuLoaded, waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    activateMenuItemAsUser, clickAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {
    waitForWorkspaceToolbarSnapshot, readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {waitForViewportQuiet} from '@tests/e2e/electron/helpers/viewportPageObservation';
import {evaluateInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import type {Page} from 'puppeteer-core';
import {collectDocumentOpenDiagnostics} from '@tests/e2e/electron/helpers/collectDocumentOpenDiagnostics';


/** Two DjVu pages: a tall page 1 (1200x4000) and a short page 2 (1200x400), each one black rule. */
const TALL_THEN_SHORT_DJVU = resolve(process.cwd(), 'tests', 'fixtures', 'electron', 'djvu-fixtures', 'tall-then-short.djvu');
/** The horizontal case: a narrow page 1 (200x200) and a wide page 2 (6000x200). */
const NARROW_THEN_WIDE_DJVU = resolve(process.cwd(), 'tests', 'fixtures', 'electron', 'djvu-fixtures', 'narrow-then-wide.djvu');

/** Page 1 and 2 as the DjVu page-source renderer lays them out, in the scroll container's coordinates. */
async function readPageGeometry(page: Page) {
    return evaluateInPage(page, () => {
        const first = document.querySelector<HTMLElement>('[data-page-number="1"]');
        const second = document.querySelector<HTMLElement>('[data-page-number="2"]');
        let scroller = first?.parentElement ?? null;
        while (scroller && ![
            'auto',
            'scroll',
        ].includes(getComputedStyle(scroller).overflowY)) {
            scroller = scroller.parentElement;
        }
        if (!first || !second || !scroller) return null;
        const scrollerRect = scroller.getBoundingClientRect();
        const firstRect = first.getBoundingClientRect();
        const secondRect = second.getBoundingClientRect();
        return {
            scrollTop: scroller.scrollTop,
            viewportHeight: scroller.clientHeight,
            firstTop: firstRect.top - scrollerRect.top + scroller.scrollTop,
            firstHeight: firstRect.height,
            secondTop: secondRect.top - scrollerRect.top + scroller.scrollTop,
            secondHeight: secondRect.height,
            pointerX: scrollerRect.left + scrollerRect.width / 2,
            pointerY: scrollerRect.top + scrollerRect.height / 2,
        };
    });
}

describe('Electron E2E - DjVu visible page indicator', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-djvu-visible-indicator-${Date.now()}`});

    // T5/L2: a replacement open must paint its page in the current opening.
    it.each([
        [
            'DjVu',
            'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu',
        ],
        [
            'PDF',
            'tests/fixtures/electron/generated-text.pdf',
        ],
    ])('paints an active %s reopened through File > Open in the same tab', async (kind, fixture) => {
        const session = await sessions.restart({
            hard: true,
            sessionName: () => `e2e-same-file-reopen-${kind.toLowerCase()}-${Date.now()}`,
            extraEnv: {EVB_E2E_OPEN_DIALOG_PATH: resolve(fixture)},
        });
        const {page} = session;
        const waitForLoaded = kind === 'DjVu' ? waitForDjvuLoaded : waitForPdfLoaded;
        await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+O'});
        await waitForLoaded(page, 120_000);
        await waitForViewerInteractive(page, 120_000);
        await waitForViewportQuiet(page);
        const tabId = await page.$eval('.editor-pane.is-active .tab.is-active', tab => tab.getAttribute('data-tab-id'));
        const generation = await page.$eval('.editor-pane.is-active [data-open-surface-generation]', element => element.getAttribute('data-open-surface-generation'));

        await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+O'});
        // Do not accept readiness from the previous opening before its replacement starts.
        await page.waitForFunction(previous => {
            const current = document.querySelector('.editor-pane.is-active [data-open-surface-generation]')
                ?.getAttribute('data-open-surface-generation');
            return current !== undefined && current !== previous;
        }, {timeout: 10_000}, generation);
        try {
            await waitForLoaded(page, 10_000);
            await waitForViewerInteractive(page, 10_000);
            // A PDF replacement can reacquire before its new working copy arrives.
            // Observe the settled view, then require the painted page again.
            await waitForViewportQuiet(page, 600, 10_000);
            await waitForLoaded(page, 10_000);
            await waitForViewerInteractive(page, 10_000);
            expect(await page.$eval('.editor-pane.is-active .tab.is-active', tab => tab.getAttribute('data-tab-id'))).toBe(tabId);
            expect(await page.$$eval('.tab-list .tab[data-tab-id]', tabs => tabs.length)).toBe(1);
            expect(await page.$('.document-viewer-chassis__opening-page')).toBeNull();
        } finally {
            const directory = resolve('.devkit/sessions', session.name);
            writeFileSync(join(directory, 'same-file-reopen.json'), JSON.stringify(await collectDocumentOpenDiagnostics(page), null, 2));
            await page.screenshot({path: join(directory, 'same-file-reopen.png')});
        }
    }, 180_000);

    it('renders the requested two-page DjVu with trailing no-break space beside its one-page sibling', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-e2e-djvu-identity-'));
        onTestFinished(() => rm(directory, {
            recursive: true,
            force: true,
        }));
        const sibling = join(directory, 'edge.djvu');
        const requested = `${sibling}\u00a0`;
        copyFileSync(resolve('tests/fixtures/djvu/sources/layered.djvu'), sibling);
        copyFileSync(resolve('tests/fixtures/djvu/sources/mixed-dpi.djvu'), requested);
        const session = await sessions.restart({
            hard: true,
            extraEnv: {EVB_ALLOW_MULTI_AUTOMATION_SESSIONS: '0'},
        });
        const {page} = session;
        await openDjvuInApp(page, sibling);
        expect((await readToolbarPageIndicator(page)).totalPagesText).toBe('1');

        await openDjvuInApp(page, requested);
        await expect.poll(async () => (await readWorkspaceStateValues(page, ['originalPath'])).originalPath, {timeout: 30_000}).toBe(requested);
        await waitForDjvuLoaded(page);
        await waitForViewportQuiet(page);
        expect((await readToolbarPageIndicator(page)).totalPagesText, 'requested 2 pages, not its 1-page sibling').toBe('2');
    }, 120_000);

    it('names the visible page 1 while the viewport sits inside a tall page whose centre is far away', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-e2e-djvu-visible-indicator-'));
        onTestFinished(() => rm(directory, {
            recursive: true,
            force: true,
        }));
        const djvuPath = join(directory, 'tall-then-short.djvu');
        copyFileSync(TALL_THEN_SHORT_DJVU, djvuPath);
        const {page} = sessions.getSession();
        await openDjvuInApp(page, djvuPath);
        await waitForDjvuLoaded(page);
        // DjVu opens in continuous scroll, the mode the indicator follows.
        await waitForWorkspaceToolbarSnapshot(page, {continuousScroll: true});
        await waitForViewportQuiet(page);

        // Scroll with the wheel until the viewport centre sits in the lower part
        // of page 1, where page 2's centre is nearer than page 1's.
        const target = await readPageGeometry(page);
        expect(target, 'both DjVu pages are mounted').not.toBeNull();
        const desiredCenter = target!.firstTop + target!.firstHeight * 0.83;
        const desiredScrollTop = desiredCenter - target!.viewportHeight / 2;
        expect(desiredCenter + target!.viewportHeight / 2).toBeLessThan(target!.firstTop + target!.firstHeight);
        const viewerPoint = {
            x: target!.pointerX,
            y: target!.pointerY,
        };
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const current = await readPageGeometry(page);
            if (!current || Math.abs(current.scrollTop - desiredScrollTop) < 40) break;
            await page.mouse.move(viewerPoint.x, viewerPoint.y);
            await page.mouse.wheel({deltaY: Math.sign(desiredScrollTop - current.scrollTop) * Math.min(400, Math.abs(desiredScrollTop - current.scrollTop))});
            await waitForViewportQuiet(page, 300);
        }
        await waitForViewportQuiet(page);
        const settled = await readPageGeometry(page);
        expect(settled, 'the viewport is still measurable').not.toBeNull();
        expect(settled!.scrollTop).toBeGreaterThanOrEqual(settled!.firstTop);
        expect(settled!.scrollTop + settled!.viewportHeight).toBeLessThanOrEqual(settled!.firstTop + settled!.firstHeight);
        // The centre the old nearest-centre rule used is nearer page 2's centre than page 1's.
        const viewportCentre = settled!.scrollTop + settled!.viewportHeight / 2;
        const firstCentre = settled!.firstTop + settled!.firstHeight / 2;
        const secondCentre = settled!.secondTop + settled!.secondHeight / 2;
        expect(Math.abs(viewportCentre - secondCentre)).toBeLessThan(Math.abs(viewportCentre - firstCentre));
        const indicator = await readToolbarPageIndicator(page);
        expect(indicator.renderedPage, 'the toolbar names the page the viewport is inside').toBe(1);
    }, 240_000);
    it('names the wide visible page after horizontal wheel input hides the narrow page', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-e2e-djvu-wide-indicator-'));
        onTestFinished(() => rm(directory, {
            recursive: true,
            force: true,
        }));
        const {page} = sessions.getSession();
        const djvuPath = join(directory, 'narrow-then-wide.djvu');
        copyFileSync(NARROW_THEN_WIDE_DJVU, djvuPath);
        await openDjvuInApp(page, djvuPath);
        await waitForDjvuLoaded(page);
        await clickAsUser(page, '.zoom-controls-display');
        await page.waitForSelector('.zoom-chip');
        const preset = await page.$$('.zoom-chip');
        for (const button of preset) {
            if ((await button.evaluate(node => node.textContent?.trim())) === '100%') {
                await clickAsUser(page, button);
                break;
            }
        }
        await page.keyboard.press('Escape');
        await waitForWorkspaceToolbarSnapshot(page, {
            zoomMode: 'custom',
            effectiveZoom: 1,
            continuousScroll: true,
        });
        await waitForViewportQuiet(page);
        const before = await readPageGeometry(page);
        expect(before).not.toBeNull();
        await page.mouse.move(before!.pointerX, before!.pointerY);
        await page.mouse.wheel({deltaX: 600});
        await waitForViewportQuiet(page);
        const rectangles = await evaluateInPage(page, () => {
            const first = document.querySelector<HTMLElement>('[data-page-number="1"]')!;
            const second = document.querySelector<HTMLElement>('[data-page-number="2"]')!;
            let container = first.parentElement!;
            while (![
                'auto',
                'scroll',
            ].includes(getComputedStyle(container).overflowY)) container = container.parentElement!;
            const view = container.getBoundingClientRect();
            const intersection = (element: HTMLElement) => {
                const rect = element.getBoundingClientRect();
                return Math.max(0, Math.min(view.right, rect.right) - Math.max(view.left, rect.left))
                    * Math.max(0, Math.min(view.bottom, rect.bottom) - Math.max(view.top, rect.top));
            };
            return {
                firstArea: intersection(first),
                secondArea: intersection(second),
                scrollLeft: container.scrollLeft,
            };
        });
        console.log('wide-indicator rectangles', rectangles);
        expect(rectangles.scrollLeft).toBeGreaterThan(0);
        expect(rectangles.firstArea).toBe(0);
        expect(rectangles.secondArea).toBeGreaterThan(0);
        const indicator = await readToolbarPageIndicator(page);
        console.log('wide-indicator toolbar', indicator);
        expect(indicator.renderedPage).toBe(2);
    }, 240_000);

});
