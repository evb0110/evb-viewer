import type { Page } from 'puppeteer-core';

type TSerializableValue =
    | boolean
    | number
    | string
    | null
    | TSerializableValue[]
    | { [key: string]: TSerializableValue | undefined }
    | undefined;

type TPageFunction<TResult, TArgs extends TSerializableValue[]> = (...args: TArgs) => TResult;

interface IE2EPageHelpers {
    getActiveWorkspaceHost: (requiredSelector?: string) => HTMLElement | null;
    isElementVisible: (element: HTMLElement | null, minSizePx?: number) => boolean;
}

declare global {
    var __evbE2E: IE2EPageHelpers;
}

const PAGE_EVALUATION_SHIM_SOURCE = 'globalThis.__name = globalThis.__name || ((fn) => fn);';
const PAGE_DOMAIN_HELPERS_SOURCE = `globalThis.__evbE2E = globalThis.__evbE2E || {
    isElementVisible(element, minSizePx = 0) {
        if (!element?.isConnected) return false;
        let current = element;
        while (current) {
            const style = globalThis.getComputedStyle(current);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
                return false;
            }
            current = current.parentElement;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > minSizePx && rect.height > minSizePx;
    },
    getActiveWorkspaceHost(requiredSelector) {
        const visibleHosts = Array.from(globalThis.document.querySelectorAll('.workspace-host'))
            .filter(element => globalThis.__evbE2E.isElementVisible(element, 100));
        const activeHost = globalThis.document.querySelector(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) || globalThis.document.querySelector('.editor-pane.is-active .workspace-host');
        const matchesRequirement = host => !requiredSelector || Boolean(host?.querySelector(requiredSelector));
        if (activeHost && visibleHosts.includes(activeHost) && matchesRequirement(activeHost)) return activeHost;
        const matchingHosts = visibleHosts.filter(matchesRequirement);
        if (matchingHosts.length === 1) return matchingHosts[0];
        return visibleHosts.length === 1 ? visibleHosts[0] : null;
    },
};`;

function serializeForPage(value: TSerializableValue) {
    if (value === undefined) {
        return 'undefined';
    }
    if (typeof value === 'number') {
        if (Number.isNaN(value)) {
            return 'Number.NaN';
        }
        if (value === Number.POSITIVE_INFINITY) {
            return 'Number.POSITIVE_INFINITY';
        }
        if (value === Number.NEGATIVE_INFINITY) {
            return 'Number.NEGATIVE_INFINITY';
        }
        if (Object.is(value, -0)) {
            return '-0';
        }
    }

    return JSON.stringify(value);
}

function buildPageInvocation<TResult, TArgs extends TSerializableValue[]>(
    pageFunction: TPageFunction<TResult, TArgs>,
    args: TArgs,
) {
    const serializedArgs = args.map(serializeForPage).join(', ');
    return `(() => {
        const __name = (fn) => fn;
        return (${pageFunction.toString()})(${serializedArgs});
    })()`;
}

export async function installPageEvaluationShims(page: Page) {
    await page.evaluateOnNewDocument(PAGE_EVALUATION_SHIM_SOURCE);
    await page.evaluateOnNewDocument(PAGE_DOMAIN_HELPERS_SOURCE);
    await page.evaluate(PAGE_EVALUATION_SHIM_SOURCE);
    await page.evaluate(PAGE_DOMAIN_HELPERS_SOURCE);
}

export async function evaluateInPage<TResult, TArgs extends TSerializableValue[]>(
    page: Page,
    pageFunction: TPageFunction<TResult, TArgs>,
    ...args: TArgs
): Promise<Awaited<TResult>> {
    return page.evaluate(buildPageInvocation(pageFunction, args)) as Promise<Awaited<TResult>>;
}

export async function waitForFunctionInPage<TResult, TArgs extends TSerializableValue[]>(
    page: Page,
    pageFunction: TPageFunction<TResult, TArgs>,
    options?: Parameters<Page['waitForFunction']>[1],
    ...args: TArgs
) {
    return page.waitForFunction(
        buildPageInvocation(pageFunction, args),
        options,
    );
}
