import {
    mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {
    PDFDocument, StandardFonts, rgb,
} from 'pdf-lib';
import {
    afterEach, describe, expect, it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    ensureSidebarOpen, goToPageViaToolbar, openPdfInApp, waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import type {Page} from 'puppeteer-core';
import {electronAppTempDirPath} from '@scripts/electron-run/electronRunSessionPaths';

const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-move-tab-view-state-${Date.now()}`});
let outputDirectory: string | null = null;

afterEach(() => {
    if (outputDirectory) rmSync(outputDirectory, {
        recursive: true,
        force: true,
    });
    outputDirectory = null;
});

async function createTwelvePageFixture(filePath: string) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let pageNumber = 1; pageNumber <= 12; pageNumber += 1) {
        const page = document.addPage([
            612,
            792,
        ]);
        page.drawText(`Transfer view page ${pageNumber}`, {
            x: 72,
            y: 700,
            size: 24,
            font,
            color: rgb(0.1, 0.1, 0.1),
        });
    }
    writeFileSync(filePath, await document.save());
}

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
    const menuItems = await page.$$('[role="menuitem"]');
    const transferItems = await Promise.all(menuItems.map(async candidate => ({
        candidate,
        text: await candidate.evaluate(element => element.textContent ?? ''),
    })));
    const transferItem = transferItems.find(item => item.text.includes('Move Tab to New Window'));
    if (!transferItem) throw new Error('Move Tab to New Window menu item was not rendered');
    await transferItem.candidate.click();
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
        const appTempDirectory = electronAppTempDirPath(session.name);
        mkdirSync(appTempDirectory, {recursive: true});
        outputDirectory = mkdtempSync(join(appTempDirectory, 'tab-view-transfer-'));
        const fixture = join(outputDirectory, 'transfer-view.pdf');
        await createTwelvePageFixture(fixture);
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
