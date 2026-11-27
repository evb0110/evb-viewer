import type {Page} from 'puppeteer-core';
import {evaluateInPage, waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';

export const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_HOST_SIZE_PX = 100;

export interface IPoint {
    x: number;
    y: number;
}

export async function waitForActiveWorkspaceHost(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await waitForFunctionInPage(
        page,
        (minHostSizePx: number) => {
            const isVisibleHost = (element: HTMLElement) => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return (
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    Number(style.opacity || '1') > 0 &&
                    rect.width > minHostSizePx &&
                    rect.height > minHostSizePx
                );
            };

            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).filter(isVisibleHost);
            const activeHost =
                document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"]') ??
                document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            if (activeHost && visibleHosts.includes(activeHost)) {
                return true;
            }

            return visibleHosts.length === 1;
        },
        {timeout: timeoutMs},
        MIN_HOST_SIZE_PX,
    );
}

export async function findVisiblePointInActiveHost(page: Page, selector: string, text?: string): Promise<IPoint | null> {
    await waitForActiveWorkspaceHost(page);

    return evaluateInPage(
        page,
        ({minHostSizePx, targetSelector, targetText}) => {
            const isVisibleHost = (element: HTMLElement) => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return (
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    Number(style.opacity || '1') > 0 &&
                    rect.width > minHostSizePx &&
                    rect.height > minHostSizePx
                );
            };

            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).filter(isVisibleHost);
            const activeHost =
                document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"]') ??
                document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const host = activeHost && visibleHosts.includes(activeHost) ? activeHost : visibleHosts.length === 1 ? visibleHosts[0] : null;
            if (!host) {
                return null;
            }

            const nodes = Array.from(host.querySelectorAll<HTMLElement>(targetSelector)).filter((node) => {
                const rect = node.getBoundingClientRect();
                const style = window.getComputedStyle(node);
                if (rect.width <= 0 || rect.height <= 0) {
                    return false;
                }
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
                    return false;
                }
                if (!targetText) {
                    return true;
                }
                return (node.textContent ?? '').trim() === targetText;
            });

            const target = nodes[0];
            if (!target) {
                return null;
            }

            const rect = target.getBoundingClientRect();
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        },
        {
            minHostSizePx: MIN_HOST_SIZE_PX,
            targetSelector: selector,
            targetText: text ?? null,
        },
    );
}
