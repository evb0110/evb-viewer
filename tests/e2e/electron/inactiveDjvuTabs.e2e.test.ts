import {
    describe,
    expect,
    it,
} from 'vitest';
import { copyFileSync } from 'node:fs';
import {
    createFixturePath,
    createMultiPageTextFixturePdf,
    resolveDjvuFixturePath,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import {assertInactiveDocumentPressureReleased} from '@tests/e2e/electron/helpers/assertInactiveDocumentPressureReleased';
import {
    goToPageViaToolbar,
    openDjvuInApp,
    openPdfInApp,
    setTabMemoryPolicyForE2E,
    waitForDjvuLoaded,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    activateWorkspaceTab as activateTab,
    createNewWorkspaceTab as createNewTab,
    splitActiveWorkspaceDocument as splitActiveDocument,
} from '@tests/e2e/electron/helpers/workspaceTabs';
import {
    callWorkspaceCommand,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    expectSplitPaneCloseContinuity,
    runSplitPaneCloseContinuity,
} from '@tests/e2e/electron/helpers/splitPaneCloseContinuity';

interface IWorkspaceDjvuPressure {
    index: number;
    active: boolean;
    visible: boolean;
    pageShells: number;
    images: number;
}

interface IWorkspaceSurfaceBudgetSnapshotForE2E {
    leaseCount: number;
    pressureLevel: string;
    reservedBytes: number;
    reservedBytesByCategory: Record<string, number>;
}

interface IWorkspaceSurfacePressureWindow extends Window {
    __getWorkspaceSurfaceBudgetForE2E?: () => IWorkspaceSurfaceBudgetSnapshotForE2E;
    __setWorkspaceSurfacePressureForE2E?: (
        level: 'healthy' | 'moderate',
    ) => void;
}

interface IInactiveDjvuRenderCancellationProbe {
    committedPagesAfterDeactivation: number[];
    committedImagesBeforeDeactivation: WeakSet<HTMLImageElement>;
    deactivated: boolean;
    observer: MutationObserver;
}

interface IInactiveDjvuRenderCancellationWindow extends Window {__inactiveDjvuRenderCancellationProbe?: IInactiveDjvuRenderCancellationProbe;}

interface IDjvuActivationOccupancyFrame {
    canonicalShellCount: number;
    elapsedMs: number;
    effectiveZoom: number | null;
    pageHeight: number | null;
    pageNumber: number | null;
    pageWidth: number | null;
    shellVisuals: string[];
    visibleShellCount: number;
}

interface IDjvuPagePresentationGeometry {
    height: number;
    imageHeight: number;
    imageNaturalHeight: number;
    imageNaturalWidth: number;
    imageWidth: number;
    pageNumber: number;
    width: number;
}

interface IDjvuFitWidthState {
    currentPage: number;
    hasOpeningFrame: boolean;
    mountedPages: number[];
    pageWidth: number;
    viewportWidth: number;
    zoomMode: string | null;
}

interface IDjvuActivationOccupancyProbe {
    frames: IDjvuActivationOccupancyFrame[];
    startedAt: number;
    animationFrame: number;
    handleScroll: (event: Event) => void;
    trustedDjvuScrollEvents: number;
}

interface IDjvuActivationOccupancyWindow extends Window {__djvuActivationOccupancyProbe?: IDjvuActivationOccupancyProbe;}

const DJVU_E2E_TIMEOUT_MS = 90_000;

function readDjvuPressureFromPage(): IWorkspaceDjvuPressure[] {
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
                pageShells: host.querySelectorAll('[data-testid="document-page-source-page"]').length,
                images: host.querySelectorAll('[data-testid="document-page-source-image"]').length,
            };
        });
}

async function installDjvuActivationOccupancyProbe(
    session: IElectronE2ESession,
    activateTabIndex: number | null = null,
) {
    await session.page.evaluate((tabIndex: number | null) => {
        const probeWindow = window as IDjvuActivationOccupancyWindow;
        if (probeWindow.__djvuActivationOccupancyProbe) {
            cancelAnimationFrame(probeWindow.__djvuActivationOccupancyProbe.animationFrame);
        }
        const probe: IDjvuActivationOccupancyProbe = {
            animationFrame: 0,
            frames: [],
            handleScroll: () => {},
            startedAt: performance.now(),
            trustedDjvuScrollEvents: 0,
        };
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 100
                && rect.height > 100;
        };
        const sample = () => {
            const host = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .find(candidate => (
                    isVisible(candidate)
                    && candidate.querySelector('[data-testid="document-page-source-viewer"]')
                ));
            const viewport = host?.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport]') ?? null;
            if (viewport) {
                const viewportRect = viewport.getBoundingClientRect();
                const visibleShells = Array.from(viewport.querySelectorAll<HTMLElement>(
                    '[data-testid="document-page-source-page"]',
                )).filter((shell) => {
                    const rect = shell.getBoundingClientRect();
                    return rect.bottom > viewportRect.top + 1
                        && rect.top < viewportRect.bottom - 1
                        && rect.right > viewportRect.left + 1
                        && rect.left < viewportRect.right - 1;
                });
                const canonicalShellCount = visibleShells.filter((shell) => {
                    const skeleton = shell.querySelector<HTMLElement>('.document-page-skeleton');
                    if (skeleton && getComputedStyle(skeleton).display !== 'none') {
                        return true;
                    }
                    const image = shell.querySelector<HTMLImageElement>(
                        ':scope > [data-testid="document-page-source-image"]',
                    );
                    return Boolean(
                        image?.complete
                        && image.naturalWidth > 0
                        && image.naturalHeight > 0
                        && getComputedStyle(image).visibility === 'visible',
                    );
                }).length;
                probe.frames.push({
                    canonicalShellCount,
                    elapsedMs: performance.now() - probe.startedAt,
                    effectiveZoom: (window as IE2EWindow)
                        .__evbTestApi?.getActiveToolbarSnapshot?.()?.effectiveZoom ?? null,
                    pageHeight: visibleShells[0]?.getBoundingClientRect().height ?? null,
                    pageNumber: Number(visibleShells[0]?.dataset.pageNumber) || null,
                    pageWidth: visibleShells[0]?.getBoundingClientRect().width ?? null,
                    shellVisuals: visibleShells.map(shell => shell.dataset.pageSourceVisual ?? ''),
                    visibleShellCount: visibleShells.length,
                });
            }
            probe.animationFrame = requestAnimationFrame(sample);
        };
        probe.handleScroll = (event: Event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement) || event.isTrusted !== true) {
                return;
            }
            const host = target.closest<HTMLElement>('.workspace-host');
            if (host && isVisible(host) && host.querySelector('[data-testid="document-page-source-viewer"]')) {
                probe.trustedDjvuScrollEvents += 1;
            }
        };
        document.addEventListener('scroll', probe.handleScroll, true);
        probeWindow.__djvuActivationOccupancyProbe = probe;
        probe.animationFrame = requestAnimationFrame(sample);
        if (tabIndex !== null) {
            const tabs = Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'));
            tabs[tabIndex]?.click();
        }
    }, activateTabIndex);
}

async function readActiveDjvuPagePresentationGeometry(
    session: IElectronE2ESession,
    pageNumber: number,
) {
    return session.page.evaluate((expectedPage: number) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const page = host?.querySelector<HTMLElement>(
            `[data-testid="document-page-source-page"][data-page-number="${String(expectedPage)}"]`,
        );
        const image = page?.querySelector<HTMLImageElement>(
            ':scope > [data-testid="document-page-source-image"]',
        );
        if (!page || !image) {
            return null;
        }
        const pageRect = page.getBoundingClientRect();
        const imageRect = image.getBoundingClientRect();
        return {
            height: pageRect.height,
            imageHeight: imageRect.height,
            imageNaturalHeight: image.naturalHeight,
            imageNaturalWidth: image.naturalWidth,
            imageWidth: imageRect.width,
            pageNumber: expectedPage,
            width: pageRect.width,
        } satisfies IDjvuPagePresentationGeometry;
    }, pageNumber);
}

async function stopDjvuActivationOccupancyProbe(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const probeWindow = window as IDjvuActivationOccupancyWindow;
        const probe = probeWindow.__djvuActivationOccupancyProbe;
        if (!probe) {
            return {
                frames: [] as IDjvuActivationOccupancyFrame[],
                trustedDjvuScrollEvents: 0,
            };
        }
        cancelAnimationFrame(probe.animationFrame);
        document.removeEventListener('scroll', probe.handleScroll, true);
        delete probeWindow.__djvuActivationOccupancyProbe;
        return {
            frames: probe.frames,
            trustedDjvuScrollEvents: probe.trustedDjvuScrollEvents,
        };
    });
}

async function waitForActiveDjvuImages(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => {
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        return (activeHost?.querySelectorAll('[data-testid="document-page-source-image"]').length ?? 0) > 0;
    }, { timeout: 20_000 });
}

async function waitForDjvuPreviewBytes(
    session: IElectronE2ESession,
    predicate: (bytes: number) => boolean,
    timeoutMs: number,
) {
    const deadline = Date.now() + timeoutMs;
    let snapshot: IWorkspaceSurfaceBudgetSnapshotForE2E | null = null;
    while (Date.now() < deadline) {
        snapshot = await session.page.evaluate(() => (
            (window as IWorkspaceSurfacePressureWindow).__getWorkspaceSurfaceBudgetForE2E?.() ?? null
        ));
        if (snapshot && predicate(snapshot.reservedBytesByCategory['djvu-preview'] ?? 0)) {
            return snapshot;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`DjVu preview residency did not reach the expected state: ${JSON.stringify(snapshot)}`);
}

async function waitForInactiveDjvuImagesToRelease(session: IElectronE2ESession, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    let snapshots: IWorkspaceDjvuPressure[] = [];
    while (Date.now() < deadline) {
        snapshots = await session.page.evaluate(readDjvuPressureFromPage);
        if (snapshots.filter(host => !host.active).every(host => host.images === 0)) {
            return snapshots;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Inactive DjVu images were not released: ${JSON.stringify(snapshots)}`);
}

async function installInactiveDjvuRenderCancellationProbe(session: IElectronE2ESession) {
    await session.page.evaluate(() => {
        const probeWindow = window as IInactiveDjvuRenderCancellationWindow;
        probeWindow.__inactiveDjvuRenderCancellationProbe?.observer.disconnect();
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        if (!activeHost?.querySelector('[data-testid="document-page-source-viewer"]')) {
            throw new Error('Active DjVu workspace was not found');
        }
        const probe: IInactiveDjvuRenderCancellationProbe = {
            committedPagesAfterDeactivation: [],
            committedImagesBeforeDeactivation: new WeakSet(),
            deactivated: false,
            observer: new MutationObserver(() => {
                if (!probe.deactivated) {
                    return;
                }
                const committedPages = Array.from(activeHost.querySelectorAll<HTMLImageElement>(
                    '[data-testid="document-page-source-image"].document-page-visual--committed'
                    + '[data-document-page-visual="committed"]',
                )).filter(image => !probe.committedImagesBeforeDeactivation.has(image))
                    .map(image => Number(
                        image.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber,
                    )).filter(Number.isFinite);
                probe.committedPagesAfterDeactivation.push(...committedPages);
            }),
        };
        probe.observer.observe(activeHost, {
            attributes: true,
            childList: true,
            subtree: true,
        });
        probeWindow.__inactiveDjvuRenderCancellationProbe = probe;
    });
}

async function stopInactiveDjvuRenderCancellationProbe(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const probeWindow = window as IInactiveDjvuRenderCancellationWindow;
        const probe = probeWindow.__inactiveDjvuRenderCancellationProbe;
        probe?.observer.disconnect();
        delete probeWindow.__inactiveDjvuRenderCancellationProbe;
        return probe?.committedPagesAfterDeactivation ?? [];
    });
}

async function waitForActiveDjvuCommittedPage(session: IElectronE2ESession, pageNumber: number) {
    await session.page.waitForFunction((expectedPage: number) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const viewport = host?.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport]');
        const page = viewport?.querySelector<HTMLElement>(
            `[data-testid="document-page-source-page"][data-page-number="${String(expectedPage)}"]`,
        );
        const image = page?.querySelector<HTMLImageElement>(
            ':scope > [data-testid="document-page-source-image"]',
        );
        const style = image ? window.getComputedStyle(image) : null;
        return Boolean(
            page?.dataset.pageSourceVisual === 'fresh'
            && !page.querySelector('.document-source-viewer__skeleton')
            && image?.complete
            && image.naturalWidth > 0
            && image.naturalHeight > 0
            && image.classList.contains('document-page-visual--committed')
            && image.dataset.documentPageVisual === 'committed'
            && style?.visibility === 'visible',
        );
    }, {timeout: DJVU_E2E_TIMEOUT_MS}, pageNumber);
}

async function waitForActiveDjvuAuthorityConvergence(
    session: IElectronE2ESession,
    pageNumber: number,
) {
    await session.page.waitForFunction((expectedPage: number) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis');
        const viewport = host?.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport]');
        const viewportRect = viewport?.getBoundingClientRect();
        const visiblePages = viewport && viewportRect
            ? Array.from(viewport.querySelectorAll<HTMLElement>('[data-document-page-number]'))
                .filter((page) => {
                    const rect = page.getBoundingClientRect();
                    return rect.bottom > viewportRect.top + 1 && rect.top < viewportRect.bottom - 1;
                })
                .map(page => Number(page.dataset.documentPageNumber))
            : [];
        const toolbarPage = (window as IE2EWindow)
            .__evbTestApi?.getActiveToolbarSnapshot?.()?.currentPage ?? null;
        const committedOrObservedPage = Number(
            chassis?.dataset.viewportCommittedPage
            || chassis?.dataset.viewportObservedPage,
        );
        return toolbarPage === expectedPage
            && Number(chassis?.dataset.chassisCurrentPage) === expectedPage
            && Number(chassis?.dataset.viewportRequestedPage) === expectedPage
            && committedOrObservedPage === expectedPage
            && visiblePages.includes(expectedPage);
    }, {timeout: DJVU_E2E_TIMEOUT_MS}, pageNumber);
}

async function waitForVisibleDjvuImageHosts(session: IElectronE2ESession, expectedCount: number) {
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
            .filter(host => isVisible(host) && host.querySelectorAll('[data-testid="document-page-source-image"]').length > 0)
            .length >= expected;
    }, { timeout: DJVU_E2E_TIMEOUT_MS }, expectedCount);
}

async function readActiveDjvuFitWidthState(session: IElectronE2ESession): Promise<IDjvuFitWidthState> {
    return session.page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis');
        const viewport = host?.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport]');
        const toolbar = (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot?.();
        const currentPage = toolbar?.currentPage ?? 0;
        const page = viewport?.querySelector<HTMLElement>(
            `[data-testid="document-page-source-page"][data-page-number="${String(currentPage)}"]`,
        );
        return {
            currentPage,
            hasOpeningFrame: chassis?.dataset.openSurfaceHasOpeningFrame === 'true',
            mountedPages: Array.from(viewport?.querySelectorAll<HTMLElement>(
                '[data-testid="document-page-source-page"]',
            ) ?? []).map(element => Number(element.dataset.pageNumber)),
            pageWidth: page?.getBoundingClientRect().width ?? 0,
            viewportWidth: viewport?.clientWidth ?? 0,
            zoomMode: toolbar?.zoomMode ?? null,
        };
    });
}

const djvuFixture = resolveDjvuFixturePath();
const runOrSkip = selectFixtureDescribe(describe, djvuFixture);

runOrSkip('Electron E2E - Inactive DjVu Tabs', () => {
    let pdfFixturePath = '';

    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-inactive-djvu-tabs-${Date.now()}`});

    it('keeps fit-width geometry scroll-invariant and retires opening destinations', async () => {
        let session = sessionFixture.getSession();
        if (!session || !djvuFixture.path) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-djvu-fit-width-layout-${Date.now()}`,
        });
        if (!session) {
            return;
        }
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_E2E_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_E2E_TIMEOUT_MS);
        expect((await callWorkspaceCommand(session.page, 'handleFitWidth')).called).toBe(true);
        const snapshot = await waitForWorkspaceToolbarSnapshot(
            session.page,
            {minTotalPages: 40},
            {timeoutMs: DJVU_E2E_TIMEOUT_MS},
        );
        const firstTarget = Math.min(40, snapshot.totalPages);
        const secondTarget = Math.min(firstTarget + 1, snapshot.totalPages);

        for (const target of [
            firstTarget,
            secondTarget,
        ]) {
            await goToPageViaToolbar(session.page, target);
            await waitForActiveDjvuCommittedPage(session, target);
            await waitForActiveDjvuAuthorityConvergence(session, target);
            const state = await readActiveDjvuFitWidthState(session);
            expect(state.zoomMode, JSON.stringify(state)).toBe('fit-width');
            expect(state.currentPage, JSON.stringify(state)).toBe(target);
            expect(state.hasOpeningFrame, JSON.stringify(state)).toBe(false);
            expect(state.pageWidth, JSON.stringify(state)).toBeGreaterThan(state.viewportWidth - 50);
            expect(state.pageWidth, JSON.stringify(state)).toBeLessThanOrEqual(state.viewportWidth);
            expect(state.mountedPages, JSON.stringify(state)).not.toContain(1);
        }
    }, 120_000);

    it('retains a warm high-zoom DjVu presentation without scroll input', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        await setTabMemoryPolicyForE2E(session.page, 'conservative', DJVU_E2E_TIMEOUT_MS);
        pdfFixturePath = await createMultiPageTextFixturePdf(`inactive-djvu-other-tab-${Date.now()}.pdf`, 3);
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_E2E_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_E2E_TIMEOUT_MS);
        await waitForActiveDjvuImages(session);
        const loadedSnapshot = await waitForWorkspaceToolbarSnapshot(
            session.page,
            {minTotalPages: 2},
            {timeoutMs: DJVU_E2E_TIMEOUT_MS},
        );
        const restoredPage = Math.min(1057, Math.floor(loadedSnapshot.totalPages * 0.9));
        const restoredZoom = 6.47;
        expect((await callWorkspaceCommand(
            session.page,
            'setCustomZoomFromDisplay',
            [restoredZoom],
        )).called).toBe(true);
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {minEffectiveZoom: restoredZoom - 0.005},
            {timeoutMs: DJVU_E2E_TIMEOUT_MS},
        );
        await waitForActiveDjvuCommittedPage(session, loadedSnapshot.currentPage);

        await installDjvuActivationOccupancyProbe(session);
        await goToPageViaToolbar(session.page, restoredPage);
        await waitForActiveDjvuCommittedPage(session, restoredPage);
        await waitForActiveDjvuAuthorityConvergence(session, restoredPage);
        await new Promise(resolve => setTimeout(resolve, 3_000));
        await waitForActiveDjvuAuthorityConvergence(session, restoredPage);
        const navigationProbe = await stopDjvuActivationOccupancyProbe(session);
        expect(navigationProbe.frames.length, JSON.stringify(navigationProbe.frames)).toBeGreaterThan(0);
        expect(
            navigationProbe.frames.every(frame => (
                frame.visibleShellCount > 0
                && frame.canonicalShellCount > 0
                && (frame.effectiveZoom ?? 0) >= restoredZoom - 0.005
            )),
            JSON.stringify(navigationProbe.frames),
        ).toBe(true);
        const beforeDeactivationGeometry = await readActiveDjvuPagePresentationGeometry(session, restoredPage);
        expect(beforeDeactivationGeometry).not.toBeNull();

        const afterDjvuOpen = await session.page.evaluate(readDjvuPressureFromPage);
        expect(afterDjvuOpen).toHaveLength(1);
        expect(afterDjvuOpen[0]?.active).toBe(true);
        expect(afterDjvuOpen[0]?.images).toBeGreaterThan(0);

        await createNewTab(session);
        await openPdfInApp(session.page, pdfFixturePath);
        await waitForPdfLoaded(session.page);

        const afterPdfOpen = await waitForInactiveDjvuImagesToRelease(session, 4_000);
        expect(afterPdfOpen).toHaveLength(2);
        expect(afterPdfOpen.find(host => !host.active)?.images).toBe(0);

        await installDjvuActivationOccupancyProbe(session, 0);
        await waitForDjvuLoaded(session.page);
        await waitForActiveDjvuImages(session);
        await waitForActiveDjvuCommittedPage(session, restoredPage);
        await waitForActiveDjvuAuthorityConvergence(session, restoredPage);
        const restoredSnapshot = await waitForWorkspaceToolbarSnapshot(
            session.page,
            {
                currentPage: restoredPage,
                minEffectiveZoom: restoredZoom - 0.005,
            },
            {timeoutMs: DJVU_E2E_TIMEOUT_MS},
        );
        expect(restoredSnapshot.zoomMode).toBe('custom');
        expect(restoredSnapshot.zoom).toBeCloseTo(restoredZoom, 3);
        expect(restoredSnapshot.effectiveZoom).toBeCloseTo(restoredZoom, 3);
        const afterReactivationGeometry = await readActiveDjvuPagePresentationGeometry(session, restoredPage);
        expect(afterReactivationGeometry).not.toBeNull();
        expect(afterReactivationGeometry?.width).toBeCloseTo(beforeDeactivationGeometry?.width ?? 0, 0);
        expect(afterReactivationGeometry?.height).toBeCloseTo(beforeDeactivationGeometry?.height ?? 0, 0);
        expect(afterReactivationGeometry?.imageWidth).toBeCloseTo(afterReactivationGeometry?.width ?? 0, 0);
        expect(afterReactivationGeometry?.imageHeight).toBeCloseTo(afterReactivationGeometry?.height ?? 0, 0);
        const activationProbe = await stopDjvuActivationOccupancyProbe(session);
        const activationFrames = activationProbe.frames;
        expect(activationFrames.length, JSON.stringify(activationFrames)).toBeGreaterThan(0);
        expect(
            activationFrames.every(frame => (
                frame.visibleShellCount > 0
                && frame.canonicalShellCount > 0
            )),
            JSON.stringify(activationFrames),
        ).toBe(true);
        const firstVisibleFrame = activationFrames.find(frame => frame.visibleShellCount > 0);
        expect(firstVisibleFrame?.elapsedMs, JSON.stringify(activationFrames)).toBeLessThan(1_500);
        expect(activationProbe.trustedDjvuScrollEvents).toBe(0);

        const afterDjvuReactivation = await session.page.evaluate(readDjvuPressureFromPage);
        const activeAfterDjvuReactivation = afterDjvuReactivation.find(host => host.active);
        expect(activeAfterDjvuReactivation?.images).toBeGreaterThan(0);
        expect(afterDjvuReactivation.filter(host => !host.active).every(host => host.images === 0)).toBe(true);
    }, 120_000);

    it('cancels queued and in-flight DjVu renders when its tab deactivates', async () => {
        let session = sessionFixture.getSession();
        if (!session || !djvuFixture.path) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-djvu-deactivation-cancellation-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        await createNewTab(session);
        await activateTab(session, 0);
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_E2E_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_E2E_TIMEOUT_MS);
        await waitForActiveDjvuImages(session);
        expect((await callWorkspaceCommand(
            session.page,
            'setCustomZoomFromDisplay',
            [6.47],
        )).called).toBe(true);
        const toolbar = await waitForWorkspaceToolbarSnapshot(
            session.page,
            {minEffectiveZoom: 6.465},
            {timeoutMs: DJVU_E2E_TIMEOUT_MS},
        );
        const targetPage = Math.max(2, toolbar.totalPages - 8);
        const queuedPages = [
            Math.max(2, targetPage - 2),
            targetPage,
        ];
        await installInactiveDjvuRenderCancellationProbe(session);

        const commandDispatch = await session.page.evaluate((pages: number[]) => {
            const probe = (window as IInactiveDjvuRenderCancellationWindow)
                .__inactiveDjvuRenderCancellationProbe;
            const api = (window as IE2EWindow).__evbTestApi;
            if (!probe || !api) {
                return false;
            }
            for (const page of pages) {
                void api.callActiveWorkspaceCommand('handleGoToPage', [page]).catch(() => undefined);
            }
            return true;
        }, queuedPages);

        if (commandDispatch) {
            await session.page.waitForFunction((pages: number[]) => {
                const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
                return Array.from(host?.querySelectorAll<HTMLElement>(
                    '[data-testid="document-page-source-page"][data-page-source-visual="skeleton"]',
                ) ?? []).some(page => pages.includes(Number(page.dataset.pageNumber)));
            }, {timeout: DJVU_E2E_TIMEOUT_MS}, queuedPages);
        }

        const transition = await session.page.evaluate((commandAvailable: boolean) => {
            const probe = (window as IInactiveDjvuRenderCancellationWindow)
                .__inactiveDjvuRenderCancellationProbe;
            const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const pendingPages = Array.from(host?.querySelectorAll<HTMLElement>(
                '[data-testid="document-page-source-page"][data-page-source-visual="skeleton"]',
            ) ?? []).map(page => Number(page.dataset.pageNumber));
            const tabs = Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'));
            if (probe) {
                probe.committedImagesBeforeDeactivation = new WeakSet(
                    Array.from(host?.querySelectorAll<HTMLImageElement>(
                        '[data-testid="document-page-source-image"].document-page-visual--committed'
                        + '[data-document-page-visual="committed"]',
                    ) ?? []),
                );
            }
            tabs[1]?.click();
            if (probe) {
                probe.deactivated = true;
            }
            return {
                commandAvailable: commandAvailable && Boolean(probe),
                pendingPages,
                switchedTabs: Boolean(tabs[1]),
            };
        }, commandDispatch);

        expect(transition.commandAvailable).toBe(true);
        expect(transition.switchedTabs).toBe(true);
        expect(
            transition.pendingPages.some(page => queuedPages.includes(page)),
            JSON.stringify(transition),
        ).toBe(true);

        await waitForDjvuPreviewBytes(session, bytes => bytes === 0, 4_000);
        await new Promise(resolve => setTimeout(resolve, 250));
        const committedPagesAfterDeactivation = await stopInactiveDjvuRenderCancellationProbe(session);
        expect(
            committedPagesAfterDeactivation.filter(page => queuedPages.includes(page)),
            JSON.stringify(committedPagesAfterDeactivation),
        ).toEqual([]);
        await waitForInactiveDjvuImagesToRelease(session, 4_000);
        const pressure = await assertInactiveDocumentPressureReleased(session.page);
        expect(pressure.filter(host => !host.active).every(host => host.djvuImages === 0)).toBe(true);
    }, 120_000);

    it('releases inactive DjVu leases immediately under moderate memory pressure', async () => {
        let session = sessionFixture.getSession();
        if (!session || !djvuFixture.path) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-djvu-moderate-pressure-release-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        await createNewTab(session);
        await activateTab(session, 0);
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_E2E_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_E2E_TIMEOUT_MS);
        await waitForActiveDjvuImages(session);
        const resident = await waitForDjvuPreviewBytes(session, bytes => bytes > 0, DJVU_E2E_TIMEOUT_MS);
        expect(resident.reservedBytesByCategory['djvu-preview']).toBeGreaterThan(0);

        const release = await session.page.evaluate(async () => {
            const pressureWindow = window as IWorkspaceSurfacePressureWindow;
            if (
                !pressureWindow.__setWorkspaceSurfacePressureForE2E
                || !pressureWindow.__getWorkspaceSurfaceBudgetForE2E
            ) {
                throw new Error('Workspace surface pressure E2E hook is unavailable');
            }
            const applyPressure = () => pressureWindow.__setWorkspaceSurfacePressureForE2E?.('moderate');
            applyPressure();
            const pressureTimer = window.setInterval(applyPressure, 200);
            try {
                const tabs = Array.from(document.querySelectorAll<HTMLElement>(
                    '.tab-list .tab[data-tab-id]',
                ));
                tabs[1]?.click();
                const activationDeadline = performance.now() + 1_250;
                while (
                    performance.now() < activationDeadline
                    && tabs[1]?.getAttribute('aria-selected') !== 'true'
                ) {
                    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                }
                const tabActivated = tabs[1]?.getAttribute('aria-selected') === 'true';
                applyPressure();
                const startedAt = performance.now();
                const deadline = startedAt + 1_250;
                let snapshot = pressureWindow.__getWorkspaceSurfaceBudgetForE2E();
                while (
                    performance.now() < deadline
                    && (snapshot.reservedBytesByCategory['djvu-preview'] ?? 0) > 0
                ) {
                    await new Promise(resolve => setTimeout(resolve, 25));
                    snapshot = pressureWindow.__getWorkspaceSurfaceBudgetForE2E();
                }
                return {
                    elapsedMs: performance.now() - startedAt,
                    snapshot,
                    switchedTabs: tabActivated,
                    tabActivated,
                };
            } finally {
                window.clearInterval(pressureTimer);
                pressureWindow.__setWorkspaceSurfacePressureForE2E('healthy');
            }
        });

        expect(release.switchedTabs).toBe(true);
        expect(release.tabActivated).toBe(true);
        expect(release.snapshot.pressureLevel).toBe('moderate');
        expect(release.snapshot.reservedBytesByCategory['djvu-preview'] ?? -1).toBe(0);
        expect(release.elapsedMs, JSON.stringify(release)).toBeLessThan(1_250);
        await waitForInactiveDjvuImagesToRelease(session, 4_000);
        const pressure = await assertInactiveDocumentPressureReleased(session.page);
        expect(pressure.filter(host => !host.active).every(host => host.djvuImages === 0)).toBe(true);
    }, 120_000);

    it('keeps independently opened visible split-pane DjVu documents rendered', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        await openDjvuInApp(session.page, djvuFixture.path, DJVU_E2E_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_E2E_TIMEOUT_MS);
        await waitForActiveDjvuImages(session);

        const independentDjvuPath = createFixturePath(`split-pane-${Date.now()}.djvu`);
        copyFileSync(djvuFixture.path, independentDjvuPath);
        await splitActiveDocument(session, 'right');
        await openDjvuInApp(session.page, independentDjvuPath, DJVU_E2E_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_E2E_TIMEOUT_MS);
        await waitForVisibleDjvuImageHosts(session, 2);

        const pressure = await assertInactiveDocumentPressureReleased(session.page);
        expect(pressure.filter(host => host.active).length).toBeGreaterThanOrEqual(2);
        expect(pressure.filter(host => host.active).every(host => host.djvuImages > 0)).toBe(true);
    });

    it('keeps the exact DjVu pane, tab, document surface, and viewport anchor while closing an empty split', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-djvu-empty-split-continuity-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        await openDjvuInApp(session.page, djvuFixture.path, DJVU_E2E_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_E2E_TIMEOUT_MS);
        await waitForActiveDjvuImages(session);

        await goToPageViaToolbar(session.page, 18);
        await waitForActiveDjvuCommittedPage(session, 18);
        await waitForActiveDjvuAuthorityConvergence(session, 18);

        const continuity = await runSplitPaneCloseContinuity(session, {
            documentKind: 'djvu',
            expectedPageNumber: 18,
        });
        expectSplitPaneCloseContinuity(continuity);
    }, 120_000);
});
