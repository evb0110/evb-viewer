import type { Page } from 'puppeteer-core';
import { expect } from 'vitest';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {openDocumentSidebarTab} from '@tests/e2e/electron/helpers/viewerCore';

export type TSplitPaneCloseDocumentKind = 'pdf' | 'djvu';

export interface ISplitPaneCloseContinuityResult {
    anchorDriftFrames: number;
    blankFrames: number;
    blankFramesByPhase: Record<string, number>;
    blankSamples: unknown[];
    disconnectedDocumentFrames: number;
    disconnectedHostFrames: number;
    disconnectedPaneFrames: number;
    disconnectedTabFrames: number;
    documentSurfaceChangedFrames: number;
    expectedPageNumber: number;
    finalAnchorRatio: number;
    finalPageNumber: number | null;
    finalReadyVisiblePageCount: number;
    loadingFrames: number;
    maxAnchorDrift: number;
    newTabFrames: number;
    pageChangedFrames: number;
    pageChangedFramesByPhase: Record<string, number>;
    sampleCount: number;
    sourcePaneId: string;
    sourceTabId: string;
    sourceTabTitle: string;
    thumbnailBlankFrames: number;
    thumbnailDisconnectedFrames: number;
    thumbnailFinalPageNumber: number | null;
    thumbnailInitialPageNumber: number;
    thumbnailInitialScrollTop: number;
    thumbnailPageChangedFrames: number;
    thumbnailScrollResetFrames: number;
    thumbnailSurfaceChangedFrames: number;
}

interface IProbeInstallResult {
    installed: boolean;
    reason: string;
    sourcePaneId: string;
}

const CONTINUITY_TIMEOUT_MS = 30_000;
const ANCHOR_RATIO_TOLERANCE = 0.2;

async function prepareThumbnailRail(
    page: Page,
    documentKind: TSplitPaneCloseDocumentKind,
    targetPageNumber: number,
) {
    await openDocumentSidebarTab(page, 'Pages', CONTINUITY_TIMEOUT_MS);
    await page.waitForFunction((payload: {
        documentKind: TSplitPaneCloseDocumentKind;
        targetPageNumber: number;
    }) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const root = payload.documentKind === 'pdf'
            ? host?.querySelector<HTMLElement>('.pdf-sidebar-pages-thumbnails .pdf-thumbnails') ?? null
            : host?.querySelector<HTMLElement>('[data-testid="document-thumbnail-list"]') ?? null;
        if (!root || root.clientHeight <= 0) {
            return false;
        }
        const item = payload.documentKind === 'pdf'
            ? root.querySelector<HTMLElement>(`.pdf-thumbnail[data-page="${String(payload.targetPageNumber)}"]`)
            : root.querySelector<HTMLElement>(`[data-thumbnail-page="${String(payload.targetPageNumber)}"]`);
        if (!item) {
            // A virtualized rail only mounts items near the scroll position, so
            // sweep until the target page mounts instead of waiting forever.
            const step = Math.max(64, root.clientHeight * 0.8);
            const atEnd = root.scrollTop + root.clientHeight >= root.scrollHeight - 1;
            root.scrollTop = atEnd ? 0 : root.scrollTop + step;
            root.dispatchEvent(new Event('scroll', {bubbles: true}));
            return false;
        }
        const rootRect = root.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        const centerDelta = itemRect.top
            + (itemRect.height / 2)
            - rootRect.top
            - (rootRect.height / 2);
        if (Math.abs(centerDelta) > 1) {
            root.scrollTop += centerDelta;
            root.dispatchEvent(new Event('scroll', {bubbles: true}));
            return false;
        }
        const canvas = item.querySelector<HTMLCanvasElement>('canvas');
        const image = item.querySelector<HTMLImageElement>('img');
        const visible = Math.min(rootRect.bottom, itemRect.bottom) - Math.max(rootRect.top, itemRect.top) > 8;
        return visible && Boolean(
            (canvas && canvas.width > 0 && canvas.height > 0)
            || (image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0),
        );
    }, {timeout: CONTINUITY_TIMEOUT_MS}, {
        documentKind,
        targetPageNumber,
    });

    // A ResizeObserver delivery can follow the first centered-ready result
    // when the page track finishes settling. Recheck after two painted frames
    // so the target pixels are ready before centerTargetPage performs its one
    // calculated document scroll. Semantic page navigation may leave the page
    // far outside the viewport until that scroll, so readiness must not require
    // physical centering here.
    await page.evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await page.waitForFunction((payload: {
        documentKind: TSplitPaneCloseDocumentKind;
        targetPageNumber: number;
    }) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const surface = payload.documentKind === 'pdf'
            ? host?.querySelector<HTMLElement>('#pdf-viewer') ?? null
            : host?.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]') ?? null;
        const viewport = payload.documentKind === 'pdf'
            ? surface
            : surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]') ?? null;
        const pageElement = surface?.querySelector<HTMLElement>(
            payload.documentKind === 'pdf'
                ? `.page_container[data-page="${String(payload.targetPageNumber)}"]`
                : `[data-testid="document-page-source-page"][data-page-number="${String(payload.targetPageNumber)}"]`,
        ) ?? null;
        if (!viewport || !pageElement) {
            return false;
        }
        const canvas = payload.documentKind === 'pdf'
            ? pageElement.querySelector<HTMLCanvasElement>('.page_canvas canvas, canvas')
            : null;
        const image = payload.documentKind === 'djvu'
            ? pageElement.querySelector<HTMLImageElement>('[data-testid="document-page-source-image"]')
            : null;
        return Boolean(
            (canvas && canvas.width > 0 && canvas.height > 0)
            || (image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0),
        );
    }, {timeout: CONTINUITY_TIMEOUT_MS}, {
        documentKind,
        targetPageNumber,
    });
}

async function centerTargetPage(
    page: Page,
    documentKind: TSplitPaneCloseDocumentKind,
    targetPageNumber: number,
) {
    await page.waitForFunction((payload: {
        documentKind: TSplitPaneCloseDocumentKind;
        targetPageNumber: number;
    }) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const pageSelector = payload.documentKind === 'pdf'
            ? `.page_container[data-page="${String(payload.targetPageNumber)}"]`
            : `[data-testid="document-page-source-page"][data-page-number="${String(payload.targetPageNumber)}"]`;
        const pageElement = host?.querySelector<HTMLElement>(pageSelector) ?? null;
        if (!pageElement) {
            return false;
        }
        if (payload.documentKind === 'pdf') {
            const canvas = pageElement.querySelector<HTMLCanvasElement>('.page_canvas canvas, canvas');
            return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
        }
        const image = pageElement.querySelector<HTMLImageElement>('[data-testid="document-page-source-image"]');
        return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
    }, {timeout: CONTINUITY_TIMEOUT_MS}, {
        documentKind,
        targetPageNumber,
    });

    const centered = await page.evaluate((payload: {
        documentKind: TSplitPaneCloseDocumentKind;
        targetPageNumber: number;
    }) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const surface = payload.documentKind === 'pdf'
            ? host?.querySelector<HTMLElement>('#pdf-viewer') ?? null
            : host?.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]') ?? null;
        const viewport = payload.documentKind === 'pdf'
            ? surface
            : surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]') ?? null;
        const pageSelector = payload.documentKind === 'pdf'
            ? `.page_container[data-page="${String(payload.targetPageNumber)}"]`
            : `[data-testid="document-page-source-page"][data-page-number="${String(payload.targetPageNumber)}"]`;
        const pageElement = surface?.querySelector<HTMLElement>(pageSelector) ?? null;
        if (!viewport || !pageElement) {
            return false;
        }

        const viewportRect = viewport.getBoundingClientRect();
        const pageRect = pageElement.getBoundingClientRect();
        viewport.scrollTop += (
            pageRect.top
            + (pageRect.height / 2)
            - viewportRect.top
            - (viewportRect.height / 2)
        );
        viewport.dispatchEvent(new Event('scroll', {bubbles: true}));
        return true;
    }, {
        documentKind,
        targetPageNumber,
    });
    if (!centered) {
        throw new Error(`Could not center ${documentKind} page ${String(targetPageNumber)}`);
    }

    await page.evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await page.waitForFunction((payload: {
        documentKind: TSplitPaneCloseDocumentKind;
        targetPageNumber: number;
    }) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const surface = payload.documentKind === 'pdf'
            ? host?.querySelector<HTMLElement>('#pdf-viewer') ?? null
            : host?.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]') ?? null;
        const viewport = payload.documentKind === 'pdf'
            ? surface
            : surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]') ?? null;
        const pageElement = surface?.querySelector<HTMLElement>(
            payload.documentKind === 'pdf'
                ? `.page_container[data-page="${String(payload.targetPageNumber)}"]`
                : `[data-testid="document-page-source-page"][data-page-number="${String(payload.targetPageNumber)}"]`,
        ) ?? null;
        if (!viewport || !pageElement) {
            return false;
        }
        const viewportRect = viewport.getBoundingClientRect();
        const pageRect = pageElement.getBoundingClientRect();
        const centerY = viewportRect.top + (viewportRect.height / 2);
        const canvas = payload.documentKind === 'pdf'
            ? pageElement.querySelector<HTMLCanvasElement>('.page_canvas canvas, canvas')
            : null;
        const image = payload.documentKind === 'djvu'
            ? pageElement.querySelector<HTMLImageElement>('[data-testid="document-page-source-image"]')
            : null;
        return pageRect.top <= centerY
            && pageRect.bottom >= centerY
            && Boolean(
                (canvas && canvas.width > 0 && canvas.height > 0)
                || (image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0),
            );
    }, {timeout: CONTINUITY_TIMEOUT_MS}, {
        documentKind,
        targetPageNumber,
    });
}

async function installContinuityProbe(
    page: Page,
    documentKind: TSplitPaneCloseDocumentKind,
    expectedPageNumber: number,
): Promise<IProbeInstallResult> {
    return page.evaluate((payload: {
        documentKind: TSplitPaneCloseDocumentKind;
        expectedPageNumber: number;
        anchorRatioTolerance: number;
    }) => {
        interface IAnchorSnapshot {
            pageNumber: number | null;
            pageRatio: number;
            readyVisiblePageCount: number;
        }
        interface IThumbnailSnapshot {
            pageNumber: number | null;
            readyVisiblePageCount: number;
            scrollTop: number;
        }
        interface IContinuityProbe extends ISplitPaneCloseContinuityResult {
            expectedAnchorRatio: number;
            frameId: number;
            previousCanvasByPage: Map<string, HTMLCanvasElement | null>;
            sample: (scheduleNextFrame: boolean) => void;
            sourceDocumentSurface: HTMLElement;
            sourceHost: HTMLElement;
            sourcePane: HTMLElement;
            sourceTab: HTMLElement;
            sourceThumbnailSurface: HTMLElement;
            phase: string;
            timerId: number;
        }
        type TProbeWindow = Window & {__splitPaneCloseContinuityProbe?: IContinuityProbe};

        const sourcePane = document.querySelector<HTMLElement>('.editor-pane.is-active');
        const sourceHost = sourcePane?.querySelector<HTMLElement>('.workspace-host') ?? null;
        const sourceTab = sourcePane?.querySelector<HTMLElement>('.tab.is-active[data-tab-id]') ?? null;
        const sourceDocumentSurface = payload.documentKind === 'pdf'
            ? sourceHost?.querySelector<HTMLElement>('#pdf-viewer') ?? null
            : sourceHost?.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]') ?? null;
        const sourceThumbnailSurface = payload.documentKind === 'pdf'
            ? sourceHost?.querySelector<HTMLElement>('.pdf-sidebar-pages-thumbnails .pdf-thumbnails') ?? null
            : sourceHost?.querySelector<HTMLElement>('[data-testid="document-thumbnail-list"]') ?? null;
        const sourcePaneId = sourcePane?.dataset.editorPaneId ?? '';
        const sourceTabId = sourceTab?.dataset.tabId ?? '';
        const sourceTabTitle = sourceTab?.textContent?.trim() ?? '';

        if (!sourcePane || !sourceHost || !sourceTab || !sourceDocumentSurface || !sourceThumbnailSurface) {
            return {
                installed: false,
                reason: 'Source pane, tab, host, document surface, or thumbnail rail was unavailable',
                sourcePaneId,
            };
        }
        if (!sourcePaneId || !sourceTabId || sourceTabTitle.includes('New Tab')) {
            return {
                installed: false,
                reason: 'Source pane/tab identity was incomplete or already empty',
                sourcePaneId,
            };
        }

        const readAnchor = (): IAnchorSnapshot => {
            const viewport = payload.documentKind === 'pdf'
                ? sourceDocumentSurface
                : sourceDocumentSurface.closest<HTMLElement>('[data-document-viewer-chassis-viewport]');
            const pageSelector = payload.documentKind === 'pdf'
                ? '.page_container[data-page]'
                : '[data-testid="document-page-source-page"][data-page-number]';
            const viewportRect = viewport?.getBoundingClientRect() ?? null;
            const pages = Array.from(sourceDocumentSurface.querySelectorAll<HTMLElement>(pageSelector));
            const visiblePages = viewportRect
                ? pages.filter((pageElement) => {
                    const rect = pageElement.getBoundingClientRect();
                    return Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top) > 8;
                })
                : [];
            const centerY = viewportRect ? viewportRect.top + (viewportRect.height / 2) : 0;
            const anchorPage = visiblePages.find((pageElement) => {
                const rect = pageElement.getBoundingClientRect();
                return rect.top <= centerY && rect.bottom >= centerY;
            }) ?? null;
            const anchorRect = anchorPage?.getBoundingClientRect() ?? null;
            const readyVisiblePageCount = visiblePages.filter((pageElement) => {
                if (payload.documentKind === 'pdf') {
                    const canvas = pageElement.querySelector<HTMLCanvasElement>('.page_canvas canvas, canvas');
                    return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
                }
                const image = pageElement.querySelector<HTMLImageElement>('[data-testid="document-page-source-image"]');
                return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
            }).length;

            return {
                pageNumber: anchorPage
                    ? Number.parseInt(
                        payload.documentKind === 'pdf'
                            ? anchorPage.dataset.page ?? ''
                            : anchorPage.dataset.pageNumber ?? '',
                        10,
                    ) || null
                    : null,
                pageRatio: anchorRect && anchorRect.height > 0
                    ? (centerY - anchorRect.top) / anchorRect.height
                    : 0,
                readyVisiblePageCount,
            };
        };

        const readThumbnailAnchor = (): IThumbnailSnapshot => {
            const itemSelector = payload.documentKind === 'pdf'
                ? '.pdf-thumbnail[data-page]'
                : '[data-thumbnail-page]';
            const viewportRect = sourceThumbnailSurface.getBoundingClientRect();
            const visibleItems = Array.from(
                sourceThumbnailSurface.querySelectorAll<HTMLElement>(itemSelector),
            ).filter((item) => {
                const rect = item.getBoundingClientRect();
                return Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top) > 8;
            });
            const centerY = viewportRect.top + (viewportRect.height / 2);
            const anchorItem = visibleItems.find((item) => {
                const rect = item.getBoundingClientRect();
                return rect.top <= centerY && rect.bottom >= centerY;
            }) ?? visibleItems[0] ?? null;
            const readyVisiblePageCount = visibleItems.filter((item) => {
                const canvas = item.querySelector<HTMLCanvasElement>('canvas');
                const image = item.querySelector<HTMLImageElement>('img');
                return Boolean(
                    (canvas && canvas.width > 0 && canvas.height > 0)
                    || (image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0),
                );
            }).length;
            return {
                pageNumber: anchorItem
                    ? Number.parseInt(
                        payload.documentKind === 'pdf'
                            ? anchorItem.dataset.page ?? ''
                            : anchorItem.dataset.thumbnailPage ?? '',
                        10,
                    ) || null
                    : null,
                readyVisiblePageCount,
                scrollTop: sourceThumbnailSurface.scrollTop,
            };
        };

        const initialAnchor = readAnchor();
        const initialThumbnailAnchor = readThumbnailAnchor();
        if (
            initialAnchor.pageNumber !== payload.expectedPageNumber
            || initialAnchor.readyVisiblePageCount === 0
            || initialThumbnailAnchor.pageNumber === null
            || initialThumbnailAnchor.readyVisiblePageCount === 0
        ) {
            return {
                installed: false,
                reason: `Initial page anchor was ${String(initialAnchor.pageNumber)} (${String(initialAnchor.readyVisiblePageCount)} ready); thumbnail anchor was ${String(initialThumbnailAnchor.pageNumber)} (${String(initialThumbnailAnchor.readyVisiblePageCount)} ready)`,
                sourcePaneId,
            };
        }

        const probe: IContinuityProbe = {
            anchorDriftFrames: 0,
            blankFrames: 0,
            blankFramesByPhase: {},
            blankSamples: [],
            disconnectedDocumentFrames: 0,
            disconnectedHostFrames: 0,
            disconnectedPaneFrames: 0,
            disconnectedTabFrames: 0,
            documentSurfaceChangedFrames: 0,
            expectedAnchorRatio: initialAnchor.pageRatio,
            expectedPageNumber: payload.expectedPageNumber,
            finalAnchorRatio: initialAnchor.pageRatio,
            finalPageNumber: initialAnchor.pageNumber,
            finalReadyVisiblePageCount: initialAnchor.readyVisiblePageCount,
            frameId: 0,
            loadingFrames: 0,
            maxAnchorDrift: 0,
            previousCanvasByPage: new Map<string, HTMLCanvasElement | null>(),
            newTabFrames: 0,
            pageChangedFrames: 0,
            pageChangedFramesByPhase: {},
            phase: 'before-split',
            sample: () => {},
            sampleCount: 0,
            sourceDocumentSurface,
            sourceHost,
            sourcePane,
            sourcePaneId,
            sourceTab,
            sourceTabId,
            sourceTabTitle,
            sourceThumbnailSurface,
            thumbnailBlankFrames: 0,
            thumbnailDisconnectedFrames: 0,
            thumbnailFinalPageNumber: initialThumbnailAnchor.pageNumber,
            thumbnailInitialPageNumber: initialThumbnailAnchor.pageNumber,
            thumbnailInitialScrollTop: initialThumbnailAnchor.scrollTop,
            thumbnailPageChangedFrames: 0,
            thumbnailScrollResetFrames: 0,
            thumbnailSurfaceChangedFrames: 0,
            timerId: 0,
        };

        probe.sample = (scheduleNextFrame: boolean) => {
            probe.sampleCount += 1;
            const currentPane = Array.from(document.querySelectorAll<HTMLElement>('.editor-pane'))
                .find(candidate => candidate.dataset.editorPaneId === sourcePaneId) ?? null;
            const currentHost = currentPane?.querySelector<HTMLElement>('.workspace-host') ?? null;
            const currentTab = currentPane?.querySelector<HTMLElement>(`.tab[data-tab-id="${CSS.escape(sourceTabId)}"]`) ?? null;
            const currentDocumentSurface = payload.documentKind === 'pdf'
                ? currentHost?.querySelector<HTMLElement>('#pdf-viewer') ?? null
                : currentHost?.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]') ?? null;
            const currentThumbnailSurface = payload.documentKind === 'pdf'
                ? currentHost?.querySelector<HTMLElement>('.pdf-sidebar-pages-thumbnails .pdf-thumbnails') ?? null
                : currentHost?.querySelector<HTMLElement>('[data-testid="document-thumbnail-list"]') ?? null;
            const anchor = readAnchor();
            const thumbnailAnchor = readThumbnailAnchor();
            const anchorDrift = Math.abs(anchor.pageRatio - probe.expectedAnchorRatio);
            const banner = sourceHost.querySelector<HTMLElement>('.djvu-banner');
            const hasLoadingState = Boolean(
                sourceHost.querySelector([
                    '.workspace-host__loading',
                    '.document-viewer-chassis__opening-page',
                    '.pdf-loading',
                    '.pdf-loading-overlay',
                    '[data-loading="true"]',
                    '[data-error="true"]',
                ].join(','))
                || banner?.getAttribute('aria-busy') === 'true'
                || banner?.textContent?.includes('Opening DjVu'),
            );

            probe.disconnectedPaneFrames += Number(!sourcePane.isConnected || currentPane !== sourcePane);
            probe.disconnectedHostFrames += Number(!sourceHost.isConnected || currentHost !== sourceHost);
            probe.disconnectedTabFrames += Number(!sourceTab.isConnected || currentTab !== sourceTab);
            probe.disconnectedDocumentFrames += Number(!sourceDocumentSurface.isConnected);
            probe.documentSurfaceChangedFrames += Number(currentDocumentSurface !== sourceDocumentSurface);
            probe.thumbnailDisconnectedFrames += Number(!sourceThumbnailSurface.isConnected);
            probe.thumbnailSurfaceChangedFrames += Number(currentThumbnailSurface !== sourceThumbnailSurface);
            probe.thumbnailBlankFrames += Number(thumbnailAnchor.readyVisiblePageCount === 0);
            probe.thumbnailPageChangedFrames += Number(
                thumbnailAnchor.pageNumber !== probe.thumbnailInitialPageNumber,
            );
            probe.thumbnailScrollResetFrames += Number(
                probe.thumbnailInitialScrollTop >= 1 && thumbnailAnchor.scrollTop < 1,
            );
            probe.thumbnailFinalPageNumber = thumbnailAnchor.pageNumber;
            probe.newTabFrames += Number(sourceTab.textContent?.includes('New Tab') ?? false);
            probe.loadingFrames += Number(hasLoadingState);
            probe.blankFrames += Number(anchor.readyVisiblePageCount === 0);
            probe.pageChangedFrames += Number(anchor.pageNumber !== payload.expectedPageNumber);
            if (anchor.readyVisiblePageCount === 0) {
                probe.blankFramesByPhase[probe.phase] = (probe.blankFramesByPhase[probe.phase] ?? 0) + 1;
                if (probe.blankSamples.length < 10) {
                    const viewport = payload.documentKind === 'pdf'
                        ? sourceDocumentSurface
                        : sourceDocumentSurface.closest<HTMLElement>('[data-document-viewer-chassis-viewport]');
                    probe.blankSamples.push({
                        phase: probe.phase,
                        chassis: (() => {
                            const element = sourceDocumentSurface.closest<HTMLElement>(
                                '.document-viewer-chassis',
                            );
                            return {
                                anchorPage: element?.dataset.chassisResizeAnchorPage ?? '',
                                resizing: element?.dataset.chassisResizing ?? '',
                            };
                        })(),
                        viewport: viewport ? {
                            clientHeight: viewport.clientHeight,
                            scrollHeight: viewport.scrollHeight,
                            scrollTop: viewport.scrollTop,
                        } : null,
                        pages: Array.from(sourceDocumentSurface.querySelectorAll<HTMLElement>(
                            payload.documentKind === 'pdf'
                                ? '.page_container[data-page]'
                                : '[data-testid="document-page-source-page"][data-page-number]',
                        )).slice(0, 20).map((element) => {
                            const pageKey = element.dataset.page ?? element.dataset.pageNumber ?? '';
                            const canvas = element.querySelector<HTMLCanvasElement>(
                                '.page_canvas canvas, canvas',
                            );
                            const canvasStyle = canvas ? getComputedStyle(canvas) : null;
                            const previousCanvas = probe.previousCanvasByPage.get(pageKey) ?? null;
                            return {
                                page: pageKey,
                                display: getComputedStyle(element).display,
                                renderStateClass: element.className,
                                canvasExists: Boolean(canvas),
                                canvasWidth: canvas?.width ?? 0,
                                canvasHeight: canvas?.height ?? 0,
                                canvasVisibility: canvasStyle?.visibility ?? '',
                                canvasDisplay: canvasStyle?.display ?? '',
                                canvasOpacity: canvasStyle?.opacity ?? '',
                                sameCanvasAsPrevious: canvas !== null && canvas === previousCanvas,
                                canvasWasPresentPreviousFrame: previousCanvas !== null,
                                rect: {
                                    height: element.getBoundingClientRect().height,
                                    top: element.getBoundingClientRect().top,
                                },
                            };
                        }),
                    });
                }
            }
            if (anchor.pageNumber !== payload.expectedPageNumber) {
                probe.pageChangedFramesByPhase[probe.phase] = (probe.pageChangedFramesByPhase[probe.phase] ?? 0) + 1;
            }
            probe.anchorDriftFrames += Number(anchorDrift > payload.anchorRatioTolerance);
            probe.maxAnchorDrift = Math.max(probe.maxAnchorDrift, anchorDrift);
            probe.finalAnchorRatio = anchor.pageRatio;
            probe.finalPageNumber = anchor.pageNumber;
            probe.finalReadyVisiblePageCount = anchor.readyVisiblePageCount;

            probe.previousCanvasByPage.clear();
            for (const element of Array.from(sourceDocumentSurface.querySelectorAll<HTMLElement>(
                payload.documentKind === 'pdf'
                    ? '.page_container[data-page]'
                    : '[data-testid="document-page-source-page"][data-page-number]',
            ))) {
                const pageKey = element.dataset.page ?? element.dataset.pageNumber ?? '';
                probe.previousCanvasByPage.set(
                    pageKey,
                    element.querySelector<HTMLCanvasElement>('.page_canvas canvas, canvas'),
                );
            }

            if (scheduleNextFrame) {
                // rAF callbacks run before paint and may observe the transient
                // layout before a later ResizeObserver-owned rAF restores the
                // semantic anchor in the same rendering opportunity. Sample
                // after that paint boundary so a counted blank corresponds to
                // pixels a user could actually have seen.
                probe.frameId = requestAnimationFrame(() => {
                    probe.timerId = window.setTimeout(() => probe.sample(true), 0);
                });
            }
        };

        (window as TProbeWindow).__splitPaneCloseContinuityProbe = probe;
        probe.sample(true);
        return {
            installed: true,
            reason: '',
            sourcePaneId,
        };
    }, {
        documentKind,
        expectedPageNumber,
        anchorRatioTolerance: ANCHOR_RATIO_TOLERANCE,
    });
}

async function splitAndCloseEmptyRightPane(page: Page, sourcePaneId: string) {
    await page.evaluate(() => {
        const probe = (window as Window & {__splitPaneCloseContinuityProbe?: {phase: string}})
            .__splitPaneCloseContinuityProbe;
        if (probe) probe.phase = 'split';
    });
    const split = await page.evaluate(async () => {
        interface ISplitWindow extends Window { __splitEditorEmptyForE2E?: (direction: 'right') => Promise<void> | void; }
        const splitEditor = (window as ISplitWindow).__splitEditorEmptyForE2E;
        if (typeof splitEditor !== 'function') {
            return false;
        }
        await splitEditor('right');
        return true;
    });
    if (!split) {
        throw new Error('Empty split automation hook was unavailable');
    }
    await page.waitForFunction(
        () => document.querySelectorAll('.editor-pane').length === 2,
        {timeout: CONTINUITY_TIMEOUT_MS},
    );

    await page.evaluate(() => {
        const probe = (window as Window & {__splitPaneCloseContinuityProbe?: {phase: string}})
            .__splitPaneCloseContinuityProbe;
        if (probe) probe.phase = 'close';
    });

    const closeResult = await page.evaluate((retainedPaneId: string) => {
        const activePane = document.querySelector<HTMLElement>('.editor-pane.is-active');
        const activePaneId = activePane?.dataset.editorPaneId ?? '';
        const activeTabTitle = activePane?.querySelector<HTMLElement>('.tab.is-active')?.textContent?.trim() ?? '';
        const closeButton = activePane?.querySelector<HTMLButtonElement>('.tab.is-active .tab-close') ?? null;
        if (!activePane || activePaneId === retainedPaneId || !closeButton) {
            return {
                activePaneId,
                activeTabTitle,
                closed: false,
            };
        }
        return {
            activePaneId,
            activeTabTitle,
            closed: true,
        };
    }, sourcePaneId);
    if (!closeResult.closed) {
        throw new Error(`Could not close empty split pane (${JSON.stringify(closeResult)})`);
    }
    if (!closeResult.activeTabTitle.includes('New Tab')) {
        throw new Error(`Split target was not empty: '${closeResult.activeTabTitle}'`);
    }
    // Use Puppeteer's mouse path so this covers the same pointer-driven tab
    // close that a user performs. The DOM probe above only validates that the
    // active pane is the empty split target before the click.
    await page.click('.editor-pane.is-active .tab.is-active .tab-close');

    await page.waitForFunction(
        () => document.querySelectorAll('.editor-pane').length === 1,
        {timeout: CONTINUITY_TIMEOUT_MS},
    );
    await page.evaluate(async () => {
        for (let frame = 0; frame < 12; frame += 1) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
    });
}

async function stopContinuityProbe(page: Page): Promise<ISplitPaneCloseContinuityResult> {
    return page.evaluate(() => {
        interface IContinuityProbe extends ISplitPaneCloseContinuityResult {
            expectedAnchorRatio: number;
            frameId: number;
            sample: (scheduleNextFrame: boolean) => void;
            sourceDocumentSurface: HTMLElement;
            sourceHost: HTMLElement;
            sourcePane: HTMLElement;
            sourceTab: HTMLElement;
            sourceThumbnailSurface: HTMLElement;
            phase: string;
            timerId: number;
        }
        type TProbeWindow = Window & {__splitPaneCloseContinuityProbe?: IContinuityProbe};
        const probeWindow = window as TProbeWindow;
        const probe = probeWindow.__splitPaneCloseContinuityProbe;
        if (!probe) {
            throw new Error('Split-pane close continuity probe was not installed');
        }
        cancelAnimationFrame(probe.frameId);
        clearTimeout(probe.timerId);
        probe.sample(false);
        delete probeWindow.__splitPaneCloseContinuityProbe;
        return {
            anchorDriftFrames: probe.anchorDriftFrames,
            blankFrames: probe.blankFrames,
            blankFramesByPhase: probe.blankFramesByPhase,
            blankSamples: probe.blankSamples,
            disconnectedDocumentFrames: probe.disconnectedDocumentFrames,
            disconnectedHostFrames: probe.disconnectedHostFrames,
            disconnectedPaneFrames: probe.disconnectedPaneFrames,
            disconnectedTabFrames: probe.disconnectedTabFrames,
            documentSurfaceChangedFrames: probe.documentSurfaceChangedFrames,
            expectedPageNumber: probe.expectedPageNumber,
            finalAnchorRatio: probe.finalAnchorRatio,
            finalPageNumber: probe.finalPageNumber,
            finalReadyVisiblePageCount: probe.finalReadyVisiblePageCount,
            loadingFrames: probe.loadingFrames,
            maxAnchorDrift: probe.maxAnchorDrift,
            newTabFrames: probe.newTabFrames,
            pageChangedFrames: probe.pageChangedFrames,
            pageChangedFramesByPhase: probe.pageChangedFramesByPhase,
            sampleCount: probe.sampleCount,
            sourcePaneId: probe.sourcePaneId,
            sourceTabId: probe.sourceTabId,
            sourceTabTitle: probe.sourceTabTitle,
            thumbnailBlankFrames: probe.thumbnailBlankFrames,
            thumbnailDisconnectedFrames: probe.thumbnailDisconnectedFrames,
            thumbnailFinalPageNumber: probe.thumbnailFinalPageNumber,
            thumbnailInitialPageNumber: probe.thumbnailInitialPageNumber,
            thumbnailInitialScrollTop: probe.thumbnailInitialScrollTop,
            thumbnailPageChangedFrames: probe.thumbnailPageChangedFrames,
            thumbnailScrollResetFrames: probe.thumbnailScrollResetFrames,
            thumbnailSurfaceChangedFrames: probe.thumbnailSurfaceChangedFrames,
        };
    });
}

export async function runSplitPaneCloseContinuity(
    session: IElectronE2ESession,
    options: {
        documentKind: TSplitPaneCloseDocumentKind;
        expectedPageNumber: number;
    },
) {
    await prepareThumbnailRail(session.page, options.documentKind, options.expectedPageNumber);
    await centerTargetPage(session.page, options.documentKind, options.expectedPageNumber);
    const installResult = await installContinuityProbe(
        session.page,
        options.documentKind,
        options.expectedPageNumber,
    );
    if (!installResult.installed) {
        throw new Error(`Could not install split-pane close continuity probe: ${installResult.reason}`);
    }

    try {
        await splitAndCloseEmptyRightPane(session.page, installResult.sourcePaneId);
        return await stopContinuityProbe(session.page);
    } catch (error) {
        await stopContinuityProbe(session.page).catch(() => null);
        throw error;
    }
}

export function expectSplitPaneCloseContinuity(result: ISplitPaneCloseContinuityResult) {
    const detail = JSON.stringify(result);

    expect(result.sampleCount, detail).toBeGreaterThan(10);
    expect(result.sourcePaneId, detail).not.toBe('');
    expect(result.sourceTabId, detail).not.toBe('');
    expect(result.sourceTabTitle, detail).not.toContain('New Tab');
    expect(result.disconnectedPaneFrames, detail).toBe(0);
    expect(result.disconnectedHostFrames, detail).toBe(0);
    expect(result.disconnectedTabFrames, detail).toBe(0);
    expect(result.disconnectedDocumentFrames, detail).toBe(0);
    expect(result.documentSurfaceChangedFrames, detail).toBe(0);
    expect(result.thumbnailDisconnectedFrames, detail).toBe(0);
    expect(result.thumbnailSurfaceChangedFrames, detail).toBe(0);
    expect(result.thumbnailBlankFrames, detail).toBe(0);
    expect(result.thumbnailPageChangedFrames, detail).toBe(0);
    expect(result.thumbnailScrollResetFrames, detail).toBe(0);
    expect(result.newTabFrames, detail).toBe(0);
    expect(result.loadingFrames, detail).toBe(0);
    expect(result.blankFrames, detail).toBe(0);
    expect(result.pageChangedFrames, detail).toBe(0);
    expect(result.anchorDriftFrames, detail).toBe(0);
    expect(result.maxAnchorDrift, detail).toBeLessThanOrEqual(ANCHOR_RATIO_TOLERANCE);
    expect(result.finalPageNumber, detail).toBe(result.expectedPageNumber);
    expect(result.finalReadyVisiblePageCount, detail).toBeGreaterThan(0);
    expect(result.thumbnailFinalPageNumber, detail).toBe(result.thumbnailInitialPageNumber);
}
