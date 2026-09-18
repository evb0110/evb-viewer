import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createSearchMatchScrollFixturePdf,
    SEARCH_MATCH_SCROLL_FIXTURE_PAGE_COUNT,
    SEARCH_MATCH_SCROLL_FIXTURE_QUERY,
    SEARCH_MATCH_SCROLL_FIXTURE_TARGET_MATCH,
    SEARCH_MATCH_SCROLL_FIXTURE_TARGET_PAGE,
} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    ensureSidebarOpen,
    openDocumentSidebarTab,
    openPdfInApp,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {enablePdfDiagnosticSession} from '@tests/e2e/electron/helpers/pdfDiagnosticSession';
import {
    callWorkspaceCommand,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    countWarmHighlightPixels,
    countOrangeHighlightPixelsInFrame,
    startSearchHighlightPaintCapture,
    writeSearchHighlightPaintEvidence,
} from '@tests/e2e/electron/helpers/searchHighlightPaint';

const SEARCH_MATCH_SCROLL_TIMEOUT_MS = 240_000;
const SEARCH_MATCH_PAINT_TIMEOUT_MS = 5_000;
const SEARCH_RESULT_LIST_EDGE_TOLERANCE_PX = 8;
const defaultSearchMatchScrollResultCount = SEARCH_MATCH_SCROLL_FIXTURE_PAGE_COUNT - 1 + 4;
const suppliedSearchMatchScrollPdf = process.env.EVB_SEARCH_SCROLL_PDF;

function readPositiveIntegerEnv(name: string, fallback: number) {
    const rawValue = process.env[name];
    if (rawValue === undefined) {
        return fallback;
    }
    const value = Number(rawValue);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

function readPositiveNumberEnv(name: string, fallback: number) {
    const rawValue = process.env[name];
    if (rawValue === undefined) {
        return fallback;
    }
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive number`);
    }
    return value;
}

function normalizeMatchText(value: string) {
    return value.normalize('NFC').replaceAll(/\s+/g, ' ').trim().toLocaleLowerCase();
}

const searchMatchScrollConfig = {
    applyBudgetMs: readPositiveNumberEnv(
        'EVB_SEARCH_SCROLL_APPLY_BUDGET_MS',
        suppliedSearchMatchScrollPdf ? 2_000 : 1_500,
    ),
    expectedResultCount: readPositiveIntegerEnv(
        'EVB_SEARCH_SCROLL_RESULT_COUNT',
        suppliedSearchMatchScrollPdf ? 25 : defaultSearchMatchScrollResultCount,
    ),
    fixturePath: suppliedSearchMatchScrollPdf,
    query: process.env.EVB_SEARCH_SCROLL_QUERY
        ?? (suppliedSearchMatchScrollPdf ? 'lezgian' : SEARCH_MATCH_SCROLL_FIXTURE_QUERY),
    targetGroup: process.env.EVB_SEARCH_SCROLL_TARGET_GROUP
        ?? String(suppliedSearchMatchScrollPdf ? 369 : SEARCH_MATCH_SCROLL_FIXTURE_TARGET_PAGE),
    targetMatch: readPositiveIntegerEnv(
        'EVB_SEARCH_SCROLL_TARGET_MATCH',
        suppliedSearchMatchScrollPdf ? 1 : SEARCH_MATCH_SCROLL_FIXTURE_TARGET_MATCH,
    ),
    targetViewerPage: readPositiveIntegerEnv(
        'EVB_SEARCH_SCROLL_TARGET_PAGE',
        suppliedSearchMatchScrollPdf ? 369 : SEARCH_MATCH_SCROLL_FIXTURE_TARGET_PAGE,
    ),
    zoom: readPositiveNumberEnv(
        'EVB_SEARCH_SCROLL_ZOOM',
        suppliedSearchMatchScrollPdf ? 2.84 : 3.8,
    ),
};

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: () => `e2e-search-match-scroll-${Date.now()}`,
    timeoutMs: 300_000,
});

describe('Electron E2E - PDF search match scrolling', () => {
    it('keeps the final result visible and centers its match after a high-zoom xlarge search', async () => {
        const session = sessionFixture.getSession();

        const fixturePath = searchMatchScrollConfig.fixturePath
            ?? await createSearchMatchScrollFixturePdf(`search-match-scroll-${Date.now()}.pdf`);
        await session.page.setViewport({
            deviceScaleFactor: 1,
            height: 900,
            width: 1_440,
        });
        await openPdfInApp(session.page, fixturePath, SEARCH_MATCH_SCROLL_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, SEARCH_MATCH_SCROLL_TIMEOUT_MS);
        await enablePdfDiagnosticSession(session.page, {
            navigation: true,
            render: true,
        });
        await ensureSidebarOpen(session.page);
        await openDocumentSidebarTab(session.page, 'Search');

        const searchInput = await session.page.$(
            '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-bar input',
        );
        expect(searchInput).not.toBeNull();
        await searchInput!.type(searchMatchScrollConfig.query);
        const searchStarted = await session.page.evaluate(() => {
            const button = document.querySelector<HTMLButtonElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .search-run-button',
            );
            if (!button || button.disabled) {
                return false;
            }
            button.click();
            return true;
        });
        expect(searchStarted).toBe(true);

        await waitForFunctionInPage(session.page, (expectedCount: number) => {
            const summary = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-results-header-summary',
            );
            const spinner = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-results-spinner',
            );
            return Boolean(
                summary?.textContent?.trim().startsWith(`${expectedCount} results`)
                && !spinner,
            );
        }, {timeout: SEARCH_MATCH_SCROLL_TIMEOUT_MS}, searchMatchScrollConfig.expectedResultCount);

        const zoomResult = await callWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [searchMatchScrollConfig.zoom]);
        expect(zoomResult.called).toBe(true);
        await waitForWorkspaceToolbarSnapshot(session.page, {
            hasPdf: true,
            minEffectiveZoom: searchMatchScrollConfig.zoom * 0.98,
        }, {timeoutMs: SEARCH_MATCH_SCROLL_TIMEOUT_MS});

        const collapsedGroupAtListBottom = await session.page.evaluate(async (targetGroup: string) => {
            const list = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-results-list',
            );
            if (!list) {
                throw new Error('Search results list was not found');
            }
            const findGroup = () => Array.from(list.querySelectorAll<HTMLElement>(
                '.document-search-results-group-toggle',
            )).find(group => group.dataset.pageNumber === targetGroup);
            const waitForVirtualRows = () => new Promise<void>(resolve => requestAnimationFrame(() => (
                requestAnimationFrame(() => resolve())
            )));
            const step = Math.max(36, Math.floor(list.clientHeight * 0.75));
            const findTargetGroup = async () => {
                const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
                for (let top = 0; top <= maxScrollTop; top += step) {
                    list.scrollTop = top;
                    list.dispatchEvent(new Event('scroll'));
                    await waitForVirtualRows();
                    const group = findGroup();
                    if (group) {
                        return group;
                    }
                }
                list.scrollTop = maxScrollTop;
                list.dispatchEvent(new Event('scroll'));
                await waitForVirtualRows();
                return findGroup() ?? null;
            };

            let group = await findTargetGroup();
            if (!group) {
                return null;
            }
            if (group.getAttribute('aria-expanded') === 'true') {
                group.click();
                await waitForVirtualRows();
                group = findGroup() ?? await findTargetGroup();
            }
            if (!group || group.getAttribute('aria-expanded') !== 'false') {
                return null;
            }

            const listRect = list.getBoundingClientRect();
            const groupRect = group.getBoundingClientRect();
            list.scrollTop = Math.min(
                Math.max(0, list.scrollHeight - list.clientHeight),
                Math.max(0, list.scrollTop + groupRect.bottom - listRect.bottom),
            );
            list.dispatchEvent(new Event('scroll'));
            await waitForVirtualRows();
            group = findGroup() ?? null;
            if (!group) {
                return null;
            }
            const alignedListRect = list.getBoundingClientRect();
            const alignedGroupRect = group.getBoundingClientRect();
            return {
                bottomGap: alignedListRect.bottom - alignedGroupRect.bottom,
                expanded: group.getAttribute('aria-expanded'),
            };
        }, searchMatchScrollConfig.targetGroup);
        expect(collapsedGroupAtListBottom).not.toBeNull();
        expect(collapsedGroupAtListBottom!.expanded).toBe('false');
        expect(Math.abs(collapsedGroupAtListBottom!.bottomGap)).toBeLessThanOrEqual(
            SEARCH_RESULT_LIST_EDGE_TOLERANCE_PX,
        );

        const openedTargetGroup = await session.page.evaluate((targetGroup: string) => {
            const group = Array.from(document.querySelectorAll<HTMLButtonElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-results-group-toggle',
            )).find(candidate => candidate.dataset.pageNumber === targetGroup);
            if (!group || group.getAttribute('aria-expanded') !== 'false') {
                return false;
            }
            group.click();
            return true;
        }, searchMatchScrollConfig.targetGroup);
        expect(openedTargetGroup).toBe(true);

        await waitForFunctionInPage(session.page, ({
            targetMatch,
            targetPage,
        }: {
            targetMatch: number;
            targetPage: number;
        }) => {
            const list = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-results-list',
            );
            const result = document.querySelector<HTMLElement>(
                `.editor-pane.is-active [data-testid="document-sidebar"] .document-search-result[data-page-number="${String(targetPage)}"][data-page-match-number="${String(targetMatch)}"]`,
            );
            if (!list || !result) {
                return false;
            }
            const listRect = list.getBoundingClientRect();
            const resultRect = result.getBoundingClientRect();
            return resultRect.top >= listRect.top - 1 && resultRect.bottom <= listRect.bottom + 1;
        }, {timeout: SEARCH_MATCH_PAINT_TIMEOUT_MS}, {
            targetMatch: searchMatchScrollConfig.targetMatch,
            targetPage: searchMatchScrollConfig.targetViewerPage,
        });

        const sidebarStatusGeometry = await session.page.evaluate(({
            targetMatch,
            targetPage,
        }: {
            targetMatch: number;
            targetPage: number;
        }) => {
            const sidebar = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"]',
            );
            const sidebarContent = sidebar?.querySelector<HTMLElement>('.app-sidebar-shell__content');
            const panel = sidebar?.querySelector<HTMLElement>('.document-search-panel');
            const results = sidebar?.querySelector<HTMLElement>('.document-search-results');
            const listShell = sidebar?.querySelector<HTMLElement>('.document-search-results-list-shell');
            const list = sidebar?.querySelector<HTMLElement>('.document-search-results-list');
            const result = sidebar?.querySelector<HTMLElement>(
                `.document-search-result[data-page-number="${String(targetPage)}"][data-page-match-number="${String(targetMatch)}"]`,
            );
            const status = document.querySelector<HTMLElement>('#editor-global-status-host .status-bar');
            if (!sidebar || !sidebarContent || !panel || !results || !listShell || !list || !result || !status) {
                throw new Error('Sidebar status geometry could not be measured');
            }
            const sidebarRect = sidebar.getBoundingClientRect();
            const sidebarContentRect = sidebarContent.getBoundingClientRect();
            const panelRect = panel.getBoundingClientRect();
            const resultsRect = results.getBoundingClientRect();
            const listShellRect = listShell.getBoundingClientRect();
            const listRect = list.getBoundingClientRect();
            const resultRect = result.getBoundingClientRect();
            const statusRect = status.getBoundingClientRect();
            const resultCenterX = resultRect.left + resultRect.width / 2;
            const resultCenterY = resultRect.top + resultRect.height / 2;
            const hitTarget = document.elementFromPoint(resultCenterX, resultCenterY);
            return {
                listBottom: listRect.bottom,
                listShellBottom: listShellRect.bottom,
                panelBottom: panelRect.bottom,
                resultBottom: resultRect.bottom,
                resultCenterX,
                resultCenterY,
                resultHitTarget: hitTarget === result || Boolean(hitTarget && result.contains(hitTarget)),
                resultIndex: Number(result.dataset.resultIndex),
                resultsBottom: resultsRect.bottom,
                sidebarContentBottom: sidebarContentRect.bottom,
                sidebarBottom: sidebarRect.bottom,
                statusTop: statusRect.top,
            };
        }, {
            targetMatch: searchMatchScrollConfig.targetMatch,
            targetPage: searchMatchScrollConfig.targetViewerPage,
        });
        expect(
            sidebarStatusGeometry.sidebarBottom,
            JSON.stringify({sidebarStatusGeometry}),
        ).toBeLessThanOrEqual(sidebarStatusGeometry.statusTop + SEARCH_RESULT_LIST_EDGE_TOLERANCE_PX);
        expect(
            Math.abs(sidebarStatusGeometry.panelBottom - sidebarStatusGeometry.sidebarContentBottom),
            JSON.stringify({sidebarStatusGeometry}),
        ).toBeLessThanOrEqual(1);
        expect(
            Math.abs(sidebarStatusGeometry.resultsBottom - sidebarStatusGeometry.sidebarContentBottom),
            JSON.stringify({sidebarStatusGeometry}),
        ).toBeLessThanOrEqual(1);
        expect(
            Math.abs(sidebarStatusGeometry.listShellBottom - sidebarStatusGeometry.sidebarContentBottom),
            JSON.stringify({sidebarStatusGeometry}),
        ).toBeLessThanOrEqual(1);
        expect(
            sidebarStatusGeometry.listBottom,
            JSON.stringify({sidebarStatusGeometry}),
        ).toBeLessThanOrEqual(sidebarStatusGeometry.sidebarContentBottom + 1);
        expect(
            sidebarStatusGeometry.resultBottom,
            JSON.stringify({sidebarStatusGeometry}),
        ).toBeLessThanOrEqual(sidebarStatusGeometry.statusTop + SEARCH_RESULT_LIST_EDGE_TOLERANCE_PX);
        expect(sidebarStatusGeometry.resultIndex).toBe(searchMatchScrollConfig.expectedResultCount - 1);
        expect(sidebarStatusGeometry.resultHitTarget, JSON.stringify({sidebarStatusGeometry})).toBe(true);

        await session.page.evaluate(() => {
            const diagnosticWindow = window as Window & {
                __clearPdfNavLog?: () => void;
                __clearPdfRenderTrace?: () => void;
            };
            diagnosticWindow.__clearPdfNavLog?.();
            diagnosticWindow.__clearPdfRenderTrace?.();
        });
        const clickedTarget = await session.page.evaluate(({
            targetMatch,
            targetPage,
        }: {
            targetMatch: number;
            targetPage: number;
        }) => {
            const result = document.querySelector<HTMLElement>(
                `.editor-pane.is-active [data-testid="document-sidebar"] .document-search-result[data-page-number="${String(targetPage)}"][data-page-match-number="${String(targetMatch)}"]`,
            );
            const matchText = result?.querySelector<HTMLElement>(
                '.document-search-result-highlight',
            )?.textContent ?? '';
            const resultRect = result?.getBoundingClientRect();
            const clickedAtMs = performance.now();
            return result && resultRect ? {
                centerX: resultRect.left + resultRect.width / 2,
                centerY: resultRect.top + resultRect.height / 2,
                clickedAtMs,
                matchText,
            } : null;
        }, {
            targetMatch: searchMatchScrollConfig.targetMatch,
            targetPage: searchMatchScrollConfig.targetViewerPage,
        });
        expect(clickedTarget).not.toBeNull();
        expect(clickedTarget!.matchText.trim().length).toBeGreaterThan(0);
        await session.page.mouse.click(clickedTarget!.centerX, clickedTarget!.centerY);

        await waitForFunctionInPage(session.page, ({
            targetMatch,
            targetPage,
        }: {
            targetMatch: number;
            targetPage: number;
        }) => {
            const currentResult = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-result[aria-current="true"]',
            );
            const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host #pdf-viewer');
            const page = viewer?.querySelector<HTMLElement>(`.page_container[data-page="${String(targetPage)}"]`);
            const highlights = Array.from(page?.querySelectorAll<HTMLElement>(
                '.pdf-search-highlight--current, .pdf-word-box--current',
            ) ?? []).map(highlight => highlight.getBoundingClientRect())
                .filter(rect => rect.width > 0 && rect.height > 0);
            if (currentResult?.dataset.pageNumber !== String(targetPage)
                || currentResult.dataset.pageMatchNumber !== String(targetMatch)
                || !viewer
                || !page
                || highlights.length === 0) {
                return false;
            }
            return true;
        }, {timeout: SEARCH_MATCH_PAINT_TIMEOUT_MS}, {
            targetMatch: searchMatchScrollConfig.targetMatch,
            targetPage: searchMatchScrollConfig.targetViewerPage,
        });

        const readFinalState = () => session.page.evaluate((targetPage: number) => {
            const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host #pdf-viewer');
            const page = viewer?.querySelector<HTMLElement>(`.page_container[data-page="${String(targetPage)}"]`);
            const viewerRect = viewer?.getBoundingClientRect() ?? null;
            const pageRect = page?.getBoundingClientRect() ?? null;
            const highlightElements = Array.from(page?.querySelectorAll<HTMLElement>(
                '.pdf-search-highlight--current, .pdf-word-box--current',
            ) ?? []);
            const highlightRects = highlightElements.map(element => element.getBoundingClientRect())
                .filter(rect => rect.width > 0 && rect.height > 0);
            const highlight = highlightRects.length > 0
                ? {
                    bottom: Math.max(...highlightRects.map(rect => rect.bottom)),
                    left: Math.min(...highlightRects.map(rect => rect.left)),
                    right: Math.max(...highlightRects.map(rect => rect.right)),
                    top: Math.min(...highlightRects.map(rect => rect.top)),
                }
                : null;
            const trace = ((window as Window & {__getPdfRenderTrace?: () => Array<{
                event: string;
                payload?: Record<string, unknown>
            }>;}).__getPdfRenderTrace?.() ?? []);
            const navigationMessages = ((window as Window & {__getPdfNavLog?: () => Array<{message: string;}>;})
                .__getPdfNavLog?.() ?? []).map(entry => entry.message);
            const appliedCount = trace.filter(entry => (
                entry.event === 'navigation-viewport-authority-applied'
                && entry.payload?.kind === 'search'
            )).length;
            const applied = trace.find(entry => (
                entry.event === 'navigation-viewport-authority-applied'
                && entry.payload?.kind === 'search'
                && entry.payload?.page === targetPage
            ));
            const afterRangeUpdate = trace.find(entry => (
                entry.event === 'navigation-viewport-authority-after-range-update'
                && entry.payload?.intentId === applied?.payload?.intentId
            ));
            const refined = [...trace].reverse().find(entry => (
                entry.event === 'navigation-text-anchor-refined'
                && entry.payload?.intentId === applied?.payload?.intentId
                && entry.payload?.page === targetPage
            ));
            const targetTrace = trace.filter(entry => entry.payload?.pageNumber === targetPage);
            const cancelledCount = trace.filter(entry => (
                entry.event.endsWith('-intent-cancelled')
                && entry.payload?.intentId === applied?.payload?.intentId
            )).length;
            const resolvedRectValue = refined?.payload?.resolvedRect;
            const resolvedRect = resolvedRectValue && typeof resolvedRectValue === 'object'
                ? resolvedRectValue as Record<string, unknown>
                : null;
            const resolvedNumbers = resolvedRect
                ? [
                    resolvedRect.left,
                    resolvedRect.top,
                    resolvedRect.width,
                    resolvedRect.height,
                ].map(Number)
                : [];
            const resolvedHighlightEdgeDelta = highlight && pageRect
                && resolvedNumbers.length === 4
                && resolvedNumbers.every(Number.isFinite)
                ? Math.max(
                    Math.abs(highlight.left - (pageRect.left + resolvedNumbers[0]! * pageRect.width)),
                    Math.abs(highlight.top - (pageRect.top + resolvedNumbers[1]! * pageRect.height)),
                    Math.abs(highlight.right - (
                        pageRect.left + (resolvedNumbers[0]! + resolvedNumbers[2]!) * pageRect.width
                    )),
                    Math.abs(highlight.bottom - (
                        pageRect.top + (resolvedNumbers[1]! + resolvedNumbers[3]!) * pageRect.height
                    )),
                )
                : null;
            return {
                afterRangeActualTop: Number(afterRangeUpdate?.payload?.actualTop),
                appliedActualTop: Number(applied?.payload?.actualTop),
                highlight: highlight
                    ? {
                        bottom: highlight.bottom,
                        left: highlight.left,
                        right: highlight.right,
                        top: highlight.top,
                    }
                    : null,
                highlightBackgroundColors: highlightElements.map(element => getComputedStyle(element).backgroundColor),
                highlightOpacities: highlightElements.map(element => getComputedStyle(element).opacity),
                highlightText: highlightElements.map(element => (
                    element.textContent || element.dataset.word || ''
                )).join(''),
                highlightVisibilities: highlightElements.map(element => getComputedStyle(element).visibility),
                hydrationBeginCount: targetTrace.filter(entry => (
                    entry.event === 'renderer-layer-hydration-begin'
                )).length,
                hydrationReadyCount: targetTrace.filter(entry => (
                    entry.event === 'renderer-layer-hydration-settled'
                    && entry.payload?.outcome === 'ready'
                )).length,
                leaseAcquireCount: targetTrace.filter(entry => (
                    entry.event === 'pdf-document-page-lease-acquire'
                )).length,
                navigationMessages,
                scrollTop: viewer?.scrollTop ?? null,
                appliedCount,
                appliedTraceAtMs: Number(applied?.payload?.traceAtMs),
                cancelledCount,
                hasResolvedRect: refined?.payload?.hasResolvedRect === true,
                hasResolvedSearchRange: refined?.payload?.searchRange !== null
                    && refined?.payload?.searchRange !== undefined,
                resolvedHighlightEdgeDelta,
                singlePageBeginCount: targetTrace.filter(entry => (
                    entry.event === 'renderer-single-page-begin'
                )).length,
                viewportSize: {
                    height: window.innerHeight,
                    width: window.innerWidth,
                },
                page: pageRect
                    ? {
                        bottom: pageRect.bottom,
                        left: pageRect.left,
                        right: pageRect.right,
                        top: pageRect.top,
                    }
                    : null,
                viewer: viewerRect
                    ? {
                        bottom: viewerRect.bottom,
                        left: viewerRect.left,
                        right: viewerRect.right,
                        top: viewerRect.top,
                    }
                    : null,
            };
        }, searchMatchScrollConfig.targetViewerPage);

        let finalState = await readFinalState();
        expect(finalState.highlight).not.toBeNull();
        expect(finalState.page).not.toBeNull();
        expect(finalState.viewer).not.toBeNull();
        expect(normalizeMatchText(finalState.highlightText)).toBe(
            normalizeMatchText(clickedTarget!.matchText),
        );
        expect(finalState.highlightBackgroundColors).not.toContain('rgba(0, 0, 0, 0)');
        expect(finalState.highlightOpacities).not.toContain('0');
        expect(finalState.highlightVisibilities).not.toContain('hidden');

        await waitForFunctionInPage(session.page, () => {
            const trace = ((window as Window & {__getPdfRenderTrace?: () => Array<{
                event: string;
                payload?: Record<string, unknown>
            }>;}).__getPdfRenderTrace?.() ?? []);
            const applied = trace.filter(entry => (
                entry.event === 'navigation-viewport-authority-applied'
                && entry.payload?.kind === 'search'
            ));
            const intentId = applied[0]?.payload?.intentId;
            return applied.length === 1
                && trace.some(entry => (
                    entry.event === 'navigation-viewport-authority-after-range-update'
                    && entry.payload?.intentId === intentId
                ))
                && trace.some(entry => (
                    entry.event === 'navigation-text-anchor-refined'
                    && entry.payload?.intentId === intentId
                    && entry.payload?.hasResolvedRect === true
                ));
        }, {timeout: SEARCH_MATCH_PAINT_TIMEOUT_MS});

        await waitForFunctionInPage(session.page, (targetPage: number) => {
            const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host #pdf-viewer');
            const page = viewer?.querySelector<HTMLElement>(`.page_container[data-page="${String(targetPage)}"]`);
            const viewerRect = viewer?.getBoundingClientRect();
            const highlightRects = Array.from(page?.querySelectorAll<HTMLElement>(
                '.pdf-search-highlight--current, .pdf-word-box--current',
            ) ?? []).map(element => element.getBoundingClientRect())
                .filter(rect => rect.width > 0 && rect.height > 0);
            if (!viewerRect || highlightRects.length === 0) {
                return false;
            }
            const highlight = {
                bottom: Math.max(...highlightRects.map(rect => rect.bottom)),
                left: Math.min(...highlightRects.map(rect => rect.left)),
                right: Math.max(...highlightRects.map(rect => rect.right)),
                top: Math.min(...highlightRects.map(rect => rect.top)),
            };
            const centeredY = Math.abs(
                (highlight.top + highlight.bottom) / 2 - (viewerRect.top + viewerRect.bottom) / 2,
            ) < 120;
            return centeredY
                && highlight.left >= viewerRect.left - 2
                && highlight.right <= viewerRect.right + 2
                && highlight.top >= viewerRect.top - 2
                && highlight.bottom <= viewerRect.bottom + 2;
        }, {timeout: SEARCH_MATCH_PAINT_TIMEOUT_MS}, searchMatchScrollConfig.targetViewerPage);

        await new Promise(resolve => setTimeout(resolve, 500));
        finalState = await readFinalState();
        expect(finalState.appliedCount).toBe(1);
        expect(finalState.cancelledCount).toBe(0);
        expect(Number.isFinite(finalState.appliedTraceAtMs)).toBe(true);
        expect(finalState.appliedTraceAtMs - clickedTarget!.clickedAtMs).toBeLessThanOrEqual(
            searchMatchScrollConfig.applyBudgetMs,
        );
        expect(finalState.appliedTraceAtMs).toBeGreaterThanOrEqual(clickedTarget!.clickedAtMs);
        expect(finalState.scrollTop).toBeCloseTo(finalState.appliedActualTop, 0);
        expect(finalState.afterRangeActualTop).toBeCloseTo(finalState.appliedActualTop, 0);
        expect(finalState.hasResolvedSearchRange).toBe(true);
        expect(finalState.hasResolvedRect).toBe(true);
        expect(finalState.resolvedHighlightEdgeDelta).not.toBeNull();
        expect(finalState.resolvedHighlightEdgeDelta!).toBeLessThanOrEqual(4);
        expect(finalState.singlePageBeginCount).toBeLessThanOrEqual(1);
        expect(finalState.hydrationBeginCount).toBe(1);
        expect(finalState.hydrationReadyCount).toBe(1);
        expect(finalState.leaseAcquireCount).toBeLessThanOrEqual(4);
        expect(finalState.navigationMessages.some(message => message.includes('scrollToCurrentMatch'))).toBe(false);
        expect(finalState.highlight!.left).toBeGreaterThanOrEqual(finalState.viewer!.left - 2);
        expect(finalState.highlight!.right).toBeLessThanOrEqual(finalState.viewer!.right + 2);
        expect(finalState.highlight!.top).toBeGreaterThanOrEqual(finalState.viewer!.top - 2);
        expect(finalState.highlight!.bottom).toBeLessThanOrEqual(finalState.viewer!.bottom + 2);
        const highlightCenterY = (finalState.highlight!.top + finalState.highlight!.bottom) / 2;
        const viewerCenterY = (finalState.viewer!.top + finalState.viewer!.bottom) / 2;
        expect(Math.abs(highlightCenterY - viewerCenterY)).toBeLessThan(120);
        await session.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => (
            requestAnimationFrame(() => resolve())
        ))));
        const screenshot = await session.page.screenshot({type: 'png'});
        expect(await countWarmHighlightPixels(
            screenshot,
            finalState.highlight!,
            finalState.viewportSize,
        )).toBeGreaterThan(4);
    }, SEARCH_MATCH_SCROLL_TIMEOUT_MS);

    it('keeps repeated match selections visible after navigation settles', async () => {
        const session = sessionFixture.getSession();
        const fixturePath = searchMatchScrollConfig.fixturePath
            ?? await createSearchMatchScrollFixturePdf(`search-repeat-${Date.now()}.pdf`);
        await session.page.setViewport({
            deviceScaleFactor: 2,
            height: 1018,
            width: 1869,
        });
        await openPdfInApp(session.page, fixturePath, SEARCH_MATCH_SCROLL_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, SEARCH_MATCH_SCROLL_TIMEOUT_MS);
        await enablePdfDiagnosticSession(session.page, {
            navigation: true,
            render: true,
        });
        await ensureSidebarOpen(session.page);
        await openDocumentSidebarTab(session.page, 'Search');
        const searchInput = await session.page.$('.editor-pane.is-active .document-search-bar input');
        await searchInput!.type(searchMatchScrollConfig.query);
        await session.page.click('.editor-pane.is-active .search-run-button');
        await waitForFunctionInPage(session.page, (count: number) => {
            const summary = document.querySelector('.editor-pane.is-active .document-search-results-header-summary');
            return summary?.textContent?.trim().startsWith(`${count} results`)
                && !document.querySelector('.editor-pane.is-active .document-search-results-spinner');
        }, {timeout: SEARCH_MATCH_SCROLL_TIMEOUT_MS}, searchMatchScrollConfig.expectedResultCount);
        await callWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [3.8]);
        await waitForWorkspaceToolbarSnapshot(session.page, {
            hasPdf: true,
            minEffectiveZoom: 3.7,
        });
        const targets = suppliedSearchMatchScrollPdf
            ? [
                {
                    page: 22,
                    match: 1,
                },
                {
                    page: 81,
                    match: 1,
                },
                {
                    page: 22,
                    match: 1,
                },
                {
                    page: 81,
                    match: 1,
                },
                {
                    page: 23,
                    match: 1,
                },
                {
                    page: 83,
                    match: 1,
                },
                {
                    page: 23,
                    match: 2,
                },
                {
                    page: 82,
                    match: 1,
                },
                {
                    page: 23,
                    match: 1,
                },
                {
                    page: 81,
                    match: 1,
                },
                {
                    page: 23,
                    match: 2,
                },
            ]
            : [
                {
                    page: 22,
                    match: 1,
                },
                {
                    page: 81,
                    match: 1,
                },
                {
                    page: 22,
                    match: 1,
                },
                {
                    page: 81,
                    match: 1,
                },
                {
                    page: SEARCH_MATCH_SCROLL_FIXTURE_TARGET_PAGE,
                    match: 1,
                },
                {
                    page: 1,
                    match: 1,
                },
                {
                    page: SEARCH_MATCH_SCROLL_FIXTURE_TARGET_PAGE,
                    match: 2,
                },
                {
                    page: 1,
                    match: 1,
                },
                {
                    page: SEARCH_MATCH_SCROLL_FIXTURE_TARGET_PAGE,
                    match: 3,
                },
            ];
        for (const {
            page: targetPage,
            match: targetMatch,
        } of targets) {
            const selector = `.editor-pane.is-active .document-search-result[data-page-number="${targetPage}"][data-page-match-number="${targetMatch}"]`;
            await session.page.evaluate(async (target: string) => {
                const list = document.querySelector<HTMLElement>('.editor-pane.is-active .document-search-results-list')!;
                const step = Math.max(1, Math.floor(list.clientHeight / 2));
                const maxScrollTop = list.scrollHeight;
                for (let top = 0; top <= maxScrollTop; top += step) {
                    list.scrollTop = top;
                    list.dispatchEvent(new Event('scroll'));
                    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                    const row = document.querySelector<HTMLElement>(target);
                    if (row) {
                        row.scrollIntoView({block: 'center'});
                        return;
                    }
                }
                throw new Error(`Missing result ${target}`);
            }, selector);
            const clicked = await session.page.evaluate((target: string) => {
                const row = document.querySelector<HTMLElement>(target)!;
                const box = row.getBoundingClientRect();
                const x = box.left + box.width / 2;
                const y = box.top + box.height / 2;
                const diagnosticWindow = window as Window & {__clearPdfRenderTrace?: () => void};
                diagnosticWindow.__clearPdfRenderTrace?.();
                const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active #pdf-viewer')!;
                const oldHighlight = viewer.querySelector<HTMLElement>(
                    '.pdf-search-highlight--current, .pdf-word-box--current',
                );
                const oldPage = oldHighlight?.closest<HTMLElement>('.page_container')?.dataset.page;
                const readHighlightPaint = (element: HTMLElement | null) => {
                    if (!element) {
                        return {
                            opacity: null,
                            visible: false,
                        };
                    }
                    let opacity = 1;
                    let visible = true;
                    for (let current: HTMLElement | null = element; current && current !== viewer; current = current.parentElement) {
                        const style = getComputedStyle(current);
                        const currentOpacity = Number.parseFloat(style.opacity);
                        if (Number.isFinite(currentOpacity)) {
                            opacity *= currentOpacity;
                        }
                        visible = visible
                            && style.visibility !== 'hidden'
                            && style.display !== 'none';
                    }
                    return {
                        opacity,
                        visible: visible && opacity > 0,
                    };
                };
                const outgoingPaint = readHighlightPaint(oldHighlight);
                const viewerBounds = viewer.getBoundingClientRect();
                const outgoingBounds = oldHighlight?.getBoundingClientRect();
                const outgoingInViewport = !!outgoingBounds
                    && outgoingBounds.bottom > viewerBounds.top
                    && outgoingBounds.top < viewerBounds.bottom
                    && outgoingBounds.right > viewerBounds.left
                    && outgoingBounds.left < viewerBounds.right;
                const targetPage = row.dataset.pageNumber;
                const frames: Array<{
                    committed: boolean;
                    outgoingOrange: boolean;
                    outgoingOpacity: number | null;
                    outgoingVisible: boolean;
                    targetOrange: boolean
                    targetOpacity: number | null;
                    targetVisible: boolean;
                }> = [];
                const monitor = window as Window & {
                    __matchHandoffFrames?: typeof frames;
                    __stopMatchHandoff?: boolean
                };
                monitor.__matchHandoffFrames = frames;
                monitor.__stopMatchHandoff = false;
                const sample = () => {
                    if (monitor.__stopMatchHandoff || monitor.__matchHandoffFrames !== frames) {
                        return;
                    }
                    const trace = (window as Window & {__getPdfRenderTrace?: () => Array<{event: string}>})
                        .__getPdfRenderTrace?.() ?? [];
                    if (oldPage && oldPage !== targetPage) {
                        const outgoing = readHighlightPaint(viewer.querySelector<HTMLElement>(
                            `.page_container[data-page="${oldPage}"] .pdf-search-highlight--current, .page_container[data-page="${oldPage}"] .pdf-word-box--current`,
                        ));
                        const destination = readHighlightPaint(viewer.querySelector<HTMLElement>(
                            `.page_container[data-page="${targetPage}"] .pdf-search-highlight--current, .page_container[data-page="${targetPage}"] .pdf-word-box--current`,
                        ));
                        frames.push({
                            committed: trace.some(entry => entry.event === 'navigation-viewport-authority-applied'),
                            outgoingOrange: outgoing.opacity !== null,
                            outgoingOpacity: outgoing.opacity,
                            outgoingVisible: outgoing.visible,
                            targetOrange: destination.opacity !== null,
                            targetOpacity: destination.opacity,
                            targetVisible: destination.visible,
                        });
                    }
                    requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
                return {
                    x,
                    y,
                    monitored: !!oldPage && oldPage !== targetPage,
                    outgoingOpacity: outgoingPaint.opacity,
                    outgoingVisible: outgoingPaint.visible,
                    outgoingInViewport,
                    hit: row.contains(document.elementFromPoint(x, y)),
                    text: row.querySelector('.document-search-result-highlight')?.textContent ?? '',
                    viewerRect: {
                        bottom: viewerBounds.bottom,
                        left: viewerBounds.left,
                        right: viewerBounds.right,
                        top: viewerBounds.top,
                    },
                    viewportSize: {
                        height: window.innerHeight,
                        width: window.innerWidth,
                    },
                };
            }, selector);
            expect(clicked.hit).toBe(true);
            const paintCapture = clicked.monitored && clicked.outgoingVisible && clicked.outgoingInViewport
                ? await startSearchHighlightPaintCapture(session.page)
                : null;
            try {
                await session.page.mouse.click(clicked.x, clicked.y);
                await waitForFunctionInPage(session.page, (target: string) =>
                    document.querySelector(target)?.getAttribute('aria-current') === 'true',
                {timeout: SEARCH_MATCH_PAINT_TIMEOUT_MS}, selector);
                const readState = () => session.page.evaluate((pageNumber: number) => {
                    const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active #pdf-viewer')!;
                    const bounds = viewer.getBoundingClientRect();
                    const page = viewer.querySelector<HTMLElement>(`.page_container[data-page="${pageNumber}"]`);
                    const highlights = Array.from(page?.querySelectorAll<HTMLElement>(
                        '.pdf-search-highlight--current, .pdf-word-box--current',
                    ) ?? []);
                    const rects = highlights.map(element => element.getBoundingClientRect())
                        .filter(rect => rect.width > 0 && rect.height > 0);
                    const rect = rects.length ? {
                        left: Math.min(...rects.map(value => value.left)),
                        right: Math.max(...rects.map(value => value.right)),
                        top: Math.min(...rects.map(value => value.top)),
                        bottom: Math.max(...rects.map(value => value.bottom)),
                    } : null;
                    const trace = (window as Window & {__getPdfRenderTrace?: () => Array<{
                        event: string;
                        payload?: Record<string, unknown>;
                    }>}).__getPdfRenderTrace?.() ?? [];
                    const applied = trace.filter(entry => entry.event === 'navigation-viewport-authority-applied');
                    const navigationApplies = applied.filter(entry => entry.payload?.kind === 'search'
                    || trace.some(refinement => refinement.event === 'navigation-text-anchor-refined'
                        && refinement.payload?.intentId === entry.payload?.intentId
                        && refinement.payload?.searchRange));
                    return {
                        visible: !!rect && rect.top >= bounds.top - 2
                        && rect.bottom <= bounds.bottom + 2 && rect.left >= bounds.left - 2 && rect.right <= bounds.right + 2,
                        centerDelta: rect ? (rect.top + rect.bottom - bounds.top - bounds.bottom) / 2 : null,
                        scrollTop: viewer.scrollTop,
                        scrollLeft: viewer.scrollLeft,
                        scrollHeight: viewer.scrollHeight,
                        clientHeight: viewer.clientHeight,
                        appliedLeft: Number(applied.at(-1)?.payload?.actualLeft),
                        appliedPositions: applied.map(entry => ({
                            left: Number(entry.payload?.actualLeft),
                            top: Number(entry.payload?.actualTop),
                        })),
                        appliedTop: Number(applied.at(-1)?.payload?.actualTop),
                        appliedCount: navigationApplies.length,
                        navigationTrace: trace.filter(entry => entry.event.startsWith('navigation-')),
                        text: highlights.map(element => element.textContent || element.dataset.word || '').join(''),
                        rect,
                        viewportSize: {
                            width: window.innerWidth,
                            height: window.innerHeight,
                        },
                    };
                }, targetPage);
                await vi.waitFor(async () => {
                    const state = await readState();
                    expect(state.visible, `page ${targetPage} match ${targetMatch}: ${JSON.stringify(state)}`).toBe(true);
                    expect(Math.abs(state.centerDelta!), JSON.stringify(state)).toBeLessThan(120);
                }, {
                    timeout: SEARCH_MATCH_PAINT_TIMEOUT_MS,
                    interval: 50,
                });
                // Catch a delayed resize or outgoing-anchor replay after the match
                // first appears, rather than accepting a transient correct frame.
                await new Promise(resolve => setTimeout(resolve, 500));
                const state = await readState();
                expect(state.visible, `settled page ${targetPage} match ${targetMatch}: ${JSON.stringify(state)}`).toBe(true);
                const paintedFrames = await paintCapture?.stop() ?? [];
                const orangePixelCounts = await Promise.all(paintedFrames.map(frame => countOrangeHighlightPixelsInFrame(
                    frame, clicked.viewerRect, clicked.viewportSize,
                )));
                if (paintCapture) {
                    if (orangePixelCounts.some(count => count <= 4) || process.env.EVB_SEARCH_SCROLL_PAINT_EVIDENCE === '1') {
                        writeSearchHighlightPaintEvidence({
                            label: `page-${targetPage}-match-${targetMatch}`,
                            frames: paintedFrames,
                            orangePixelCounts,
                            diagnostic: await session.page.evaluate(() => ({
                                renderTrace: (window as Window & {__getPdfRenderTrace?: () => unknown}).__getPdfRenderTrace?.(),
                                frames: (window as Window & {__matchHandoffFrames?: unknown}).__matchHandoffFrames,
                            })),
                        });
                    }
                    expect(paintedFrames.length, 'No compositor frames captured').toBeGreaterThan(0);
                    expect(orangePixelCounts.filter(count => count <= 4), 'Painted frames lost the orange match').toEqual([]);
                }
                const handoffFrames = await session.page.evaluate(() => {
                    const monitor = window as Window & {
                        __matchHandoffFrames?: Array<{
                            committed: boolean;
                            outgoingOrange: boolean;
                            targetOrange: boolean;
                            outgoingVisible: boolean;
                            targetVisible: boolean;
                        }>;
                        __stopMatchHandoff?: boolean;
                    };
                    monitor.__stopMatchHandoff = true;
                    return monitor.__matchHandoffFrames ?? [];
                });
                if (clicked.monitored) {
                    expect(handoffFrames.some(frame => frame.committed)).toBe(true);
                }
                expect(handoffFrames.filter(frame => !frame.committed && (!frame.outgoingOrange || !frame.outgoingVisible)), 'Outgoing orange disappears before viewport commit').toEqual([]);
                expect(handoffFrames.filter(frame => frame.committed && (!frame.targetOrange || !frame.targetVisible)), 'Destination arrives before orange highlight').toEqual([]);
                expect(Math.abs(state.centerDelta!), JSON.stringify(state)).toBeLessThan(120);
                expect(normalizeMatchText(state.text)).toBe(normalizeMatchText(clicked.text));
                expect(state.appliedCount, JSON.stringify({
                    targetPage,
                    targetMatch,
                    ...state,
                })).toBe(1);
                expect(state.scrollTop).toBeCloseTo(state.appliedTop, 0);
                expect(state.scrollLeft).toBeCloseTo(state.appliedLeft, 0);
                // A scrollbar resize may reassert the settled position. It must
                // never introduce another destination or sideways correction.
                for (const position of state.appliedPositions) {
                    expect(position).toEqual({
                        left: state.appliedLeft,
                        top: state.appliedTop,
                    });
                }
                expect(await countWarmHighlightPixels(
                    await session.page.screenshot({type: 'png'}), state.rect!, state.viewportSize,
                )).toBeGreaterThan(4);
            } finally {
                await paintCapture?.stop();
            }
        }
    }, SEARCH_MATCH_SCROLL_TIMEOUT_MS);
});
