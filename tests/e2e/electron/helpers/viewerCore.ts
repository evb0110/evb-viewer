import type { Page } from 'puppeteer-core';
import {realpath} from 'node:fs/promises';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import { delay } from 'es-toolkit/promise';
import {collectDocumentOpenDiagnostics} from '@tests/e2e/electron/helpers/collectDocumentOpenDiagnostics';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    DEFAULT_TIMEOUT_MS,
    waitForActiveWorkspaceHost,
} from '@tests/e2e/electron/helpers/viewerDom';
import {
    callWorkspaceCommand,
    getLatestAutomationEventId,
    getWorkspaceToolbarSnapshot,
    installWorkspaceExposeProbe,
    waitForAutomationEvent,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    runWithElectronE2EDeadline,
    type IElectronE2EDeadlineOptions,
} from '@tests/e2e/electron/helpers/electronE2ESessionFailure';

export {
    installNativePdfOpeningSampler,
    stopNativePdfOpeningSampler,
} from '@tests/e2e/electron/helpers/viewerNativePdfState';

const TOOLBAR_ACTION_ICON_HINTS: Record<string, string[]> = {
    'Toggle Sidebar': [
        '.i-ph-sidebar-simple',
        '.iconify.i-ph-sidebar-simple',
    ],
    'Save': [
        '.i-ph-floppy-disk',
        '.iconify.i-ph-floppy-disk',
    ],
    'Save As': [
        '.i-ph-floppy-disk-back',
        '.iconify.i-ph-floppy-disk-back',
    ],
    'Print': [
        '.i-ph-printer',
        '.iconify.i-ph-printer',
    ],
    'Undo': [
        '.i-ph-arrow-u-up-left',
        '.iconify.i-ph-arrow-u-up-left',
    ],
    'Redo': [
        '.i-ph-arrow-u-up-right',
        '.iconify.i-ph-arrow-u-up-right',
    ],
    // The scan-cleanup tooltip changes to live progress text while a previous
    // run is handing its output back to the viewer. Match its stable icon as
    // well as the idle label so a new document can still enter the workspace.
    'Scan cleanup': [
        '.scan-cleanup-trigger > svg',
        '.overflow-menu-scan-cleanup-icon',
    ],
};

interface IAutomationFileOpenGrantApi {
    __allowRendererFileOpenForAutomation?: (value: string) => Promise<boolean>;
    electronAPI?: { documents?: { recentFiles?: { add?: (value: string) => Promise<void>; }; }; };
}

class DirectDocumentOpenRejectedError extends Error {}

function getToolbarActionIconHints(label: string) {
    return TOOLBAR_ACTION_ICON_HINTS[label] ?? [];
}

function isExecutionContextDestroyedError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }

    return /Execution context was destroyed|Cannot find context with specified id|Target closed|Session closed|Frame was detached/i.test(error.message);
}

function describeError(error: unknown) {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

async function runWithExecutionContextRetry<T>(
    page: Page,
    task: () => Promise<T>,
) {
    try {
        return await task();
    } catch (error) {
        if (!isExecutionContextDestroyedError(error)) {
            throw error;
        }

        await delay(1_000);
        return task();
    }
}

async function resolveDocumentSourcePath(path: string) {
    try {
        return await realpath(path);
    } catch {
        return path;
    }
}

async function waitForRendererBindings(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = Date.now();
    let lastState: {
        electronAPI: string;
        openFileDirect: string;
        nuxtRootChildren: number;
        url: string;
    } | null = null;

    while (Date.now() - startedAt < timeoutMs) {
        try {
            lastState = await evaluateInPage(page, () => {
                const nuxtRoot = document.querySelector('#__nuxt');
                return {
                    electronAPI: typeof (window as IE2EWindow & { electronAPI?: unknown }).electronAPI,
                    openFileDirect: typeof (window as IE2EWindow & { __openFileDirect?: unknown }).__openFileDirect,
                    nuxtRootChildren: nuxtRoot?.children.length ?? 0,
                    url: window.location.href,
                };
            });

            if (
                lastState.electronAPI === 'object'
                && lastState.openFileDirect === 'function'
                && lastState.nuxtRootChildren > 0
            ) {
                return;
            }
        } catch (error) {
            if (!isExecutionContextDestroyedError(error)) {
                throw error;
            }
        }

        await delay(250);
    }

    const detail = lastState
        ? `openFileDirect=${lastState.openFileDirect}, electronAPI=${lastState.electronAPI}, nuxtRootChildren=${lastState.nuxtRootChildren}, url=${lastState.url}`
        : 'renderer state unavailable';
    throw new Error(`Renderer bindings did not become ready within ${timeoutMs}ms (${detail})`);
}

export async function waitForActiveDocumentSource(page: Page, path: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const sourcePath = await resolveDocumentSourcePath(path);
    await installWorkspaceExposeProbe(page);
    await waitForFunctionInPage(page, (payload: {path: string}) => {
        const normalize = (value: unknown) => typeof value === 'string'
            ? value.replace(/\\/gu, '/').toLowerCase()
            : '';
        const requestedPath = normalize(payload.path);
        const api = (window as IE2EWindow & {__evbTestApi?: {
            collectWorkspaceDebugState?: () => {activeWorkspaceState?: Record<string, unknown>;};
            readActiveWorkspaceStateValues?: (propertyNames: string[]) => Record<string, unknown>;
        };}).__evbTestApi;
        const activeState = (api?.readActiveWorkspaceStateValues?.([
            'originalPath',
            'pendingDocumentPath',
        ]) ?? api?.collectWorkspaceDebugState?.().activeWorkspaceState ?? {}) as Record<string, unknown>;
        const candidates = [
            activeState.originalPath,
            activeState.pendingDocumentPath,
        ];
        return candidates.some(candidate => normalize(candidate) === requestedPath);
    }, {timeout: timeoutMs}, {path: sourcePath});
}

export async function waitForPdfLoaded(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await runWithExecutionContextRetry(page, async () => {
        await waitForFunctionInPage(page, () => {
            const isElementVisible = (element: HTMLElement | null) => {
                if (!element?.isConnected) {
                    return false;
                }

                let current: HTMLElement | null = element;
                while (current) {
                    const style = window.getComputedStyle(current);
                    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
                        return false;
                    }
                    current = current.parentElement;
                }

                const rect = element.getBoundingClientRect();
                return rect.width > 100 && rect.height > 100;
            };
            const viewers = Array.from(document.querySelectorAll<HTMLElement>('#pdf-viewer'));
            const visibleViewers = viewers.filter(isElementVisible);
            const activeViewer = document.querySelector<HTMLElement>('.editor-pane.is-active #pdf-viewer');
            const viewer = (activeViewer && visibleViewers.includes(activeViewer))
                ? activeViewer
                : (visibleViewers.length === 1 ? visibleViewers[0] : null);
            if (!viewer) {
                return false;
            }

            const host = viewer.closest<HTMLElement>('.workspace-host');
            if (!host) {
                return false;
            }

            const pages = Array.from(viewer.querySelectorAll<HTMLElement>('.page_container'));
            if (pages.length === 0) {
                return false;
            }

            const blockingState = host.querySelector([
                '.workspace-host__loading',
                '.document-viewer-chassis__opening-page',
                '.pdf-loading',
                '.pdf-loading-overlay',
                '.pdf-error',
                '.viewer-error',
                '[data-testid="workspace-document-pdf-error"]',
                '[data-loading="true"]',
                '[data-error="true"]',
            ].join(','));
            if (blockingState) {
                return false;
            }

            const viewerRect = viewer.getBoundingClientRect();
            return pages.some((pageElement) => {
                if (!pageElement.classList.contains('page_container--rendered')) {
                    return false;
                }
                const pageRect = pageElement.getBoundingClientRect();
                const visibleHeight = Math.min(pageRect.bottom, viewerRect.bottom)
                    - Math.max(pageRect.top, viewerRect.top);
                if (visibleHeight <= 8 || pageRect.width <= 0) {
                    return false;
                }

                const canvas = pageElement.querySelector<HTMLCanvasElement>('.page_canvas canvas, canvas');
                return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
            });
        }, {timeout: timeoutMs});

        await waitForViewerInteractive(page, timeoutMs);
    });
}

export async function waitForWorkspaceHistorySettled(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = Date.now();
    let toolbar = await getWorkspaceToolbarSnapshot(page);
    while (Date.now() - startedAt < timeoutMs) {
        if (
            toolbar
            && !toolbar.isHistoryBusy
            && !toolbar.isOpeningDocument
            && toolbar.initialVisualReady
            && toolbar.totalPages > 0
        ) {
            return toolbar;
        }
        await delay(50);
        toolbar = await getWorkspaceToolbarSnapshot(page);
    }
    throw new Error(`Workspace history did not settle: ${JSON.stringify(toolbar)}`);
}

export async function waitForDjvuLoaded(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await runWithExecutionContextRetry(page, async () => {
        await waitForActiveWorkspaceHost(page, timeoutMs);

        await waitForFunctionInPage(page, () => {
            const isVisibleHost = (element: HTMLElement) => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
            };

            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter(isVisibleHost);
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const host = (activeHost && visibleHosts.includes(activeHost))
                ? activeHost
                : (visibleHosts.length === 1 ? visibleHosts[0] : null);
            if (!host) {
                return false;
            }

            const surface = host.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]');
            const viewer = surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]') ?? null;
            if (!surface || !viewer) {
                return false;
            }

            const banner = host.querySelector<HTMLElement>('.djvu-banner');
            const blockingState = host.querySelector([
                '.workspace-host__loading',
                '.document-viewer-chassis__opening-page',
                '[data-testid="workspace-document-djvu-error"]',
                '[data-loading="true"]',
                '[data-error="true"]',
            ].join(','));
            if (
                blockingState
                || banner?.getAttribute('aria-busy') === 'true'
                || banner?.textContent?.includes('Opening DjVu')
            ) {
                return false;
            }

            const viewerRect = viewer.getBoundingClientRect();
            const visiblePages = Array.from(viewer.querySelectorAll<HTMLElement>(
                '[data-testid="document-page-source-page"]',
            )).filter((pageElement) => {
                const pageRect = pageElement.getBoundingClientRect();
                return Math.min(pageRect.bottom, viewerRect.bottom)
                    - Math.max(pageRect.top, viewerRect.top) > 8;
            });
            return visiblePages.some((pageElement) => {
                const image = pageElement.querySelector<HTMLImageElement>(
                    ':scope > [data-testid="document-page-source-image"]',
                );
                const imageStyle = image ? window.getComputedStyle(image) : null;
                return pageElement.dataset.pageSourceVisual === 'fresh'
                    && !pageElement.querySelector('.document-source-viewer__skeleton')
                    && Boolean(
                        image?.complete
                        && image.naturalWidth > 0
                        && image.naturalHeight > 0
                        && image.classList.contains('document-page-visual--committed')
                        && image.dataset.documentPageVisual === 'committed'
                        && imageStyle?.visibility === 'visible',
                    );
            });
        }, {timeout: timeoutMs});
    });
}

async function waitForNativePdfPreviewLoaded(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await runWithExecutionContextRetry(page, async () => {
        await waitForActiveWorkspaceHost(page, timeoutMs);

        await waitForFunctionInPage(page, () => {
            const isElementVisible = (element: HTMLElement | null) => {
                if (!element?.isConnected) {
                    return false;
                }

                let current: HTMLElement | null = element;
                while (current) {
                    const style = window.getComputedStyle(current);
                    if (
                        style.display === 'none'
                        || style.visibility === 'hidden'
                        || Number(style.opacity || '1') === 0
                    ) {
                        return false;
                    }
                    current = current.parentElement;
                }

                const rect = element.getBoundingClientRect();
                return rect.width > 100 && rect.height > 100;
            };

            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter(isElementVisible);
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const host = activeHost && visibleHosts.includes(activeHost)
                ? activeHost
                : (visibleHosts.length === 1 ? visibleHosts[0] : null);
            const container = host?.querySelector<HTMLElement>('.native-pdf-viewer-container') ?? null;
            if (!container || !isElementVisible(container)) {
                return false;
            }

            const standardPdfViewer = host?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
            if (isElementVisible(standardPdfViewer)) {
                return false;
            }

            const blockingState = host?.querySelector([
                '[data-testid="native-pdf-viewer-error"]',
                '[data-testid="workspace-document-pdf-error"]',
                '[data-testid="workspace-document-djvu-error"]',
                '.native-pdf-page-placeholder',
            ].join(','));
            if (blockingState) {
                return false;
            }

            return Array.from(container.querySelectorAll<HTMLImageElement>('.native-pdf-page-shell img'))
                .some((image) => {
                    const rect = image.getBoundingClientRect();
                    return image.complete
                        && image.naturalWidth > 0
                        && image.naturalHeight > 0
                        && rect.width > 100
                        && rect.height > 100;
                });
        }, {timeout: timeoutMs});

        const toolbarDeadline = Date.now() + timeoutMs;
        let lastToolbarSnapshot: Awaited<ReturnType<typeof getWorkspaceToolbarSnapshot>> | null = null;
        while (Date.now() < toolbarDeadline) {
            const toolbarSnapshot = await getWorkspaceToolbarSnapshot(page);
            lastToolbarSnapshot = toolbarSnapshot;
            if (
                toolbarSnapshot
                && toolbarSnapshot.hasPdf
                && !toolbarSnapshot.isOpeningDocument
                && toolbarSnapshot.totalPages > 1
            ) {
                return;
            }
            await delay(100);
        }

        throw new Error(`Native PDF preview toolbar did not settle (${JSON.stringify(lastToolbarSnapshot)})`);
    });
}

async function openPathInApp(
    page: Page,
    path: string,
    waitForLoaded: (page: Page, timeoutMs: number) => Promise<void>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
) {
    const startedAt = Date.now();
    const sourcePath = await resolveDocumentSourcePath(path);
    let lastError: Error | null = null;
    let openTriggered = false;
    let openBaselineEventId = 0;

    try {
        await waitForActiveDocumentSource(page, sourcePath, 300);
        await waitForLoaded(page, timeoutMs);
        return;
    } catch {
        // The requested document is not already active; proceed with a new open transaction.
    }

    while (Date.now() - startedAt < timeoutMs) {
        const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt));

        try {
            await waitForRendererBindings(page, Math.min(remainingMs, 8_000));

            if (!openTriggered) {
                await waitForFunctionInPage(page, () => {
                    const api = (window as IE2EWindow).__evbTestApi;
                    const activeTabId = api?.getActiveTabId?.();
                    return api?.isStartupOpenClaimPending?.() === false
                        && typeof activeTabId === 'string'
                        && activeTabId.length > 0;
                }, {timeout: remainingMs});
                openBaselineEventId = await getLatestAutomationEventId(page);
                const openResult = await runWithExecutionContextRetry(page, async () => {
                    return evaluateInPage(page, async (path: string) => {
                        const automationGrant = (window as typeof globalThis & IE2EWindow & IAutomationFileOpenGrantApi).__allowRendererFileOpenForAutomation;
                        if (typeof automationGrant === 'function') {
                            await automationGrant(path);
                        }

                        const openFileDirect = (window as typeof globalThis & IE2EWindow & { __openFileDirect?: (value: string) => Promise<boolean> }).__openFileDirect;
                        if (typeof openFileDirect !== 'function') {
                            return false;
                        }
                        return openFileDirect(path);
                    }, path);
                });
                openTriggered = true;

                if (!openResult) {
                    const diagnostics = await collectDocumentOpenDiagnostics(page);
                    throw new DirectDocumentOpenRejectedError(
                        `window.__openFileDirect returned false. Diagnostics: ${JSON.stringify(diagnostics)}`,
                    );
                }
            }

            const domWait = (async () => {
                await waitForActiveDocumentSource(page, sourcePath, remainingMs);
                await waitForLoaded(page, remainingMs);
            })();
            const eventWait = Promise.all([
                waitForAutomationEvent(page, 'document-opened', {
                    afterEventId: openBaselineEventId,
                    path: sourcePath,
                    timeoutMs: remainingMs,
                }),
                waitForAutomationEvent(page, 'first-page-rendered', {
                    afterEventId: openBaselineEventId,
                    path: sourcePath,
                    timeoutMs: remainingMs,
                }),
            ])
                .then(async (events) => {
                    if (events.every(Boolean)) {
                        return;
                    }
                    await domWait;
                })
                .catch(() => domWait);
            await Promise.race([
                eventWait,
                domWait,
            ]);
            return;
        } catch (error) {
            if (error instanceof DirectDocumentOpenRejectedError) {
                throw error;
            }
            if (!isExecutionContextDestroyedError(error)) {
                lastError = error instanceof Error ? error : new Error(describeError(error));
            } else {
                lastError = new Error(describeError(error));
            }
            await delay(400);
        }
    }

    const detail = lastError ? ` Last error: ${lastError.message}` : '';
    const diagnostics = await collectDocumentOpenDiagnostics(page);
    throw new Error(`Failed to open document in app within ${timeoutMs}ms.${detail} Diagnostics: ${JSON.stringify(diagnostics)}`);
}

export async function triggerOpenPathInApp(page: Page, path: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = Date.now();
    let lastError: Error | null = null;

    while (Date.now() - startedAt < timeoutMs) {
        const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt));

        try {
            await waitForRendererBindings(page, Math.min(remainingMs, 8_000));
            const openResult = await runWithExecutionContextRetry(page, async () => {
                return evaluateInPage(page, async (path: string) => {
                    const automationGrant = (window as typeof globalThis & IE2EWindow & IAutomationFileOpenGrantApi).__allowRendererFileOpenForAutomation;
                    if (typeof automationGrant === 'function') {
                        await automationGrant(path);
                    }

                    const openFileDirect = (window as typeof globalThis & IE2EWindow & { __openFileDirect?: (value: string) => Promise<boolean> }).__openFileDirect;
                    if (typeof openFileDirect !== 'function') {
                        return false;
                    }
                    void openFileDirect(path).catch((error) => {
                        console.error('[E2E] Direct document open failed', error);
                    });
                    return true;
                }, path);
            });

            if (openResult) {
                return;
            }

            lastError = new Error('window.__openFileDirect is not available');
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(describeError(error));
        }

        await delay(400);
    }

    const detail = lastError ? ` Last error: ${lastError.message}` : '';
    throw new Error(`Failed to trigger document open within ${timeoutMs}ms.${detail}`);
}

export async function openPdfInApp(page: Page, pdfPath: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await openPathInApp(page, pdfPath, waitForPdfLoaded, timeoutMs);
}

export async function openDjvuInApp(page: Page, djvuPath: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await openPathInApp(page, djvuPath, waitForDjvuLoaded, timeoutMs);
}

export async function openNativePdfPreviewInApp(page: Page, pdfPath: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await openPathInApp(page, pdfPath, waitForNativePdfPreviewLoaded, timeoutMs);
}

export async function setTabMemoryPolicyForE2E(
    page: Page,
    policy: 'conservative' | 'aggressive',
    timeoutMs = DEFAULT_TIMEOUT_MS,
) {
    await waitForRendererBindings(page, timeoutMs);
    await runWithExecutionContextRetry(page, async () => {
        await evaluateInPage(page, async (policy: 'conservative' | 'aggressive') => {
            const setter = (window as IE2EWindow & {__setTabMemoryPolicyForE2E?: (policy: 'conservative' | 'aggressive') => void;}).__setTabMemoryPolicyForE2E;
            if (typeof setter !== 'function') {
                throw new Error('Tab memory policy automation hook is not available');
            }
            setter(policy);
        }, policy);
    });
    await waitForFunctionInPage(page, (policy: 'conservative' | 'aggressive') => {
        const settingsApi = (window as IE2EWindow & {electronAPI?: {settings?: {get?: () => Promise<{tabMemoryPolicy?: string;}>;};};}).electronAPI?.settings;
        return settingsApi?.get?.().then(settings => settings.tabMemoryPolicy === policy) ?? false;
    }, { timeout: timeoutMs }, policy);
}

export async function waitForViewerInteractive(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await waitForActiveWorkspaceHost(page, timeoutMs);

    await waitForFunctionInPage(page, () => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisibleHost);
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        if (!host) {
            return false;
        }

        const chassis = host.querySelector<HTMLElement>('.document-viewer-chassis');
        const chassisViewport = chassis?.querySelector<HTMLElement>(
            '[data-document-viewer-chassis-viewport]',
        ) ?? null;
        const legacyViewer = chassis ? null : host.querySelector<HTMLElement>('.pdfViewer');
        const viewport = chassisViewport ?? legacyViewer;
        const pdfPageTrack = chassisViewport?.querySelector<HTMLElement>('[data-pdf-page-track]') ?? null;
        const documentSourceViewer = chassisViewport?.querySelector<HTMLElement>(
            '[data-testid="document-page-source-viewer"]',
        ) ?? null;
        const interactiveSurface = pdfPageTrack ?? documentSourceViewer ?? legacyViewer;
        if (!viewport || !interactiveSurface) {
            return false;
        }

        const viewportStyle = window.getComputedStyle(viewport);
        const surfaceStyle = window.getComputedStyle(interactiveSurface);
        const surfacePresented = surfaceStyle.display !== 'none'
            && surfaceStyle.visibility !== 'hidden'
            && Number(surfaceStyle.opacity || '1') > 0;
        const viewportPresented = viewportStyle.display !== 'none'
            && viewportStyle.visibility !== 'hidden'
            && Number(viewportStyle.opacity || '1') > 0;
        if (
            !surfacePresented
            || !viewportPresented
            || interactiveSurface.classList.contains('pdfViewer--resize-transition')
            || interactiveSurface.classList.contains('pdfViewer--hidden')
        ) {
            return false;
        }

        return !chassis || (
            chassisViewport?.dataset.openSurfacePhase === 'ready'
            && chassis.dataset.openSurfacePresentation === 'committed'
        );
    }, {timeout: timeoutMs});
}

export async function clickVisibleToolbarButton(page: Page, ariaLabel: string) {
    const tryClickInlineButton = () => evaluateInPage(page, (args: {
        label: string;
        iconHints: string[];
    }): 'clicked' | 'disabled' | 'not-found' => {
        const matchesToolbarAction = (element: HTMLElement, label: string, iconHints: string[]) => {
            const ariaLabel = element.getAttribute('aria-label')?.trim() ?? '';
            if (ariaLabel === label || ariaLabel.startsWith(`${label} (`)) {
                return true;
            }
            return iconHints.some(selector => Boolean(element.querySelector(selector)));
        };

        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'));
        const candidates = buttons.filter((button) => {
            if (!matchesToolbarAction(button, args.label, args.iconHints)) {
                return false;
            }
            const rect = button.getBoundingClientRect();
            const style = window.getComputedStyle(button);
            return (
                rect.width > 8
                && rect.height > 8
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
            );
        });
        const target = candidates.find(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true');

        if (!target) {
            return candidates.length > 0 ? 'disabled' : 'not-found';
        }

        target.click();
        return 'clicked';
    }, {
        label: ariaLabel,
        iconHints: getToolbarActionIconHints(ariaLabel),
    });

    let clicked = false;
    const inlineButtonDeadline = Date.now() + 4_000;
    while (Date.now() < inlineButtonDeadline) {
        const result = await tryClickInlineButton();
        if (result === 'clicked') {
            clicked = true;
            break;
        }
        if (result === 'not-found') {
            break;
        }

        await delay(50);
    }

    if (!clicked) {
        const finalInlineAttempt = await tryClickInlineButton();
        if (finalInlineAttempt === 'clicked') {
            return;
        }
        if (finalInlineAttempt === 'disabled') {
            throw new Error(`Visible toolbar button stayed disabled: ${ariaLabel}`);
        }

        const overflowPoint = await evaluateInPage(page, () => {
            const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label], .toolbar-icon-button'))
                .find((candidate) => {
                    const element = candidate as HTMLElement;
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    if (
                        rect.width <= 8
                        || rect.height <= 8
                        || style.display === 'none'
                        || style.visibility === 'hidden'
                        || Number(style.opacity || '1') === 0
                    ) {
                        return false;
                    }
                    return Boolean(
                        element.classList.contains('toolbar-icon-button')
                        || Boolean(element.querySelector('.i-ph-dots-three'))
                        || Boolean(element.querySelector('.iconify.i-ph-dots-three')),
                    );
                });

            if (!trigger || trigger.disabled) {
                return null;
            }
            const rect = trigger.getBoundingClientRect();
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        });

        if (!overflowPoint) {
            const appMenuPoint = await page.evaluate(() => {
                const menuButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
                    .find((candidate) => {
                        const ariaLabel = candidate.getAttribute('aria-label')?.trim() ?? '';
                        const rect = candidate.getBoundingClientRect();
                        const style = window.getComputedStyle(candidate);
                        return (
                            ariaLabel === 'Menu'
                            && rect.width > 8
                            && rect.height > 8
                            && style.display !== 'none'
                            && style.visibility !== 'hidden'
                            && Number(style.opacity || '1') > 0
                            && !candidate.disabled
                            && candidate.getAttribute('aria-disabled') !== 'true'
                        );
                    });
                if (!menuButton) {
                    return null;
                }
                const rect = menuButton.getBoundingClientRect();
                return {
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2),
                };
            });

            if (!appMenuPoint) {
                throw new Error(`Visible toolbar button not found: ${ariaLabel}`);
            }

            await page.mouse.click(appMenuPoint.x, appMenuPoint.y);
            await page.waitForSelector('.app-menu', { timeout: 4_000 });

            const appMenuItemPoint = await page.evaluate((args: {
                label: string;
                iconHints: string[];
            }) => {
                const matchesToolbarAction = (element: HTMLElement, label: string, iconHints: string[]) => {
                    const text = (element.querySelector('.app-menu-label')?.textContent ?? '').trim();
                    if (text === label) {
                        return true;
                    }
                    return iconHints.some(selector => Boolean(element.querySelector(selector)));
                };

                const items = Array.from(document.querySelectorAll<HTMLElement>('.app-menu .app-menu-item'));
                const target = items.find((item) => {
                    if (!matchesToolbarAction(item, args.label, args.iconHints)) {
                        return false;
                    }
                    const rect = item.getBoundingClientRect();
                    const style = window.getComputedStyle(item);
                    return (
                        rect.width > 8
                        && rect.height > 8
                        && style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && Number(style.opacity || '1') > 0
                        && !item.hasAttribute('disabled')
                        && item.getAttribute('aria-disabled') !== 'true'
                    );
                });
                if (!target) {
                    return null;
                }
                const rect = target.getBoundingClientRect();
                return {
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2),
                };
            }, {
                label: ariaLabel,
                iconHints: getToolbarActionIconHints(ariaLabel),
            });

            if (!appMenuItemPoint) {
                throw new Error(`Toolbar action not found in app menu: ${ariaLabel}`);
            }

            await page.mouse.click(appMenuItemPoint.x, appMenuItemPoint.y);
            await page.waitForFunction(() => {
                const menu = document.querySelector('.app-menu');
                if (!menu) {
                    return true;
                }
                const style = window.getComputedStyle(menu);
                return (
                    style.display === 'none'
                    || style.visibility === 'hidden'
                    || Number(style.opacity || '1') === 0
                );
            }, { timeout: 4_000 });
            return;
        }

        await page.mouse.click(overflowPoint.x, overflowPoint.y);
        await page.waitForSelector('.overflow-menu', { timeout: 4_000 });

        const overflowItemPoint = await page.evaluate((args: {
            label: string;
            iconHints: string[];
        }) => {
            const matchesToolbarAction = (element: HTMLElement, label: string, iconHints: string[]) => {
                const text = (element.querySelector('.overflow-menu-label')?.textContent ?? '').trim();
                if (text === label) {
                    return true;
                }
                return iconHints.some(selector => Boolean(element.querySelector(selector)));
            };

            const items = Array.from(document.querySelectorAll<HTMLElement>('.overflow-menu .overflow-menu-item'));
            const target = items.find((item) => {
                if (!matchesToolbarAction(item, args.label, args.iconHints)) {
                    return false;
                }
                const rect = item.getBoundingClientRect();
                const style = window.getComputedStyle(item);
                return (
                    rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                    && !item.hasAttribute('disabled')
                    && item.getAttribute('aria-disabled') !== 'true'
                );
            });
            if (!target) {
                return null;
            }
            const rect = target.getBoundingClientRect();
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        }, {
            label: ariaLabel,
            iconHints: getToolbarActionIconHints(ariaLabel),
        });

        if (!overflowItemPoint) {
            throw new Error(`Toolbar action not found in overflow menu: ${ariaLabel}`);
        }
        await page.mouse.click(overflowItemPoint.x, overflowItemPoint.y);
        await page.waitForFunction(() => {
            const menu = document.querySelector('.overflow-menu');
            if (!menu) {
                return true;
            }
            const style = window.getComputedStyle(menu);
            return (
                style.display === 'none'
                || style.visibility === 'hidden'
                || Number(style.opacity || '1') === 0
            );
        }, {timeout: 4_000});
        return;
    }

}

export async function clickToolbarButtonWhenEnabled(
    page: Page,
    ariaLabel: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
) {
    const startedAt = Date.now();
    let lastError: Error | null = null;

    while (Date.now() - startedAt < timeoutMs) {
        try {
            await clickVisibleToolbarButton(page, ariaLabel);
            return;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            await delay(125);
        }
    }

    const elapsedMs = Date.now() - startedAt;
    const detail = lastError ? ` Last error: ${lastError.message}` : '';
    throw new Error(`Toolbar action '${ariaLabel}' did not become clickable in ${elapsedMs}ms.${detail}`);
}

export async function ensureSidebarOpen(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await waitForActiveWorkspaceHost(page, timeoutMs);

    const hasSidebar = await page.evaluate(() => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && isVisibleHost(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .find(isVisibleHost);
        if (!host) {
            return false;
        }
        const sidebar = host.querySelector('[data-testid="document-sidebar"]');
        if (!sidebar) {
            return false;
        }
        const rect = sidebar.getBoundingClientRect();
        const style = window.getComputedStyle(sidebar);
        return (
            rect.width > 10
            && rect.height > 10
            && style.display !== 'none'
            && style.visibility !== 'hidden'
        );
    });

    if (!hasSidebar) {
        await clickToolbarButtonWhenEnabled(page, 'Toggle Sidebar', timeoutMs);
    }

    await page.waitForFunction(() => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && isVisibleHost(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .find(isVisibleHost);
        if (!host) {
            return false;
        }
        const sidebar = host.querySelector('[data-testid="document-sidebar"]');
        if (!sidebar) {
            return false;
        }
        const rect = sidebar.getBoundingClientRect();
        const style = window.getComputedStyle(sidebar);
        return rect.width > 10 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden';
    }, {timeout: timeoutMs});
}

export async function openDocumentSidebarTab(
    page: Page,
    label: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
) {
    await ensureSidebarOpen(page, timeoutMs);
    const tabs = await page.$$('.editor-pane.is-active [data-testid="document-sidebar"] [role="tab"]');
    const tabLabels = await Promise.all(tabs.map(tab => tab.evaluate(element => (
        `${element.getAttribute('aria-label') ?? ''} ${element.textContent ?? ''}`.trim()
    ))));
    const normalizedLabel = label.trim().toLocaleLowerCase();
    const tabIndex = tabLabels.findIndex(tabLabel => (
        tabLabel.toLocaleLowerCase().includes(normalizedLabel)
    ));
    if (tabIndex < 0) {
        throw new Error(`Document sidebar tab '${label}' was unavailable: ${JSON.stringify(tabLabels)}`);
    }
    await tabs[tabIndex]!.click();
    await page.waitForFunction((expectedLabel: string) => {
        const normalized = expectedLabel.trim().toLocaleLowerCase();
        return Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active [data-testid="document-sidebar"] [role="tab"]',
        )).some((tab) => {
            const tabLabel = `${tab.getAttribute('aria-label') ?? ''} ${tab.textContent ?? ''}`
                .trim()
                .toLocaleLowerCase();
            return tabLabel.includes(normalized) && (
                tab.getAttribute('aria-selected') === 'true'
                || tab.dataset.state === 'active'
            );
        });
    }, {timeout: timeoutMs}, label);
}

async function isAnnotationsPanelVisible(page: Page) {
    return page.evaluate(() => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const isVisiblePanel = (element: HTMLElement | null) => {
            if (!element) {
                return false;
            }
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.height > 10 && rect.width > 10 && style.display !== 'none' && style.visibility !== 'hidden';
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && isVisibleHost(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .find(isVisibleHost);
        return isVisiblePanel(host?.querySelector<HTMLElement>('.notes-panel') ?? null);
    });
}

async function tryActivateAnnotationsTab(page: Page) {
    const activeSelector = '.editor-pane.is-active .workspace-host [data-testid="document-sidebar"] [role="tab"]';
    const fallbackSelector = '.workspace-host [data-testid="document-sidebar"] [role="tab"]';
    let tabs = await page.$$(activeSelector);
    if (tabs.length === 0) {
        tabs = await page.$$(fallbackSelector);
    }
    if (tabs.length === 0) {
        return 'missing-tabs';
    }

    const tabStates = await Promise.all(tabs.map(async (tab) => ({
        tab,
        visible: await tab.boundingBox() !== null,
        ...(await tab.evaluate((element) => {
            const text = [
                element.getAttribute('aria-label') ?? '',
                element.getAttribute('title') ?? '',
                element.textContent ?? '',
                element.className,
                element.querySelector('span')?.className ?? '',
                element.querySelector('svg')?.getAttribute('data-icon') ?? '',
            ]
                .join(' ')
                .toLowerCase();
            return {isAnnotationTab: text.includes('notes')
                || text.includes('annotation')
                || text.includes('message-square')
                || text.includes('sticky-note')};
        })),
    })));
    const target = tabStates.find(state => state.visible && state.isAnnotationTab);
    if (!target) {
        return 'missing-target';
    }

    // A sidebar transition can expose a tab's layout box while the page
    // still receives pointer events there. Wait for a stable, hittable tab
    // before sending the real pointer click.
    const point = await target.tab.evaluate(async (element) => {
        let previous = element.getBoundingClientRect();
        for (let frame = 0; frame < 3; frame += 1) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            const current = element.getBoundingClientRect();
            if (Math.abs(current.left - previous.left) > 0.5
                || Math.abs(current.top - previous.top) > 0.5
                || Math.abs(current.width - previous.width) > 0.5
                || Math.abs(current.height - previous.height) > 0.5) {
                return null;
            }
            previous = current;
        }
        const x = previous.left + previous.width / 2;
        const y = previous.top + previous.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (previous.width <= 8 || previous.height <= 8 || !hit || !element.contains(hit)) {
            return null;
        }
        return {
            x,
            y,
        };
    });
    if (!point) {
        return 'tab-not-ready-for-pointer';
    }
    await page.mouse.click(point.x, point.y);
    return 'clicked';
}

export async function openAnnotationsTab(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await ensureSidebarOpen(page, timeoutMs);
    await waitForActiveWorkspaceHost(page, timeoutMs);

    const startedAt = Date.now();
    let lastState = 'not-started';
    let lastError: unknown = null;

    while (Date.now() - startedAt < timeoutMs) {
        try {
            if (await isAnnotationsPanelVisible(page)) {
                return;
            }

            lastState = await tryActivateAnnotationsTab(page);
            if (await isAnnotationsPanelVisible(page)) {
                return;
            }
        } catch (error) {
            lastError = error;
            if (!isExecutionContextDestroyedError(error)) {
                lastState = describeError(error);
            }
        }

        await delay(250);
        try {
            await waitForActiveWorkspaceHost(page, Math.min(2_000, timeoutMs));
        } catch (error) {
            lastError = error;
        }
    }

    const detail = lastError ? describeError(lastError) : lastState;
    throw new Error(`Annotations tab did not open within ${timeoutMs}ms (${detail})`);
}

export async function scrollViewerToPage(page: Page, pageNumber: number) {
    await waitForActiveWorkspaceHost(page);

    const scrollCommand = await callWorkspaceCommand(page, 'handleGoToPage', [pageNumber]);
    if (scrollCommand.called) {
        try {
            await waitForToolbarCurrentPage(page, pageNumber, 5_000);
        } catch {
            await goToPageViaToolbar(page, pageNumber);
        }
        return;
    }

    const scrolled = await page.evaluate((targetPageNumber: number) => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && isVisibleHost(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .find(isVisibleHost);
        if (!host) {
            return false;
        }

        const viewer = host.querySelector<HTMLElement>('.pdfViewer');
        const pageEl = host.querySelector<HTMLElement>(`.page_container[data-page="${targetPageNumber}"]`);
        if (!viewer || !pageEl) {
            return false;
        }

        viewer.scrollTop = Math.max(0, pageEl.offsetTop - 16);
        viewer.dispatchEvent(new Event('scroll', { bubbles: true }));
        return true;
    }, pageNumber);

    if (!scrolled) {
        await goToPageViaToolbar(page, pageNumber);
        return;
    }

    try {
        await waitForToolbarCurrentPage(page, pageNumber, 5_000);
    } catch {
        await goToPageViaToolbar(page, pageNumber);
    }
}

async function readActiveViewerCurrentPageState(page: Page) {
    return (await getWorkspaceToolbarSnapshot(page))?.currentPage ?? null;
}

export async function dismissScanCleanupFirstRunGuidance(
    page: Page,
    timeoutMs = DEFAULT_TIMEOUT_MS,
) {
    const selector = '.scan-cleanup-first-run-guidance';
    const guidance = await page.$(selector);
    if (!guidance) {
        return false;
    }
    const dismissButton = await guidance.$('button');
    if (!dismissButton) {
        throw new Error('Scan Cleanup first-run guidance has no dismiss button');
    }
    await dismissButton.click();
    await page.waitForSelector(selector, {
        hidden: true,
        timeout: timeoutMs,
    });
    return true;
}

export async function goToPageViaToolbar(page: Page, pageNumber: number) {
    const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
    let lastFailure = 'toolbar page control never became clickable';

    while (Date.now() < deadline) {
        const displayPoint = await page.evaluate(() => {
            const isVisibleElement = (element: HTMLElement) => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
            };

            const toolbarHost = document.querySelector<HTMLElement>('#editor-global-toolbar-host');
            const display = Array.from((toolbarHost ?? document).querySelectorAll<HTMLButtonElement>('.page-controls-display'))
                .find(candidate => isVisibleElement(candidate) && !candidate.disabled);
            if (!display) {
                return null;
            }

            const rect = display.getBoundingClientRect();
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        });

        if (!displayPoint) {
            lastFailure = 'no enabled visible .page-controls-display in the active toolbar';
            await new Promise(resolve => setTimeout(resolve, 250));
            continue;
        }

        await page.mouse.click(displayPoint.x, displayPoint.y);
        try {
            await page.waitForSelector('.page-controls-inline-input', { timeout: 2_000 });
        } catch {
            lastFailure = 'clicking the page control did not open the inline editor';
            continue;
        }

        await page.click('.page-controls-inline-input', { count: 3 });
        await page.keyboard.type(String(pageNumber));
        await page.keyboard.press('Enter');
        await waitForToolbarCurrentPage(page, pageNumber);
        return;
    }

    throw new Error(`Toolbar page navigation to ${pageNumber} failed within ${DEFAULT_TIMEOUT_MS}ms (${lastFailure})`);
}

export async function getToolbarCurrentPage(page: Page) {
    const currentPageFromViewerState = await readActiveViewerCurrentPageState(page);
    if (Number.isFinite(currentPageFromViewerState)) {
        return currentPageFromViewerState;
    }

    return page.evaluate(() => {
        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
        };

        const currentPageText = Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current'))
            .find(isVisibleElement)
            ?.textContent
            ?.trim() ?? '';
        const currentPage = Number.parseInt(currentPageText, 10);
        return Number.isFinite(currentPage) ? currentPage : null;
    });
}

export async function waitForToolbarCurrentPage(
    page: Page,
    expectedPage: number,
    timeoutMs = DEFAULT_TIMEOUT_MS,
) {
    await waitForWorkspaceToolbarSnapshot(page, {currentPage: expectedPage}, {timeoutMs});
}

export async function saveViaWindowHandle(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const saveBaselineEventId = await getLatestAutomationEventId(page);
    const workspaceSave = await callWorkspaceCommand<boolean>(page, 'handleSave');
    const saved = workspaceSave.called
        ? workspaceSave.value === true
        : await page.evaluate(async () => {
            const save = (window as IE2EWindow & { __handleSave?: () => Promise<unknown> }).__handleSave;
            if (typeof save !== 'function') {
                return false;
            }
            return await save() === true;
        });

    if (!saved) {
        const toolbar = await getWorkspaceToolbarSnapshot(page);
        throw new Error(`Active workspace save did not commit: ${JSON.stringify({
            called: workspaceSave.called,
            value: workspaceSave.value,
            toolbar,
        })}`);
    }

    const event = await waitForAutomationEvent(page, 'save-committed', {
        afterEventId: saveBaselineEventId,
        timeoutMs,
    });
    if (!event) {
        throw new Error('Active workspace save completed without a save-committed event');
    }
    return event;
}

/**
 * Saves through the enabled visible toolbar control and requires the product's
 * save-committed event. There is deliberately no workspace-command fallback.
 */
export interface ISaveViaVisibleToolbarOptions {signal?: AbortSignal;}

function throwIfAborted(signal: AbortSignal | undefined) {
    if (!signal?.aborted) {
        return;
    }
    throw signal.reason ?? new Error('Visible toolbar save was aborted');
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined) {
    if (!signal) {
        return promise;
    }
    throwIfAborted(signal);
    let handleAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
        handleAbort = () => reject(signal.reason ?? new Error('Visible toolbar save was aborted'));
        signal.addEventListener('abort', handleAbort, {once: true});
    });
    try {
        return await Promise.race([
            promise,
            aborted,
        ]);
    } finally {
        if (handleAbort) {
            signal.removeEventListener('abort', handleAbort);
        }
    }
}

export async function saveViaVisibleToolbar(
    page: Page,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    expectedPath?: string,
    options: ISaveViaVisibleToolbarOptions = {},
) {
    const {signal} = options;
    throwIfAborted(signal);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        throwIfAborted(signal);
        const buttons = await page.$$('button[aria-label="Save"], button[aria-label^="Save ("]');
        for (const button of buttons) {
            throwIfAborted(signal);
            const enabled = await button.evaluate((candidate) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    !candidate.hasAttribute('disabled')
                    && candidate.getAttribute('aria-disabled') !== 'true'
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                    && rect.width > 0
                    && rect.height > 0
                );
            });
            if (!enabled) {
                continue;
            }

            throwIfAborted(signal);
            const baselineEventId = await getLatestAutomationEventId(page);
            await button.click();
            const event = await awaitWithAbort(
                waitForAutomationEvent(page, 'save-committed', {
                    afterEventId: baselineEventId,
                    ...(expectedPath ? {path: expectedPath} : {}),
                    timeoutMs,
                }),
                signal,
            );
            if (!event) {
                throw new Error('Visible Save completed without a save-committed event');
            }
            return event;
        }
        await delay(50);
    }

    throw new Error('Visible Save button did not become enabled');
}

export interface ISaveViaVisibleToolbarDeadlineOptions extends IElectronE2EDeadlineOptions {label?: string;}

export function saveViaVisibleToolbarWithDeadline(
    page: Page,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    expectedPath?: string,
    options: ISaveViaVisibleToolbarDeadlineOptions = {},
) {
    const {
        label = 'Visible toolbar save',
        ...deadlineOptions
    } = options;
    return runWithElectronE2EDeadline(
        label,
        timeoutMs,
        signal => saveViaVisibleToolbar(page, timeoutMs, expectedPath, {signal}),
        deadlineOptions,
    );
}
