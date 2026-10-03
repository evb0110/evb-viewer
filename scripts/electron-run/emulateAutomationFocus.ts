import type {
    Browser,
    Page,
    Target,
} from 'puppeteer-core';

// A hidden or no-focus window never receives OS focus, so its document has
// none: `focus` and `blur` never fire and `:focus` never matches, while a
// person always works in a focused window. CDP focus emulation lasts as long
// as the connection that set it, and the session controller holds its
// connection for the whole session, so it owns the emulation for the first
// window, its reloads, and every window the app opens later.

export function shouldEmulateAutomationFocus(env: NodeJS.ProcessEnv) {
    return env.EVB_AUTOMATION_NO_FOCUS === '1' || env.EVB_AUTOMATION_HIDE_WINDOW === '1';
}

async function focusPage(resolvePage: () => Promise<Page | null>) {
    try {
        await (await resolvePage())?.emulateFocusedPage(true);
    } catch {
        // The window closed before its page could attach or be focused.
    }
}

/**
 * Focuses every window: those a restored workspace opened before the
 * controller attached, and those the app opens later.
 */
export async function emulateAutomationFocus(browser: Browser, page: Page) {
    browser.on('targetcreated', async (target: Target) => {
        if (target.type() === 'page') {
            await focusPage(() => target.page());
        }
    });
    await page.emulateFocusedPage(true);
    await Promise.all((await browser.pages())
        .filter(candidate => candidate !== page)
        .map(candidate => focusPage(() => Promise.resolve(candidate))));
}
