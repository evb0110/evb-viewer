import {setTimeout as delay} from 'node:timers/promises';
import type {Page} from 'puppeteer-core';
import {waitForRendererReady} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';

interface IPackagedRendererBrowser {pages(): Promise<Page[]>;}

export async function waitForPackagedCdpEndpoint(
    port: number,
    timeoutMs: number,
    applicationName: string,
) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) {
                const payload = await response.json() as {webSocketDebuggerUrl?: string};
                if (payload.webSocketDebuggerUrl) {
                    return payload.webSocketDebuggerUrl;
                }
            }
        } catch {
            // The packaged application is still starting.
        }
        await delay(250);
    }
    throw new Error(`${applicationName} did not expose CDP on port ${port}`);
}

/**
 * The app document has finished loading and mounted the app. A caller that
 * reloads the page waits for this again before driving it.
 */
export async function waitForPackagedRendererReady(page: Page, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    await waitForFunctionInPage(page, () => document.readyState === 'complete', {timeout: timeoutMs});
    // Puppeteer reads a zero timeout as no deadline.
    await waitForRendererReady(page, Math.max(1, deadline - Date.now()));
}

/** The open app page, once ready; never a blank or closed page. */
export async function waitForPackagedRendererPage(
    browser: IPackagedRendererBrowser,
    timeoutMs: number,
    applicationName: string,
    pollIntervalMs = 100,
) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const page = (await browser.pages())
            .find(candidate => !candidate.isClosed() && candidate.url().startsWith('evb-viewer://app/'));
        if (page) {
            await waitForPackagedRendererReady(page, Math.max(1, deadline - Date.now()));
            return page;
        }
        await delay(pollIntervalMs);
    }
    throw new Error(`${applicationName} exposed no renderer page within ${timeoutMs}ms`);
}
