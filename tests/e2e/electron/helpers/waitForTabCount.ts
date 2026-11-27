import type {Page} from 'puppeteer-core';
import {DEFAULT_TIMEOUT_MS} from '@tests/e2e/electron/helpers/viewerDom';

export async function waitForTabCount(page: Page, minCount: number, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await page.waitForFunction(
        (expected: number) => {
            return document.querySelectorAll('.tab-list .tab[data-tab-id]').length >= expected;
        },
        {timeout: timeoutMs},
        minCount,
    );
}
