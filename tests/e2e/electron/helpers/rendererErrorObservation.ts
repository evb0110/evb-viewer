import type {
    ConsoleMessage,
    Page,
} from 'puppeteer-core';
import { getErrorMessage } from '@contracts/getErrorMessage';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';

// What a user notices when something breaks: an error toast, a broken document
// surface, or a renderer stack in the console. Unhandled rejections are the
// silent form of the same defect, so they are collected in the page as well.

export interface IVisibleErrorSurface {
    selector: string;
    text: string;
}

export interface IRendererErrorReport {
    consoleErrors: string[];
    pageErrors: string[];
    unhandledRejections: string[];
    /** Error surfaces that were already on screen when the observation started. */
    baselineErrorSurfaces: IVisibleErrorSurface[];
    /** Error surfaces that appeared after the observation started. */
    visibleErrorSurfaces: IVisibleErrorSurface[];
}

export interface IRendererErrorObserver {
    collect: () => Promise<IRendererErrorReport>;
    dispose: () => void;
}

const ERROR_SURFACE_SELECTORS = [
    // The card the app shows in the top right when it files a runtime error
    // report. A person reads "Error report ready" there.
    '.runtime-error-reports-card',
    '.app-toast',
    '.app-failure-alert',
    '.pdf-error',
    '.viewer-error',
    '[data-testid="workspace-document-pdf-error"]',
    '[data-testid="workspace-document-djvu-error"]',
    '[data-error="true"]',
];

interface IUnhandledRejectionWindow extends Window {__evbUnhandledRejections?: string[];}

export function isRendererErrorReportClean(report: IRendererErrorReport) {
    return report.consoleErrors.length === 0
        && report.pageErrors.length === 0
        && report.unhandledRejections.length === 0
        && report.visibleErrorSurfaces.length === 0;
}

/**
 * Starts collecting renderer failure evidence. Call `collect` after the action
 * under test and `dispose` when the observation window closes.
 */
export async function observeRendererErrors(page: Page): Promise<IRendererErrorObserver> {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const onConsole = (message: ConsoleMessage) => {
        if (message.type() === 'error') {
            consoleErrors.push(message.text());
        }
    };
    const onPageError = (error: unknown) => {
        pageErrors.push(getErrorMessage(error));
    };
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    const baselineErrorSurfaces = await readVisibleErrorSurfaces(page);
    const baselineKeys = new Set(baselineErrorSurfaces.map(surface => `${surface.selector}::${surface.text}`));

    await evaluateInPage(page, () => {
        const target = window as IUnhandledRejectionWindow;
        if (target.__evbUnhandledRejections) {
            target.__evbUnhandledRejections.length = 0;
            return;
        }
        const collected: string[] = [];
        target.__evbUnhandledRejections = collected;
        window.addEventListener('unhandledrejection', (event) => {
            const reason: unknown = event.reason;
            collected.push(reason instanceof Error
                ? `${reason.name}: ${reason.message}`
                : String(reason));
        });
    });

    return {
        collect: async () => ({
            consoleErrors: [...consoleErrors],
            pageErrors: [...pageErrors],
            unhandledRejections: await evaluateInPage(page, () => (
                [...((window as IUnhandledRejectionWindow).__evbUnhandledRejections ?? [])]
            )) as string[],
            baselineErrorSurfaces,
            visibleErrorSurfaces: (await readVisibleErrorSurfaces(page))
                .filter(surface => !baselineKeys.has(`${surface.selector}::${surface.text}`)),
        }),
        dispose: () => {
            page.off('console', onConsole);
            page.off('pageerror', onPageError);
        },
    };
}

export interface IRuntimeErrorReportEntry {
    detail: string;
    id: string;
    title: string;
}

/**
 * Expands the app's runtime error report card and reads the reports it holds.
 * Evidence only: call it when a report card is already on screen.
 */
export async function readRuntimeErrorReportDetails(page: Page): Promise<IRuntimeErrorReportEntry[]> {
    const detailsButton = await page.$('[data-runtime-error-action="details"]');
    if (!detailsButton) {
        return [];
    }
    if (!await page.$('.runtime-error-report-details')) {
        await detailsButton.click();
        await page.waitForSelector('.runtime-error-report-details', {timeout: 5_000}).catch(() => null);
    }
    return page.evaluate(() => Array.from(
        document.querySelectorAll<HTMLElement>('[data-runtime-error-report-id]'),
    ).map(entry => ({
        detail: entry.querySelector('pre')?.textContent?.trim().slice(0, 1_500) ?? '',
        id: entry.dataset.runtimeErrorReportId ?? '',
        title: entry.innerText.trim().slice(0, 300),
    })));
}

/**
 * Dismisses every runtime error report the app is showing, the way a person
 * clears the card, and returns what was dismissed.
 */
export async function dismissRuntimeErrorReports(page: Page) {
    const dismissed = await readRuntimeErrorReportDetails(page);
    if (dismissed.length === 0) {
        return dismissed;
    }
    for (const button of await page.$$('[data-runtime-error-report-id] button[aria-label]')) {
        await button.click().catch(() => undefined);
    }
    await page.waitForSelector('.runtime-error-reports-card', {
        hidden: true,
        timeout: 5_000,
    });
    return dismissed;
}

export async function readVisibleErrorSurfaces(page: Page) {
    return evaluateInPage(page, (selectors: string[]) => {
        const surfaces: Array<{
            selector: string;
            text: string;
        }> = [];
        for (const selector of selectors) {
            for (const element of document.querySelectorAll<HTMLElement>(selector)) {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                if (
                    rect.width > 4
                    && rect.height > 4
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                ) {
                    surfaces.push({
                        selector,
                        text: (element.innerText || element.textContent || '').trim().slice(0, 300),
                    });
                }
            }
        }
        return surfaces;
    }, ERROR_SURFACE_SELECTORS) as Promise<IVisibleErrorSurface[]>;
}
