import {
    describe, it,
} from 'vitest';
import {createMultiPageTextFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAsUser, clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    goToPageViaToolbar, openDocumentSidebarTab, openPdfInApp, waitForPdfLoaded, waitForToolbarCurrentPage,
} from '@tests/e2e/electron/helpers/viewerCore';

const PAGES_PANEL = '.workspace-host[data-workspace-active="true"]';

describe('Electron E2E - page numbering start limit', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-page-start-limit-${Date.now()}`});

    it('corrects a letter-style start value too large to print and keeps the document usable', async () => {
        const {page} = sessions.getSession();
        const fixture = await createMultiPageTextFixturePdf(`page-start-limit-${Date.now()}.pdf`, 3);
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Pages');
        const disclosure = `${PAGES_PANEL} .pdf-sidebar-pages-disclosure`;
        if (await page.$eval(disclosure, button => button.getAttribute('aria-expanded')) !== 'true') {
            await clickAsUser(page, disclosure);
        }
        await clickAsUser(page, '#page-label-style-input');
        await clickFoundAsUser(page, (label: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
            .find(option => option.textContent?.trim() === label), 'Letters (A, B)', {description: 'Letters numbering style'});
        await clickAsUser(page, '#page-label-start-input', {count: 3});
        await page.keyboard.type('20000000000');
        await page.keyboard.press('Tab');
        await clickAsUser(page, `${PAGES_PANEL} .pdf-sidebar-pages-primary-button`);
        // The field shows the bounded start, grouped by the locale's separators.
        await page.waitForFunction(() => {
            const field = document.querySelector('#page-label-start-input');
            const value = (field instanceof HTMLInputElement ? field : field?.querySelector('input'))?.value ?? '';
            return value.replace(/\D/g, '') === '104';
        }, {timeout: 15_000});
        await goToPageViaToolbar(page, 2);
        await waitForToolbarCurrentPage(page, 2);
    }, 90_000);
});
