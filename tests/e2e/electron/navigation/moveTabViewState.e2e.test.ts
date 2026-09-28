import {
    copyFileSync, mkdirSync,
} from 'node:fs';
import {
    join, resolve,
} from 'node:path';
import {
    describe, expect, it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    ensureSidebarOpen, goToPageViaToolbar, openPdfInApp, waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import type {Page} from 'puppeteer-core';

const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-move-tab-view-state-${Date.now()}`});
const stagedFixture = '/home/ubuntu/.devkit/project12-stage/fixtures/interaction-deterministic-12.pdf';

async function moveTabToNewWindow(page: Page) {
    const browser = page.browser();
    const previous = new Set(await browser.pages());
    // Keep a second source tab so closing the moved tab cannot destroy the
    // source window; then act on the loaded PDF tab through its real menu.
    await page.click('.tab-new');
    await page.click('.tab-list [role="tab"]:first-child');
    await page.click('.tab-list [role="tab"].is-active', {button: 'right'});
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="menuitem"]'))
        .some(item => item.textContent?.includes('Move Tab to New Window')));
    const menuItem = await page.evaluateHandle(() => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find(item => item.textContent?.includes('Move Tab to New Window')) ?? null);
    await (menuItem.asElement()!).click();
    let destination: Page | undefined;
    const deadline = Date.now() + 30_000;
    while (!destination && Date.now() < deadline) {
        destination = (await browser.pages()).find(candidate => !previous.has(candidate));
        if (!destination) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!destination) throw new Error('Transfer did not create a destination window');
    await waitForFunctionInPage(destination, () => document.querySelector('.page_container--rendered') !== null, {timeout: 30_000});
    return destination;
}

async function readView(page: Page) {
    return page.evaluate(() => {
        const snapshot = (window as Window & {__evbTestApi?: {getActiveToolbarSnapshot?: () => {
            effectiveZoom?: number;
            zoomMode?: string;
        }}}).__evbTestApi?.getActiveToolbarSnapshot?.();
        return {
            page: Number(document.querySelector('.editor-pane.is-active .document-viewer-chassis')?.getAttribute('data-chassis-current-page'))
                || Number(document.querySelector('.editor-pane.is-active .document-viewer-chassis')?.getAttribute('data-viewport-committed-page')),
            sidebarOpen: Boolean(document.querySelector('.editor-pane.is-active .sidebar-wrapper:not(.is-closed)')),
            zoomText: document.querySelector('#editor-global-toolbar-host .zoom-controls-display-value')?.textContent?.trim() ?? '',
            zoomMode: snapshot?.zoomMode ?? '',
            effectiveZoom: snapshot?.effectiveZoom ?? 0,
        };
    });
}

describe('Move Tab to New Window view state', () => {
    it('preserves page, custom zoom, and open sidebar in the destination', async () => {
        const session = sessions.getSession();
        mkdirSync(resolve('.devkit/project12/876'), {recursive: true});
        const fixture = join(resolve('.devkit/project12/876'), 'interaction-deterministic-12.pdf');
        copyFileSync(stagedFixture, fixture);
        await openPdfInApp(session.page, fixture);
        await waitForPdfLoaded(session.page);
        await goToPageViaToolbar(session.page, 7);
        await ensureSidebarOpen(session.page);
        const zoomButton = await session.page.$('#editor-global-toolbar-host .zoom-controls-display:not(:disabled)');
        if (!zoomButton) throw new Error('Custom zoom control was not available');
        await zoomButton.click();
        const zoomInput = await session.page.waitForSelector('.zoom-dropdown input', {
            visible: true,
            timeout: 10_000,
        });
        await zoomInput!.click();
        await session.page.keyboard.down('Control');
        await session.page.keyboard.press('A');
        await session.page.keyboard.up('Control');
        await session.page.keyboard.type('137');
        await session.page.keyboard.press('Enter');
        await waitForFunctionInPage(session.page, () => {
            const snapshot = (window as Window & {__evbTestApi?: {getActiveToolbarSnapshot?: () => {
                zoomMode?: string;
                effectiveZoom?: number
            }}})
                .__evbTestApi?.getActiveToolbarSnapshot?.();
            return snapshot?.zoomMode === 'custom';
        }, {timeout: 15_000});
        const beforeTransfer = await readView(session.page);
        expect(beforeTransfer.page).toBe(7);
        expect(beforeTransfer.zoomMode).toBe('custom');
        expect(beforeTransfer.zoomText).toContain('137');
        expect(beforeTransfer.effectiveZoom).toBeCloseTo(1.37, 2);
        expect(beforeTransfer.sidebarOpen).toBe(true);

        const destination = await moveTabToNewWindow(session.page);
        const result = await readView(destination);
        expect(result.page).toBe(7);
        expect(result.zoomMode).toBe('custom');
        expect(result.zoomText).toContain('137');
        expect(result.sidebarOpen).toBe(true);
    }, 120_000);
});
