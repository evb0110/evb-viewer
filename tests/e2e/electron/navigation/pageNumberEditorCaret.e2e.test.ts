import {
    describe, expect, it,
} from 'vitest';
import {
    createMultiPageTextFixturePdf,
    createPageLabelRangesFixturePdf,
} from '@tests/e2e/electron/helpers/fixtures';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    goToPageViaToolbar, openDocumentSidebarTab, openPdfInApp, waitForPdfLoaded, waitForToolbarCurrentPage,
} from '@tests/e2e/electron/helpers/viewerCore';
import type {Page} from 'puppeteer-core';

describe('Electron E2E - page number editor caret', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-page-editor-caret-${Date.now()}`});

    it('goes to the page a displayed label names when that label starts with a digit prefix', async () => {
        const {page} = sessions.getSession();
        const fixture = await createMultiPageTextFixturePdf(`page-label-entry-${Date.now()}.pdf`, 20);
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        // Numbering with prefix "1" from 1 shows page 4 as "14"; the label must reach page 4.
        await openDocumentSidebarTab(page, 'Pages');
        const disclosure = '.workspace-host[data-workspace-active="true"] .pdf-sidebar-pages-disclosure';
        if (await page.$eval(disclosure, button => button.getAttribute('aria-expanded')) !== 'true') {
            await clickAsUser(page, disclosure);
        }
        await clickAsUser(page, '#page-label-prefix-input');
        await page.keyboard.type('1');
        await clickAsUser(page, '.workspace-host[data-workspace-active="true"] .pdf-sidebar-pages-primary-button');
        await goToPageLabelViaToolbar(page, '14');
        await waitForToolbarCurrentPage(page, 4);
        expect(await page.$eval('.page_container[data-page="4"]', node => node.textContent ?? '')).toContain('Page 4 sample text');
    }, 90_000);

    it('goes to the lowercase label a typed value names, not the uppercase label of the same letters', async () => {
        const {page} = sessions.getSession();
        const fixture = await createPageLabelRangesFixturePdf(`page-label-case-${Date.now()}.pdf`, 20, [
            {
                startPage: 1,
                style: 'R',
                startNumber: 1,
            },
            {
                startPage: 11,
                style: 'r',
                startNumber: 1,
            },
        ]);
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        // Page 4 shows "IV" in the uppercase segment; page 14 shows "iv" in the lowercase one.
        await goToPageLabelViaToolbar(page, 'iv');
        await waitForToolbarCurrentPage(page, 14);
        expect(await page.$eval('.page_container[data-page="14"]', node => node.textContent ?? '')).toContain('Page 14 sample text');
    }, 90_000);

    it('keeps the editor focused and moves the caret after a trusted click inside it', async () => {
        const {page} = sessions.getSession();
        const fixture = await createMultiPageTextFixturePdf(`page-editor-caret-${Date.now()}.pdf`, 12);
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await goToPageViaToolbar(page, 7);
        await waitForToolbarCurrentPage(page, 7);
        expect(await page.$eval('.page_container[data-page="7"]', node => node.textContent ?? '')).toContain('Page 7 sample text');
        await goToPageViaToolbar(page, 12);
        await waitForToolbarCurrentPage(page, 12);
        const display = await page.$('#editor-global-toolbar-host .page-controls-display');
        expect(display).not.toBeNull();
        await clickAsUser(page, display!);
        const input = await page.waitForSelector('#editor-global-toolbar-host .page-controls-inline-input', {visible: true});
        const bounds = await input!.boundingBox();
        expect(bounds).not.toBeNull();
        const inputText = await input!.evaluate(element => (element as HTMLInputElement).value);
        expect(inputText).toBeTruthy();
        const paddingRight = await input!.evaluate(element => Number.parseFloat(getComputedStyle(element).paddingRight));
        const clickPoint = {
            x: bounds!.x + bounds!.width - paddingRight - 1,
            y: bounds!.y + bounds!.height / 2,
        };
        const hitInput = await page.evaluate((point) => {
            const target = document.elementFromPoint(point.x, point.y);
            return Boolean(target?.closest('#editor-global-toolbar-host .page-controls-inline-input'));
        }, clickPoint);
        expect(hitInput, 'the trusted pointer lands inside the visible page-number input').toBe(true);
        await page.mouse.click(clickPoint.x, clickPoint.y);
        const afterClick = await input!.evaluate(element => ({
            connected: element.isConnected,
            focused: document.activeElement === element,
            value: (element as HTMLInputElement).value,
            caret: (element as HTMLInputElement).selectionStart,
            selectionEnd: (element as HTMLInputElement).selectionEnd,
        }));
        expect(afterClick.connected, 'the page editor remains open after the caret click').toBe(true);
        expect(afterClick.focused, 'the page editor keeps focus after the caret click').toBe(true);
        expect(afterClick.value).toBe(inputText);
        expect(afterClick.caret, 'the click places the caret after the page number').toBe(afterClick.value.length);
        expect(afterClick.caret).toBe(afterClick.selectionEnd);
    }, 90_000);
});

/** Types a displayed page label into the toolbar page editor, as a person does. */
async function goToPageLabelViaToolbar(page: Page, label: string) {
    const display = await page.waitForSelector('#editor-global-toolbar-host .page-controls-display:not([disabled])', {visible: true});
    await clickAsUser(page, display!);
    await page.waitForSelector('#editor-global-toolbar-host .page-controls-inline-input', {visible: true});
    await clickAsUser(page, '#editor-global-toolbar-host .page-controls-inline-input', {count: 3});
    await page.keyboard.type(label);
    await page.keyboard.press('Enter');
}
