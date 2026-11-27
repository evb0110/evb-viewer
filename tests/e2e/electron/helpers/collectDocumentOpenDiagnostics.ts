import type {Page} from 'puppeteer-core';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';
import {evaluateInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {getErrorMessage} from '@contracts/getErrorMessage';

export async function collectDocumentOpenDiagnostics(page: Page) {
    try {
        return await evaluateInPage(page, () => {
            const testWindow = window as IE2EWindow & {
                __evbTestApi?: {
                    collectWorkspaceDebugState?: () => unknown;
                    getAutomationEvents?: () => unknown[];
                };
            };

            return {
                automationEvents: testWindow.__evbTestApi?.getAutomationEvents?.().slice(-20) ?? [],
                bodyText: document.body?.innerText.slice(0, 2_000) ?? '',
                tabs: Array.from(document.querySelectorAll<HTMLElement>('[role="tab"], .tab'))
                    .slice(0, 20)
                    .map((tab) => ({
                        ariaSelected: tab.getAttribute('aria-selected'),
                        text: tab.textContent?.trim().slice(0, 200) ?? '',
                    })),
                url: window.location.href,
                workspace: testWindow.__evbTestApi?.collectWorkspaceDebugState?.() ?? null,
            };
        });
    } catch (error) {
        return {diagnosticError: getErrorMessage(error)};
    }
}
