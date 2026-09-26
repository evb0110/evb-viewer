import type { Page } from 'puppeteer-core';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    resolveScannedFixturePageMarkerRgb,
    SCANNED_FIXTURE_MARKER_SIZE,
    SCANNED_FIXTURE_MARKER_X,
    SCANNED_FIXTURE_MARKER_Y,
} from '@tests/e2e/electron/helpers/fixtures';

export interface IPdfVirtualPageSnapshot {
    canvasConnected: boolean;
    canvasHeight: number;
    canvasWidth: number;
    documentTop: number;
    height: number;
    pageNumber: number;
    rendered: boolean;
    skeletonVisible: boolean;
    visible: boolean;
}

export interface IPdfVirtualizationSnapshot {
    computedGap: number;
    mountedPages: IPdfVirtualPageSnapshot[];
    paddingBottom: number;
    paddingTop: number;
    scrollHeight: number;
    scrollTop: number;
    totalPages: number;
    trackItems: Array<{
        documentTop: number;
        height: number;
        kind: 'page' | 'spacer';
        pageNumber: number | null;
    }>;
    trackDocumentTop: number;
    viewportHeight: number;
    visiblePages: IPdfVirtualPageSnapshot[];
}

export interface IPdfWheelSettlement {
    finalScrollTop: number;
    initialScrollTop: number;
    maxScrollTop: number;
    mutationCount: number;
    scrollEventCount: number;
}

const VIEWPORT_SELECTOR = '[data-document-viewer-chassis-viewport], #pdf-viewer';
export const PDF_PAGE_TRACK_SELECTOR = '[data-pdf-page-track]';

interface IPdfWheelSettlementProbe {
    cleanup: () => void;
    finalScrollTop: number;
    initialScrollTop: number;
    maxScrollTop: number;
    mutationCount: number;
    quietFrames: number;
    scrollEventCount: number;
    settled: boolean;
}

interface IPdfSettlementProbeWindow extends Window {__pdfWheelSettlementProbe?: IPdfWheelSettlementProbe;}

export async function collectPdfVirtualizationSnapshot(page: Page): Promise<IPdfVirtualizationSnapshot> {
    return evaluateInPage(page, ({
        pageTrackSelector,
        viewportSelector,
    }) => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 100
                && rect.height > 100
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0;
        };
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisibleHost);
        const preferredHost = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const activeHost = preferredHost && visibleHosts.includes(preferredHost)
            ? preferredHost
            : (visibleHosts.length === 1 ? visibleHosts[0] ?? null : null);
        const viewport = activeHost?.querySelector<HTMLElement>(viewportSelector) ?? null;
        if (!activeHost || !viewport) {
            throw new Error(`Active PDF viewport was not found (${viewportSelector})`);
        }
        const track = activeHost.querySelector<HTMLElement>(pageTrackSelector);
        if (!track) {
            throw new Error(`Active PDF page track was not found (${pageTrackSelector})`);
        }
        const viewportRect = viewport.getBoundingClientRect();
        const trackRect = track.getBoundingClientRect();
        const trackStyle = window.getComputedStyle(track);
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.bottom > viewportRect.top
                && rect.top < viewportRect.bottom
                && rect.right > viewportRect.left
                && rect.left < viewportRect.right
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0;
        };

        const mountedPages = Array.from(activeHost.querySelectorAll<HTMLElement>('.page_container[data-page]'))
            .map((container): IPdfVirtualPageSnapshot => {
                const rect = container.getBoundingClientRect();
                const canvas = container.querySelector<HTMLCanvasElement>('.page_canvas canvas');
                const skeleton = container.querySelector<HTMLElement>('.document-page-skeleton');
                return {
                    canvasConnected: canvas?.isConnected ?? false,
                    canvasHeight: canvas?.height ?? 0,
                    canvasWidth: canvas?.width ?? 0,
                    documentTop: rect.top - viewportRect.top + viewport.scrollTop,
                    height: rect.height,
                    pageNumber: Number(container.dataset.page) || 0,
                    rendered: container.classList.contains('page_container--rendered'),
                    skeletonVisible: Boolean(skeleton && isVisible(skeleton)),
                    visible: isVisible(container),
                };
            })
            .filter(candidate => candidate.pageNumber > 0)
            .sort((left, right) => left.pageNumber - right.pageNumber);

        const parsePixels = (value: string) => Number.parseFloat(value) || 0;
        const trackItems = Array.from(track.children)
            .filter((element): element is HTMLElement => (
                element instanceof HTMLElement
                && (
                    element.matches('.page_container[data-page]')
                    || element.matches('.pdf-viewer-virtual-spacer')
                )
            ))
            .map((element) => {
                const rect = element.getBoundingClientRect();
                const pageNumber = Number(element.dataset.page) || null;
                return {
                    documentTop: rect.top - viewportRect.top + viewport.scrollTop,
                    height: rect.height,
                    kind: pageNumber === null ? 'spacer' as const : 'page' as const,
                    pageNumber,
                };
            });
        const toolbarSnapshot = window.__evbTestApi?.getActiveToolbarSnapshot?.();
        return {
            computedGap: parsePixels(trackStyle.rowGap || trackStyle.gap),
            mountedPages,
            paddingBottom: parsePixels(trackStyle.paddingBottom),
            paddingTop: parsePixels(trackStyle.paddingTop),
            scrollHeight: viewport.scrollHeight,
            scrollTop: viewport.scrollTop,
            totalPages: toolbarSnapshot?.totalPages ?? 0,
            trackItems,
            trackDocumentTop: trackRect.top - viewportRect.top + viewport.scrollTop,
            viewportHeight: viewport.clientHeight,
            visiblePages: mountedPages.filter(candidate => candidate.visible),
        };
    }, {
        pageTrackSelector: PDF_PAGE_TRACK_SELECTOR,
        viewportSelector: VIEWPORT_SELECTOR,
    });
}

export async function waitForVisibleMountedPdfCanvases(page: Page, timeoutMs = 15_000) {
    await evaluateInPage(page, async ({
        stabilityMs,
        timeout,
        viewportSelector,
    }) => {
        const deadline = performance.now() + timeout;
        const canvasIds = new WeakMap<HTMLCanvasElement, number>();
        let nextCanvasId = 1;
        let stableSignature = '';
        let stableSince = 0;
        while (performance.now() < deadline) {
            await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter((host) => {
                    const rect = host.getBoundingClientRect();
                    const style = window.getComputedStyle(host);
                    return rect.width > 100
                        && rect.height > 100
                        && style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && Number(style.opacity || '1') > 0;
                });
            const preferredHost = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const activeHost = preferredHost && visibleHosts.includes(preferredHost)
                ? preferredHost
                : (visibleHosts.length === 1 ? visibleHosts[0] ?? null : null);
            const viewport = activeHost?.querySelector<HTMLElement>(viewportSelector) ?? null;
            if (!activeHost || !viewport) {
                stableSignature = '';
                stableSince = 0;
                continue;
            }
            const pageTrack = viewport.querySelector<HTMLElement>('[data-pdf-page-track]')
                ?? viewport.querySelector<HTMLElement>('.pdfViewer');
            const viewportRect = viewport.getBoundingClientRect();
            const visiblePages = Array.from(activeHost.querySelectorAll<HTMLElement>('.page_container[data-page]'))
                .filter((container) => {
                    const rect = container.getBoundingClientRect();
                    return rect.bottom > viewportRect.top
                        && rect.top < viewportRect.bottom
                        && rect.right > viewportRect.left
                        && rect.left < viewportRect.right;
                });
            const ready = !pageTrack?.classList.contains('pdfViewer--resize-transition')
                && visiblePages.length > 0
                && visiblePages.every((container) => {
                    const canvas = container.querySelector<HTMLCanvasElement>('.page_canvas canvas');
                    const skeleton = container.querySelector<HTMLElement>('.document-page-skeleton');
                    const skeletonVisible = skeleton
                        ? window.getComputedStyle(skeleton).display !== 'none'
                            && window.getComputedStyle(skeleton).visibility !== 'hidden'
                        : false;
                    return Boolean(
                        canvas?.isConnected
                        && canvas.width > 0
                        && canvas.height > 0
                        && container.classList.contains('page_container--rendered')
                        && !skeletonVisible,
                    );
                });
            const signature = ready
                ? `${String(Math.round(viewport.scrollTop))}:${visiblePages
                    .map((container) => {
                        const canvas = container.querySelector<HTMLCanvasElement>('.page_canvas canvas');
                        if (!canvas) {
                            return '';
                        }
                        let canvasId = canvasIds.get(canvas);
                        if (!canvasId) {
                            canvasId = nextCanvasId;
                            nextCanvasId += 1;
                            canvasIds.set(canvas, canvasId);
                        }
                        return [
                            container.dataset.page ?? '',
                            canvasId,
                            canvas.width,
                            canvas.height,
                        ].join(':');
                    })
                    .sort()
                    .join(',')}`
                : '';
            if (signature && signature === stableSignature) {
                if (performance.now() - stableSince >= stabilityMs) {
                    return;
                }
            } else {
                stableSignature = signature;
                stableSince = signature ? performance.now() : 0;
            }
        }
        throw new Error(`Visible PDF canvases did not stabilize within ${String(timeout)}ms`);
    }, {
        // Canvases unchanged across roughly fourteen frames.
        stabilityMs: 234,
        timeout: timeoutMs,
        viewportSelector: VIEWPORT_SELECTOR,
    });
}

export async function waitForAnimationFrames(page: Page, frameCount: number) {
    await evaluateInPage(page, async (count: number) => {
        for (let frame = 0; frame < count; frame += 1) {
            await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
        }
    }, frameCount);
}

export async function wheelPdfViewportAndWaitForSettlement(
    page: Page,
    deltaY: number,
    timeoutMs = 10_000,
): Promise<IPdfWheelSettlement> {
    const point = await evaluateInPage(page, ({
        pageTrackSelector,
        viewportSelector,
    }) => {
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter((host) => {
                const rect = host.getBoundingClientRect();
                const style = window.getComputedStyle(host);
                return rect.width > 100
                    && rect.height > 100
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0;
            });
        const preferredHost = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const activeHost = preferredHost && visibleHosts.includes(preferredHost)
            ? preferredHost
            : (visibleHosts.length === 1 ? visibleHosts[0] ?? null : null);
        const viewport = activeHost?.querySelector<HTMLElement>(viewportSelector) ?? null;
        const track = activeHost?.querySelector<HTMLElement>(pageTrackSelector) ?? null;
        if (!viewport || !track) {
            return null;
        }

        const probeWindow = window as IPdfSettlementProbeWindow;
        probeWindow.__pdfWheelSettlementProbe?.cleanup();
        let animationFrame = 0;
        let lastActivityFrame = 0;
        let frame = 0;
        const probe = {
            cleanup: () => {},
            finalScrollTop: viewport.scrollTop,
            initialScrollTop: viewport.scrollTop,
            maxScrollTop: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
            mutationCount: 0,
            quietFrames: 0,
            scrollEventCount: 0,
            settled: false,
        };
        const markActivity = () => {
            lastActivityFrame = frame;
            probe.quietFrames = 0;
            probe.settled = false;
            probe.finalScrollTop = viewport.scrollTop;
            probe.maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        };
        const handleScroll = () => {
            probe.scrollEventCount += 1;
            markActivity();
        };
        const observer = new MutationObserver((records) => {
            const relevantRecords = records.filter(record => (
                (record.type === 'childList' && record.target === track)
                || (
                    record.type === 'attributes'
                    && record.target instanceof HTMLElement
                    && record.target.parentElement === track
                )
            ));
            if (relevantRecords.length === 0) {
                return;
            }
            probe.mutationCount += relevantRecords.length;
            markActivity();
        });
        observer.observe(track, {
            attributeFilter: ['style'],
            attributes: true,
            childList: true,
            subtree: true,
        });
        viewport.addEventListener('scroll', handleScroll, {passive: true});
        const sampleFrame = () => {
            frame += 1;
            probe.finalScrollTop = viewport.scrollTop;
            probe.maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
            probe.quietFrames = frame - lastActivityFrame;
            probe.settled = probe.scrollEventCount > 0 && probe.quietFrames >= 2;
            animationFrame = window.requestAnimationFrame(sampleFrame);
        };
        probe.cleanup = () => {
            window.cancelAnimationFrame(animationFrame);
            observer.disconnect();
            viewport.removeEventListener('scroll', handleScroll);
        };
        probeWindow.__pdfWheelSettlementProbe = probe;
        animationFrame = window.requestAnimationFrame(sampleFrame);

        const rect = viewport.getBoundingClientRect();
        return {
            x: Math.round(rect.left + (rect.width / 2)),
            y: Math.round(rect.top + (rect.height / 2)),
        };
    }, {
        pageTrackSelector: PDF_PAGE_TRACK_SELECTOR,
        viewportSelector: VIEWPORT_SELECTOR,
    });
    if (!point) {
        throw new Error('Active PDF viewport was unavailable for wheel settlement');
    }

    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel({deltaY});
    try {
        await waitForFunctionInPage(page, () => (
            (window as IPdfSettlementProbeWindow).__pdfWheelSettlementProbe?.settled === true
        ), {timeout: timeoutMs});
    } catch (error) {
        await evaluateInPage(page, () => {
            const probeWindow = window as IPdfSettlementProbeWindow;
            probeWindow.__pdfWheelSettlementProbe?.cleanup();
            delete probeWindow.__pdfWheelSettlementProbe;
        }).catch(() => {});
        throw error;
    }
    return evaluateInPage(page, () => {
        const probeWindow = window as IPdfSettlementProbeWindow;
        const probe = probeWindow.__pdfWheelSettlementProbe;
        if (!probe) {
            throw new Error('PDF wheel settlement probe disappeared');
        }
        probe.cleanup();
        delete probeWindow.__pdfWheelSettlementProbe;
        return {
            finalScrollTop: probe.finalScrollTop,
            initialScrollTop: probe.initialScrollTop,
            maxScrollTop: probe.maxScrollTop,
            mutationCount: probe.mutationCount,
            scrollEventCount: probe.scrollEventCount,
        };
    });
}

export async function waitForScannedFixturePageIdentity(
    page: Page,
    pageNumber: number,
    timeoutMs = 15_000,
) {
    const marker = resolveScannedFixturePageMarkerRgb(pageNumber);
    await waitForFunctionInPage(page, (expected: {
        blue: number;
        green: number;
        markerSize: number;
        markerX: number;
        markerY: number;
        pageNumber: number;
        red: number;
    }) => {
        const host = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const canvas = host?.querySelector<HTMLCanvasElement>(
            `.page_container[data-page="${expected.pageNumber}"] .page_canvas canvas`,
        ) ?? null;
        if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
            return false;
        }
        const context = canvas.getContext('2d', {willReadFrequently: true});
        if (!context) {
            return false;
        }
        const centerX = Math.round(
            ((expected.markerX + (expected.markerSize / 2)) / 612) * canvas.width,
        );
        const centerY = Math.round(
            ((792 - expected.markerY - (expected.markerSize / 2)) / 792) * canvas.height,
        );
        const pixel = context.getImageData(centerX, centerY, 1, 1).data;
        return Math.abs((pixel[0] ?? 0) - expected.red) <= 8
            && Math.abs((pixel[1] ?? 0) - expected.green) <= 8
            && Math.abs((pixel[2] ?? 0) - expected.blue) <= 8;
    }, {timeout: timeoutMs}, {
        ...marker,
        markerSize: SCANNED_FIXTURE_MARKER_SIZE,
        markerX: SCANNED_FIXTURE_MARKER_X,
        markerY: SCANNED_FIXTURE_MARKER_Y,
        pageNumber,
    });
}

export function findPdfVirtualizationContractViolations(
    samples: readonly IPdfVirtualizationSnapshot[],
    expectedGap = 20,
) {
    const violations: string[] = [];
    const baselineScrollHeight = samples[0]?.scrollHeight ?? 0;
    const documentTopsByPage = new Map<number, number>();

    samples.forEach((sample, sampleIndex) => {
        if (Math.abs(sample.computedGap - expectedGap) > 1) {
            violations.push(
                `sample ${sampleIndex}: page-track gap ${sample.computedGap}px, expected ${expectedGap}px`,
            );
        }
        if (Math.abs(sample.scrollHeight - baselineScrollHeight) > 1) {
            violations.push(
                `sample ${sampleIndex}: scrollHeight changed from ${baselineScrollHeight}px to ${sample.scrollHeight}px`,
            );
        }

        if (sample.totalPages <= 0) {
            violations.push(`sample ${sampleIndex}: toolbar totalPages was unavailable`);
        }

        if (sample.trackItems.length > 0) {
            const expectedExtent = sample.paddingTop
                + sample.paddingBottom
                + sample.trackItems.reduce((total, item) => total + item.height, 0)
                + (sample.computedGap * Math.max(0, sample.trackItems.length - 1));
            if (Math.abs(sample.scrollHeight - expectedExtent) > 1) {
                violations.push(
                    `sample ${sampleIndex}: scrollHeight ${sample.scrollHeight}px disagrees with page/spacer decomposition ${expectedExtent.toFixed(2)}px`,
                );
            }
        }

        for (let index = 1; index < sample.mountedPages.length; index += 1) {
            const previous = sample.mountedPages[index - 1]!;
            const current = sample.mountedPages[index]!;
            if (current.pageNumber !== previous.pageNumber + 1) {
                continue;
            }
            const actualGap = current.documentTop - (previous.documentTop + previous.height);
            if (Math.abs(actualGap - expectedGap) > 1) {
                violations.push(
                    `sample ${sampleIndex}: pages ${previous.pageNumber}-${current.pageNumber} gap ${actualGap.toFixed(2)}px`,
                );
            }
        }

        sample.trackItems.forEach((item, itemIndex) => {
            const expectedTop = sample.trackDocumentTop
                + sample.paddingTop
                + sample.trackItems.slice(0, itemIndex).reduce((total, previous) => (
                    total + previous.height + sample.computedGap
                ), 0);
            if (Math.abs(item.documentTop - expectedTop) > 1) {
                violations.push(
                    `sample ${sampleIndex}: ${item.kind} ${item.pageNumber ?? itemIndex} documentTop ${item.documentTop.toFixed(2)}px, expected ${expectedTop.toFixed(2)}px`,
                );
            }
        });

        for (const mountedPage of sample.mountedPages) {
            const previousTop = documentTopsByPage.get(mountedPage.pageNumber);
            if (previousTop !== undefined && Math.abs(previousTop - mountedPage.documentTop) > 1) {
                violations.push(
                    `sample ${sampleIndex}: page ${mountedPage.pageNumber} moved in document coordinates by ${Math.abs(previousTop - mountedPage.documentTop).toFixed(2)}px`,
                );
            }
            documentTopsByPage.set(mountedPage.pageNumber, mountedPage.documentTop);
        }
    });

    return Array.from(new Set(violations));
}

export function findMissingVisualFrames(frames: ReadonlyArray<{
    canvasAuthorityReady: boolean;
    canvasConnected?: boolean;
    canvasPixelHeight?: number | null;
    canvasPixelWidth?: number | null;
    frame: number;
    kind: string;
    pageNumber: number | null;
    shellRect?: {
        height: number;
        width: number;
    } | null;
    skeletonSharesShell: boolean;
}>) {
    return frames
        .filter((frame) => {
            const hasCommittedCanvas = frame.kind === 'committed-canvas'
                && frame.canvasAuthorityReady
                && frame.canvasConnected === true
                && (frame.canvasPixelWidth ?? 0) > 0
                && (frame.canvasPixelHeight ?? 0) > 0;
            const hasOwnedPageShell = frame.kind === 'page-shell'
                && (
                    frame.skeletonSharesShell
                    || (
                        (frame.shellRect?.width ?? 0) > 0
                        && (frame.shellRect?.height ?? 0) > 0
                    )
                );
            return !hasCommittedCanvas && !hasOwnedPageShell;
        })
        .map(frame => (
            `frame ${frame.frame} page=${frame.pageNumber ?? 'none'} kind=${frame.kind}`
            + ' had neither an owned page frame nor a committed nonzero visual'
        ));
}
