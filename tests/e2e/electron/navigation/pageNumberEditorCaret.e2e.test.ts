import {
    describe, expect, it,
} from 'vitest';
import {createMultiPageTextFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    goToPageViaToolbar, openPdfInApp, waitForPdfLoaded, waitForToolbarCurrentPage,
} from '@tests/e2e/electron/helpers/viewerCore';

describe('Electron E2E - page number editor caret', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-page-editor-caret-${Date.now()}`});

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
        await display!.click();
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
