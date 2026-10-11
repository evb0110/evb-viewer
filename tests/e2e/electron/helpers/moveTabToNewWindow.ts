import type {Page} from 'puppeteer-core';
import {LOCALE_MESSAGES} from '@i18n-app';
import {
    clickAsUser,
    clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';

// Tab > Move Tab to New Window is the app's route to a second window. The item
// is enabled while the window holds a second tab, so the moved tab is the
// document and the source keeps the other one. The source is the tab whose
// title contains `tabTitle`; an empty title selects the first tab. Resolves with
// the new window once its document has rendered.
export async function moveTabToNewWindow(page: Page, {
    tabTitle = '',
    menuLabel = LOCALE_MESSAGES.en.menu.moveTabToNewWindow,
    timeoutMs = 30_000,
}: {
    tabTitle?: string;
    menuLabel?: string;
    timeoutMs?: number;
} = {}) {
    const browser = page.browser();
    const previousPages = new Set(await browser.pages());
    // A second source tab keeps closing the moved tab from destroying the window.
    await clickAsUser(page, '.tab-new');
    await clickFoundAsUser(page, (title: string) => Array.from(document.querySelectorAll<HTMLElement>('.tab-list [role="tab"]'))
        .find(tab => tab.textContent?.includes(title)), tabTitle, {description: `${tabTitle || 'first'} tab`});
    await clickFoundAsUser(page, (title: string) => Array.from(document.querySelectorAll<HTMLElement>('.tab-list [role="tab"].is-active'))
        .find(tab => tab.textContent?.includes(title)), tabTitle, {
        button: 'right',
        description: `${tabTitle || 'first'} tab menu`,
    });
    await clickFoundAsUser(page, (label: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find(item => item.textContent?.includes(label)), menuLabel, {description: menuLabel});
    let destination: Page | undefined;
    const deadline = Date.now() + timeoutMs;
    while (!destination && Date.now() < deadline) {
        destination = (await browser.pages()).find(candidate => !previousPages.has(candidate));
        if (!destination) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!destination) throw new Error('Move Tab to New Window did not create a window');
    await destination.waitForSelector('.page_container--rendered', {timeout: timeoutMs});
    return destination;
}
