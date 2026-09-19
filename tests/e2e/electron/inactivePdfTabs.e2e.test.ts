import {
    describe,
    expect,
    it,
} from 'vitest';
import { createMultiPageTextFixturePdf } from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {assertInactiveDocumentPressureReleased} from '@tests/e2e/electron/helpers/assertInactiveDocumentPressureReleased';
import {waitForWorkspaceToolbarSnapshot} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    clickVisibleToolbarButton,
    goToPageViaToolbar,
    getToolbarCurrentPage,
    openPdfInApp,
    setupScrollToPage,
    setTabMemoryPolicyForE2E,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    activateWorkspaceTab as activateTab,
    createNewWorkspaceTab as createNewTab,
    splitActiveWorkspaceDocument as splitActiveDocument,
} from '@tests/e2e/electron/helpers/workspaceTabs';
import {
    expectSplitPaneCloseContinuity,
    runSplitPaneCloseContinuity,
} from '@tests/e2e/electron/helpers/splitPaneCloseContinuity';

interface IWorkspaceHostPressure {
    index: number;
    active: boolean;
    visible: boolean;
    canvases: number;
    renderedPages: number;
    textSpans: number;
    searchHighlights: number;
    annotationLayers: number;
    annotationEditorLayers: number;
    freeTextEditors: number;
    noteWindows: number;
    popups: number;
}

interface IRightFileFlashProbeResult {
    flashCount: number;
    snapshotSeen: boolean;
}

interface IRightFileFlashProbe {finish: () => IRightFileFlashProbeResult;}

function readHostPressureFromPage(): IWorkspaceHostPressure[] {
    const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
            style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || '1') > 0
            && rect.width > 100
            && rect.height > 100
        );
    };

    return Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
        .map((host, index) => {
            const visible = isVisible(host);
            return {
                index,
                active: visible,
                visible,
                canvases: host.querySelectorAll('.page_canvas canvas').length,
                renderedPages: host.querySelectorAll('.page_container--rendered').length,
                textSpans: host.querySelectorAll('.text-layer span, .textLayer span').length,
                searchHighlights: host.querySelectorAll('.pdf-search-highlight, .pdf-search-highlight-current').length,
                annotationLayers: host.querySelectorAll('.annotationLayer, .annotation-layer').length,
                annotationEditorLayers: host.querySelectorAll('.annotationEditorLayer, .annotation-editor-layer').length,
                freeTextEditors: host.querySelectorAll('.freeTextEditor').length,
                noteWindows: host.querySelectorAll('.pdf-annotation-note-window, .note-window').length,
                popups: host.querySelectorAll('.annotationLayer .popup, .annotation-layer .popup, .pdf-annotation-comment-popup, #commentPopup, #commentManagerDialog').length,
            };
        });
}

async function waitForInactiveHostsToReleaseRenderedPages(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => {
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 100
                && rect.height > 100
            );
        };
        const pressures = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .map((host) => {
                const visible = isVisible(host);
                return {
                    active: visible,
                    canvases: host.querySelectorAll('.page_canvas canvas').length,
                    renderedPages: host.querySelectorAll('.page_container--rendered').length,
                    textSpans: host.querySelectorAll('.text-layer span, .textLayer span').length,
                    searchHighlights: host.querySelectorAll('.pdf-search-highlight, .pdf-search-highlight-current').length,
                    annotationLayers: host.querySelectorAll('.annotationLayer, .annotation-layer').length,
                    annotationEditorLayers: host.querySelectorAll('.annotationEditorLayer, .annotation-editor-layer').length,
                    freeTextEditors: host.querySelectorAll('.freeTextEditor').length,
                    noteWindows: host.querySelectorAll('.pdf-annotation-note-window, .note-window').length,
                    popups: host.querySelectorAll('.annotationLayer .popup, .annotation-layer .popup, .pdf-annotation-comment-popup, #commentPopup, #commentManagerDialog').length,
                };
            });
        return pressures.some(host => host.active && host.canvases > 0 && host.renderedPages > 0)
            && pressures
                .filter(host => !host.active)
                .every(host =>
                    host.canvases === 0
                    && host.renderedPages === 0
                    && host.textSpans === 0
                    && host.searchHighlights === 0
                    && host.annotationLayers === 0
                    && host.annotationEditorLayers === 0
                    && host.freeTextEditors === 0
                    && host.noteWindows === 0
                    && host.popups === 0,
                );
    }, { timeout: 30_000 });
}

async function waitForVisibleRenderedPdfHosts(session: IElectronE2ESession, expectedCount: number) {
    await session.page.waitForFunction((expected: number) => {
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 100
                && rect.height > 100
            );
        };

        return Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(host => isVisible(host) && host.querySelectorAll('.page_container--rendered').length > 0)
            .length >= expected;
    }, { timeout: 30_000 }, expectedCount);
}

describe('Electron E2E - Inactive PDF Tabs', () => {
    let firstFixturePath = '';
    let secondFixturePath = '';

    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-inactive-pdf-tabs-${Date.now()}`});

    it('releases rendered page resources from hidden PDF tabs and restores them on activation', async () => {
        const session = sessionFixture.getSession();

        await setTabMemoryPolicyForE2E(session.page, 'aggressive');
        firstFixturePath = await createMultiPageTextFixturePdf(`inactive-tabs-first-${Date.now()}.pdf`, 3);
        secondFixturePath = await createMultiPageTextFixturePdf(`inactive-tabs-second-${Date.now()}.pdf`, 3);
        await openPdfInApp(session.page, firstFixturePath);
        await waitForPdfLoaded(session.page);
        await setupScrollToPage(session.page, 3);
        expect(await getToolbarCurrentPage(session.page)).toBe(3);
        await createNewTab(session);
        await openPdfInApp(session.page, secondFixturePath);
        await waitForPdfLoaded(session.page);
        await setupScrollToPage(session.page, 2);
        expect(await getToolbarCurrentPage(session.page)).toBe(2);

        await waitForInactiveHostsToReleaseRenderedPages(session);
        const afterSecondOpen = await session.page.evaluate(readHostPressureFromPage);
        expect(afterSecondOpen.length).toBeGreaterThanOrEqual(1);
        expect(afterSecondOpen.length).toBeLessThanOrEqual(2);
        expect(afterSecondOpen.filter(host => host.active)).toHaveLength(1);
        expect(afterSecondOpen.filter(host => !host.active).every(host => host.canvases === 0)).toBe(true);
        expect(afterSecondOpen.filter(host => !host.active).every(host => host.renderedPages === 0)).toBe(true);

        await activateTab(session, 0);
        await waitForPdfLoaded(session.page);
        await waitForInactiveHostsToReleaseRenderedPages(session);

        const afterFirstReactivation = await session.page.evaluate(readHostPressureFromPage);
        const activeAfterFirstReactivation = afterFirstReactivation.find(host => host.active);
        expect(activeAfterFirstReactivation?.renderedPages).toBeGreaterThan(0);
        expect(afterFirstReactivation.filter(host => !host.active).every(host => host.canvases === 0)).toBe(true);
        expect(afterFirstReactivation.filter(host => !host.active).every(host => host.renderedPages === 0)).toBe(true);

        await activateTab(session, 1);
        await waitForPdfLoaded(session.page);
        await waitForInactiveHostsToReleaseRenderedPages(session);

        const afterSecondReactivation = await session.page.evaluate(readHostPressureFromPage);
        const activeAfterSecondReactivation = afterSecondReactivation.find(host => host.active);
        expect(afterSecondReactivation.filter(host => !host.active).every(host => host.canvases === 0)).toBe(true);
        expect(afterSecondReactivation.filter(host => !host.active).every(host => host.renderedPages === 0)).toBe(true);
        expect(activeAfterSecondReactivation?.renderedPages).toBeGreaterThan(0);
    });

    it('keeps every visible split-pane document rendered while releasing hidden resources', async () => {
        const session = sessionFixture.getSession();

        await setTabMemoryPolicyForE2E(session.page, 'aggressive');
        const splitPrimaryFixturePath = await createMultiPageTextFixturePdf(`inactive-tabs-split-primary-${Date.now()}.pdf`, 3);
        const splitHiddenFixturePath = await createMultiPageTextFixturePdf(`inactive-tabs-split-hidden-${Date.now()}.pdf`, 3);
        await openPdfInApp(session.page, splitPrimaryFixturePath);
        await waitForPdfLoaded(session.page);
        await createNewTab(session);
        await openPdfInApp(session.page, splitHiddenFixturePath);
        await waitForPdfLoaded(session.page);

        await activateTab(session, 0);
        await waitForPdfLoaded(session.page);
        await splitActiveDocument(session, 'right');
        await openPdfInApp(session.page, splitPrimaryFixturePath);
        await waitForPdfLoaded(session.page);
        await waitForVisibleRenderedPdfHosts(session, 2);

        await activateTab(session, 0);
        await waitForPdfLoaded(session.page);
        await waitForInactiveHostsToReleaseRenderedPages(session);
        const pressure = await assertInactiveDocumentPressureReleased(session.page);

        expect(pressure.filter(host => host.active).length).toBeGreaterThanOrEqual(2);
        expect(pressure.filter(host => host.active).every(host => host.renderedPages > 0)).toBe(true);
    });

    it('keeps the rendered right PDF visible while activating scan cleanup on the left', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();

        await session.page.setViewport({
            deviceScaleFactor: 2,
            height: 982,
            width: 1_512,
        });
        const sourcePath = await createMultiPageTextFixturePdf(
            `split-activation-source-${Date.now()}.pdf`,
            6,
        );
        const cleanedPath = await createMultiPageTextFixturePdf(
            `split-activation-cleaned-${Date.now()}.pdf`,
            1,
        );
        await openPdfInApp(session.page, sourcePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await clickVisibleToolbarButton(session.page, 'Scan cleanup');
        await session.page.waitForSelector('.scan-cleanup-surface', {
            timeout: 30_000,
            visible: true,
        });

        await splitActiveDocument(session, 'right');
        await openPdfInApp(session.page, cleanedPath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await session.page.waitForFunction(() => {
            const panes = Array.from(document.querySelectorAll<HTMLElement>('.editor-pane'));
            return panes.length === 2
                && panes[0]?.querySelector('.scan-cleanup-surface') !== null
                && panes[1]?.querySelector('.page_container--rendered canvas') !== null
                && panes[1]?.classList.contains('is-active') === true;
        }, {timeout: 30_000});

        await session.page.evaluate(() => {
            const rightPane = document.querySelectorAll<HTMLElement>('.editor-pane')[1];
            if (!rightPane) {
                throw new Error('Right editor pane is unavailable');
            }
            const state = {
                flashCount: 0,
                snapshotSeen: false,
                stopped: false,
            };
            const sample = () => {
                const page = rightPane.querySelector<HTMLElement>('.page_container');
                const skeleton = rightPane.querySelector<HTMLElement>('.document-page-skeleton');
                if (page?.querySelector('.page_canvas--resize-visual-snapshot')) {
                    state.snapshotSeen = true;
                }
                if (!skeleton || !page) {
                    return;
                }
                const bounds = skeleton.getBoundingClientRect();
                const style = getComputedStyle(skeleton);
                if (
                    skeleton.isConnected
                    && bounds.width > 0
                    && bounds.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                ) {
                    state.flashCount += 1;
                }
            };
            const observer = new MutationObserver(sample);
            observer.observe(rightPane, {
                attributes: true,
                childList: true,
                subtree: true,
            });
            const sampleFrame = () => {
                sample();
                if (!state.stopped) {
                    requestAnimationFrame(sampleFrame);
                }
            };
            requestAnimationFrame(sampleFrame);
            const finish = () => {
                state.stopped = true;
                observer.disconnect();
                sample();
                return state;
            };
            Object.assign(window, {__rightFileFlashProbe: {finish}});
        });

        await session.page.click('.editor-pane:not(.is-active) .scan-cleanup-surface');
        await new Promise(resolve => setTimeout(resolve, 1_500));
        const result = await session.page.evaluate(() => {
            if (!('__rightFileFlashProbe' in window)) {
                throw new Error('Right file flash probe is unavailable');
            }
            const probe = window.__rightFileFlashProbe as IRightFileFlashProbe;
            return probe.finish();
        });

        // Activating a sibling Scan Cleanup pane does not necessarily change
        // the PDF pane's geometry, so a resize snapshot is optional here. The
        // user-visible invariant is that the already-rendered right PDF never
        // exposes a skeleton flash during that activation.
        expect(result.flashCount).toBe(0);
    }, 180_000);

    it('keeps the exact PDF pane, tab, document surface, and viewport anchor while closing an empty split', async () => {
        let session = sessionFixture.getSession();

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-pdf-empty-split-continuity-${Date.now()}`,
        });

        const fixturePath = await createMultiPageTextFixturePdf(
            `pdf-empty-split-continuity-${Date.now()}.pdf`,
            8,
        );
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        await goToPageViaToolbar(session.page, 4);
        await waitForWorkspaceToolbarSnapshot(session.page, {currentPage: 4});
        expect(await getToolbarCurrentPage(session.page)).toBe(4);

        const continuity = await runSplitPaneCloseContinuity(session, {
            documentKind: 'pdf',
            expectedPageNumber: 4,
        });
        expectSplitPaneCloseContinuity(continuity);
    }, 120_000);
});
