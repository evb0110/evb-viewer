import {
    afterAll,
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import type {CDPSession} from 'puppeteer-core';
import {execFileSync} from 'node:child_process';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    readFile,
    stat,
} from 'node:fs/promises';
import {
    cleanupRunFixtures,
    createLargeScannedFixturePdf,
    createMixedPageSizeTextFixturePdf,
    createMultiPageTextFixturePdf,
    resolveDjvuFixturePath,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import { getActiveWorkspaceWorkingCopyPath } from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    goToPageViaToolbar,
    openDjvuInApp,
    openPdfInApp,
    waitForActiveDocumentSource,
    waitForDjvuLoaded,
    waitForPdfLoaded,
    waitForToolbarCurrentPage,
    waitForWorkspaceHistorySettled,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    getWorkspaceToolbarSnapshot,
    installWorkspaceExposeProbe,
    requireWorkspaceCommand,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import {
    disablePdfDiagnosticSession,
    enablePdfDiagnosticSession,
} from '@tests/e2e/electron/helpers/pdfDiagnosticSession';
import {
    findCommittedSurfaceCausalOpenViolations,
    findCommittedSurfaceContractViolations,
    findCommittedSurfaceInteractionTailViolations,
    findInitialRenderAuthorityViolations,
    installCommittedSurfaceSampler,
    markCommittedSurfaceInteractionCheckpoint,
    stopCommittedSurfaceSampler,
    summarizeCommittedSurfaceTiming,
    waitForCommittedSurfaceSamples,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';
import {
    collectPdfVirtualizationSnapshot,
    findMissingVisualFrames,
    findPdfVirtualizationContractViolations,
    waitForScannedFixturePageIdentity,
    waitForVisibleMountedPdfCanvases,
    wheelPdfViewportAndWaitForSettlement,
} from '@tests/e2e/electron/helpers/viewerVirtualizationContract';
import { findViewportLifecycleViolations } from '@tests/e2e/electron/helpers/findViewportLifecycleViolations';
import { resolveClockwiseRotationDelta } from '@tests/e2e/electron/helpers/resolveClockwiseRotationDelta';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';

const PR_BLOCKING_SMOKE_TIMEOUT_MS = 90_000;
const LARGE_PDF_INTERACTION_WAIT_TIMEOUT_MS = 45_000;
const LARGE_PDF_VISUAL_READY_TIMEOUT_MS = 30_000;
// The synthetic file is a path/range-IPC regression sentinel, not a codec-fidelity
// substitute for the exact Arnold diagnostic. These budgets retain CI headroom
// over the representative path-backed open flow while rejecting the videoed delay.
// Cold opens include pre-commit qpdf validation, and an occluded Electron
// renderer can expose RAF observations at roughly one-second intervals. Keep
// the budgets tight enough to catch a user-visible stall while leaving one
// sampling quantum of headroom around the validated handoff.
const LARGE_PDF_FIRST_PAGE_SHELL_BUDGET_MS = 2_500;
const LARGE_PDF_FIRST_VISUAL_BUDGET_MS = 5_000;
const LARGE_PDF_GEOMETRY_SETTLE_BUDGET_MS = 1_000;
const LARGE_PDF_READY_AFTER_CANVAS_BUDGET_MS = 1_000;
const LARGE_PDF_SETTLED_OBSERVATION_MS = 3_000;
const LARGE_PDF_PAGE_COUNT = 431;
const PR_BLOCKING_FIXTURE_OWNER = 'pr-blocking-smoke';
const LARGE_PDF_MIN_BYTES = 27 * 1024 * 1024;
const REPEATED_OPEN_SHELL_JITTER_BUDGET_MS = 750;
const DJVU_FIRST_PAGE_SHELL_BUDGET_MS = 1_250;
const LIFECYCLE_ONLY_SURFACE_SAMPLER_OPTIONS = {sampleCanvasPixels: false} as const;
const DJVU_FIRST_VISUAL_BUDGET_MS = 5_000;
const DJVU_READY_AFTER_VISUAL_BUDGET_MS = 1_000;
const PDF_NAVIGATION_SKELETON_DEBOUNCE_MS = 150;
const CDP_CLEANUP_TIMEOUT_MS = 5_000;
const prSmokeScope = process.env.EVB_PR_SMOKE_SCOPE;
const blockingIt = prSmokeScope === 'pressure' ? it.skip : it;
const pressureIt = prSmokeScope === 'blocking' ? it.skip : it;
const djvuBlockingFixture = resolveDjvuFixturePath();
const runDjvuBlockingOrSkip = prSmokeScope === 'pressure'
    ? describe.skip
    : selectFixtureDescribe(describe, djvuBlockingFixture);

interface IPdfRenderTraceEntrySnapshot {
    event: string;
    payload: Record<string, unknown>;
}

interface IPdfRenderTraceReaderWindow extends Window {__getPdfRenderTrace?: () => IPdfRenderTraceEntrySnapshot[];}

interface IPdfFitGeometrySnapshot {
    canvasCssHeight: number;
    canvasCssWidth: number;
    canvasPixelHeight: number;
    canvasPixelWidth: number;
    effectiveZoom: number;
    layerBoundsViolations: string[];
    pageHeight: number;
    pageWidth: number;
    viewportClientHeight: number;
    viewportClientWidth: number;
    viewportScrollWidth: number;
}

async function startPdfRenderTrace(page: Parameters<typeof installCommittedSurfaceSampler>[0]) {
    await enablePdfDiagnosticSession(page, {render: true});
}

async function stopPdfRenderTrace(page: Parameters<typeof installCommittedSurfaceSampler>[0]) {
    const entries = await evaluateInPage(page, () => {
        const traceWindow = window as IPdfRenderTraceReaderWindow;
        return traceWindow.__getPdfRenderTrace?.() ?? [];
    });
    await disablePdfDiagnosticSession(page);
    return entries;
}

async function collectPdfStageDiagnostics(
    page: Parameters<typeof installCommittedSurfaceSampler>[0],
) {
    return evaluateInPage(page, () => {
        const toolbar = (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot?.() ?? null;
        const host = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        );
        const viewport = host?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
        const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
        const traceWindow = window as IPdfRenderTraceReaderWindow;
        const renderTrace = traceWindow.__getPdfRenderTrace?.() ?? [];
        return {
            devicePixelRatio: window.devicePixelRatio,
            toolbar,
            host: host ? {
                attributes: Object.fromEntries(
                    Array.from(host.attributes).map(attribute => [
                        attribute.name,
                        attribute.value,
                    ]),
                ),
                text: host.textContent?.trim().slice(0, 300) ?? '',
            } : null,
            viewport: viewport ? {
                attributes: Object.fromEntries(
                    Array.from(viewport.attributes).map(attribute => [
                        attribute.name,
                        attribute.value,
                    ]),
                ),
                clientHeight: viewport.clientHeight,
                clientWidth: viewport.clientWidth,
                scrollHeight: viewport.scrollHeight,
                scrollLeft: viewport.scrollLeft,
                scrollTop: viewport.scrollTop,
                scrollWidth: viewport.scrollWidth,
            } : null,
            chassis: chassis ? Object.fromEntries(
                Array.from(chassis.attributes).map(attribute => [
                    attribute.name,
                    attribute.value,
                ]),
            ) : null,
            pages: Array.from(viewport?.querySelectorAll<HTMLElement>('.page_container') ?? [])
                .map((pageContainer) => {
                    const rect = pageContainer.getBoundingClientRect();
                    const canvas = pageContainer.querySelector<HTMLCanvasElement>('.page_canvas canvas');
                    return {
                        page: pageContainer.dataset.page ?? null,
                        classes: pageContainer.className,
                        height: rect.height,
                        top: rect.top,
                        width: rect.width,
                        hasSkeleton: pageContainer.querySelector('.document-page-skeleton') !== null,
                        canvas: canvas ? {
                            height: canvas.height,
                            width: canvas.width,
                        } : null,
                    };
                }),
            layers: Array.from(viewport?.querySelectorAll<HTMLElement>(
                '.page_container:not(.page_container--buffered) :is(.text-layer, .textLayer, .annotation-layer, .annotationLayer, .annotation-editor-layer, .annotationEditorLayer)',
            ) ?? []).map((layer) => {
                const owner = layer.closest<HTMLElement>('.page_container');
                const layerRect = layer.getBoundingClientRect();
                const ownerRect = owner?.getBoundingClientRect() ?? null;
                return {
                    className: layer.className,
                    page: owner?.dataset.page ?? null,
                    rect: {
                        bottom: layerRect.bottom,
                        height: layerRect.height,
                        left: layerRect.left,
                        right: layerRect.right,
                        top: layerRect.top,
                        width: layerRect.width,
                    },
                    ownerRect: ownerRect ? {
                        bottom: ownerRect.bottom,
                        height: ownerRect.height,
                        left: ownerRect.left,
                        right: ownerRect.right,
                        top: ownerRect.top,
                        width: ownerRect.width,
                    } : null,
                };
            }),
            viewportAuthorityTrace: renderTrace.filter(entry => (
                entry.event.startsWith('viewport-session-')
                || entry.event.startsWith('navigation-')
                || entry.event.startsWith('workspace-')
            )),
            renderTrace: renderTrace.slice(-60),
        };
    });
}

async function runPdfDiagnosticStage<T>(
    page: Parameters<typeof installCommittedSurfaceSampler>[0],
    stage: string,
    operation: () => Promise<T>,
): Promise<T> {
    console.info(`[pdf-stage:start] ${stage}`);
    try {
        // The operation owns its timeout. Racing it against a second timer leaves
        // the operation running after this wrapper rejects, so fixture cleanup can
        // delete its input while the leaked open is still retrying.
        const result = await operation();
        console.info(`[pdf-stage:done] ${stage}`);
        return result;
    } catch (error) {
        const diagnostics = await collectPdfStageDiagnostics(page).catch(diagnosticError => ({diagnosticError: String(diagnosticError)}));
        throw new Error(
            `[pdf-stage:failed] ${stage}: ${String(error)}; diagnostics=${JSON.stringify(diagnostics)}`,
        );
    }
}

async function runLargePdfInteractionWait<T>(
    page: Parameters<typeof installCommittedSurfaceSampler>[0],
    pageNumber: number,
    operation: () => Promise<T>,
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        const state = await evaluateInPage(page, (targetPage: number) => {
            const pageContainer = document.querySelector<HTMLElement>(
                `.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer .page_container[data-page="${String(targetPage)}"]`,
            );
            const canvas = pageContainer?.querySelector<HTMLCanvasElement>(
                '.page_canvas__render-layer canvas',
            ) ?? null;
            const canvasRect = canvas?.getBoundingClientRect() ?? null;
            const toolbar = (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot?.() ?? null;
            return {
                canvas: canvas ? {
                    height: canvas.height,
                    width: canvas.width,
                } : null,
                canvasRect: canvasRect ? {
                    bottom: canvasRect.bottom,
                    height: canvasRect.height,
                    left: canvasRect.left,
                    right: canvasRect.right,
                    top: canvasRect.top,
                    width: canvasRect.width,
                } : null,
                effectiveZoom: toolbar?.effectiveZoom ?? null,
                rendered: pageContainer?.classList.contains('page_container--rendered') ?? false,
                skeleton: pageContainer?.querySelector('.document-page-skeleton') !== null,
            };
        }, pageNumber).catch(diagnosticError => ({diagnosticError: String(diagnosticError)}));
        throw new Error(`${String(error)}; state=${JSON.stringify(state)}`);
    }
}

async function waitForCommittedEmptyBaseline(
    page: Parameters<typeof installCommittedSurfaceSampler>[0],
) {
    await waitForFunctionInPage(page, () => {
        const isVisible = (element: HTMLElement | null) => {
            if (!element) {
                return false;
            }
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0;
        };
        const startupOverlay = document.querySelector<HTMLElement>('#evb-startup-overlay');
        const placeholder = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .workspace-host__placeholder',
        );
        const mountedEmptyState = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .empty-state',
        );
        const committedEmptySurface = isVisible(mountedEmptyState)
            ? mountedEmptyState
            : placeholder;
        if (isVisible(startupOverlay) || !isVisible(committedEmptySurface)) {
            return false;
        }
        const rect = committedEmptySurface!.getBoundingClientRect();
        const topElement = document.elementFromPoint(
            rect.left + (rect.width / 2),
            rect.top + (rect.height / 2),
        );
        return Boolean(topElement && committedEmptySurface!.contains(topElement));
    }, {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS});
}

async function waitForVisuallyPresentedPdfPage(
    page: Parameters<typeof installCommittedSurfaceSampler>[0],
    pageNumber: number,
) {
    await waitForFunctionInPage(page, (targetPage: number) => {
        const viewer = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer',
        );
        const target = viewer?.querySelector<HTMLElement>(
            `.page_container[data-page="${String(targetPage)}"]`,
        ) ?? null;
        const canvas = target?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
        if (
            !viewer
            || !target
            || !canvas
            || canvas.width <= 0
            || canvas.height <= 0
            || target.querySelector('.document-page-skeleton') !== null
            || window.getComputedStyle(viewer).visibility === 'hidden'
            || window.getComputedStyle(target).visibility === 'hidden'
        ) {
            return false;
        }
        const viewerRect = viewer.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const intersectionLeft = Math.max(viewerRect.left, targetRect.left);
        const intersectionRight = Math.min(viewerRect.right, targetRect.right);
        const intersectionTop = Math.max(viewerRect.top, targetRect.top);
        const intersectionBottom = Math.min(viewerRect.bottom, targetRect.bottom);
        if (intersectionRight <= intersectionLeft || intersectionBottom <= intersectionTop) {
            return false;
        }
        const topmost = document.elementFromPoint(
            intersectionLeft + ((intersectionRight - intersectionLeft) / 2),
            intersectionTop + ((intersectionBottom - intersectionTop) / 2),
        );
        return topmost?.closest('.page_container') === target;
    }, {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS}, pageNumber);
}

async function readCommittedPdfCanvasPixelSize(
    page: Parameters<typeof installCommittedSurfaceSampler>[0],
    pageNumber: number,
) {
    return evaluateInPage(page, (targetPage: number) => {
        const target = document.querySelector<HTMLElement>(
            `.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer .page_container[data-page="${String(targetPage)}"]`,
        );
        const canvas = target?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
        return {
            height: canvas?.height ?? 0,
            skeletonVisible: target?.querySelector('.document-page-skeleton') !== null,
            width: canvas?.width ?? 0,
        };
    }, pageNumber);
}

async function readManagedPdfOpeningGeometry(
    page: Parameters<typeof evaluateInPage>[0],
    workingCopyPath: TDocumentRef,
) {
    return evaluateInPage(page, async (path: TDocumentRef) => {
        const readOpeningGeometry = (window as IE2EWindow).electronAPI
            ?.documentFiles?.getPdfOpeningGeometry;
        if (!readOpeningGeometry) {
            throw new Error('electronAPI PDF opening geometry capability is unavailable');
        }
        return readOpeningGeometry(path);
    }, workingCopyPath);
}

async function waitForManagedPdfRotation(
    workingCopyPath: string,
    expectedRotation: number,
    timeoutMs = PR_BLOCKING_SMOKE_TIMEOUT_MS,
) {
    const deadline = Date.now() + timeoutMs;
    const nativeTools = getPdfNativeToolPaths();
    let rotation: number | null = null;
    while (rotation !== expectedRotation) {
        const pageListing = execFileSync(nativeTools.qpdf, [
            '--show-pages',
            workingCopyPath,
        ], {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            timeout: 10_000,
        });
        const pageObjectMatch = /^page\s+1:\s+(\d+)\s+(\d+)\s+R\s*$/imu.exec(pageListing);
        if (!pageObjectMatch?.[1] || !pageObjectMatch[2]) {
            throw new Error('qpdf did not report the page 1 object');
        }
        const pageObject = execFileSync(nativeTools.qpdf, [
            `--show-object=${pageObjectMatch[1]},${pageObjectMatch[2]}`,
            workingCopyPath,
        ], {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            timeout: 10_000,
        });
        const match = /\/Rotate\s+(-?\d+)\b/u.exec(pageObject);
        const rawRotation = Number.parseInt(match?.[1] ?? '', 10);
        rotation = Number.isSafeInteger(rawRotation)
            ? ((rawRotation % 360) + 360) % 360
            : null;
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for persisted PDF rotation ${expectedRotation}; last observed ${String(rotation)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return rotation;
}

async function waitForCommittedPdfCanvasResize(
    page: Parameters<typeof installCommittedSurfaceSampler>[0],
    pageNumber: number,
    previous: Awaited<ReturnType<typeof readCommittedPdfCanvasPixelSize>>,
    direction: 'larger' | 'smaller',
    timeoutMs = PR_BLOCKING_SMOKE_TIMEOUT_MS,
) {
    const deadline = Date.now() + timeoutMs;
    let current = await readCommittedPdfCanvasPixelSize(page, pageNumber);
    const resized = () => current.width > 0
        && current.height > 0
        && !current.skeletonVisible
        && (direction === 'larger'
            ? current.width > previous.width && current.height > previous.height
            : current.width < previous.width && current.height < previous.height);
    while (!resized()) {
        if (Date.now() >= deadline) {
            throw new Error(
                `Timed out waiting for page ${pageNumber} canvas to become ${direction} than `
                + `${previous.width}x${previous.height}; `
                + `last observed ${current.width}x${current.height}, skeleton=${String(current.skeletonVisible)}`,
            );
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        current = await readCommittedPdfCanvasPixelSize(page, pageNumber);
    }
    return current;
}

async function waitForCommittedFitHeightGeometry(
    page: Parameters<typeof installCommittedSurfaceSampler>[0],
    pageNumber: number,
    expected?: IPdfFitGeometrySnapshot,
) {
    try {
        await waitForFunctionInPage(page, (
            targetPage: number,
            expectedZoom: number | null,
            expectedPageWidth: number | null,
            expectedPageHeightValue: number | null,
            expectedViewportWidth: number | null,
            expectedViewportHeight: number | null,
        ) => {
            const toolbar = (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot?.() ?? null;
            const viewport = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer',
            );
            const pageContainer = viewport?.querySelector<HTMLElement>(
                `.page_container[data-page="${String(targetPage)}"]`,
            ) ?? null;
            // A fit change preserves the pre-fit pixels in a resize snapshot
            // canvas until the new-scale raster commits. Measuring that
            // snapshot would report the previous fit's raster resolution, so
            // read the live render layer and require the preserved copy to be
            // retired before this geometry counts as committed.
            const canvas = pageContainer?.querySelector<HTMLCanvasElement>(
                '.page_canvas .page_canvas__render-layer canvas',
            ) ?? null;
            if (
                toolbar?.zoomMode !== 'fit-height'
            || !viewport
            || !pageContainer
            || !canvas
            || canvas.width <= 0
            || canvas.height <= 0
            || !pageContainer.classList.contains('page_container--rendered')
            || pageContainer.querySelector('.pdf-resize-canvas-snapshot') !== null
            || pageContainer.querySelector('.document-page-skeleton') !== null
            ) {
                return false;
            }
            const pageRect = pageContainer.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            const layerBoundsViolations = Array.from(viewport.querySelectorAll<HTMLElement>(
                '.page_container:not(.page_container--buffered) :is(.text-layer, .textLayer, .annotation-layer, .annotationLayer, .annotation-editor-layer, .annotationEditorLayer)',
            )).flatMap((layer) => {
                const owner = layer.closest<HTMLElement>('.page_container');
                if (!owner) {
                    return [`${layer.className}:missing-page-owner`];
                }
                const ownerRect = owner.getBoundingClientRect();
                const layerRect = layer.getBoundingClientRect();
                // PDF.js deliberately collapses a disabled, non-editing editor
                // layer to a 0x0 box. It is not a presented visual layer and its
                // origin is therefore unrelated to the owning page geometry.
                const isPresented = layerRect.width > 0 && layerRect.height > 0;
                const exceedsOwner = isPresented && (layerRect.left < ownerRect.left - 1
                || layerRect.top < ownerRect.top - 1
                || layerRect.right > ownerRect.right + 1
                || layerRect.bottom > ownerRect.bottom + 1
                || layerRect.width > ownerRect.width + 1
                || layerRect.height > ownerRect.height + 1);
                return exceedsOwner
                    ? [`${layer.className}:page-${owner.dataset.page ?? 'unknown'}`]
                    : [];
            });
            const expectedPageHeight = viewport.clientHeight - 40;
            const isCanonicalFitHeight = Math.abs(pageRect.height - expectedPageHeight) <= 1.5
            && Math.abs(canvasRect.width - pageRect.width) <= 1
            && Math.abs(canvasRect.height - pageRect.height) <= 1
            && layerBoundsViolations.length === 0
            && viewport.scrollWidth <= viewport.clientWidth + 1;
            if (!isCanonicalFitHeight) {
                return false;
            }
            if (
                expectedZoom === null
            || expectedPageWidth === null
            || expectedPageHeightValue === null
            || expectedViewportWidth === null
            || expectedViewportHeight === null
            ) {
                return true;
            }
            return Math.abs(toolbar.effectiveZoom - expectedZoom) <= 0.001
            && Math.abs(pageRect.width - expectedPageWidth) <= 1
            && Math.abs(pageRect.height - expectedPageHeightValue) <= 1
            && viewport.clientWidth === expectedViewportWidth
            && viewport.clientHeight === expectedViewportHeight;
        }, {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS},
        pageNumber,
        expected?.effectiveZoom ?? null,
        expected?.pageWidth ?? null,
        expected?.pageHeight ?? null,
        expected?.viewportClientWidth ?? null,
        expected?.viewportClientHeight ?? null);
    } catch (error) {
        const diagnostics = await evaluateInPage(page, (targetPage: number) => {
            const toolbar = (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot?.() ?? null;
            const viewport = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer',
            );
            const pageContainer = viewport?.querySelector<HTMLElement>(
                `.page_container[data-page="${String(targetPage)}"]`,
            ) ?? null;
            const canvas = pageContainer?.querySelector<HTMLCanvasElement>(
                '.page_canvas .page_canvas__render-layer canvas',
            ) ?? null;
            const pageRect = pageContainer?.getBoundingClientRect() ?? null;
            const canvasRect = canvas?.getBoundingClientRect() ?? null;
            const traceWindow = window as IPdfRenderTraceReaderWindow;
            const layers = Array.from(viewport?.querySelectorAll<HTMLElement>(
                '.page_container:not(.page_container--buffered) :is(.text-layer, .textLayer, .annotation-layer, .annotationLayer, .annotation-editor-layer, .annotationEditorLayer)',
            ) ?? []).map((layer) => {
                const owner = layer.closest<HTMLElement>('.page_container');
                const ownerRect = owner?.getBoundingClientRect() ?? null;
                const layerRect = layer.getBoundingClientRect();
                return {
                    className: layer.className,
                    page: owner?.dataset.page ?? null,
                    rect: {
                        bottom: layerRect.bottom,
                        height: layerRect.height,
                        left: layerRect.left,
                        right: layerRect.right,
                        top: layerRect.top,
                        width: layerRect.width,
                    },
                    ownerRect: ownerRect ? {
                        bottom: ownerRect.bottom,
                        height: ownerRect.height,
                        left: ownerRect.left,
                        right: ownerRect.right,
                        top: ownerRect.top,
                        width: ownerRect.width,
                    } : null,
                };
            });
            return {
                toolbar,
                viewport: viewport ? {
                    clientHeight: viewport.clientHeight,
                    clientWidth: viewport.clientWidth,
                    scrollHeight: viewport.scrollHeight,
                    scrollLeft: viewport.scrollLeft,
                    scrollTop: viewport.scrollTop,
                    scrollWidth: viewport.scrollWidth,
                } : null,
                page: pageRect ? {
                    height: pageRect.height,
                    left: pageRect.left,
                    top: pageRect.top,
                    width: pageRect.width,
                    hasResizeSnapshot: pageContainer?.querySelector('.pdf-resize-canvas-snapshot') !== null,
                    hasSkeleton: pageContainer?.querySelector('.document-page-skeleton') !== null,
                    isRendered: pageContainer?.classList.contains('page_container--rendered') ?? false,
                } : null,
                canvas: canvasRect ? {
                    cssHeight: canvasRect.height,
                    cssWidth: canvasRect.width,
                    pixelHeight: canvas?.height ?? 0,
                    pixelWidth: canvas?.width ?? 0,
                } : null,
                layers,
                renderTrace: traceWindow.__getPdfRenderTrace?.().slice(-40) ?? [],
            };
        }, pageNumber);
        throw new Error(
            `Fit-height geometry did not settle: ${JSON.stringify(diagnostics)}; cause: ${String(error)}`,
        );
    }

    return evaluateInPage(page, (targetPage: number): IPdfFitGeometrySnapshot => {
        const toolbar = (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot?.() ?? null;
        const viewport = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer',
        )!;
        const pageContainer = viewport.querySelector<HTMLElement>(
            `.page_container[data-page="${String(targetPage)}"]`,
        )!;
        const canvas = pageContainer.querySelector<HTMLCanvasElement>(
            '.page_canvas .page_canvas__render-layer canvas',
        )!;
        if (!toolbar) {
            throw new Error('Active toolbar snapshot is unavailable');
        }
        const pageRect = pageContainer.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const layerBoundsViolations = Array.from(viewport.querySelectorAll<HTMLElement>(
            '.page_container:not(.page_container--buffered) :is(.text-layer, .textLayer, .annotation-layer, .annotationLayer, .annotation-editor-layer, .annotationEditorLayer)',
        )).flatMap((layer) => {
            const owner = layer.closest<HTMLElement>('.page_container');
            if (!owner) {
                return [`${layer.className}:missing-page-owner`];
            }
            const ownerRect = owner.getBoundingClientRect();
            const layerRect = layer.getBoundingClientRect();
            const isPresented = layerRect.width > 0 && layerRect.height > 0;
            const exceedsOwner = isPresented && (layerRect.left < ownerRect.left - 1
                || layerRect.top < ownerRect.top - 1
                || layerRect.right > ownerRect.right + 1
                || layerRect.bottom > ownerRect.bottom + 1
                || layerRect.width > ownerRect.width + 1
                || layerRect.height > ownerRect.height + 1);
            return exceedsOwner
                ? [`${layer.className}:page-${owner.dataset.page ?? 'unknown'}`]
                : [];
        });
        return {
            canvasCssHeight: canvasRect.height,
            canvasCssWidth: canvasRect.width,
            canvasPixelHeight: canvas.height,
            canvasPixelWidth: canvas.width,
            effectiveZoom: toolbar.effectiveZoom,
            layerBoundsViolations,
            pageHeight: pageRect.height,
            pageWidth: pageRect.width,
            viewportClientHeight: viewport.clientHeight,
            viewportClientWidth: viewport.clientWidth,
            viewportScrollWidth: viewport.scrollWidth,
        };
    }, pageNumber);
}

async function closeActiveDocumentToEmpty(
    page: Parameters<typeof installCommittedSurfaceSampler>[0],
) {
    const closed = await evaluateInPage(page, () => {
        const activeTab = document.querySelector<HTMLElement>('.tab-list .tab.is-active');
        const closeButton = activeTab?.querySelector<HTMLButtonElement>('.tab-close') ?? null;
        closeButton?.click();
        return closeButton !== null;
    });
    expect(closed).toBe(true);
    await waitForCommittedEmptyBaseline(page);
}

async function openActionableRecentFile(
    page: Parameters<typeof installCommittedSurfaceSampler>[0],
    sourcePath: string,
) {
    await waitForFunctionInPage(page, (targetSourcePath: string) => {
        const row = Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .recent-row--data:not(.recent-row--skeleton)',
        )).find(candidate => (
            candidate.dataset.recentOpenActionable === 'true'
            && candidate.dataset.recentSource === targetSourcePath
        ));
        if (!row) {
            return false;
        }
        (window as Window & {__committedSurfaceInteractionCheckpoint?: string | null;})
            .__committedSurfaceInteractionCheckpoint = 'recent-djvu-click';
        row.click();
        return true;
    }, {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS}, sourcePath);
}

async function captureRepeatedLargePdfOpen(
    page: Parameters<typeof installCommittedSurfaceSampler>[0],
    fixturePath: string,
) {
    await installCommittedSurfaceSampler(page);
    await startPdfRenderTrace(page);
    await openPdfInApp(page, fixturePath, LARGE_PDF_VISUAL_READY_TIMEOUT_MS);
    await runPdfDiagnosticStage(page, 'large-reopen:wait-authoritative-page-ready', () => waitForFunctionInPage(page, () => {
        const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer');
        const chassis = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .document-viewer-chassis',
        );
        const requestedPage = Number(chassis?.dataset.viewportRequestedPage ?? 0);
        const committedPage = Number(chassis?.dataset.viewportCommittedPage ?? 0);
        const canvas = viewer?.querySelector<HTMLCanvasElement>(
            `.page_container[data-page="${requestedPage}"] .page_canvas canvas`,
        ) ?? null;
        return Boolean(
            requestedPage > 0
            && committedPage === requestedPage
            && canvas
            && canvas.width > 0
            && canvas.height > 0
            && viewer?.dataset.openSurfacePhase === 'ready'
            && chassis?.dataset.openSurfacePresentation === 'committed',
        );
    }, {timeout: LARGE_PDF_VISUAL_READY_TIMEOUT_MS}));
    // The DOM readiness probe above can complete between two throttled RAFs.
    // Keep polling from the host until the causal sampler has observed the
    // committed surface itself; otherwise a healthy reopen can be reported as
    // having no committed canvas at all.
    await waitForCommittedSurfaceSamples(page, {
        kind: 'committed-canvas',
        minimumSamples: 10,
    });
    const lifecycleState = await evaluateInPage(page, () => {
        const loadedHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(host => host.querySelector('#pdf-viewer .page_container'));
        const hiddenLoadedHosts = loadedHosts.filter((host) => {
            const rect = host.getBoundingClientRect();
            const style = window.getComputedStyle(host);
            return rect.width <= 0
                || rect.height <= 0
                || style.display === 'none'
                || style.visibility === 'hidden';
        });
        return {
            committedPage: Number(
                document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .document-viewer-chassis',
                )?.dataset.viewportCommittedPage ?? 0,
            ),
            hiddenLoadedHostCount: hiddenLoadedHosts.length,
            loadedHostCount: loadedHosts.length,
        };
    });
    const surfaceTrace = await stopCommittedSurfaceSampler(page);
    const renderTrace = await stopPdfRenderTrace(page);
    return {
        renderTrace,
        surfaceTrace,
        lifecycleState,
    };
}

async function waitForAnimationFrames(
    _page: Parameters<typeof installCommittedSurfaceSampler>[0],
    frameCount = 12,
) {
    // Occluded Electron renderers can throttle requestAnimationFrame to roughly
    // one callback per second. A host-side settle avoids leaving a pending CDP
    // evaluation that serializes every later page command behind that throttle.
    await new Promise(resolve => setTimeout(resolve, Math.max(2_000, frameCount * 100)));
}

interface ILargePdfOpenSample {
    bodyOverflow: number;
    documentOverflow: number;
    currentPageCanvasPixelHeight: number | null;
    currentPageCanvasPixelWidth: number | null;
    currentPageCanvasLuminanceRange: number;
    currentPageCanvasNonblankPixels: number;
    elapsedMs: number;
    horizontalOverflow: number | null;
    hostLoaderCount: number;
    hostLoaderSkeletonCount: number;
    hostLoaderSpinnerCount: number;
    pageCanvasBackgroundColor: string | null;
    pageCanvasBorderRadius: string | null;
    pageCanvasBoxShadow: string | null;
    pageCanvasHeight: number | null;
    pageCanvasLeft: number | null;
    pageCanvasTop: number | null;
    pageCanvasWidth: number | null;
    pageSkeletonBackgroundColor: string | null;
    pageSkeletonBorderRadius: string | null;
    pageSkeletonBoxShadow: string | null;
    pageSkeletonCount: number;
    pageSkeletonHeight: number | null;
    pageSkeletonLeft: number | null;
    pageSkeletonTop: number | null;
    pageSkeletonVisible: boolean;
    pageSkeletonWidth: number | null;
    openSurfaceCount: number;
    openSurfaceSkeletonCount: number;
    openSurfaceSpinnerCount: number;
    openSurfacePhase: string | null;
    openSurfaceVisible: boolean;
    pageHeight: number | null;
    pageTop: number | null;
    pageWidth: number | null;
    sampleSource: 'mutation' | 'raf';
    viewportClientWidth: number | null;
    viewportScrollLeft: number | null;
    viewportScrollTop: number | null;
    visibleCanvasReady: boolean;
}

interface ILargePdfVisualState {
    canvasHeight: number;
    canvasWidth: number;
    horizontalOverflow: number;
    hiddenLoadedHostCount: number;
    loadedHostCount: number;
    nestedPdfViewerCount: number;
    renderedPageCount: number;
    visibleCanvasCount: number;
    visibleLoadingStateCount: number;
    visibleOpenSurfaceCount: number;
    visibleOpeningFallbackCount: number;
    visibleSkeletonCount: number;
}

describe('Electron E2E - PR Blocking Smoke', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: false,
        sessionName: 'e2e-pr-blocking-smoke',
        timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS,
    });
    let viewportLifecycleCpuThrottleClient: CDPSession | null = null;
    let viewportLifecycleCpuThrottleRelease: Promise<void> | null = null;
    async function runBoundedCdpCleanup(
        label: string,
        cleanup: () => Promise<unknown>,
        timeoutMs = CDP_CLEANUP_TIMEOUT_MS,
    ) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                cleanup(),
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => reject(new Error(
                        `${label} did not complete within ${String(timeoutMs)}ms`,
                    )), timeoutMs);
                }),
            ]);
        } finally {
            if (timeout !== undefined) {
                clearTimeout(timeout);
            }
        }
    }
    async function releaseViewportLifecycleCpuThrottle() {
        if (viewportLifecycleCpuThrottleRelease) {
            return viewportLifecycleCpuThrottleRelease;
        }
        const client = viewportLifecycleCpuThrottleClient;
        if (!client) {
            return;
        }
        const release = (async () => {
            const errors: unknown[] = [];
            try {
                await runBoundedCdpCleanup('CPU throttle reset', () => (
                    client.send('Emulation.setCPUThrottlingRate', {rate: 1})
                ));
            } catch (error) {
                errors.push(error);
            }
            try {
                await runBoundedCdpCleanup('CPU throttle CDP detach', () => client.detach());
            } catch (error) {
                errors.push(error);
            }
            if (errors.length > 0) {
                throw new AggregateError(errors, 'Failed to release viewport lifecycle CPU throttling');
            }
        })();
        viewportLifecycleCpuThrottleRelease = release;
        try {
            await release;
            if (viewportLifecycleCpuThrottleClient === client) {
                viewportLifecycleCpuThrottleClient = null;
            }
        } finally {
            if (viewportLifecycleCpuThrottleRelease === release) {
                viewportLifecycleCpuThrottleRelease = null;
            }
        }
    }
    afterEach(async () => {
        try {
            await releaseViewportLifecycleCpuThrottle();
        } catch (error) {
            console.warn('[E2E cleanup] CDP throttle reset failed; replacing the owning renderer session', error);
            try {
                await runBoundedCdpCleanup('CPU throttle renderer replacement', () => (
                    sessionFixture.restart({
                        clean: true,
                        hard: true,
                        keepNuxt: true,
                        sessionName: 'e2e-pr-blocking-timeout-recovery',
                    })
                ), 45_000);
            } finally {
                viewportLifecycleCpuThrottleClient = null;
                viewportLifecycleCpuThrottleRelease = null;
            }
        }
    }, 60_000);
    afterAll(() => cleanupRunFixtures(PR_BLOCKING_FIXTURE_OWNER));

    blockingIt('reports the canonical 0.1.x application version from the real Electron runtime', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: 'e2e-pr-blocking-version',
        });

        const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {version?: unknown};
        expect(packageJson.version).toMatch(/^0\.1\.\d+$/u);

        await waitForFunctionInPage(session.page, () => Boolean(
            (window as IE2EWindow).electronAPI?.updates,
        ), {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS});
        const updateState = await evaluateInPage(session.page, async () => {
            const electronAPI = (window as IE2EWindow).electronAPI;
            if (!electronAPI) {
                return null;
            }
            return Promise.race([
                electronAPI.updates.getState(),
                new Promise<never>((_resolve, reject) => {
                    window.setTimeout(() => reject(new Error('updates.getState timed out')), 10_000);
                }),
            ]);
        });

        expect(updateState).not.toBeNull();
        expect(updateState?.version).toBe(packageJson.version);
    });

    blockingIt('keeps a long inactive-tab title clear of its hovered close button', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: 'e2e-pr-blocking-inactive-tab-close',
        });

        const fixturePath = await createMultiPageTextFixturePdf(
            'inactive-tab-close-regression-with-an-intentionally-long-document-name.pdf',
            1,
        );
        await openPdfInApp(session.page, fixturePath, PR_BLOCKING_SMOKE_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS);

        const inactiveTabId = await evaluateInPage(session.page, () => {
            const activeTab = document.querySelector<HTMLElement>('.tab-list .tab.is-active[data-tab-id]');
            const newTabButton = document.querySelector<HTMLButtonElement>('.tab-bar .tab-new');
            newTabButton?.click();
            return activeTab?.dataset.tabId ?? null;
        });
        expect(inactiveTabId).not.toBeNull();
        await waitForFunctionInPage(session.page, (tabId: string) => {
            const target = Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'))
                .find(tab => tab.dataset.tabId === tabId);
            return Boolean(target && !target.classList.contains('is-active'));
        }, {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS}, inactiveTabId ?? '');

        const targetSelector = `.tab-list .tab[data-tab-id="${inactiveTabId}"]`;
        await session.page.hover(targetSelector);
        await waitForFunctionInPage(session.page, (tabId: string) => {
            const tab = Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'))
                .find(candidate => candidate.dataset.tabId === tabId) ?? null;
            const close = tab?.querySelector<HTMLElement>('.tab-close') ?? null;
            return Boolean(close && Number(window.getComputedStyle(close).opacity) >= 0.99);
        }, {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS}, inactiveTabId ?? '');
        const geometry = await evaluateInPage(session.page, (tabId: string) => {
            const tab = Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'))
                .find(candidate => candidate.dataset.tabId === tabId) ?? null;
            const label = tab?.querySelector<HTMLElement>('.tab-label') ?? null;
            const close = tab?.querySelector<HTMLElement>('.tab-close') ?? null;
            const tabRect = tab?.getBoundingClientRect() ?? null;
            const labelRect = label?.getBoundingClientRect() ?? null;
            const closeRect = close?.getBoundingClientRect() ?? null;
            const closeCenterOwner = closeRect
                ? document.elementFromPoint(
                    closeRect.left + (closeRect.width / 2),
                    closeRect.top + (closeRect.height / 2),
                )?.closest('.tab-close') === close
                : false;
            return {
                closeCenterOwner,
                closeOpacity: close ? Number(window.getComputedStyle(close).opacity) : 0,
                closeRect: closeRect ? {
                    left: closeRect.left,
                    right: closeRect.right,
                } : null,
                labelIsEllipsized: Boolean(label && label.scrollWidth > label.clientWidth),
                labelRect: labelRect ? {
                    left: labelRect.left,
                    right: labelRect.right,
                } : null,
                tabRect: tabRect ? {
                    left: tabRect.left,
                    right: tabRect.right,
                } : null,
            };
        }, inactiveTabId ?? '');

        expect(geometry.labelIsEllipsized, JSON.stringify(geometry)).toBe(true);
        expect(geometry.closeOpacity, JSON.stringify(geometry)).toBeGreaterThanOrEqual(0.99);
        expect(geometry.closeCenterOwner, JSON.stringify(geometry)).toBe(true);
        expect(geometry.labelRect, JSON.stringify(geometry)).not.toBeNull();
        expect(geometry.closeRect, JSON.stringify(geometry)).not.toBeNull();
        expect(geometry.tabRect, JSON.stringify(geometry)).not.toBeNull();
        expect(
            geometry.labelRect?.right ?? Number.POSITIVE_INFINITY,
            JSON.stringify(geometry),
        ).toBeLessThanOrEqual(geometry.closeRect?.left ?? Number.NEGATIVE_INFINITY);
        expect(
            geometry.closeRect?.right ?? Number.POSITIVE_INFINITY,
            JSON.stringify(geometry),
        ).toBeLessThanOrEqual(geometry.tabRect?.right ?? Number.NEGATIVE_INFINITY);
    });

    blockingIt('opens a PDF, persists a real IPC rotation, and navigates the viewer', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: 'e2e-pr-blocking-rotation-navigation',
        });

        const fixturePath = await createMultiPageTextFixturePdf('pr-blocking-smoke.pdf', 3);
        await runPdfDiagnosticStage(session.page, 'rotation:open-pdf', () => (
            openPdfInApp(session.page, fixturePath, PR_BLOCKING_SMOKE_TIMEOUT_MS)
        ));
        await runPdfDiagnosticStage(session.page, 'rotation:wait-loaded', () => (
            waitForPdfLoaded(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS)
        ));
        await runPdfDiagnosticStage(session.page, 'rotation:wait-initial-toolbar', () => (
            waitForWorkspaceToolbarSnapshot(
                session.page,
                {
                    hasPdf: true,
                    currentPage: 1,
                    minTotalPages: 3,
                },
                {timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS},
            )
        ));

        const workingCopyPath = await runPdfDiagnosticStage(
            session.page,
            'rotation:resolve-working-copy',
            () => getActiveWorkspaceWorkingCopyPath(session.page),
        );
        const persistedBeforeRotation = await readManagedPdfOpeningGeometry(
            session.page,
            workingCopyPath,
        );
        expect(persistedBeforeRotation).not.toBeNull();
        const rotationDelta = resolveClockwiseRotationDelta(
            persistedBeforeRotation?.rotation ?? 0,
            90,
        );
        if (rotationDelta !== 0) {
            const surfaceRevisionBeforeRotation = await evaluateInPage(session.page, () => (
                document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .document-viewer-chassis',
                )?.dataset.openSurfaceDocumentRevision ?? null
            ));
            await runPdfDiagnosticStage(
                session.page,
                'rotation:persist-workspace-mutation',
                () => requireWorkspaceCommand(session.page, 'handleRotateCw', [[1]]),
            );
            await runPdfDiagnosticStage(session.page, 'rotation:wait-workspace-reload', () => (
                waitForFunctionInPage(session.page, (previousRevision: string | null) => {
                    const chassis = document.querySelector<HTMLElement>(
                        '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .document-viewer-chassis',
                    );
                    const viewer = document.querySelector<HTMLElement>(
                        '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer',
                    );
                    const toolbar = (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot?.();
                    return Boolean(
                        chassis
                        && chassis.dataset.openSurfaceDocumentRevision !== previousRevision
                        && chassis.dataset.openSurfacePresentation === 'committed'
                        && viewer?.dataset.openSurfacePhase === 'ready'
                        && toolbar
                        && toolbar.currentPage === 1
                        && !toolbar.isPageOperationInProgress,
                    );
                }, {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS}, surfaceRevisionBeforeRotation)
            ));
        }
        const persistedRotation = await runPdfDiagnosticStage(
            session.page,
            'rotation:wait-persisted-bytes',
            () => waitForManagedPdfRotation(workingCopyPath, 90),
        );
        expect(persistedRotation).toBe(90);
        // The revision commits before the bounded managed-shape import finishes.
        // Let that post-mutation refresh settle before issuing a page command,
        // otherwise it can legitimately restore the reload anchor on page 1.
        await waitForAnimationFrames(session.page, 10);

        // Adjacent-page prefetch is opportunistic. Requiring page 2 to have a
        // canvas before navigation made this smoke wait forever whenever the
        // authoritative visible render correctly won the scheduling race.
        // The contract is that navigation itself promotes page 2 to required
        // demand and reaches a committed visual, whether or not it was warm.

        await runPdfDiagnosticStage(
            session.page,
            'rotation:set-actual-size',
            () => requireWorkspaceCommand(session.page, 'handleActualSize'),
        );
        await runPdfDiagnosticStage(session.page, 'rotation:wait-actual-size', () => (
            waitForFunctionInPage(session.page, () => (
                (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot?.()?.zoomMode === 'custom'
            ), {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS})
        ));
        expect((await getWorkspaceToolbarSnapshot(session.page))?.zoomMode).toBe('custom');

        await installCommittedSurfaceSampler(session.page);
        await startPdfRenderTrace(session.page);
        let navigationSurfaceTrace: Awaited<ReturnType<typeof stopCommittedSurfaceSampler>> = {frames: []};
        let navigationRenderTrace: IPdfRenderTraceEntrySnapshot[] = [];
        try {
            await runPdfDiagnosticStage(
                session.page,
                'rotation:navigate-next',
                () => requireWorkspaceCommand(session.page, 'handleGoToPage', [2]),
            );
            await runPdfDiagnosticStage(session.page, 'rotation:wait-page-2-toolbar', () => (
                waitForToolbarCurrentPage(session.page, 2)
            ));
            await runPdfDiagnosticStage(
                session.page,
                'rotation:set-fit-width',
                () => requireWorkspaceCommand(session.page, 'handleFitWidth'),
            );
            await runPdfDiagnosticStage(session.page, 'rotation:wait-fit-width', () => (
                waitForFunctionInPage(session.page, () => (
                    (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot?.()?.zoomMode === 'fit-width'
                ), {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS})
            ));

            await runPdfDiagnosticStage(session.page, 'rotation:wait-page-2-snapshot', () => (
                waitForWorkspaceToolbarSnapshot(
                    session.page,
                    {
                        hasPdf: true,
                        currentPage: 2,
                        minTotalPages: 3,
                    },
                    {timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS},
                )
            ));
            await runPdfDiagnosticStage(session.page, 'rotation:wait-page-2-visual', () => (
                waitForVisuallyPresentedPdfPage(session.page, 2)
            ));
            await waitForAnimationFrames(session.page, 10);
        } finally {
            navigationSurfaceTrace = await stopCommittedSurfaceSampler(session.page);
            navigationRenderTrace = await stopPdfRenderTrace(session.page);
        }
        expect(
            findMissingVisualFrames(navigationSurfaceTrace.frames),
            JSON.stringify({
                frames: navigationSurfaceTrace.frames,
                renderTrace: navigationRenderTrace,
            }),
        ).toEqual([]);
        expect((await getWorkspaceToolbarSnapshot(session.page))?.zoomMode).toBe('fit-width');
    });

    blockingIt('fits paged spreads without buffer overflow or phantom gutters', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: 'e2e-pr-blocking-fit-height-overflow',
        });
        const fixturePath = await createMultiPageTextFixturePdf('fit-height-overflow.pdf', 7);
        await openPdfInApp(session.page, fixturePath, PR_BLOCKING_SMOKE_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS);
        await evaluateInPage(session.page, () => {
            // Keep the original fractional-height case as well as spread layout.
            document.querySelector<HTMLElement>('#pdf-viewer')!.style.height = '445.6px';
        });
        await requireWorkspaceCommand(session.page, 'handleFitHeight');
        await requireWorkspaceCommand(session.page, 'handleToggleContinuousScroll');
        await waitForWorkspaceToolbarSnapshot(session.page, {continuousScroll: false});

        async function chooseViewMode(index: number) {
            await session.page.click('#editor-global-toolbar-host .zoom-controls-display');
            await session.page.waitForSelector('.zoom-dropdown', {visible: true});
            const point = await evaluateInPage(session.page, (modeIndex: number) => {
                const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(
                    '.zoom-dropdown .zoom-toggle-btn',
                )).slice(-3);
                const rect = buttons[modeIndex]!.getBoundingClientRect();
                return {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                };
            }, index);
            await session.page.mouse.click(point.x, point.y);
            const modes = [
                'single',
                'facing',
                'facing-first-single',
            ] as const;
            await waitForFunctionInPage(session.page, (expectedMode: string) => (
                (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot?.()?.viewMode === expectedMode
            ), {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS}, modes[index]!);
        }

        async function readSpread() {
            return evaluateInPage(session.page, () => {
                const viewport = document.querySelector<HTMLElement>('#pdf-viewer')!;
                const bounds = viewport.getBoundingClientRect();
                const pages = Array.from(viewport.querySelectorAll<HTMLElement>(
                    '.page_container:not(.page_container--buffered)',
                )).map(element => {
                    const rect = element.getBoundingClientRect();
                    return {
                        page: Number(element.dataset.page),
                        left: rect.left,
                        right: rect.right,
                        top: rect.top,
                        bottom: rect.bottom,
                    };
                });
                return {
                    pages,
                    top: bounds.top,
                    bottom: bounds.bottom,
                    trackBottom: viewport.querySelector('[data-pdf-page-track]')!.getBoundingClientRect().bottom,
                    left: bounds.left,
                    width: viewport.clientWidth,
                    scrollRange: viewport.scrollHeight - viewport.clientHeight,
                    scrollTop: viewport.scrollTop,
                };
            });
        }

        // L1: buffering is invisible to fit geometry, at both document ends and
        // in an interior spread. The menu action is trusted pointer input.
        for (const pageNumber of [
            1,
            4,
            7,
        ]) {
            await goToPageViaToolbar(session.page, pageNumber);
            for (const mode of [
                0,
                1,
                2,
            ]) {
                await chooseViewMode(mode);
                await waitForCommittedFitHeightGeometry(session.page, pageNumber);
                const spread = await readSpread();
                expect(spread.scrollRange, JSON.stringify({
                    pageNumber,
                    mode,
                    spread,
                })).toBe(0);
                expect(spread.scrollTop).toBe(0);
                // clientHeight is rounded; compare physical boxes as well to
                // catch the original fractional-pixel overflow.
                expect(spread.trackBottom).toBeLessThanOrEqual(spread.bottom);
                expect(spread.pages.some(page => page.page === pageNumber)).toBe(true);
                for (const page of spread.pages) {
                    expect(page.top).toBeGreaterThanOrEqual(spread.top);
                    expect(page.bottom).toBeLessThanOrEqual(spread.bottom);
                }
            }
        }

        // Rotation is setup; switching back to Single exercises the same
        // layout transition with PDF.js text/link layers in rotated coordinates.
        for (const rotation of [
            90,
            270,
            0,
        ]) {
            await requireWorkspaceCommand(session.page, 'setViewRotation', [rotation]);
            await chooseViewMode(0);
            await waitForCommittedFitHeightGeometry(session.page, 7);
            const spread = await readSpread();
            expect(spread.scrollRange, JSON.stringify({
                rotation,
                spread,
            })).toBe(0);
            expect(spread.trackBottom).toBeLessThanOrEqual(spread.bottom);
        }

        async function waitForUnpairedFitWidth() {
            await waitForVisibleMountedPdfCanvases(session.page);
            await waitForFunctionInPage(session.page, () => {
                const viewport = document.querySelector<HTMLElement>('#pdf-viewer');
                const pages = viewport?.querySelectorAll<HTMLElement>(
                    '.page_container:not(.page_container--buffered)',
                );
                const page = pages?.[0];
                return Boolean(viewport && page && pages?.length === 1
                    && page.dataset.page === '7'
                    && page.querySelector('.pdf-resize-canvas-snapshot') === null
                    && Math.abs(page.getBoundingClientRect().width - (viewport.clientWidth - 40)) <= 1);
            }, {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS});
        }

        // A lone last page in Facing must fill the same width as Single. It
        // has no partner, hence no inter-page gutter to reserve (L1).
        await chooseViewMode(0);
        await requireWorkspaceCommand(session.page, 'handleFitWidth');
        await waitForWorkspaceToolbarSnapshot(session.page, {zoomMode: 'fit-width'});
        await waitForUnpairedFitWidth();
        const single = await readSpread();
        await chooseViewMode(1);
        await waitForUnpairedFitWidth();
        const facing = await readSpread();
        expect(facing.pages).toHaveLength(1);
        expect(Math.abs((facing.pages[0]!.right - facing.pages[0]!.left)
            - (single.pages[0]!.right - single.pages[0]!.left))).toBeLessThanOrEqual(1);
    });

    blockingIt('keeps buffered neighbors out of the paged fit-height scroll extent', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: 'e2e-pr-blocking-paged-fit-height-buffered-scroll',
        });
        const fixturePath = await createMixedPageSizeTextFixturePdf(
            'paged-fit-height-buffered-scroll.pdf',
        );
        await openPdfInApp(session.page, fixturePath, PR_BLOCKING_SMOKE_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS);
        await requireWorkspaceCommand(session.page, 'handleFitHeight');
        await requireWorkspaceCommand(session.page, 'handleToggleContinuousScroll');
        await waitForWorkspaceToolbarSnapshot(session.page, {
            continuousScroll: false,
            currentPage: 1,
        });
        await waitForCommittedFitHeightGeometry(session.page, 1);

        const viewportPoint = await evaluateInPage(session.page, () => {
            const viewport = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer',
            );
            if (!viewport) {
                throw new Error('Active PDF viewport is missing');
            }
            const rect = viewport.getBoundingClientRect();
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            };
        });
        await session.page.mouse.move(viewportPoint.x, viewportPoint.y);
        await session.page.mouse.wheel({deltaY: 708});
        await waitForToolbarCurrentPage(session.page, 2);
        await waitForCommittedFitHeightGeometry(session.page, 2);

        const observation = await evaluateInPage(session.page, () => {
            const viewport = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer',
            );
            const activePage = viewport?.querySelector<HTMLElement>('.page_container[data-page="2"]');
            if (!viewport || !activePage) {
                throw new Error('Paged fit-height observation target is missing');
            }
            const viewportRect = viewport.getBoundingClientRect();
            const pageRect = activePage.getBoundingClientRect();
            return {
                activePageBottom: pageRect.bottom,
                viewportBottom: viewportRect.bottom,
                overflowY: getComputedStyle(viewport).overflowY,
                scrollRange: viewport.scrollHeight - viewport.clientHeight,
                scrollTop: viewport.scrollTop,
            };
        });

        expect(observation, JSON.stringify(observation)).toMatchObject({
            overflowY: 'hidden',
            scrollRange: 0,
            scrollTop: 0,
        });
        expect(observation.activePageBottom).toBeLessThanOrEqual(observation.viewportBottom + 1);
    });

    blockingIt('keeps fit-height geometry stable across continuous and paged modes', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: 'e2e-pr-blocking-fit-height',
        });

        const fixturePath = await createMultiPageTextFixturePdf('pr-blocking-fit-height.pdf', 3);
        await runPdfDiagnosticStage(session.page, 'fit:open-pdf', () => (
            openPdfInApp(session.page, fixturePath, PR_BLOCKING_SMOKE_TIMEOUT_MS)
        ));
        await runPdfDiagnosticStage(session.page, 'fit:wait-loaded', () => (
            waitForPdfLoaded(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS)
        ));
        await runPdfDiagnosticStage(session.page, 'fit:wait-initial-toolbar', () => (
            waitForWorkspaceToolbarSnapshot(
                session.page,
                {
                    hasPdf: true,
                    currentPage: 1,
                    minTotalPages: 3,
                },
                {timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS},
            )
        ));
        await startPdfRenderTrace(session.page);
        await runPdfDiagnosticStage(session.page, 'fit:go-to-page-2', () => (
            goToPageViaToolbar(session.page, 2)
        ));
        await runPdfDiagnosticStage(session.page, 'fit:wait-toolbar-page-2', () => (
            waitForToolbarCurrentPage(session.page, 2)
        ));
        await requireWorkspaceCommand(session.page, 'handleFitWidth');
        await runPdfDiagnosticStage(session.page, 'fit:wait-fit-width-mode', () => (
            waitForFunctionInPage(session.page, () => (
                (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot?.()?.zoomMode === 'fit-width'
            ), {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS})
        ));
        await runPdfDiagnosticStage(session.page, 'fit:wait-fit-width-page-2', () => (
            waitForVisuallyPresentedPdfPage(session.page, 2)
        ));

        const fitWidthPageGeometry = await evaluateInPage(session.page, () => {
            const pageContainer = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer .page_container[data-page="2"]',
            )!;
            const rect = pageContainer.getBoundingClientRect();
            return {
                height: rect.height,
                width: rect.width,
            };
        });
        await requireWorkspaceCommand(session.page, 'handleFitHeight');
        const continuousFitHeight = await runPdfDiagnosticStage(
            session.page,
            'fit:continuous-fit-height-geometry',
            () => waitForCommittedFitHeightGeometry(session.page, 2),
        );
        expect(
            Math.max(
                Math.abs(continuousFitHeight.pageWidth - fitWidthPageGeometry.width),
                Math.abs(continuousFitHeight.pageHeight - fitWidthPageGeometry.height),
            ),
        ).toBeGreaterThan(10);
        expect(continuousFitHeight.canvasCssWidth).toBeCloseTo(continuousFitHeight.pageWidth, 0);
        expect(continuousFitHeight.canvasCssHeight).toBeCloseTo(continuousFitHeight.pageHeight, 0);
        expect(continuousFitHeight.layerBoundsViolations).toEqual([]);
        expect(continuousFitHeight.viewportScrollWidth).toBeLessThanOrEqual(
            continuousFitHeight.viewportClientWidth + 1,
        );

        await requireWorkspaceCommand(session.page, 'handleToggleContinuousScroll');
        await runPdfDiagnosticStage(session.page, 'fit:wait-paged-mode', () => (
            waitForWorkspaceToolbarSnapshot(
                session.page,
                {continuousScroll: false},
                {timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS},
            )
        ));
        const pagedFitHeight = await runPdfDiagnosticStage(
            session.page,
            'fit:paged-fit-height-geometry',
            () => waitForCommittedFitHeightGeometry(session.page, 2, continuousFitHeight),
        );
        expect(pagedFitHeight.canvasPixelWidth).toBe(continuousFitHeight.canvasPixelWidth);
        expect(pagedFitHeight.canvasPixelHeight).toBe(continuousFitHeight.canvasPixelHeight);
        expect(pagedFitHeight.layerBoundsViolations).toEqual([]);
        expect(pagedFitHeight.viewportScrollWidth).toBeLessThanOrEqual(
            pagedFitHeight.viewportClientWidth + 1,
        );

        await requireWorkspaceCommand(session.page, 'handleToggleContinuousScroll');
        await runPdfDiagnosticStage(session.page, 'fit:wait-restored-continuous-mode', () => (
            waitForWorkspaceToolbarSnapshot(
                session.page,
                {continuousScroll: true},
                {timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS},
            )
        ));
        const restoredContinuousFitHeight = await runPdfDiagnosticStage(
            session.page,
            'fit:restored-continuous-fit-height-geometry',
            () => waitForCommittedFitHeightGeometry(session.page, 2, continuousFitHeight),
        );
        expect(restoredContinuousFitHeight.canvasPixelWidth).toBe(continuousFitHeight.canvasPixelWidth);
        expect(restoredContinuousFitHeight.canvasPixelHeight).toBe(continuousFitHeight.canvasPixelHeight);
        expect(restoredContinuousFitHeight.layerBoundsViolations).toEqual([]);
        expect(restoredContinuousFitHeight.viewportScrollWidth).toBeLessThanOrEqual(
            restoredContinuousFitHeight.viewportClientWidth + 1,
        );
        await stopPdfRenderTrace(session.page);
    });

    pressureIt('serializes early Recent navigation and owns every viewport frame', {
        retry: 0,
        timeout: 180_000,
    }, async () => {
        const session = await sessionFixture.restart({
            clean: true,
            hard: true,
            keepNuxt: true,
            sessionName: 'e2e-pr-blocking-viewport-lifecycle',
        });

        const fixturePath = await createLargeScannedFixturePdf(
            'pr-blocking-viewport-lifecycle.pdf',
            12,
            0,
            1,
            {runOwner: PR_BLOCKING_FIXTURE_OWNER},
        );
        const fixtureDocumentRef = requireDocumentRef(fixturePath);
        await runPdfDiagnosticStage(session.page, 'early:prime-open-pdf', () => (
            openPdfInApp(session.page, fixturePath, PR_BLOCKING_SMOKE_TIMEOUT_MS)
        ));
        await runPdfDiagnosticStage(session.page, 'early:prime-wait-loaded', () => (
            waitForPdfLoaded(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS)
        ));
        await runPdfDiagnosticStage(session.page, 'early:close-to-recents', () => (
            closeActiveDocumentToEmpty(session.page)
        ));
        await runPdfDiagnosticStage(session.page, 'early:wait-actionable-recent', () => (
            waitForFunctionInPage(session.page, (targetSourcePath: string) => (
                Array.from(document.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)'))
                    .some(row => (
                        row.dataset.recentOpenActionable === 'true'
                        && row.dataset.recentSource === targetSourcePath
                    ))
            ), {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS}, fixturePath)
        ));

        const sourceDeferred = await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__deferDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef);
        expect(sourceDeferred).toBe(true);
        await installCommittedSurfaceSampler(
            session.page,
            LIFECYCLE_ONLY_SURFACE_SAMPLER_OPTIONS,
        );
        await startPdfRenderTrace(session.page);
        const earlyNavigation = await evaluateInPage(session.page, (targetSourcePath: string) => {
            const row = Array.from(document.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)'))
                .find(candidate => (
                    candidate.dataset.recentOpenActionable === 'true'
                    && candidate.dataset.recentSource === targetSourcePath
                ));
            const api = (window as IE2EWindow).__evbTestApi;
            if (!row || !api) {
                return {
                    clicked: false,
                    requestCount: 0,
                };
            }
            (window as Window & {__committedSurfaceInteractionCheckpoint?: string | null;})
                .__committedSurfaceInteractionCheckpoint = 'recent-early-navigation';
            row.click();
            const requests: Array<Promise<{called: boolean;}>> = [];
            for (let pageNumber = 2; pageNumber <= 6; pageNumber += 1) {
                requests.push(api.callActiveWorkspaceCommand('handleGoToPage', [pageNumber]));
            }
            (window as Window & {__viewportLifecycleEarlyNavigationRequests?: Array<Promise<{called: boolean;}>>;}).__viewportLifecycleEarlyNavigationRequests = requests;
            return {
                clicked: true,
                requestCount: 5,
            };
        }, fixturePath);
        expect(earlyNavigation).toEqual({
            clicked: true,
            requestCount: 5,
        });
        await waitForAnimationFrames(session.page, 4);
        const sourceReleased = await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__releaseDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef);
        expect(sourceReleased).toBe(true);
        const earlyNavigationRequestResults = await runPdfDiagnosticStage(
            session.page,
            'early:resolve-navigation-command-promises',
            () => evaluateInPage(session.page, async () => {
                const testWindow = window as Window & {__viewportLifecycleEarlyNavigationRequests?: Array<Promise<{called: boolean;}>>;};
                const results = await Promise.all(testWindow.__viewportLifecycleEarlyNavigationRequests ?? []);
                delete testWindow.__viewportLifecycleEarlyNavigationRequests;
                return results;
            }),
        );
        expect(earlyNavigationRequestResults).toHaveLength(5);
        // Setup, not an outcome: a navigation request the workspace never
        // received would make the screen checks below meaningless.
        if (!earlyNavigationRequestResults.every(result => result.called)) {
            throw new Error('An early navigation request never reached the active workspace');
        }
        await runPdfDiagnosticStage(session.page, 'early:wait-toolbar-page-6', () => (
            waitForWorkspaceToolbarSnapshot(
                session.page,
                {
                    hasPdf: true,
                    currentPage: 6,
                    minTotalPages: 12,
                },
                {timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS},
            )
        ));
        await runPdfDiagnosticStage(session.page, 'early:wait-visible-page-6', () => (
            waitForVisuallyPresentedPdfPage(session.page, 6)
        ));
        await waitForAnimationFrames(session.page, 12);
        const firstPageSixCanvas = await readCommittedPdfCanvasPixelSize(session.page, 6);
        expect(firstPageSixCanvas.width).toBeGreaterThan(0);
        expect(firstPageSixCanvas.height).toBeGreaterThan(0);
        expect(firstPageSixCanvas.skeletonVisible).toBe(false);
        await runPdfDiagnosticStage(session.page, 'early:wait-prefetched-page-7', () => (
            waitForFunctionInPage(session.page, () => {
                const prefetchedPage = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer .page_container[data-page="7"]',
                );
                const canvas = prefetchedPage?.querySelector<HTMLCanvasElement>(
                    '.page_canvas__render-layer canvas',
                );
                return Boolean(
                    prefetchedPage?.classList.contains('page_container--rendered')
                    && canvas
                    && canvas.width > 0
                    && canvas.height > 0,
                );
            }, {timeout: LARGE_PDF_INTERACTION_WAIT_TIMEOUT_MS})
        ));
        const earlyNavigationTrace = await runPdfDiagnosticStage(
            session.page,
            'early:stop-initial-sampler',
            () => stopCommittedSurfaceSampler(session.page),
        );
        const earlyNavigationViolations = findViewportLifecycleViolations(earlyNavigationTrace, {
            expectedFinalPage: 6,
            interactionCheckpoint: 'recent-early-navigation',
            rejectUnexpectedCanvasPages: true,
            requireSkeleton: true,
            startAtOpenSurfaceClaim: true,
        });
        expect(
            earlyNavigationViolations,
            JSON.stringify(earlyNavigationTrace.frames),
        ).toEqual([]);

        await runPdfDiagnosticStage(session.page, 'early:install-fast-sampler', () => (
            installCommittedSurfaceSampler(session.page, LIFECYCLE_ONLY_SURFACE_SAMPLER_OPTIONS)
        ));
        await runPdfDiagnosticStage(session.page, 'early:mark-fast-checkpoint', () => (
            markCommittedSurfaceInteractionCheckpoint(session.page, 'fast-navigation')
        ));
        await runPdfDiagnosticStage(session.page, 'early:go-to-page-7', () => (
            requireWorkspaceCommand(session.page, 'handleGoToPage', [7])
        ));
        await runPdfDiagnosticStage(session.page, 'early:wait-toolbar-page-7', () => (
            waitForWorkspaceToolbarSnapshot(
                session.page,
                {currentPage: 7},
                {timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS},
            )
        ));
        await runPdfDiagnosticStage(session.page, 'early:wait-visible-page-7', () => (
            waitForVisuallyPresentedPdfPage(session.page, 7)
        ));
        await runPdfDiagnosticStage(session.page, 'early:settle-page-7', () => (
            waitForAnimationFrames(session.page, 12)
        ));
        const pageSevenCanvas = await runPdfDiagnosticStage(
            session.page,
            'early:read-page-7-canvas',
            () => readCommittedPdfCanvasPixelSize(session.page, 7),
        );
        expect(pageSevenCanvas.width).toBeGreaterThan(0);
        expect(pageSevenCanvas.height).toBeGreaterThan(0);
        expect(pageSevenCanvas.skeletonVisible).toBe(false);
        const fastNavigationTrace = await runPdfDiagnosticStage(
            session.page,
            'early:stop-fast-sampler',
            () => stopCommittedSurfaceSampler(session.page),
        );
        expect(
            findViewportLifecycleViolations(fastNavigationTrace, {
                expectedFinalPage: 7,
                interactionCheckpoint: 'fast-navigation',
                requireSkeleton: false,
            }),
            JSON.stringify(fastNavigationTrace.frames),
        ).toEqual([]);

        await runPdfDiagnosticStage(session.page, 'late:go-back-to-page-6', () => (
            requireWorkspaceCommand(session.page, 'handleGoToPage', [6])
        ));
        await runPdfDiagnosticStage(session.page, 'late:wait-toolbar-page-6', () => (
            waitForWorkspaceToolbarSnapshot(
                session.page,
                {currentPage: 6},
                {timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS},
            )
        ));
        await runPdfDiagnosticStage(session.page, 'late:wait-visible-page-6', () => (
            waitForVisuallyPresentedPdfPage(session.page, 6)
        ));
        const revisitedPageSixCanvas = await runPdfDiagnosticStage(
            session.page,
            'late:read-page-6-canvas',
            () => readCommittedPdfCanvasPixelSize(session.page, 6),
        );
        expect(revisitedPageSixCanvas).toEqual(firstPageSixCanvas);

        await runPdfDiagnosticStage(session.page, 'late:restore-page-7', () => (
            requireWorkspaceCommand(session.page, 'handleGoToPage', [7])
        ));
        await runPdfDiagnosticStage(session.page, 'late:wait-restored-page-7', () => (
            waitForVisuallyPresentedPdfPage(session.page, 7)
        ));
        expect(await runPdfDiagnosticStage(
            session.page,
            'late:read-restored-page-7-canvas',
            () => readCommittedPdfCanvasPixelSize(session.page, 7),
        )).toEqual(pageSevenCanvas);

        const client = await runPdfDiagnosticStage(session.page, 'late:create-cdp-session', () => (
            session.page.createCDPSession()
        ));
        viewportLifecycleCpuThrottleClient = client;
        let zoomReplacementTrace: Awaited<ReturnType<typeof stopCommittedSurfaceSampler>> = {frames: []};
        let slowNavigationTrace: Awaited<ReturnType<typeof stopCommittedSurfaceSampler>> = {frames: []};
        try {
            await runPdfDiagnosticStage(session.page, 'late:install-zoom-sampler', () => (
                installCommittedSurfaceSampler(session.page, LIFECYCLE_ONLY_SURFACE_SAMPLER_OPTIONS)
            ));
            await runPdfDiagnosticStage(session.page, 'late:mark-zoom-checkpoint', () => (
                markCommittedSurfaceInteractionCheckpoint(session.page, 'zoom-replacement')
            ));
            // Sample the current fresh owner before submitting the replacement.
            await runPdfDiagnosticStage(session.page, 'late:settle-before-zoom', () => (
                waitForAnimationFrames(session.page, 2)
            ));
            await runPdfDiagnosticStage(session.page, 'late:set-custom-zoom', () => (
                requireWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [5.03])
            ));
            await runPdfDiagnosticStage(session.page, 'late:wait-custom-zoom-toolbar', () => (
                waitForFunctionInPage(session.page, () => (
                    (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot?.()?.zoomMode === 'custom'
                ), {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS})
            ));
            const zoomedPageSevenCanvas = await runPdfDiagnosticStage(
                session.page,
                'late:wait-zoomed-page-7-raster',
                () => waitForCommittedPdfCanvasResize(session.page, 7, pageSevenCanvas, 'larger'),
            );
            await runPdfDiagnosticStage(session.page, 'late:wait-zoomed-page-7', () => (
                waitForVisuallyPresentedPdfPage(session.page, 7)
            ));
            await runPdfDiagnosticStage(session.page, 'late:settle-zoomed-page-7', () => (
                waitForAnimationFrames(session.page, 12)
            ));
            zoomReplacementTrace = await runPdfDiagnosticStage(
                session.page,
                'late:stop-zoom-sampler',
                () => stopCommittedSurfaceSampler(session.page),
            );

            // Keep the two ownership contracts independent: the high-zoom
            // replacement trace above proves every presentable zoom frame,
            // while the navigation trace below proves ownership under severe
            // CPU pressure. Combining a continuously running RAF observer,
            // 5.03x software rasterization, and CDP throttling can starve
            // Chromium's own automation/toolbar polling rather than expose an
            // application lifecycle transition.
            await runPdfDiagnosticStage(session.page, 'late:reset-zoom', () => (
                requireWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [1])
            ));
            await runPdfDiagnosticStage(session.page, 'late:wait-reset-zoom-toolbar', () => (
                waitForFunctionInPage(session.page, () => {
                    const effectiveZoom = (window as IE2EWindow)
                        .__evbTestApi
                        ?.getActiveToolbarSnapshot?.()
                        ?.effectiveZoom;
                    return typeof effectiveZoom === 'number' && Math.abs(effectiveZoom - 1) < 0.01;
                }, {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS})
            ));
            await runPdfDiagnosticStage(session.page, 'late:wait-reset-page-7-raster', () => (
                waitForCommittedPdfCanvasResize(session.page, 7, zoomedPageSevenCanvas, 'smaller')
            ));
            await runPdfDiagnosticStage(session.page, 'late:enable-cpu-throttling', () => (
                client.send('Emulation.setCPUThrottlingRate', {rate: 4})
            ));
            await runPdfDiagnosticStage(session.page, 'late:install-slow-sampler', () => (
                installCommittedSurfaceSampler(session.page, LIFECYCLE_ONLY_SURFACE_SAMPLER_OPTIONS)
            ));
            await runPdfDiagnosticStage(session.page, 'late:mark-slow-checkpoint', () => (
                markCommittedSurfaceInteractionCheckpoint(session.page, 'controlled-slow-navigation')
            ));
            // Establish a checkpointed committed baseline so debounce timing is
            // measured from a real pre-navigation frame rather than treating
            // the first post-navigation skeleton sample as time zero.
            await runPdfDiagnosticStage(session.page, 'late:settle-before-slow-navigation', () => (
                waitForAnimationFrames(session.page, 2)
            ));
            await runPdfDiagnosticStage(session.page, 'late:go-to-page-10', () => (
                requireWorkspaceCommand(session.page, 'handleGoToPage', [10])
            ));
            await runPdfDiagnosticStage(session.page, 'late:wait-toolbar-page-10', () => (
                waitForWorkspaceToolbarSnapshot(
                    session.page,
                    {currentPage: 10},
                    {timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS},
                )
            ));
            await runPdfDiagnosticStage(session.page, 'late:wait-visible-page-10', () => (
                waitForVisuallyPresentedPdfPage(session.page, 10)
            ));
            await runPdfDiagnosticStage(session.page, 'late:settle-page-10', () => (
                waitForAnimationFrames(session.page, 12)
            ));
        } finally {
            await runPdfDiagnosticStage(session.page, 'late:disable-cpu-throttling', () => (
                releaseViewportLifecycleCpuThrottle()
            ));
            const remainingTrace = await runPdfDiagnosticStage(
                session.page,
                'late:stop-remaining-sampler',
                () => stopCommittedSurfaceSampler(session.page),
            );
            if (slowNavigationTrace.frames.length === 0) {
                slowNavigationTrace = remainingTrace;
            }
        }
        const zoomPageFrames = zoomReplacementTrace.frames.filter(frame => (
            frame.interactionCheckpoint === 'zoom-replacement'
            && frame.pageNumber === 7
            && frame.kind === 'committed-canvas'
        ));
        expect(zoomPageFrames[0]?.pageVisualState, JSON.stringify(zoomReplacementTrace.frames)).toBe('ready');
        expect(
            zoomPageFrames.every(frame => frame.pageVisualState === 'ready'),
            JSON.stringify(zoomReplacementTrace.frames),
        ).toBe(true);
        expect(
            zoomPageFrames.every(frame => frame.pageCanvasNonzeroCanvasCount === 1),
            JSON.stringify(zoomReplacementTrace.frames),
        ).toBe(true);
        expect(
            zoomPageFrames[0]?.canvasId,
            JSON.stringify(zoomReplacementTrace.frames),
        ).not.toBe(zoomPageFrames.at(-1)?.canvasId);
        expect(
            findViewportLifecycleViolations(slowNavigationTrace, {
                expectedFinalPage: 10,
                interactionCheckpoint: 'controlled-slow-navigation',
                minimumSkeletonDelayMs: PDF_NAVIGATION_SKELETON_DEBOUNCE_MS,
            }),
            JSON.stringify(slowNavigationTrace.frames),
        ).toEqual([]);

        const closeRecentState = await evaluateInPage(session.page, (
            targetSourcePath: string,
        ) => new Promise<{
            enabled: boolean;
            found: boolean;
            host: Record<string, string | undefined> | null;
            rowReady: string | null;
        }>((resolve) => {
            document.querySelector<HTMLButtonElement>('.tab-list .tab.is-active .tab-close')?.click();
            window.requestAnimationFrame(() => {
                const row = Array.from(document.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)'))
                    .find(candidate => candidate.dataset.recentSource === targetSourcePath);
                const host = document.querySelector<HTMLElement>('.workspace-host[data-workspace-active="true"]');
                resolve({
                    enabled: row?.dataset.recentOpenActionable === 'true',
                    found: Boolean(row),
                    host: host ? {...host.dataset} : null,
                    rowReady: row?.dataset.recentOpenReady ?? null,
                });
            });
        }), fixturePath);
        expect(closeRecentState.found, JSON.stringify(closeRecentState)).toBe(true);
        expect(closeRecentState.enabled, JSON.stringify(closeRecentState)).toBe(true);
        await stopPdfRenderTrace(session.page);
    });

    pressureIt('keeps Recent actionable across document-tab close and reopen', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: 'e2e-pr-blocking-recent-close-reopen',
        });

        const client = await session.page.createCDPSession();
        const rendererExceptions: string[] = [];
        await client.send('Runtime.enable');
        client.on('Runtime.exceptionThrown', (event) => {
            rendererExceptions.push(
                event.exceptionDetails.exception?.description
                ?? event.exceptionDetails.text,
            );
        });

        try {
            const fixturePath = await createLargeScannedFixturePdf(
                'pr-blocking-recent-close-reopen.pdf',
                3,
                0,
                1,
                {runOwner: PR_BLOCKING_FIXTURE_OWNER},
            );
            await openPdfInApp(session.page, fixturePath, PR_BLOCKING_SMOKE_TIMEOUT_MS);
            await waitForPdfLoaded(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS);
            await requireWorkspaceCommand(session.page, 'handleFitHeight');
            await waitForFunctionInPage(session.page, () => (
                (window as IE2EWindow).__evbTestApi
                    ?.getActiveToolbarSnapshot?.()?.zoomMode === 'fit-height'
            ), {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS});
            await requireWorkspaceCommand(session.page, 'handleToggleSidebar');
            await waitForWorkspaceToolbarSnapshot(
                session.page,
                {showSidebar: true},
                {timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS},
            );
            await evaluateInPage(session.page, () => {
                document.querySelector<HTMLButtonElement>('.tab-list .tab.is-active .tab-close')?.click();
            });
            await waitForFunctionInPage(session.page, (targetSourcePath: string) => (
                Array.from(document.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)'))
                    .some(row => (
                        row.dataset.recentOpenActionable === 'true'
                        && row.dataset.recentSource === targetSourcePath
                    ))
            ), {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS}, fixturePath);
            await evaluateInPage(session.page, (targetSourcePath: string) => {
                const row = Array.from(document.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)'))
                    .find(candidate => (
                        candidate.dataset.recentOpenActionable === 'true'
                        && candidate.dataset.recentSource === targetSourcePath
                    ));
                row?.click();
            }, fixturePath);
            await waitForActiveDocumentSource(session.page, fixturePath, PR_BLOCKING_SMOKE_TIMEOUT_MS);
            await waitForWorkspaceHistorySettled(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS);
            await waitForPdfLoaded(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS);
            await waitForWorkspaceToolbarSnapshot(
                session.page,
                {showSidebar: false},
                {timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS},
            );
            expect((await getWorkspaceToolbarSnapshot(session.page))?.zoomMode).toBe('fit-width');
            expect(rendererExceptions).toEqual([]);
        } catch (error) {
            throw new Error(`${String(error)}; rendererExceptions=${JSON.stringify(rendererExceptions)}`);
        } finally {
            await client.detach();
        }
    });

    pressureIt('keeps large-PDF opening, virtualization, and repeated reopen within budget', {
        retry: 0,
        timeout: 240_000,
    }, async () => {
        const session = await sessionFixture.restart({
            clean: true,
            hard: true,
            keepNuxt: true,
            sessionName: 'e2e-pr-blocking-large-scanned-pdf',
        });

        const fixturePath = await createLargeScannedFixturePdf(
            'pr-blocking-large-scanned-pdf.pdf',
            LARGE_PDF_PAGE_COUNT,
            28 * 1024 * 1024,
            1,
            {runOwner: PR_BLOCKING_FIXTURE_OWNER},
        );
        expect((await stat(fixturePath)).size).toBeGreaterThanOrEqual(LARGE_PDF_MIN_BYTES);

        // This must run before the open trigger so a one-frame blank, loader, or
        // separate fallback surface cannot escape the release-blocking trace.
        await waitForCommittedEmptyBaseline(session.page);
        await installCommittedSurfaceSampler(session.page);
        await startPdfRenderTrace(session.page);
        await evaluateInPage(session.page, () => {
            const testWindow = window as typeof window & {
                __largePdfOpenSampleObserver?: MutationObserver;
                __largePdfOpenSampleAnimationFrame?: number;
                __largePdfOpenSamples?: ILargePdfOpenSample[];
            };
            if (testWindow.__largePdfOpenSampleAnimationFrame !== undefined) {
                window.cancelAnimationFrame(testWindow.__largePdfOpenSampleAnimationFrame);
            }
            testWindow.__largePdfOpenSampleObserver?.disconnect();
            const startedAt = performance.now();
            const previousSampleSignatures = new Map<string, string>();
            testWindow.__largePdfOpenSamples = [];
            const captureSample = (sampleSource: 'mutation' | 'raf') => {
                const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer');
                const currentPage = viewer?.querySelector<HTMLElement>('.page_container[data-page="1"]') ?? null;
                const rect = currentPage?.getBoundingClientRect() ?? null;
                const currentPageCanvas = currentPage?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
                const currentPageCanvasRect = currentPageCanvas?.getBoundingClientRect() ?? null;
                const pageCanvas = currentPage?.querySelector<HTMLElement>('.page_canvas') ?? null;
                const pageCanvasRect = pageCanvas?.getBoundingClientRect() ?? null;
                const pageCanvasStyle = pageCanvas ? window.getComputedStyle(pageCanvas) : null;
                const pageSkeletons = Array.from(
                    currentPage?.querySelectorAll<HTMLElement>('.document-page-skeleton') ?? [],
                );
                const sampleCanvasPixels = (canvas: HTMLCanvasElement | null) => {
                    if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
                        return {
                            luminanceRange: 0,
                            nonblankPixels: 0,
                        };
                    }
                    const sampleSize = 32;
                    const boundedCanvas = document.createElement('canvas');
                    boundedCanvas.width = sampleSize;
                    boundedCanvas.height = sampleSize;
                    const boundedContext = boundedCanvas.getContext('2d', {willReadFrequently: true});
                    if (!boundedContext) {
                        return {
                            luminanceRange: 0,
                            nonblankPixels: 0,
                        };
                    }
                    boundedContext.drawImage(canvas, 0, 0, sampleSize, sampleSize);
                    const pixels = boundedContext.getImageData(0, 0, sampleSize, sampleSize).data;
                    let minLuminance = 255;
                    let maxLuminance = 0;
                    let nonblankPixels = 0;
                    for (let offset = 0; offset < pixels.length; offset += 4) {
                        const alpha = pixels[offset + 3] ?? 0;
                        if (alpha === 0) {
                            continue;
                        }
                        const red = pixels[offset] ?? 0;
                        const green = pixels[offset + 1] ?? 0;
                        const blue = pixels[offset + 2] ?? 0;
                        const luminance = (red * 0.2126) + (green * 0.7152) + (blue * 0.0722);
                        minLuminance = Math.min(minLuminance, luminance);
                        maxLuminance = Math.max(maxLuminance, luminance);
                        if (red < 245 || green < 245 || blue < 245) {
                            nonblankPixels += 1;
                        }
                    }
                    return {
                        luminanceRange: Math.round(maxLuminance - minLuminance),
                        nonblankPixels,
                    };
                };
                const canvasPixels = sampleCanvasPixels(currentPageCanvas);
                const openSurfaces = Array.from(document.querySelectorAll<HTMLElement>(
                    '[data-document-open-surface="neutral"]',
                ));
                const isVisible = (element: HTMLElement) => {
                    const elementRect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return elementRect.width > 0
                        && elementRect.height > 0
                        && style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && Number(style.opacity || '1') > 0;
                };
                const visibleOpenSurfaces = openSurfaces.filter(isVisible);
                const visiblePageSkeletons = pageSkeletons.filter(isVisible);
                const pageSkeleton = visiblePageSkeletons[0] ?? null;
                const pageSkeletonRect = pageSkeleton?.getBoundingClientRect() ?? null;
                const pageSkeletonStyle = pageSkeleton ? window.getComputedStyle(pageSkeleton) : null;
                const visibleHostLoaders = Array.from(document.querySelectorAll<HTMLElement>(
                    '.editor-pane.is-active .workspace-host__loading',
                )).filter(isVisible);
                const visibleCanvasReady = Boolean(
                    currentPageCanvas
                    && currentPageCanvasRect
                    && isVisible(currentPageCanvas)
                    && currentPageCanvas.width > 0
                    && currentPageCanvas.height > 0
                    && currentPageCanvasRect.width > 0
                    && currentPageCanvasRect.height > 0
                    && currentPageCanvasRect.bottom > 0
                    && currentPageCanvasRect.right > 0
                    && currentPageCanvasRect.top < window.innerHeight
                    && currentPageCanvasRect.left < window.innerWidth
                    && canvasPixels.nonblankPixels > 2
                    && canvasPixels.luminanceRange > 8,
                );
                const sample: ILargePdfOpenSample = {
                    bodyOverflow: Math.max(0, Math.round(document.body.scrollWidth - document.body.clientWidth)),
                    documentOverflow: Math.max(0, Math.round(
                        document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    )),
                    currentPageCanvasPixelHeight: currentPageCanvas?.height ?? null,
                    currentPageCanvasPixelWidth: currentPageCanvas?.width ?? null,
                    currentPageCanvasLuminanceRange: canvasPixels.luminanceRange,
                    currentPageCanvasNonblankPixels: canvasPixels.nonblankPixels,
                    elapsedMs: Math.round(performance.now() - startedAt),
                    horizontalOverflow: viewer
                        ? Math.max(0, Math.round(viewer.scrollWidth - viewer.clientWidth))
                        : null,
                    hostLoaderCount: visibleHostLoaders.length,
                    hostLoaderSkeletonCount: visibleHostLoaders.reduce((count, loader) => (
                        count + loader.querySelectorAll('.document-page-skeleton').length
                    ), 0),
                    hostLoaderSpinnerCount: visibleHostLoaders.reduce((count, loader) => (
                        count + loader.querySelectorAll('.animate-spin').length
                    ), 0),
                    pageCanvasBackgroundColor: pageCanvasStyle?.backgroundColor ?? null,
                    pageCanvasBorderRadius: pageCanvasStyle?.borderRadius ?? null,
                    pageCanvasBoxShadow: pageCanvasStyle?.boxShadow ?? null,
                    pageCanvasHeight: pageCanvasRect ? Math.round(pageCanvasRect.height) : null,
                    pageCanvasLeft: pageCanvasRect ? Math.round(pageCanvasRect.left) : null,
                    pageCanvasTop: pageCanvasRect ? Math.round(pageCanvasRect.top) : null,
                    pageCanvasWidth: pageCanvasRect ? Math.round(pageCanvasRect.width) : null,
                    pageSkeletonBackgroundColor: pageSkeletonStyle?.backgroundColor ?? null,
                    pageSkeletonBorderRadius: pageSkeletonStyle?.borderRadius ?? null,
                    pageSkeletonBoxShadow: pageSkeletonStyle?.boxShadow ?? null,
                    pageSkeletonCount: visiblePageSkeletons.length,
                    pageSkeletonHeight: pageSkeletonRect ? Math.round(pageSkeletonRect.height) : null,
                    pageSkeletonLeft: pageSkeletonRect ? Math.round(pageSkeletonRect.left) : null,
                    pageSkeletonTop: pageSkeletonRect ? Math.round(pageSkeletonRect.top) : null,
                    pageSkeletonVisible: visiblePageSkeletons.length > 0,
                    pageSkeletonWidth: pageSkeletonRect ? Math.round(pageSkeletonRect.width) : null,
                    openSurfaceCount: visibleOpenSurfaces.length,
                    openSurfaceSkeletonCount: visibleOpenSurfaces.reduce((count, surface) => (
                        count + surface.querySelectorAll('.document-page-skeleton').length
                    ), 0),
                    openSurfaceSpinnerCount: visibleOpenSurfaces.reduce((count, surface) => (
                        count + surface.querySelectorAll('.animate-spin').length
                    ), 0),
                    openSurfacePhase: viewer?.dataset.openSurfacePhase ?? null,
                    openSurfaceVisible: visibleOpenSurfaces.length > 0,
                    pageHeight: rect ? Math.round(rect.height) : null,
                    pageTop: rect ? Math.round(rect.top) : null,
                    pageWidth: rect ? Math.round(rect.width) : null,
                    sampleSource,
                    viewportClientWidth: viewer?.clientWidth ?? null,
                    viewportScrollLeft: viewer ? Math.round(viewer.scrollLeft) : null,
                    viewportScrollTop: viewer ? Math.round(viewer.scrollTop) : null,
                    visibleCanvasReady,
                };
                const sampleSignature = JSON.stringify({
                    ...sample,
                    elapsedMs: 0,
                });
                if (sampleSignature === previousSampleSignatures.get(sampleSource)) {
                    return;
                }
                previousSampleSignatures.set(sampleSource, sampleSignature);
                testWindow.__largePdfOpenSamples?.push(sample);
            };
            testWindow.__largePdfOpenSampleObserver = new MutationObserver(() => captureSample('mutation'));
            testWindow.__largePdfOpenSampleObserver.observe(document.documentElement, {
                attributeFilter: [
                    'class',
                    'height',
                    'style',
                    'width',
                ],
                childList: true,
                subtree: true,
            });
            captureSample('mutation');
            const captureAnimationFrame = () => {
                captureSample('raf');
                testWindow.__largePdfOpenSampleAnimationFrame = window.requestAnimationFrame(captureAnimationFrame);
            };
            testWindow.__largePdfOpenSampleAnimationFrame = window.requestAnimationFrame(captureAnimationFrame);
        });

        await openPdfInApp(session.page, fixturePath, LARGE_PDF_VISUAL_READY_TIMEOUT_MS);
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {
                hasPdf: true,
                currentPage: 1,
                minTotalPages: LARGE_PDF_PAGE_COUNT,
            },
            {timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS},
        );
        await waitForFunctionInPage(session.page, () => {
            const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer');
            const canvas = viewer?.querySelector<HTMLCanvasElement>(
                '.page_container[data-page="1"] .page_canvas canvas',
            ) ?? null;
            if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
                return false;
            }
            const rect = canvas.getBoundingClientRect();
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth;
        }, {timeout: LARGE_PDF_VISUAL_READY_TIMEOUT_MS});

        await new Promise(resolve => setTimeout(resolve, LARGE_PDF_SETTLED_OBSERVATION_MS));
        await waitForCommittedSurfaceSamples(session.page, {
            kind: 'committed-canvas',
            minimumSamples: 10,
        });
        const committedSurfaceTrace = await stopCommittedSurfaceSampler(session.page);
        const initialRenderTrace = await stopPdfRenderTrace(session.page);
        const result = await evaluateInPage(session.page, () => {
            const testWindow = window as typeof window & {
                __largePdfOpenSampleObserver?: MutationObserver;
                __largePdfOpenSampleAnimationFrame?: number;
                __largePdfOpenSamples?: ILargePdfOpenSample[];
            };
            if (testWindow.__largePdfOpenSampleAnimationFrame !== undefined) {
                window.cancelAnimationFrame(testWindow.__largePdfOpenSampleAnimationFrame);
                delete testWindow.__largePdfOpenSampleAnimationFrame;
            }
            testWindow.__largePdfOpenSampleObserver?.disconnect();
            delete testWindow.__largePdfOpenSampleObserver;

            const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer');
            const isVisible = (element: Element) => {
                const htmlElement = element as HTMLElement;
                const rect = htmlElement.getBoundingClientRect();
                const style = window.getComputedStyle(htmlElement);
                return rect.width > 0
                    && rect.height > 0
                    && rect.bottom > 0
                    && rect.right > 0
                    && rect.top < window.innerHeight
                    && rect.left < window.innerWidth
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0;
            };
            const visibleCanvases = Array.from(
                viewer?.querySelectorAll<HTMLCanvasElement>('.page_container canvas') ?? [],
            ).filter(canvas => isVisible(canvas) && canvas.width > 0 && canvas.height > 0);
            const firstCanvas = visibleCanvases[0];
            const loadedHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter(host => host.querySelector('#pdf-viewer .page_container'));
            const hiddenLoadedHosts = loadedHosts.filter(host => !isVisible(host));
            const visualState: ILargePdfVisualState = {
                canvasHeight: firstCanvas?.height ?? 0,
                canvasWidth: firstCanvas?.width ?? 0,
                horizontalOverflow: viewer ? Math.max(0, viewer.scrollWidth - viewer.clientWidth) : -1,
                hiddenLoadedHostCount: hiddenLoadedHosts.length,
                loadedHostCount: loadedHosts.length,
                nestedPdfViewerCount: viewer?.querySelectorAll('.pdfViewer').length ?? -1,
                renderedPageCount: viewer?.querySelectorAll('.page_container--rendered').length ?? 0,
                visibleCanvasCount: visibleCanvases.length,
                visibleLoadingStateCount: Array.from(document.querySelectorAll<HTMLElement>(
                    '.document-loading, .pdf-loading, .pdf-loading-overlay, [data-loading="true"]',
                )).filter(isVisible).length,
                visibleOpenSurfaceCount: Array.from(document.querySelectorAll<HTMLElement>(
                    '[data-document-open-surface="neutral"]',
                )).filter(isVisible).length,
                visibleOpeningFallbackCount: Array.from(document.querySelectorAll<HTMLElement>(
                    '.workspace-host-document-open-fallback',
                )).filter(isVisible).length,
                visibleSkeletonCount: Array.from(
                    viewer?.querySelectorAll('.document-page-skeleton') ?? [],
                ).filter(isVisible).length,
            };
            return {
                samples: testWindow.__largePdfOpenSamples ?? [],
                visualState,
            };
        });

        const committedSurfaceViolations = findCommittedSurfaceCausalOpenViolations(
            committedSurfaceTrace,
            {
                maxFirstCanvasMs: LARGE_PDF_FIRST_VISUAL_BUDGET_MS,
                maxFirstPageShellMs: LARGE_PDF_FIRST_PAGE_SHELL_BUDGET_MS,
                maxReadyAfterCanvasMs: LARGE_PDF_READY_AFTER_CANVAS_BUDGET_MS,
                requirePageShell: true,
            },
        );
        const committedSurfaceDiagnostic = committedSurfaceTrace.frames.filter((frame, index, frames) => (
            frame.kind === 'blank'
            || frame.kind === 'loader'
            || frame.kind === 'neutral'
            || frame.kind !== frames[index - 1]?.kind
            || frame.kind !== frames[index + 1]?.kind
        ));
        expect(
            committedSurfaceViolations,
            JSON.stringify(committedSurfaceDiagnostic),
        ).toEqual([]);
        expect(
            findInitialRenderAuthorityViolations(initialRenderTrace, 1),
            JSON.stringify(initialRenderTrace),
        ).toEqual([]);

        expect(result.visualState.visibleCanvasCount, JSON.stringify(result)).toBeGreaterThan(0);
        expect(result.visualState.canvasWidth, JSON.stringify(result)).toBeGreaterThan(0);
        expect(result.visualState.canvasHeight, JSON.stringify(result)).toBeGreaterThan(0);
        expect(result.visualState.horizontalOverflow, JSON.stringify(result)).toBe(0);
        expect(result.visualState.hiddenLoadedHostCount, JSON.stringify(result)).toBe(0);
        expect(result.visualState.loadedHostCount, JSON.stringify(result)).toBe(1);
        expect(result.visualState.nestedPdfViewerCount, JSON.stringify(result)).toBe(0);
        expect(result.visualState.renderedPageCount, JSON.stringify(result)).toBeGreaterThan(0);
        expect(result.visualState.visibleLoadingStateCount, JSON.stringify(result)).toBe(0);
        expect(result.visualState.visibleOpenSurfaceCount, JSON.stringify(result)).toBe(0);
        expect(result.visualState.visibleOpeningFallbackCount, JSON.stringify(result)).toBe(0);
        expect(result.visualState.visibleSkeletonCount, JSON.stringify(result)).toBe(0);

        const firstVisibleCanvasSample = result.samples.find(sample => (
            sample.visibleCanvasReady
            && !sample.openSurfaceVisible
            && sample.sampleSource === 'raf'
        ));
        expect(firstVisibleCanvasSample, JSON.stringify(result)).toBeDefined();
        expect(
            firstVisibleCanvasSample?.elapsedMs ?? Number.POSITIVE_INFINITY,
            JSON.stringify(result),
        ).toBeLessThanOrEqual(LARGE_PDF_FIRST_VISUAL_BUDGET_MS);
        const currentPageCanvasSamples = result.samples.filter(sample => (
            sample.visibleCanvasReady
            && sample.currentPageCanvasPixelHeight !== null
            && sample.currentPageCanvasPixelWidth !== null
        ));
        expect(currentPageCanvasSamples.length, JSON.stringify(result)).toBeGreaterThan(0);
        const committedCanvasSizes = new Set(currentPageCanvasSamples.map(sample => (
            `${sample.currentPageCanvasPixelWidth}x${sample.currentPageCanvasPixelHeight}`
        )));
        expect(committedCanvasSizes.size, JSON.stringify(result)).toBe(1);

        // The empty-to-document contract requires one page-frame skeleton in
        // the exact `.page_canvas` that receives the first canvas. A neutral
        // overlay, spinner, or detached skeleton is never valid.
        const transitionSamples = result.samples.filter(sample => (
            sample.sampleSource === 'raf'
            && (sample.openSurfaceVisible || sample.hostLoaderCount > 0)
        ));
        expect(transitionSamples, JSON.stringify(result)).toEqual([]);
        for (const sample of result.samples) {
            expect(
                sample.visibleCanvasReady && sample.pageSkeletonVisible,
                JSON.stringify(result),
            ).toBe(false);
            if (sample.horizontalOverflow !== null) {
                expect(sample.horizontalOverflow, JSON.stringify(result)).toBe(0);
            }
        }

        const settledCanvasFrames = result.samples.filter((sample): sample is ILargePdfOpenSample & {
            pageHeight: number;
            pageTop: number;
            pageWidth: number;
            viewportScrollLeft: number;
            viewportScrollTop: number;
        } => (
            sample.sampleSource === 'raf'
            && !sample.openSurfaceVisible
            && sample.visibleCanvasReady
            && sample.pageHeight !== null
            && sample.pageTop !== null
            && sample.pageWidth !== null
            && sample.viewportScrollLeft !== null
            && sample.viewportScrollTop !== null
        ));
        const settledBaseline = settledCanvasFrames[0];
        expect(settledBaseline, JSON.stringify(result)).toBeDefined();
        for (const sample of settledCanvasFrames) {
            expect(Math.abs(sample.pageTop - settledBaseline!.pageTop), JSON.stringify(result)).toBeLessThanOrEqual(1);
            expect(Math.abs(sample.pageWidth - settledBaseline!.pageWidth), JSON.stringify(result)).toBeLessThanOrEqual(1);
            expect(Math.abs(sample.pageHeight - settledBaseline!.pageHeight), JSON.stringify(result)).toBeLessThanOrEqual(1);
            expect(
                Math.abs(sample.viewportScrollTop - settledBaseline!.viewportScrollTop),
                JSON.stringify(result),
            ).toBeLessThanOrEqual(1);
            expect(
                Math.abs(sample.viewportScrollLeft - settledBaseline!.viewportScrollLeft),
                JSON.stringify(result),
            ).toBeLessThanOrEqual(1);
        }

        const geometrySamples = settledCanvasFrames;
        expect(geometrySamples.length, JSON.stringify(result)).toBeGreaterThan(0);
        const firstGeometryAtMs = geometrySamples[0]?.elapsedMs ?? 0;
        let lastSignificantGeometryChangeAtMs = firstGeometryAtMs;
        for (let index = 1; index < geometrySamples.length; index += 1) {
            const previous = geometrySamples[index - 1];
            const current = geometrySamples[index];
            if (!previous || !current) {
                continue;
            }
            const changed = Math.abs(current.pageTop - previous.pageTop) > 8
                || Math.abs(current.pageWidth - previous.pageWidth) > 8
                || Math.abs(current.pageHeight - previous.pageHeight) > 8;
            if (changed) {
                lastSignificantGeometryChangeAtMs = current.elapsedMs;
            }
        }
        expect(
            lastSignificantGeometryChangeAtMs - firstGeometryAtMs,
            JSON.stringify({
                firstGeometryAtMs,
                lastSignificantGeometryChangeAtMs,
                result,
            }),
        ).toBeLessThanOrEqual(LARGE_PDF_GEOMETRY_SETTLE_BUDGET_MS);

        // Compact blocking virtualization sentinel. The deeper page-30 run
        // remains in the nightly rapid-navigation lane.
        await waitForVisibleMountedPdfCanvases(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS);
        await waitForScannedFixturePageIdentity(session.page, 1, PR_BLOCKING_SMOKE_TIMEOUT_MS);
        const virtualizationSamples = [await collectPdfVirtualizationSnapshot(session.page)];
        const wheelScrollViolations: string[] = [];
        let maxMountedPage = Math.max(
            ...virtualizationSamples[0]!.mountedPages.map(page => page.pageNumber),
        );
        for (let step = 0; step < 12 && maxMountedPage < 10; step += 1) {
            const previous = virtualizationSamples.at(-1)!;
            const deltaY = Math.max(300, Math.round(previous.viewportHeight * 0.8));
            const settlement = await wheelPdfViewportAndWaitForSettlement(
                session.page,
                deltaY,
                PR_BLOCKING_SMOKE_TIMEOUT_MS,
            );
            const expectedScrollTop = Math.min(
                settlement.initialScrollTop + deltaY,
                settlement.maxScrollTop,
            );
            if (Math.abs(settlement.finalScrollTop - expectedScrollTop) > 1) {
                wheelScrollViolations.push(
                    `step ${step}: scrollTop ${settlement.finalScrollTop}px, expected ${expectedScrollTop}px`,
                );
            }
            const sample = await collectPdfVirtualizationSnapshot(session.page);
            virtualizationSamples.push(sample);
            maxMountedPage = Math.max(
                maxMountedPage,
                ...sample.mountedPages.map(page => page.pageNumber),
            );
        }
        await waitForVisibleMountedPdfCanvases(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS);
        const finalVirtualizationSample = await collectPdfVirtualizationSnapshot(session.page);
        virtualizationSamples.push(finalVirtualizationSample);
        const identityPage = finalVirtualizationSample.visiblePages[0]?.pageNumber ?? maxMountedPage;
        await waitForScannedFixturePageIdentity(
            session.page,
            identityPage,
            PR_BLOCKING_SMOKE_TIMEOUT_MS,
        );
        expect(maxMountedPage).toBeGreaterThanOrEqual(10);
        expect(finalVirtualizationSample.totalPages).toBe(LARGE_PDF_PAGE_COUNT);
        expect(
            findPdfVirtualizationContractViolations(virtualizationSamples),
            JSON.stringify(virtualizationSamples),
        ).toEqual([]);
        expect(wheelScrollViolations, JSON.stringify(virtualizationSamples)).toEqual([]);

        const repeatedOpenTimings = [summarizeCommittedSurfaceTiming(committedSurfaceTrace)];
        for (let attempt = 2; attempt <= 5; attempt += 1) {
            await closeActiveDocumentToEmpty(session.page);
            const repeatedOpen = await captureRepeatedLargePdfOpen(session.page, fixturePath);
            const repeatedSurfaceViolations = findCommittedSurfaceCausalOpenViolations(
                repeatedOpen.surfaceTrace,
                {
                    maxFirstCanvasMs: LARGE_PDF_FIRST_VISUAL_BUDGET_MS,
                    maxFirstPageShellMs: LARGE_PDF_FIRST_PAGE_SHELL_BUDGET_MS,
                    maxReadyAfterCanvasMs: LARGE_PDF_READY_AFTER_CANVAS_BUDGET_MS,
                    requirePageShell: true,
                },
            );
            expect(
                findInitialRenderAuthorityViolations(
                    repeatedOpen.renderTrace,
                    repeatedOpen.lifecycleState.committedPage,
                ),
                JSON.stringify(repeatedOpen.renderTrace),
            ).toEqual([]);
            expect(
                repeatedSurfaceViolations,
                JSON.stringify(repeatedOpen.surfaceTrace.frames),
            ).toEqual([]);
            expect(repeatedOpen.lifecycleState.hiddenLoadedHostCount, JSON.stringify(repeatedOpen)).toBe(0);
            expect(repeatedOpen.lifecycleState.loadedHostCount, JSON.stringify(repeatedOpen)).toBe(1);
            repeatedOpenTimings.push(summarizeCommittedSurfaceTiming(repeatedOpen.surfaceTrace));
        }
        const firstOpenShellMs = repeatedOpenTimings[0]?.firstPageShellMs;
        expect(firstOpenShellMs, JSON.stringify(repeatedOpenTimings)).not.toBeNull();
        for (const timing of repeatedOpenTimings.slice(1)) {
            expect(timing.firstPageShellMs, JSON.stringify(repeatedOpenTimings)).not.toBeNull();
            expect(
                timing.firstPageShellMs ?? Number.POSITIVE_INFINITY,
                JSON.stringify(repeatedOpenTimings),
            ).toBeLessThanOrEqual(
                (firstOpenShellMs ?? 0) + REPEATED_OPEN_SHELL_JITTER_BUDGET_MS,
            );
        }
    });

    pressureIt('keeps large-PDF interaction transitions causally stable', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            hard: true,
            keepNuxt: true,
            sessionName: 'e2e-pr-blocking-large-scanned-pdf-interactions',
        });
        const fixturePath = await createLargeScannedFixturePdf(
            'pr-blocking-large-scanned-pdf-interactions.pdf',
            LARGE_PDF_PAGE_COUNT,
            28 * 1024 * 1024,
            1,
            {runOwner: PR_BLOCKING_FIXTURE_OWNER},
        );
        await openPdfInApp(session.page, fixturePath, LARGE_PDF_VISUAL_READY_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, LARGE_PDF_VISUAL_READY_TIMEOUT_MS);
        await waitForVisibleMountedPdfCanvases(session.page, LARGE_PDF_VISUAL_READY_TIMEOUT_MS);
        await startPdfRenderTrace(session.page);

        // Keep the same causal RAF sampler alive through the complete interaction
        // tail. Stable checkpoints are marked only after the corresponding
        // workspace/viewer authority reports its committed state; transition
        // frames remain observable under the preceding transition checkpoint.
        await installCommittedSurfaceSampler(session.page);
        await runLargePdfInteractionWait(session.page, 1, () => (
            waitForWorkspaceToolbarSnapshot(
                session.page,
                {
                    continuousScroll: true,
                    currentPage: 1,
                },
                {timeoutMs: LARGE_PDF_INTERACTION_WAIT_TIMEOUT_MS},
            )
        ));
        await markCommittedSurfaceInteractionCheckpoint(session.page, 'continuous-stable');
        await waitForCommittedSurfaceSamples(session.page, {
            interactionCheckpoint: 'continuous-stable',
            minimumSamples: 10,
        });

        await markCommittedSurfaceInteractionCheckpoint(session.page, 'single-page-transition');
        await requireWorkspaceCommand(session.page, 'handleToggleContinuousScroll');
        await runLargePdfInteractionWait(session.page, 1, () => (
            waitForWorkspaceToolbarSnapshot(
                session.page,
                {
                    continuousScroll: false,
                    currentPage: 1,
                },
                {timeoutMs: LARGE_PDF_INTERACTION_WAIT_TIMEOUT_MS},
            )
        ));
        await runLargePdfInteractionWait(session.page, 1, () => (
            waitForFunctionInPage(session.page, () => {
                const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer');
                const canvas = viewer?.querySelector<HTMLCanvasElement>(
                    '.page_container[data-page="1"] .page_canvas canvas',
                ) ?? null;
                return Boolean(
                    viewer?.classList.contains('pdfViewer--single-page')
                    && canvas
                    && canvas.width > 0
                    && canvas.height > 0,
                );
            }, {timeout: LARGE_PDF_INTERACTION_WAIT_TIMEOUT_MS})
        ));
        await markCommittedSurfaceInteractionCheckpoint(session.page, 'single-page-stable');
        await waitForCommittedSurfaceSamples(session.page, {
            interactionCheckpoint: 'single-page-stable',
            minimumSamples: 10,
        });

        await markCommittedSurfaceInteractionCheckpoint(session.page, 'page-7-transition');
        await runPdfDiagnosticStage(session.page, 'interaction:go-to-page-7', () => (
            goToPageViaToolbar(session.page, 7)
        ));
        await runLargePdfInteractionWait(session.page, 7, () => (
            waitForWorkspaceToolbarSnapshot(
                session.page,
                {
                    continuousScroll: false,
                    currentPage: 7,
                },
                {timeoutMs: LARGE_PDF_INTERACTION_WAIT_TIMEOUT_MS},
            )
        ));
        await runLargePdfInteractionWait(session.page, 7, () => (
            waitForFunctionInPage(session.page, () => {
                const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer');
                const page = viewer?.querySelector<HTMLElement>('.page_container[data-page="7"]') ?? null;
                const canvas = page?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
                const viewerRect = viewer?.getBoundingClientRect() ?? null;
                const pageRect = page?.getBoundingClientRect() ?? null;
                const viewportCenter = viewerRect ? viewerRect.top + viewerRect.height / 2 : null;
                return Boolean(
                    canvas
                    && canvas.width > 0
                    && canvas.height > 0
                    && canvas.getBoundingClientRect().width > 0
                    && page?.classList.contains('page_container--rendered')
                    && !page.querySelector('.document-page-skeleton')
                    && pageRect
                    && viewportCenter !== null
                    && pageRect.top <= viewportCenter
                    && pageRect.bottom >= viewportCenter,
                );
            }, {timeout: LARGE_PDF_INTERACTION_WAIT_TIMEOUT_MS})
        ));
        await markCommittedSurfaceInteractionCheckpoint(session.page, 'page-7-stable');
        await waitForCommittedSurfaceSamples(session.page, {
            interactionCheckpoint: 'page-7-stable',
            minimumSamples: 10,
        });

        await installWorkspaceExposeProbe(session.page);
        const zoomResult = await runPdfDiagnosticStage(
            session.page,
            'interaction:set-custom-zoom',
            () => evaluateInPage(session.page, async (zoom: number) => {
                const testWindow = window as typeof window & {__committedSurfaceInteractionCheckpoint?: string | null;};
                testWindow.__committedSurfaceInteractionCheckpoint = 'high-zoom-transition';
                return testWindow.__evbTestApi?.callActiveWorkspaceCommand(
                    'setCustomZoomFromDisplay',
                    [zoom],
                ) ?? {
                    called: false,
                    value: null,
                };
            }, 5.03),
        );
        if (!zoomResult.called) {
            throw new Error('The active workspace has no setCustomZoomFromDisplay command, so this setup did nothing');
        }
        await runLargePdfInteractionWait(session.page, 7, () => (
            waitForWorkspaceToolbarSnapshot(
                session.page,
                {
                    currentPage: 7,
                    minEffectiveZoom: 5.02,
                    zoomMode: 'custom',
                },
                {timeoutMs: LARGE_PDF_INTERACTION_WAIT_TIMEOUT_MS},
            )
        ));
        // The constrained tier floors the output scale at 1x (and the pixel budget
        // can clamp further), so backing density is host-dependent; only presentation
        // geometry is contractual.
        await runPdfDiagnosticStage(session.page, 'interaction:wait-high-zoom-page-7', () => (
            runLargePdfInteractionWait(session.page, 7, () => (
                waitForFunctionInPage(session.page, () => {
                    const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer');
                    const page = viewer?.querySelector<HTMLElement>('.page_container[data-page="7"]') ?? null;
                    const canvas = page?.querySelector<HTMLCanvasElement>('.page_canvas__render-layer canvas') ?? null;
                    const canvasRect = canvas?.getBoundingClientRect() ?? null;
                    return Boolean(
                        viewer
                        && viewer.scrollWidth > viewer.clientWidth + 20
                        && page?.classList.contains('page_container--rendered')
                        && !page.querySelector('.document-page-skeleton')
                        && canvas
                        && canvas.width > 0
                        && canvas.height > 0
                        && canvasRect
                        && canvasRect.width > 2_500
                        && canvas.width >= canvasRect.width - 1,
                    );
                }, {timeout: LARGE_PDF_INTERACTION_WAIT_TIMEOUT_MS})
            ))
        ));
        const highZoom = await evaluateInPage(session.page, () => {
            const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer');
            const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            if (!viewer) {
                return null;
            }
            const before = viewer.scrollLeft;
            viewer.scrollLeft = Math.min(viewer.scrollWidth - viewer.clientWidth, before + 96);
            const viewerRect = viewer.getBoundingClientRect();
            const hostRect = host?.getBoundingClientRect() ?? null;
            return {
                after: viewer.scrollLeft,
                before,
                bodyOverflow: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
                documentOverflow: Math.max(
                    0,
                    document.documentElement.scrollWidth - document.documentElement.clientWidth,
                ),
                hostRight: hostRect?.right ?? null,
                viewerOverflow: viewer.scrollWidth - viewer.clientWidth,
                viewerRight: viewerRect.right,
            };
        });
        await waitForAnimationFrames(session.page);
        await markCommittedSurfaceInteractionCheckpoint(session.page, 'high-zoom-stable');
        await waitForCommittedSurfaceSamples(session.page, {
            interactionCheckpoint: 'high-zoom-stable',
            minimumSamples: 10,
        });
        const interactionTailTrace = await stopCommittedSurfaceSampler(session.page);
        const interactionRenderTrace = await stopPdfRenderTrace(session.page);
        const interactionTailViolations = findCommittedSurfaceInteractionTailViolations(interactionTailTrace, {
            allowedSkeletonCheckpoints: [
                'page-7-transition',
                'high-zoom-transition',
            ],
            expectedPageByCheckpoint: {
                'continuous-stable': 1,
                'high-zoom-transition': 7,
                'single-page-stable': 1,
                'page-7-stable': 7,
                'high-zoom-stable': 7,
            },
            horizontalOverflowCheckpoint: 'high-zoom-transition',
            minStableFrames: 10,
            preserveShellIdentityAcross: [
                [
                    'continuous-stable',
                    'single-page-stable',
                ],
                [
                    'page-7-stable',
                    'high-zoom-stable',
                ],
            ],
            preserveWidthAcross: [[
                'continuous-stable',
                'single-page-stable',
                'page-7-stable',
            ]],
            stableCheckpoints: [
                'continuous-stable',
                'single-page-stable',
                'page-7-stable',
                'high-zoom-stable',
            ],
        });
        expect(
            interactionTailViolations,
            JSON.stringify({
                violations: interactionTailViolations,
                renderTrace: interactionRenderTrace.filter(entry => (
                    entry.payload.pageNumber === 7
                    || /cleanup|demand|rerender|visible-render/.test(entry.event)
                )).slice(-120),
            }),
        ).toEqual([]);
        expect(highZoom, JSON.stringify(highZoom)).not.toBeNull();
        expect(highZoom?.viewerOverflow ?? 0, JSON.stringify(highZoom)).toBeGreaterThan(20);
        expect(highZoom?.after ?? 0, JSON.stringify(highZoom)).toBeGreaterThan(highZoom?.before ?? 0);
        expect(highZoom?.bodyOverflow ?? -1, JSON.stringify(highZoom)).toBeLessThanOrEqual(1);
        expect(highZoom?.documentOverflow ?? -1, JSON.stringify(highZoom)).toBeLessThanOrEqual(1);
        expect(
            Math.abs((highZoom?.hostRight ?? 0) - (highZoom?.viewerRight ?? 100)),
            JSON.stringify(highZoom),
        ).toBeLessThanOrEqual(2);
    });

    pressureIt('does not report a delayed render error for a high-zoom current page', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            hard: true,
            keepNuxt: true,
            sessionName: 'e2e-pr-blocking-current-page-render-watchdog',
        });
        const fixturePath = await createMultiPageTextFixturePdf(
            'current-page-render-watchdog.pdf',
            8,
        );
        await waitForCommittedEmptyBaseline(session.page);
        await installCommittedSurfaceSampler(
            session.page,
            LIFECYCLE_ONLY_SURFACE_SAMPLER_OPTIONS,
        );
        await openPdfInApp(session.page, fixturePath, PR_BLOCKING_SMOKE_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS);
        await waitForVisuallyPresentedPdfPage(session.page, 1);
        await waitForCommittedSurfaceSamples(session.page, {
            kind: 'committed-canvas',
            minimumSamples: 10,
        });
        const smallFixtureSurfaceTrace = await stopCommittedSurfaceSampler(session.page);
        const smallFixtureSurfaceDiagnostic = smallFixtureSurfaceTrace.frames.filter((frame, index, frames) => (
            frame.kind === 'blank'
            || frame.kind === 'loader'
            || frame.kind === 'neutral'
            || frame.kind !== frames[index - 1]?.kind
            || frame.kind !== frames[index + 1]?.kind
        ));
        expect(
            findCommittedSurfaceContractViolations(smallFixtureSurfaceTrace),
            JSON.stringify(smallFixtureSurfaceDiagnostic),
        ).toEqual([]);
        await requireWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [5.03]);
        await goToPageViaToolbar(session.page, 7);
        await waitForFunctionInPage(session.page, () => {
            const canvas = document.querySelector<HTMLCanvasElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer .page_container[data-page="7"] .page_canvas canvas',
            );
            return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
        }, {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS});

        await new Promise(resolve => setTimeout(resolve, 8_500));
        const currentPageState = await evaluateInPage(session.page, () => {
            const isVisible = (element: HTMLElement) => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return rect.width > 0
                    && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0;
            };
            const canvas = document.querySelector<HTMLCanvasElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer .page_container[data-page="7"] .page_canvas canvas',
            );
            const visibleErrors = Array.from(document.querySelectorAll<HTMLElement>(
                '.pdf-error, .viewer-error, [data-error="true"], [data-testid="workspace-document-pdf-error"]',
            )).filter(isVisible);
            return {
                canvasHeight: canvas?.height ?? 0,
                canvasWidth: canvas?.width ?? 0,
                errorTexts: visibleErrors.map(error => error.textContent?.trim() ?? ''),
            };
        });
        expect(currentPageState.canvasWidth, JSON.stringify(currentPageState)).toBeGreaterThan(0);
        expect(currentPageState.canvasHeight, JSON.stringify(currentPageState)).toBeGreaterThan(0);
        expect(currentPageState.errorTexts, JSON.stringify(currentPageState)).toEqual([]);
    });
});

runDjvuBlockingOrSkip('Electron E2E - PR Blocking DjVu Committed Surface', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: 'e2e-pr-blocking-djvu-committed-surface',
        timeoutMs: PR_BLOCKING_SMOKE_TIMEOUT_MS,
    });

    it('commits one stable in-frame DjVu page shell before the first page visual', async () => {
        const session = sessionFixture.getSession();
        if (!djvuBlockingFixture.path) {
            throw new Error(djvuBlockingFixture.reason);
        }

        // Establish the same revision-fenced geometry cache populated by the
        // application-level Recent warmup, then exercise the reopen handoff.
        await openDjvuInApp(
            session.page,
            djvuBlockingFixture.path,
            PR_BLOCKING_SMOKE_TIMEOUT_MS,
        );
        await waitForDjvuLoaded(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS);
        await closeActiveDocumentToEmpty(session.page);
        await waitForCommittedEmptyBaseline(session.page);
        await installCommittedSurfaceSampler(session.page);
        await openActionableRecentFile(
            session.page,
            djvuBlockingFixture.path,
        );
        await waitForDjvuLoaded(session.page, PR_BLOCKING_SMOKE_TIMEOUT_MS);
        await waitForFunctionInPage(session.page, () => {
            const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
            const viewport = host?.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport]') ?? null;
            const page = host?.querySelector<HTMLElement>(
                '[data-testid="document-page-source-page"][data-page-source-visual="fresh"]',
            ) ?? null;
            const image = page?.querySelector<HTMLImageElement>(
                ':scope > [data-testid="document-page-source-image"]',
            ) ?? null;
            return Boolean(
                image?.complete
                && image.naturalWidth > 0
                && image.naturalHeight > 0
                && viewport?.dataset.openSurfacePhase === 'ready'
                && chassis?.dataset.openSurfacePresentation === 'committed',
            );
        }, {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS});

        // Observe actual browser-presentable frames rather than inferring their
        // count from wall time. Busy Electron renderers can coalesce RAFs even
        // after the image has decoded.
        await waitForFunctionInPage(session.page, () => {
            const testWindow = window as typeof window & {__committedSurfaceFrames?: Array<{kind?: string}>};
            const frames = testWindow.__committedSurfaceFrames ?? [];
            const firstCanvasIndex = frames.findIndex(frame => frame.kind === 'committed-canvas');
            return firstCanvasIndex >= 0
                && frames.slice(firstCanvasIndex).filter(frame => frame.kind === 'committed-canvas').length >= 10;
        }, {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS});
        const trace = await stopCommittedSurfaceSampler(session.page);
        const clickFrame = trace.frames.find(frame => frame.interactionCheckpoint === 'recent-djvu-click');
        const postClickFrames = trace.frames
            .filter(frame => frame.interactionCheckpoint === 'recent-djvu-click')
            .map(frame => ({
                ...frame,
                elapsedMs: Math.max(0, frame.elapsedMs - (clickFrame?.elapsedMs ?? 0)),
            }));
        const postClickTrace = {frames: postClickFrames};
        const diagnostic = postClickTrace.frames.filter((frame, index, frames) => (
            frame.kind === 'blank'
            || frame.kind === 'loader'
            || frame.kind === 'neutral'
            || frame.kind !== frames[index - 1]?.kind
            || frame.kind !== frames[index + 1]?.kind
        ));
        const timing = summarizeCommittedSurfaceTiming(postClickTrace);
        const pendingEmptyFrames = postClickTrace.frames.filter(frame => (
            frame.kind === 'committed-empty' && frame.openSurfacePhase === 'pending'
        ));
        const firstReadyFrame = postClickTrace.frames.find(frame => (
            frame.openSurfacePhase === 'ready'
            && frame.openSurfacePresentation === 'committed'
        ));
        const stalePostReadyFrames = firstReadyFrame
            ? postClickTrace.frames.filter(frame => (
                frame.frame > firstReadyFrame.frame
                && (
                    frame.openSurfacePhase !== 'ready'
                    || frame.openSurfacePresentation !== 'committed'
                )
            ))
            : [];
        console.info('[E2E recent DjVu open timing]', JSON.stringify({
            diagnostic,
            firstReadyMs: firstReadyFrame?.elapsedMs ?? null,
            pendingEmptyFrames: pendingEmptyFrames.length,
            timing,
        }));
        expect(clickFrame, JSON.stringify(trace.frames)).toBeDefined();
        expect(pendingEmptyFrames.length, JSON.stringify(pendingEmptyFrames)).toBeLessThanOrEqual(2);
        expect(firstReadyFrame, JSON.stringify(postClickTrace.frames)).toBeDefined();
        expect(stalePostReadyFrames, JSON.stringify(stalePostReadyFrames)).toEqual([]);
        expect(
            findCommittedSurfaceCausalOpenViolations(postClickTrace, {
                maxFirstCanvasMs: DJVU_FIRST_VISUAL_BUDGET_MS,
                maxFirstPageShellMs: DJVU_FIRST_PAGE_SHELL_BUDGET_MS,
                maxReadyAfterCanvasMs: DJVU_READY_AFTER_VISUAL_BUDGET_MS,
                requirePageShell: true,
            }),
            JSON.stringify({
                diagnostic,
                timing,
            }),
        ).toEqual([]);

        for (const targetPage of [
            2,
            1,
        ]) {
            // This lane owns the DjVu committed-surface/navigation contract.
            // The PDF toolbar's transient inline editor is covered separately
            // and is not a valid prerequisite for page-source navigation.
            await requireWorkspaceCommand(
                session.page,
                'handleGoToPage',
                [targetPage],
            );
            await waitForFunctionInPage(session.page, (pageNumber: number) => {
                const host = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
                );
                const viewport = host?.querySelector<HTMLElement>(
                    '[data-document-viewer-chassis-viewport]',
                ) ?? null;
                const page = host?.querySelector<HTMLElement>(
                    `[data-testid="document-page-source-page"][data-page-number="${String(pageNumber)}"]`,
                ) ?? null;
                const image = page?.querySelector<HTMLImageElement>(
                    ':scope > [data-testid="document-page-source-image"]',
                ) ?? null;
                return Boolean(
                    page?.dataset.pageSourceVisual === 'fresh'
                    && image?.complete
                    && image.naturalWidth > 0
                    && image.naturalHeight > 0
                    && !page.querySelector('.document-source-viewer__skeleton')
                    && !page.querySelector('[role="alert"]')
                    && viewport?.dataset.openSurfacePhase === 'ready',
                );
            }, {timeout: PR_BLOCKING_SMOKE_TIMEOUT_MS}, targetPage);
        }
    });
});
