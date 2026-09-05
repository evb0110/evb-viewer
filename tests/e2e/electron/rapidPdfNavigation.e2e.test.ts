import {
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { delay } from 'es-toolkit/promise';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    createLargeScannedFixturePdf,
    resolvePathFixtureAvailability,
} from '@tests/e2e/electron/helpers/fixtures';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import { openPdfInApp } from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import type { IPdfRenderTraceEntry } from '@app/utils/pdfRenderTrace';
import type { IEvbTestApi } from '@app/types/evbTestApi';
import { enablePdfDiagnosticSession } from '@tests/e2e/electron/helpers/pdfDiagnosticSession';
import {
    installCommittedSurfaceSampler,
    stopCommittedSurfaceSampler,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';
import {
    collectPdfVirtualizationSnapshot,
    findMissingVisualFrames,
    findPdfVirtualizationContractViolations,
    waitForAnimationFrames,
    waitForScannedFixturePageIdentity,
    waitForVisibleMountedPdfCanvases,
    wheelPdfViewportAndWaitForSettlement,
} from '@tests/e2e/electron/helpers/viewerVirtualizationContract';

const PAGE_JUMP_PDF_ENV_VAR = 'EVB_E2E_PAGE_JUMP_PDF_PATH';
const PAGE_JUMP_PDF_OVERRIDE = process.env[PAGE_JUMP_PDF_ENV_VAR]?.trim() ?? null;
const GENERATED_PAGE_JUMP_PAGE_COUNT = 431;
const TARGET_PAGE = 100;
const TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-page-100-jump-trace.json',
);
const NEXT_PREV_TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-next-prev-10-to-7-trace.json',
);
const RAPID_NEXT_TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-rapid-next-to-21-trace.json',
);
const CONTINUOUS_SCROLL_TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-continuous-scroll-virtualization-trace.json',
);
const TRUSTED_FAST_SCROLL_TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-trusted-fast-scroll-trace.json',
);
const TRUSTED_FAST_SCROLL_FIRST_PAGE_TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-trusted-fast-scroll-first-page-trace.json',
);
const IN_FLIGHT_SCROLL_TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-in-flight-scroll-trace.json',
);
const NEXT_FIT_WIDTH_TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-next-fit-width-visual-trace.json',
);
const LAST_PAGE_TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-last-page-navigation-trace.json',
);
const PAGED_FIT_HEIGHT_WHEEL_TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-paged-fit-height-wheel-trace.json',
);
const PAGED_FIT_HEIGHT_BACKWARD_WHEEL_TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-paged-fit-height-backward-wheel-trace.json',
);
interface IVisiblePageState {
    page: number | null;
    renderedClass: boolean;
    hasCanvas: boolean;
    canvasCount: number;
    textSpanCount: number;
    noteCount: number;
    linkOverlayCount: number;
    shapeOverlayCount: number;
    visibleShapeCount: number;
    annotationEditorNodeCount: number;
    skeletonDisplay: string | null;
    rectTop: number;
    rectHeight: number;
    computedVisible: boolean;
    topmost: boolean;
}

interface IPageButtonState {
    label: string;
    disabled: boolean;
    visible: boolean;
}

interface IRapidNavigationProbeWindow { __evbTestApi?: IEvbTestApi }

function writeTraceArtifact(payload: unknown, outputPath = TRACE_OUTPUT_PATH) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function resolvePageJumpPdfPath() {
    if (PAGE_JUMP_PDF_OVERRIDE) {
        const override = resolvePathFixtureAvailability({
            path: PAGE_JUMP_PDF_OVERRIDE,
            label: 'page-jump PDF override',
            requiredEnvVar: PAGE_JUMP_PDF_ENV_VAR,
        });
        if (!override.path) {
            throw new Error(override.reason);
        }
        return override.path;
    }

    return createLargeScannedFixturePdf(
        `page-jump-source-${Date.now()}.pdf`,
        GENERATED_PAGE_JUMP_PAGE_COUNT,
        0,
    );
}

async function enableBufferedPdfTrace(session: IElectronE2ESession) {
    await enablePdfDiagnosticSession(session.page, {render: true});
}

async function collectNavigationControlState(session: IElectronE2ESession) {
    return session.page.evaluate(() => ({
        pageControlsText: document.querySelector<HTMLElement>('.page-controls')?.innerText ?? '',
        pageButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button[aria-label]'))
            .map((button): IPageButtonState => {
                const rect = button.getBoundingClientRect();
                const style = window.getComputedStyle(button);
                return {
                    label: button.getAttribute('aria-label') ?? '',
                    disabled: button.disabled,
                    visible: (
                        rect.width > 0
                        && rect.height > 0
                        && style.display !== 'none'
                        && style.visibility !== 'hidden'
                    ),
                };
            }),
    }));
}

async function collectVisiblePageState(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const activeHost = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const viewport = activeHost?.querySelector<HTMLElement>(
            '.pdf-viewer-viewport, .pdfViewer, #pdf-viewer',
        ) ?? null;
        if (!activeHost || !viewport) {
            return [];
        }
        const viewportRect = viewport?.getBoundingClientRect() ?? {
            left: 0,
            right: window.innerWidth,
            top: 0,
            bottom: window.innerHeight,
        };
        return Array.from(activeHost.querySelectorAll<HTMLElement>('.page_container'))
            .filter((container) => {
                const rect = container.getBoundingClientRect();
                return rect.bottom > viewportRect.top
                    && rect.top < viewportRect.bottom
                    && rect.right > viewportRect.left
                    && rect.left < viewportRect.right;
            })
            .map((container): IVisiblePageState => {
                const rect = container.getBoundingClientRect();
                const skeleton = container.querySelector<HTMLElement>('.document-page-skeleton');
                const style = window.getComputedStyle(container);
                const intersectionLeft = Math.max(viewportRect.left, rect.left);
                const intersectionRight = Math.min(viewportRect.right, rect.right);
                const intersectionTop = Math.max(viewportRect.top, rect.top);
                const intersectionBottom = Math.min(viewportRect.bottom, rect.bottom);
                const topmost = intersectionRight > intersectionLeft && intersectionBottom > intersectionTop
                    ? document.elementFromPoint(
                        intersectionLeft + ((intersectionRight - intersectionLeft) / 2),
                        intersectionTop + ((intersectionBottom - intersectionTop) / 2),
                    )
                    : null;
                return {
                    page: Number(container.dataset.page) || null,
                    renderedClass: container.classList.contains('page_container--rendered'),
                    hasCanvas: Boolean(container.querySelector('.page_canvas canvas')),
                    canvasCount: container.querySelectorAll('.page_canvas canvas').length,
                    textSpanCount: container.querySelectorAll('.text-layer span, .textLayer span').length,
                    noteCount: container.querySelectorAll('.pdf-annotation-editor-note').length,
                    linkOverlayCount: container.querySelectorAll('.pdf-link-overlay').length,
                    shapeOverlayCount: container.querySelectorAll('.pdf-shape-overlay').length,
                    visibleShapeCount: container.querySelectorAll('.pdf-shape-overlay > g:not(.is-drawing)').length,
                    annotationEditorNodeCount: container.querySelectorAll('.annotationEditorLayer *, .annotation-editor-layer *').length,
                    skeletonDisplay: skeleton?.style.display ?? null,
                    rectTop: rect.top,
                    rectHeight: rect.height,
                    computedVisible: style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && Number(style.opacity || '1') > 0,
                    topmost: topmost?.closest('.page_container') === container,
                };
            })
            .filter(page => page.computedVisible);
    });
}

async function collectVirtualScrollGeometry(session: IElectronE2ESession, targetPage: number) {
    return session.page.evaluate((pageNumber) => {
        const viewport = document.querySelector<HTMLElement>('.pdf-viewer-viewport, .pdfViewer, #pdf-viewer');
        const target = document.querySelector<HTMLElement>(`.page_container[data-page="${pageNumber}"]`);
        const targetRect = target?.getBoundingClientRect() ?? null;
        return {
            viewport: viewport ? {
                clientHeight: viewport.clientHeight,
                scrollHeight: viewport.scrollHeight,
                scrollTop: viewport.scrollTop,
            } : null,
            target: targetRect ? {
                offsetTop: target?.offsetTop ?? null,
                rectHeight: targetRect.height,
                rectTop: targetRect.top,
            } : null,
            spacers: Array.from(document.querySelectorAll<HTMLElement>('.pdf-viewer-virtual-spacer')).map((spacer) => {
                const rect = spacer.getBoundingClientRect();
                return {
                    computedHeight: window.getComputedStyle(spacer).height,
                    inlineHeight: spacer.style.height,
                    offsetHeight: spacer.offsetHeight,
                    rectHeight: rect.height,
                };
            }),
        };
    }, targetPage);
}

async function collectConsecutivePageGaps(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const pages = Array.from(document.querySelectorAll<HTMLElement>(
            '#pdf-viewer .page_container:not(.page_container--buffered)',
        )).map((element) => {
            const rect = element.getBoundingClientRect();
            return {
                bottom: rect.bottom,
                page: Number(element.dataset.page),
                top: rect.top,
            };
        }).filter(page => Number.isSafeInteger(page.page))
            .sort((left, right) => left.page - right.page);
        return pages.slice(1).flatMap((page, index) => {
            const previous = pages[index]!;
            return page.page === previous.page + 1
                ? [{
                    fromPage: previous.page,
                    gap: page.top - previous.bottom,
                    toPage: page.page,
                }]
                : [];
        });
    });
}

async function collectCommittedCanvasQuality(
    session: IElectronE2ESession,
    pageNumber: number,
    marker?: string,
) {
    return session.page.evaluate((input) => {
        const page = document.querySelector<HTMLElement>(
            `#pdf-viewer .page_container[data-page="${String(input.pageNumber)}"]`,
        );
        const canvas = page?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
        if (!page || !canvas) {
            return null;
        }
        if (input.marker) {
            canvas.dataset.e2eCommittedCanvasMarker = input.marker;
        }
        const rect = canvas.getBoundingClientRect();
        const context = canvas.getContext('2d');
        let luminanceVariance = 0;
        if (context && canvas.width > 0 && canvas.height > 0) {
            const samples: number[] = [];
            for (let row = 1; row <= 8; row += 1) {
                for (let column = 1; column <= 8; column += 1) {
                    const x = Math.min(canvas.width - 1, Math.round((canvas.width * column) / 9));
                    const y = Math.min(canvas.height - 1, Math.round((canvas.height * row) / 9));
                    const pixel = context.getImageData(x, y, 1, 1).data;
                    samples.push((pixel[0]! * 0.2126) + (pixel[1]! * 0.7152) + (pixel[2]! * 0.0722));
                }
            }
            const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
            luminanceVariance = samples.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
                / samples.length;
        }
        return {
            backingHeight: canvas.height,
            backingScaleX: rect.width > 0 ? canvas.width / rect.width : 0,
            backingScaleY: rect.height > 0 ? canvas.height / rect.height : 0,
            backingWidth: canvas.width,
            cssHeight: rect.height,
            cssWidth: rect.width,
            luminanceVariance,
            marker: canvas.dataset.e2eCommittedCanvasMarker ?? '',
            rendered: page.classList.contains('page_container--rendered'),
            skeletonVisible: Array.from(page.querySelectorAll<HTMLElement>('.document-page-skeleton'))
                .some(skeleton => window.getComputedStyle(skeleton).display !== 'none'),
        };
    }, {
        marker,
        pageNumber,
    });
}

async function collectTrace(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const traceWindow = window as IE2EWindow & { __getPdfRenderTrace?: () => IPdfRenderTraceEntry[]; };
        return traceWindow.__getPdfRenderTrace?.() ?? [];
    });
}

async function collectRapidNavigationDebug(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const probeWindow = window as Window & IRapidNavigationProbeWindow;
        return {
            activeToolbarSnapshot: probeWindow.__evbTestApi?.getActiveToolbarSnapshot?.() ?? null,
            toolbarPrimaryTexts: Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
                .map(element => element.textContent?.trim() ?? ''),
            workspaceDebugState: probeWindow.__evbTestApi?.collectWorkspaceDebugState?.() ?? null,
        };
    });
}

async function collectRapidNavigationFrameSamples(session: IElectronE2ESession, durationMs = 1_000) {
    return session.page.evaluate(async (duration) => {
        const samples: unknown[] = [];
        const startedAt = performance.now();
        const collectPage = (activeHost: HTMLElement, pageNumber: number) => {
            const page = activeHost.querySelector<HTMLElement>(
                `.page_container[data-page="${String(pageNumber)}"]`,
            );
            const rect = page?.getBoundingClientRect() ?? null;
            const canvas = page?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
            return {
                buffered: page?.classList.contains('page_container--buffered') ?? false,
                canvasHeight: canvas?.height ?? 0,
                canvasMounted: Boolean(canvas?.isConnected),
                canvasWidth: canvas?.width ?? 0,
                rect: rect ? {
                    bottom: rect.bottom,
                    height: rect.height,
                    top: rect.top,
                } : null,
                rendered: page?.classList.contains('page_container--rendered') ?? false,
            };
        };
        while (performance.now() - startedAt < duration) {
            await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
            const activeHost = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const viewport = activeHost?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
            const chassis = viewport?.closest<HTMLElement>('.document-viewer-chassis') ?? null;
            samples.push({
                chassis: chassis ? {
                    committedPage: Number(chassis.dataset.viewportCommittedPage) || null,
                    lifecycle: chassis.dataset.viewportLifecycle ?? null,
                    requestedPage: Number(chassis.dataset.viewportRequestedPage) || null,
                    stagedRenderPage: Number(chassis.dataset.viewportStagedRenderPage) || null,
                    stagedViewportPage: Number(chassis.dataset.viewportStagedViewportPage) || null,
                    visualPage: Number(chassis.dataset.viewportVisualPage) || null,
                    visualPresentation: chassis.dataset.viewportVisualPresentation ?? null,
                } : null,
                elapsedMs: Math.round(performance.now() - startedAt),
                page20: activeHost ? collectPage(activeHost, 20) : null,
                page21: activeHost ? collectPage(activeHost, 21) : null,
                toolbarPage: (window as IRapidNavigationProbeWindow)
                    .__evbTestApi?.getActiveToolbarSnapshot?.()?.currentPage ?? null,
                viewport: viewport ? {
                    clientHeight: viewport.clientHeight,
                    rect: {
                        bottom: viewport.getBoundingClientRect().bottom,
                        top: viewport.getBoundingClientRect().top,
                    },
                    scrollHeight: viewport.scrollHeight,
                    scrollTop: viewport.scrollTop,
                } : null,
            });
        }
        return samples;
    }, durationMs);
}

async function clickPageNavigationButton(session: IElectronE2ESession, label: string) {
    await session.page.waitForFunction((targetLabel: string) => {
        return Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button[aria-label]'))
            .some((candidate) => {
                const ariaLabel = candidate.getAttribute('aria-label')?.trim() ?? '';
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    (ariaLabel === targetLabel || ariaLabel.startsWith(`${targetLabel} (`))
                    && !candidate.disabled
                    && candidate.getAttribute('aria-disabled') !== 'true'
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                );
            });
    }, { timeout: 12_000 }, label);

    const clicked = await session.page.evaluate((targetLabel: string) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button[aria-label]'))
            .find((candidate) => {
                const ariaLabel = candidate.getAttribute('aria-label')?.trim() ?? '';
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    (ariaLabel === targetLabel || ariaLabel.startsWith(`${targetLabel} (`))
                    && !candidate.disabled
                    && candidate.getAttribute('aria-disabled') !== 'true'
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                );
            });
        button?.click();
        return Boolean(button);
    }, label);

    if (!clicked) {
        throw new Error(`Unable to find enabled page navigation button: ${label}`);
    }
}

async function clickVisibleButtonByAriaLabel(
    session: IElectronE2ESession,
    selector: string,
    label: string,
) {
    await session.page.waitForFunction((targetSelector: string, targetLabel: string) => {
        return Array.from(document.querySelectorAll<HTMLButtonElement>(targetSelector))
            .some((candidate) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return candidate.getAttribute('aria-label') === targetLabel
                    && !candidate.disabled
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
    }, {timeout: 15_000}, selector, label);

    const point = await session.page.evaluate((targetSelector: string, targetLabel: string) => {
        const candidate = Array.from(document.querySelectorAll<HTMLButtonElement>(targetSelector))
            .find((button) => {
                const rect = button.getBoundingClientRect();
                const style = window.getComputedStyle(button);
                return button.getAttribute('aria-label') === targetLabel
                    && !button.disabled
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
        if (!candidate) {
            return null;
        }
        const rect = candidate.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    }, selector, label);
    if (!point) {
        throw new Error(`Unable to find visible ${label} button`);
    }
    await session.page.mouse.click(point.x, point.y);
}

async function waitForToolbarCurrentPage(session: IElectronE2ESession, pageNumber: number) {
    await session.page.waitForFunction((targetPageNumber: number) => {
        const toolbarPage = (window as IRapidNavigationProbeWindow)
            .__evbTestApi?.getActiveToolbarSnapshot?.()?.currentPage;
        if (toolbarPage === targetPageNumber) {
            return true;
        }
        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
        };
        return Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
            .some((element) => {
                const controls = element.closest<HTMLElement>('.page-controls');
                return element.textContent?.trim() === String(targetPageNumber)
                    && isVisibleElement(controls ?? element);
            });
    }, { timeout: 10_000 }, pageNumber);
}

async function waitForVisiblePageCanvas(session: IElectronE2ESession, pageNumber: number, timeout = 10_000) {
    return session.page.waitForFunction((targetPageNumber: number) => {
        const viewer = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer',
        );
        const container = viewer?.querySelector<HTMLElement>(
            `.page_container[data-page="${targetPageNumber}"]`,
        ) ?? null;
        const canvas = container?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
        const viewerRect = viewer?.getBoundingClientRect();
        const rect = container?.getBoundingClientRect();
        if (!viewer || !viewerRect || !container || !rect || !canvas) {
            return false;
        }
        const left = Math.max(viewerRect.left, rect.left);
        const right = Math.min(viewerRect.right, rect.right);
        const top = Math.max(viewerRect.top, rect.top);
        const bottom = Math.min(viewerRect.bottom, rect.bottom);
        if (right <= left || bottom <= top) {
            return false;
        }
        const topmost = document.elementFromPoint(
            left + ((right - left) / 2),
            top + ((bottom - top) / 2),
        );
        return Boolean(
            container?.classList.contains('page_container--rendered')
            && canvas.width > 0
            && canvas.height > 0
            && window.getComputedStyle(container).visibility !== 'hidden'
            && !container.classList.contains('page_container--buffered')
            && topmost?.closest('.page_container') === container,
        );
    }, { timeout }, pageNumber)
        .then(() => true)
        .catch(() => false);
}

async function jumpToPageAndWaitForCanvas(session: IElectronE2ESession, pageNumber: number) {
    await session.page.waitForFunction(() => Boolean(document.querySelector('#pdf-viewer')), { timeout: 15_000 });

    const workspaceJump = await callWorkspaceCommand(session.page, 'handleGoToPage', [pageNumber]);

    if (workspaceJump.called) {
        const canvasMounted = await waitForVisiblePageCanvas(session, pageNumber, 8_000);
        if (canvasMounted) {
            return;
        }
    }

    await callWorkspaceCommand(session.page, 'handleGoToPage', [pageNumber]);

    const canvasMounted = await waitForVisiblePageCanvas(session, pageNumber, 8_000);

    if (canvasMounted) {
        return;
    }

    const displayPoint = await session.page.evaluate(() => {
        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
        };

        const display = Array.from(document.querySelectorAll<HTMLElement>('.page-controls-display'))
            .find(isVisibleElement);
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
        throw new Error(`Unable to find the visible page control for page ${pageNumber}`);
    }

    await session.page.mouse.click(displayPoint.x, displayPoint.y);
    await session.page.waitForFunction(() => {
        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
        };

        return Array.from(document.querySelectorAll<HTMLInputElement>('.page-controls-inline-input'))
            .some(isVisibleElement);
    }, { timeout: 15_000 });

    const inputPoint = await session.page.evaluate(() => {
        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
        };

        const input = Array.from(document.querySelectorAll<HTMLInputElement>('.page-controls-inline-input'))
            .find(isVisibleElement);
        if (!input) {
            return null;
        }

        const rect = input.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    });

    if (!inputPoint) {
        throw new Error(`Unable to find the visible page input for page ${pageNumber}`);
    }

    await session.page.mouse.click(inputPoint.x, inputPoint.y, { count: 3 });
    await session.page.keyboard.type(String(pageNumber));
    await session.page.keyboard.press('Enter');

    await delay(1_000);
}

describe('Electron E2E - paged fit-height backward wheel regression', () => {
    let pdfPath: string | null = null;
    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: false,
        sessionName: () => `e2e-pdf-paged-fit-height-backward-${Date.now()}`,
        timeoutMs: 180_000,
    });

    beforeAll(async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Paged fit-height backward-wheel E2E session did not start');
        }
        pdfPath = await resolvePageJumpPdfPath();
        await enableBufferedPdfTrace(session);
        await openPdfInApp(session.page, pdfPath, 45_000);
    }, 90_000);

    it('returns from page 6 to page 1 and closes cleanly using mouse wheel navigation', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pdfPath) {
            return;
        }
        const states: unknown[] = [];
        const collectState = () => session.page.evaluate(() => {
            const viewport = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer',
            );
            const chassis = viewport?.closest<HTMLElement>('.document-viewer-chassis') ?? null;
            const currentPage = (window as IRapidNavigationProbeWindow).__evbTestApi
                ?.getActiveToolbarSnapshot?.()?.currentPage ?? null;
            const page = currentPage === null
                ? null
                : viewport?.querySelector<HTMLElement>(`.page_container[data-page="${String(currentPage)}"]`) ?? null;
            const canvas = page?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
            return {
                canvasReady: Boolean(
                    page?.classList.contains('page_container--rendered')
                    && canvas
                    && canvas.width > 0
                    && canvas.height > 0
                    && !page.querySelector('.document-page-skeleton'),
                ),
                currentPage,
                lifecycle: chassis?.dataset.viewportLifecycle ?? null,
                requestedPage: Number(chassis?.dataset.viewportRequestedPage) || null,
                skeletonVisible: Boolean(page?.querySelector('.document-page-skeleton')),
                visualPage: Number(chassis?.dataset.viewportVisualPage) || null,
                visualPresentation: chassis?.dataset.viewportVisualPresentation ?? null,
            };
        });

        const initialToolbar = await getWorkspaceToolbarSnapshot(session.page);
        if (initialToolbar?.zoomMode !== 'fit-height') {
            const fitHeight = await callWorkspaceCommand(session.page, 'handleFitHeight');
            expect(fitHeight.called).toBe(true);
        }
        await session.page.waitForFunction(() => (
            (window as IRapidNavigationProbeWindow).__evbTestApi
                ?.getActiveToolbarSnapshot?.()?.zoomMode === 'fit-height'
        ), {timeout: 15_000});
        const fitHeightToolbar = await getWorkspaceToolbarSnapshot(session.page);
        if (fitHeightToolbar?.continuousScroll !== false) {
            const paged = await callWorkspaceCommand(session.page, 'handleToggleContinuousScroll');
            expect(paged.called).toBe(true);
        }
        await session.page.waitForFunction(() => (
            (window as IRapidNavigationProbeWindow).__evbTestApi
                ?.getActiveToolbarSnapshot?.()?.continuousScroll === false
        ), {timeout: 15_000});
        await waitForToolbarCurrentPage(session, 1);
        expect(await waitForVisiblePageCanvas(session, 1, 20_000)).toBe(true);

        const viewportPoint = await session.page.evaluate(() => {
            const viewport = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer',
            );
            if (!viewport) {
                return null;
            }
            const rect = viewport.getBoundingClientRect();
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        });
        expect(viewportPoint).not.toBeNull();
        if (!viewportPoint) {
            return;
        }

        await session.page.mouse.move(viewportPoint.x, viewportPoint.y);
        for (let targetPage = 2; targetPage <= 6; targetPage += 1) {
            await session.page.mouse.wheel({deltaY: 180});
            await waitForToolbarCurrentPage(session, targetPage);
            await delay(450);
            states.push(await collectState());
        }
        expect(await waitForVisiblePageCanvas(session, 6, 20_000)).toBe(true);

        for (let targetPage = 5; targetPage >= 1; targetPage -= 1) {
            await session.page.mouse.wheel({deltaY: -180});
            await waitForToolbarCurrentPage(session, targetPage);
            await delay(450);
            states.push(await collectState());
        }
        const firstPageCanvasReady = await waitForVisiblePageCanvas(session, 1, 20_000);
        const settledState = await collectState();
        states.push(settledState);
        expect(firstPageCanvasReady, JSON.stringify(settledState)).toBe(true);
        expect(settledState).toMatchObject({
            canvasReady: true,
            currentPage: 1,
            lifecycle: 'ready',
            requestedPage: 1,
            skeletonVisible: false,
            visualPage: 1,
            visualPresentation: 'canvas',
        });

        const trace = await collectTrace(session);
        await clickVisibleButtonByAriaLabel(session, '.tab.is-active .tab-close', 'Close Tab');
        await delay(1_000);
        const closeState = await session.page.evaluate(() => ({
            bodyText: document.body.innerText,
            title: document.title,
        }));
        writeTraceArtifact({
            closeState,
            pdfPath,
            scenario: 'paged-fit-height-backward-wheel-and-close',
            settledState,
            states,
            trace,
        }, PAGED_FIT_HEIGHT_BACKWARD_WHEEL_TRACE_OUTPUT_PATH);
        expect(closeState.title).not.toContain('500');
        expect(closeState.bodyText).not.toContain('Invalid document viewport session');
        expect(closeState.bodyText).not.toContain('Internal Server Error');
    }, 90_000);
});

describe('Electron E2E - PDF Page Jump Rendering', () => {
    let pageJumpPdfPath: string | null = null;
    let pageJumpReady = false;

    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: false,
        sessionName: () => `e2e-pdf-page-jump-${Date.now()}`,
        timeoutMs: 180_000,
    });

    beforeAll(async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('PDF page-jump E2E session did not start');
        }

        pageJumpPdfPath = await resolvePageJumpPdfPath();
        await enableBufferedPdfTrace(session);
        await openPdfInApp(session.page, pageJumpPdfPath, 45_000);
        pageJumpReady = true;
    }, 90_000);

    beforeEach(async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady) {
            return;
        }
        const toolbar = await getWorkspaceToolbarSnapshot(session.page);
        if (toolbar?.continuousScroll === false) {
            const continuous = await callWorkspaceCommand(session.page, 'handleToggleContinuousScroll');
            expect(continuous.called).toBe(true);
            await session.page.waitForFunction(() => (
                (window as IRapidNavigationProbeWindow).__evbTestApi
                    ?.getActiveToolbarSnapshot?.()?.continuousScroll === true
            ), {timeout: 15_000});
        }
    }, 20_000);

    it('keeps the toolbar on the final page after Last Page navigation settles', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady) {
            return;
        }

        await jumpToPageAndWaitForCanvas(session, 1);
        await waitForToolbarCurrentPage(session, 1);
        await session.page.waitForFunction(() => (
            Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
                .some(element => element.textContent?.trim() === 'ii')
        ), {timeout: 15_000}).catch(() => undefined);
        const fitHeight = await callWorkspaceCommand(session.page, 'handleFitHeight');
        expect(fitHeight.called).toBe(true);
        await session.page.waitForFunction(() => (
            (window as IRapidNavigationProbeWindow).__evbTestApi
                ?.getActiveToolbarSnapshot?.()?.zoomMode === 'fit-height'
        ), {timeout: 15_000});
        const finalPage = (await getWorkspaceToolbarSnapshot(session.page))?.totalPages ?? 0;
        expect(finalPage).toBeGreaterThan(1);
        await clickPageNavigationButton(session, 'Last Page');
        expect(await waitForVisiblePageCanvas(session, finalPage, 15_000)).toBe(true);

        // Let delayed scroll/viewport projections drain. The regression
        // rendered the final canvas correctly, then rewound only the toolbar
        // projection to page 1 after the navigation had visually settled.
        await delay(2_000);

        const toolbarSnapshot = await getWorkspaceToolbarSnapshot(session.page);
        writeTraceArtifact({
            navigationControls: await collectNavigationControlState(session),
            rapidNavigationDebug: await collectRapidNavigationDebug(session),
            scenario: 'toolbar-last-page',
            toolbarSnapshot,
            trace: await collectTrace(session),
        }, LAST_PAGE_TRACE_OUTPUT_PATH);
        expect(toolbarSnapshot?.currentPage).toBe(finalPage);
    }, 60_000);

    it('keeps paged fit-height wheel navigation visually committed during sustained scrolling', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        await jumpToPageAndWaitForCanvas(session, 1);
        await waitForToolbarCurrentPage(session, 1);
        const fitHeight = await callWorkspaceCommand(session.page, 'handleFitHeight');
        expect(fitHeight.called).toBe(true);
        await session.page.waitForFunction(() => (
            (window as IRapidNavigationProbeWindow).__evbTestApi
                ?.getActiveToolbarSnapshot?.()?.zoomMode === 'fit-height'
        ), {timeout: 15_000});
        const beforePaged = await getWorkspaceToolbarSnapshot(session.page);
        if (beforePaged?.continuousScroll !== false) {
            const paged = await callWorkspaceCommand(session.page, 'handleToggleContinuousScroll');
            expect(paged.called).toBe(true);
        }
        await session.page.waitForFunction(() => (
            (window as IRapidNavigationProbeWindow).__evbTestApi
                ?.getActiveToolbarSnapshot?.()?.continuousScroll === false
        ), {timeout: 15_000});
        expect(await waitForVisiblePageCanvas(session, 1, 15_000)).toBe(true);

        const viewportPoint = await session.page.evaluate(() => {
            const viewport = document.querySelector<HTMLElement>('#pdf-viewer');
            if (!viewport) {
                return null;
            }
            const rect = viewport.getBoundingClientRect();
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        });
        expect(viewportPoint).not.toBeNull();
        if (!viewportPoint) {
            return;
        }

        const collectPagedState = () => session.page.evaluate(() => {
            const viewport = document.querySelector<HTMLElement>('#pdf-viewer');
            const chassis = viewport?.closest<HTMLElement>('.document-viewer-chassis') ?? null;
            const toolbar = (window as IRapidNavigationProbeWindow).__evbTestApi
                ?.getActiveToolbarSnapshot?.() ?? null;
            const visible = Array.from(
                viewport?.querySelectorAll<HTMLElement>('.page_container:not(.page_container--buffered)') ?? [],
            ).find((page) => {
                const rect = page.getBoundingClientRect();
                const viewportRect = viewport?.getBoundingClientRect();
                return Boolean(viewportRect && rect.bottom > viewportRect.top && rect.top < viewportRect.bottom);
            }) ?? null;
            const canvas = visible?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
            return {
                canvasReady: Boolean(
                    visible?.classList.contains('page_container--rendered')
                    && canvas
                    && canvas.width > 0
                    && canvas.height > 0
                    && !visible.querySelector('.document-page-skeleton'),
                ),
                committedPage: Number(chassis?.dataset.viewportCommittedPage) || null,
                currentPage: toolbar?.currentPage ?? 0,
                lifecycle: chassis?.dataset.viewportLifecycle ?? null,
                requestedPage: Number(chassis?.dataset.viewportRequestedPage) || null,
                stagedRenderPage: Number(chassis?.dataset.viewportStagedRenderPage) || null,
                stagedViewportPage: Number(chassis?.dataset.viewportStagedViewportPage) || null,
                scrollTop: viewport?.scrollTop ?? -1,
                visiblePage: Number(visible?.dataset.page) || null,
                visualPage: Number(chassis?.dataset.viewportVisualPage) || null,
                visualPresentation: chassis?.dataset.viewportVisualPresentation ?? null,
            };
        });
        const expectPagedStateConverged = (sample: Awaited<ReturnType<typeof collectPagedState>>) => {
            expect(sample.canvasReady, JSON.stringify(sample)).toBe(true);
            expect(sample.visiblePage, JSON.stringify(sample)).toBe(sample.currentPage);
            expect(sample.requestedPage, JSON.stringify(sample)).toBe(sample.currentPage);
            expect(sample.committedPage, JSON.stringify(sample)).toBe(sample.currentPage);
            expect(sample.lifecycle, JSON.stringify(sample)).toBe('ready');
            expect(sample.visualPage, JSON.stringify(sample)).toBe(sample.currentPage);
            expect(sample.visualPresentation, JSON.stringify(sample)).toBe('canvas');
            expect(sample.stagedRenderPage, JSON.stringify(sample)).toBeNull();
            expect(sample.stagedViewportPage, JSON.stringify(sample)).toBeNull();
        };
        const expectPagedStateOwned = (sample: Awaited<ReturnType<typeof collectPagedState>>) => {
            const diagnostics = JSON.stringify(sample);
            const isTargetOwnedSkeleton = !sample.canvasReady
                && sample.visiblePage === sample.currentPage
                && sample.requestedPage === sample.currentPage
                && sample.committedPage !== sample.currentPage
                && sample.lifecycle === 'transitioning'
                && sample.visualPage === sample.currentPage
                && sample.visualPresentation === 'skeleton'
                && sample.stagedRenderPage === null
                && sample.stagedViewportPage === null;
            if (isTargetOwnedSkeleton) {
                return;
            }
            expectPagedStateConverged(sample);
            expect(sample.canvasReady, diagnostics).toBe(true);
        };
        const collectConvergedPagedState = async () => {
            const deadline = Date.now() + 20_000;
            let sample = await collectPagedState();
            while (
                Date.now() < deadline
                && !(
                    sample.canvasReady
                    && sample.visiblePage === sample.currentPage
                    && sample.requestedPage === sample.currentPage
                    && sample.committedPage === sample.currentPage
                    && sample.lifecycle === 'ready'
                    && sample.visualPage === sample.currentPage
                    && sample.visualPresentation === 'canvas'
                    && sample.stagedRenderPage === null
                    && sample.stagedViewportPage === null
                )
            ) {
                await delay(50);
                sample = await collectPagedState();
            }
            return sample;
        };
        const samples: Array<Awaited<ReturnType<typeof collectPagedState>>> = [];
        await session.page.mouse.move(viewportPoint.x, viewportPoint.y);
        for (let packet = 0; packet < 12; packet += 1) {
            await session.page.mouse.wheel({deltaY: 180});
            await delay(220);
            samples.push(await collectConvergedPagedState());
        }

        await delay(1_000);
        const forwardToolbar = await getWorkspaceToolbarSnapshot(session.page);
        const forwardPage = forwardToolbar?.currentPage ?? 0;
        const forwardCanvasReady = forwardPage > 1
            && await waitForVisiblePageCanvas(session, forwardPage, 20_000);
        const forwardFinalState = await collectPagedState();

        const reverseSamples: Array<Awaited<ReturnType<typeof collectPagedState>>> = [];
        for (let packet = 0; packet < 4; packet += 1) {
            await session.page.mouse.wheel({deltaY: -180});
            await delay(220);
            reverseSamples.push(await collectConvergedPagedState());
        }
        const reverseToolbar = await getWorkspaceToolbarSnapshot(session.page);
        const reversePage = reverseToolbar?.currentPage ?? 0;
        const reverseCanvasReady = reversePage > 0
            && await waitForVisiblePageCanvas(session, reversePage, 20_000);
        const reverseFinalState = await collectPagedState();

        await clickPageNavigationButton(session, 'First Page');
        await waitForToolbarCurrentPage(session, 1);
        const firstRecoveryCanvasReady = await waitForVisiblePageCanvas(session, 1, 20_000);
        const firstRecoveryState = await collectPagedState();

        for (let packet = 0; packet < 24; packet += 1) {
            await session.page.mouse.wheel({deltaY: 180});
            await delay(40);
        }
        await delay(1_000);
        const fastToolbar = await getWorkspaceToolbarSnapshot(session.page);
        const fastPage = fastToolbar?.currentPage ?? 0;
        const fastCanvasReady = fastPage > 1
            && await waitForVisiblePageCanvas(session, fastPage, 20_000);
        const fastState = await collectPagedState();

        await clickPageNavigationButton(session, 'First Page');
        await waitForToolbarCurrentPage(session, 1);
        const postFastFirstCanvasReady = await waitForVisiblePageCanvas(session, 1, 20_000);
        const postFastFirstState = await collectPagedState();

        const removedCurrentCanvas = await session.page.evaluate(() => {
            const canvas = document.querySelector<HTMLCanvasElement>(
                '#pdf-viewer .page_container[data-page="1"] .page_canvas canvas',
            );
            canvas?.remove();
            return Boolean(canvas);
        });
        expect(removedCurrentCanvas).toBe(true);
        const samePageRecoveryCommand = await callWorkspaceCommand(
            session.page,
            'handleGoToPage',
            [1],
        );
        expect(samePageRecoveryCommand.called).toBe(true);
        const samePageRecoveryCanvasReady = await waitForVisiblePageCanvas(session, 1, 20_000);
        const samePageRecoveryState = await collectPagedState();
        const trace = await collectTrace(session);
        writeTraceArtifact({
            fastCanvasReady,
            fastState,
            fastToolbar,
            firstRecoveryCanvasReady,
            firstRecoveryState,
            forwardCanvasReady,
            forwardFinalState,
            forwardToolbar,
            pageJumpPdfPath,
            postFastFirstCanvasReady,
            postFastFirstState,
            samePageRecoveryCanvasReady,
            samePageRecoveryState,
            reverseCanvasReady,
            reverseFinalState,
            reverseSamples,
            reverseToolbar,
            samples,
            scenario: 'paged-fit-height-wheel-and-first-page-recovery',
            trace,
        }, PAGED_FIT_HEIGHT_WHEEL_TRACE_OUTPUT_PATH);

        expect(forwardPage).toBeGreaterThanOrEqual(12);
        expect(forwardCanvasReady).toBe(true);
        for (const [
            index,
            sample,
        ] of samples.entries()) {
            const previousPage = index === 0 ? 1 : samples[index - 1]!.currentPage;
            expectPagedStateOwned(sample);
            expect(sample.currentPage, JSON.stringify(sample)).toBeGreaterThanOrEqual(previousPage);
            expect(sample.currentPage, JSON.stringify(sample)).toBeLessThanOrEqual(previousPage + 1);
        }
        expect(samples.at(-1)?.visiblePage).toBe(forwardPage);
        expectPagedStateConverged(forwardFinalState);
        expect(reversePage).toBeLessThanOrEqual(forwardPage - 4);
        expect(reverseCanvasReady).toBe(true);
        for (const [
            index,
            sample,
        ] of reverseSamples.entries()) {
            const previousPage = index === 0 ? forwardPage : reverseSamples[index - 1]!.currentPage;
            expectPagedStateOwned(sample);
            expect(sample.currentPage, JSON.stringify(sample)).toBeLessThanOrEqual(previousPage);
            expect(sample.currentPage, JSON.stringify(sample)).toBeGreaterThanOrEqual(previousPage - 1);
        }
        expect(reverseSamples.at(-1)?.visiblePage).toBe(reversePage);
        expectPagedStateConverged(reverseFinalState);
        expect(firstRecoveryCanvasReady).toBe(true);
        expectPagedStateConverged(firstRecoveryState);
        expect(fastPage).toBeGreaterThanOrEqual(4);
        expect(fastCanvasReady).toBe(true);
        expectPagedStateConverged(fastState);
        expect(postFastFirstCanvasReady).toBe(true);
        expectPagedStateConverged(postFastFirstState);
        expect(samePageRecoveryCanvasReady).toBe(true);
        expectPagedStateConverged(samePageRecoveryState);
    }, 90_000);

    it('renders page 7 after toolbar next navigation to page 10 and previous navigation back', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        let targetCanvasMounted = false;
        let visiblePages: IVisiblePageState[] = [];
        let navigationControls: Awaited<ReturnType<typeof collectNavigationControlState>> | null = null;
        let trace: IPdfRenderTraceEntry[] = [];

        try {
            await jumpToPageAndWaitForCanvas(session, 1);
            await waitForToolbarCurrentPage(session, 1);

            for (let pageNumber = 2; pageNumber <= 10; pageNumber += 1) {
                await clickPageNavigationButton(session, 'Next Page');
                await waitForToolbarCurrentPage(session, pageNumber);
                await delay(150);
            }

            for (let pageNumber = 9; pageNumber >= 7; pageNumber -= 1) {
                await clickPageNavigationButton(session, 'Previous Page');
                await waitForToolbarCurrentPage(session, pageNumber);
                await delay(150);
            }

            targetCanvasMounted = await waitForVisiblePageCanvas(session, 7, 12_000);
            visiblePages = await collectVisiblePageState(session);
            navigationControls = await collectNavigationControlState(session);
            trace = await collectTrace(session);
        } finally {
            if (visiblePages.length === 0) {
                visiblePages = await collectVisiblePageState(session).catch(() => []);
            }
            navigationControls ??= await collectNavigationControlState(session).catch(() => null);
            if (trace.length === 0) {
                trace = await collectTrace(session).catch(() => []);
            }
            const blankVisiblePages = visiblePages.filter(page => !page.hasCanvas || !page.renderedClass);
            const targetPageState = visiblePages.find(page => page.page === 7) ?? null;
            writeTraceArtifact({
                pdfPath: pageJumpPdfPath,
                scenario: 'toolbar-next-to-10-prev-to-7',
                navigationControls,
                visiblePages,
                targetPageState,
                targetCanvasMounted,
                blankVisiblePages,
                trace,
            }, NEXT_PREV_TRACE_OUTPUT_PATH);
        }

        const blankVisiblePages = visiblePages.filter(page => !page.hasCanvas || !page.renderedClass);
        const targetPageState = visiblePages.find(page => page.page === 7) ?? null;

        expect(targetCanvasMounted).toBe(true);
        expect(targetPageState).not.toBeNull();
        expect(targetPageState?.topmost).toBe(true);
        expect(blankVisiblePages).toEqual([]);
    }, 70_000);

    it('advances the chassis current page when PageDown is pressed in the viewer', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            throw new Error('Page navigation fixture is unavailable');
        }

        await jumpToPageAndWaitForCanvas(session, 1);
        await waitForToolbarCurrentPage(session, 1);
        // Keyboard paging is inert inside editable controls, so make sure an
        // earlier scenario has not left focus in the page-label input.
        await session.page.evaluate(() => {
            const active = document.activeElement;
            if (active instanceof HTMLElement) {
                active.blur();
            }
        });

        await session.page.keyboard.press('PageDown');
        await waitForToolbarCurrentPage(session, 2);

        const chassisCurrentPage = await session.page.evaluate(() => {
            const host = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
            return chassis?.dataset.chassisCurrentPage ?? null;
        });

        expect(chassisCurrentPage).toBe('2');
    }, 70_000);

    it('renders the final page after twenty rapid next-page clicks', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        let targetCanvasMounted = false;
        let visiblePages: IVisiblePageState[] = [];
        let navigationControls: Awaited<ReturnType<typeof collectNavigationControlState>> | null = null;
        let rapidNavigationDebug: Awaited<ReturnType<typeof collectRapidNavigationDebug>> | null = null;
        let trace: IPdfRenderTraceEntry[] = [];
        let frameSamples: Awaited<ReturnType<typeof collectRapidNavigationFrameSamples>> = [];
        let toolbarReachedTarget = false;
        let failureMessage: string | null = null;

        try {
            await jumpToPageAndWaitForCanvas(session, 1);
            await waitForToolbarCurrentPage(session, 1);

            for (let step = 0; step < 20; step += 1) {
                await clickPageNavigationButton(session, 'Next Page');
            }
            await waitForToolbarCurrentPage(session, 21);
            toolbarReachedTarget = true;

            targetCanvasMounted = await waitForVisiblePageCanvas(session, 21, 14_000);
            frameSamples = await collectRapidNavigationFrameSamples(session);
            await waitForAnimationFrames(session.page, 2);
            await waitForVisibleMountedPdfCanvases(session.page, 5_000);
            visiblePages = await collectVisiblePageState(session);
            navigationControls = await collectNavigationControlState(session);
            rapidNavigationDebug = await collectRapidNavigationDebug(session);
            trace = await collectTrace(session);
        } catch (error) {
            failureMessage = error instanceof Error
                ? error.message
                : String(error);
            throw error;
        } finally {
            if (visiblePages.length === 0) {
                visiblePages = await collectVisiblePageState(session).catch(() => []);
            }
            navigationControls ??= await collectNavigationControlState(session).catch(() => null);
            rapidNavigationDebug ??= await collectRapidNavigationDebug(session).catch(() => null);
            if (trace.length === 0) {
                trace = await collectTrace(session).catch(() => []);
            }
            const blankVisiblePages = visiblePages.filter(page => !page.hasCanvas || !page.renderedClass);
            const targetPageState = visiblePages.find(page => page.page === 21) ?? null;
            writeTraceArtifact({
                pdfPath: pageJumpPdfPath,
                scenario: 'toolbar-rapid-next-to-21',
                failureMessage,
                frameSamples,
                navigationControls,
                rapidNavigationDebug,
                toolbarReachedTarget,
                visiblePages,
                targetPageState,
                targetCanvasMounted,
                blankVisiblePages,
                trace,
            }, RAPID_NEXT_TRACE_OUTPUT_PATH);
        }

        const blankVisiblePages = visiblePages.filter(page => !page.hasCanvas || !page.renderedClass);
        const targetPageState = visiblePages.find(page => page.page === 21) ?? null;

        expect(targetCanvasMounted).toBe(true);
        expect(targetPageState).not.toBeNull();
        expect(targetPageState?.topmost).toBe(true);
        expect(blankVisiblePages).toEqual([]);
    }, 80_000);

    it('keeps the first committed page crisp without a quality-promotion replacement after revisit', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        await jumpToPageAndWaitForCanvas(session, 1);
        await waitForScannedFixturePageIdentity(session.page, 1, 15_000);
        const marker = `first-commit-${String(Date.now())}`;
        const initial = await collectCommittedCanvasQuality(session, 1, marker);
        expect(initial).not.toBeNull();
        expect(initial?.rendered).toBe(true);
        expect(initial?.skeletonVisible).toBe(false);
        // CSS layout can land between physical pixels. Requiring the ratio to
        // be exactly >= 1 rejects a canvas that covers every whole CSS pixel
        // (for example 5044 / 5044.999). Keep the crispness tripwire at the
        // actual raster boundary instead of comparing a rounded ratio.
        expect(initial?.backingWidth).toBeGreaterThanOrEqual(Math.floor(initial?.cssWidth ?? 0));
        expect(initial?.backingHeight).toBeGreaterThanOrEqual(Math.floor(initial?.cssHeight ?? 0));
        expect(initial?.luminanceVariance).toBeGreaterThan(0);

        await clickPageNavigationButton(session, 'Next Page');
        await waitForToolbarCurrentPage(session, 2);
        expect(await waitForVisiblePageCanvas(session, 2, 15_000)).toBe(true);
        await clickPageNavigationButton(session, 'Previous Page');
        await waitForToolbarCurrentPage(session, 1);
        expect(await waitForVisiblePageCanvas(session, 1, 15_000)).toBe(true);

        const revisited = await collectCommittedCanvasQuality(session, 1);
        expect(revisited).not.toBeNull();
        expect(revisited).toMatchObject({
            backingHeight: initial?.backingHeight,
            backingWidth: initial?.backingWidth,
            marker,
            rendered: true,
            skeletonVisible: false,
        });
        expect(revisited?.cssHeight).toBeCloseTo(initial?.cssHeight ?? 0, 1);
        expect(revisited?.cssWidth).toBeCloseTo(initial?.cssWidth ?? 0, 1);
        expect(revisited?.backingScaleX).toBeCloseTo(initial?.backingScaleX ?? 0, 3);
        expect(revisited?.backingScaleY).toBeCloseTo(initial?.backingScaleY ?? 0, 3);
        expect(revisited?.luminanceVariance).toBeCloseTo(initial?.luminanceVariance ?? 0, 3);
    }, 60_000);

    it('keeps exact page-track geometry and renders every visible page beyond the initial wheel buffer', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        await jumpToPageAndWaitForCanvas(session, 1);
        await waitForVisibleMountedPdfCanvases(session.page, 15_000);
        await waitForScannedFixturePageIdentity(session.page, 1, 15_000);

        const samples = [await collectPdfVirtualizationSnapshot(session.page)];
        const initialPageGaps = await collectConsecutivePageGaps(session);
        let maxMountedPage = Math.max(...samples[0]!.mountedPages.map(page => page.pageNumber));
        const wheelScrollViolations: string[] = [];
        for (let step = 0; step < 60 && maxMountedPage < 30; step += 1) {
            const previous = samples.at(-1)!;
            const deltaY = Math.max(300, Math.round(previous.viewportHeight * 0.8));
            const settlement = await wheelPdfViewportAndWaitForSettlement(session.page, deltaY);
            const sample = await collectPdfVirtualizationSnapshot(session.page);
            const expectedScrollTop = Math.min(
                settlement.initialScrollTop + deltaY,
                settlement.maxScrollTop,
            );
            if (Math.abs(settlement.finalScrollTop - expectedScrollTop) > 1) {
                wheelScrollViolations.push(
                    `step ${step}: scrollTop ${settlement.finalScrollTop}px, expected ${expectedScrollTop}px after ${deltaY}px wheel`,
                );
            }
            samples.push(sample);
            maxMountedPage = Math.max(maxMountedPage, ...sample.mountedPages.map(page => page.pageNumber));
        }

        await waitForVisibleMountedPdfCanvases(session.page, 15_000);
        await waitForAnimationFrames(session.page, 2);
        samples.push(await collectPdfVirtualizationSnapshot(session.page));

        const finalSample = samples.at(-1)!;
        const finalPageGaps = await collectConsecutivePageGaps(session);
        const geometryViolations = findPdfVirtualizationContractViolations(
            samples,
        );
        const uncommittedVisiblePages = finalSample.visiblePages.filter(page => (
            !page.canvasConnected
            || page.canvasWidth <= 0
            || page.canvasHeight <= 0
            || !page.rendered
            || page.skeletonVisible
        ));
        writeTraceArtifact({
            geometryViolations,
            maxMountedPage,
            initialPageGaps,
            finalPageGaps,
            samples,
            scenario: 'continuous-wheel-beyond-initial-buffer',
            uncommittedVisiblePages,
            wheelScrollViolations,
        }, CONTINUOUS_SCROLL_TRACE_OUTPUT_PATH);

        expect(maxMountedPage).toBeGreaterThanOrEqual(30);
        expect(finalSample.totalPages).toBe(GENERATED_PAGE_JUMP_PAGE_COUNT);
        await waitForScannedFixturePageIdentity(
            session.page,
            finalSample.visiblePages[0]?.pageNumber ?? maxMountedPage,
            15_000,
        );
        expect(uncommittedVisiblePages).toEqual([]);
        expect(geometryViolations).toEqual([]);
        expect(wheelScrollViolations).toEqual([]);
        expect(initialPageGaps.length).toBeGreaterThan(0);
        expect(finalPageGaps.length).toBeGreaterThan(0);
        for (const pageGap of [
            ...initialPageGaps,
            ...finalPageGaps,
        ]) {
            expect(pageGap.gap, JSON.stringify(pageGap)).toBeCloseTo(20, 0);
        }
    }, 90_000);

    it('keeps trusted fast scroll, toolbar semantics, and subsequent navigation synchronized', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        await jumpToPageAndWaitForCanvas(session, 1);
        await waitForToolbarCurrentPage(session, 1);
        const zoom = await callWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [5.33]);
        expect(zoom.called).toBe(true);
        await session.page.waitForFunction(() => (
            (window as IRapidNavigationProbeWindow).__evbTestApi
                ?.getActiveToolbarSnapshot?.()?.zoomMode === 'custom'
        ), {timeout: 15_000});
        expect(await waitForVisiblePageCanvas(session, 1, 15_000)).toBe(true);

        const viewport = await session.page.evaluate(() => {
            const element = document.querySelector<HTMLElement>('#pdf-viewer');
            if (!element) {
                return null;
            }
            const rect = element.getBoundingClientRect();
            const testWindow = window as Window & {
                __trustedFastScrollRaf?: number;
                __trustedFastScrollSamples?: Array<Record<string, unknown>>;
                __trustedFastScrollCount?: number;
            };
            testWindow.__trustedFastScrollSamples = [];
            testWindow.__trustedFastScrollCount = 0;
            element.addEventListener('scroll', event => {
                if (event.isTrusted) testWindow.__trustedFastScrollCount = (testWindow.__trustedFastScrollCount ?? 0) + 1;
            }, {passive: true});
            const sample = () => {
                const viewerRect = element.getBoundingClientRect();
                const visiblePages = Array.from(element.querySelectorAll<HTMLElement>('.page_container[data-page]'))
                    .filter(page => {
                        const pageRect = page.getBoundingClientRect();
                        return pageRect.bottom > viewerRect.top && pageRect.top < viewerRect.bottom;
                    });
                const occupied = visiblePages.some(page => {
                    const canvas = page.querySelector<HTMLCanvasElement>('.page_canvas canvas');
                    const skeleton = page.querySelector<HTMLElement>('.document-page-skeleton');
                    const skeletonRect = skeleton?.getBoundingClientRect() ?? null;
                    const skeletonStyle = skeleton ? getComputedStyle(skeleton) : null;
                    return Boolean(
                        canvas && canvas.width > 0 && canvas.height > 0
                        || skeleton && skeletonStyle?.display !== 'none'
                            && skeletonStyle?.visibility !== 'hidden'
                            && (skeletonRect?.width ?? 0) > 0
                            && (skeletonRect?.height ?? 0) > 0,
                    );
                });
                const chassis = element.closest<HTMLElement>('.document-viewer-chassis');
                testWindow.__trustedFastScrollSamples?.push({
                    occupied,
                    observedPage: Number(chassis?.dataset.viewportObservedPage ?? 0),
                    requestedPage: Number(chassis?.dataset.viewportRequestedPage ?? 0),
                    scrollTop: Math.round(element.scrollTop),
                    toolbarPage: (testWindow as Window & IRapidNavigationProbeWindow)
                        .__evbTestApi?.getActiveToolbarSnapshot?.()?.currentPage ?? null,
                    visiblePages: visiblePages.map(page => Number(page.dataset.page)),
                });
                testWindow.__trustedFastScrollRaf = requestAnimationFrame(sample);
            };
            testWindow.__trustedFastScrollRaf = requestAnimationFrame(sample);
            return {
                maxScrollTop: Math.max(0, element.scrollHeight - element.clientHeight),
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        });
        expect(viewport).not.toBeNull();
        if (!viewport) {
            return;
        }

        await session.page.mouse.move(viewport.x, viewport.y);
        // The preceding geometry scenario can leave this shared viewer
        // scrolled while it returns to page-one toolbar semantics. Discard
        // those pre-input frames: this assertion covers the trusted wheel
        // sequence below, not the prior scenario's teardown window.
        await session.page.evaluate(() => {
            const testWindow = window as Window & {
                __trustedFastScrollSamples?: Array<Record<string, unknown>>;
                __trustedFastScrollCount?: number;
            };
            testWindow.__trustedFastScrollSamples = [];
            testWindow.__trustedFastScrollCount = 0;
        });
        // Chromium can coalesce one enormous synthetic wheel delta under
        // hosted-runner load. Drive several ordinary trusted wheel events so
        // the scroll observer sees the same sequence a user produces.
        for (let attempt = 0; attempt < 12; attempt += 1) {
            await session.page.mouse.wheel({deltaY: Math.max(
                1_600,
                Math.round(viewport.maxScrollTop * 0.08),
            )});
            await delay(120);
            const synchronized = await session.page.evaluate(() => {
                const toolbarPage = (window as IRapidNavigationProbeWindow)
                    .__evbTestApi?.getActiveToolbarSnapshot?.()?.currentPage ?? 0;
                const chassis = document.querySelector<HTMLElement>('.document-viewer-chassis');
                return toolbarPage > 20
                    && Number(chassis?.dataset.viewportObservedPage ?? 0) === toolbarPage;
            });
            if (synchronized) {
                break;
            }
        }
        await session.page.waitForFunction(() => {
            const toolbarPage = (window as IRapidNavigationProbeWindow)
                .__evbTestApi?.getActiveToolbarSnapshot?.()?.currentPage ?? 0;
            const chassis = document.querySelector<HTMLElement>('.document-viewer-chassis');
            const observedPage = Number(chassis?.dataset.viewportObservedPage ?? 0);
            return toolbarPage > 20 && observedPage === toolbarPage;
        }, {timeout: 20_000});
        await waitForVisibleMountedPdfCanvases(session.page, 20_000);
        await waitForAnimationFrames(session.page, 8);

        const beforeNext = (await getWorkspaceToolbarSnapshot(session.page))?.currentPage ?? 0;
        expect(beforeNext).toBeGreaterThan(20);
        const totalPages = (await getWorkspaceToolbarSnapshot(session.page))?.totalPages ?? 0;
        expect(beforeNext).toBeLessThan(totalPages);
        await clickPageNavigationButton(session, 'Next Page');
        await waitForToolbarCurrentPage(session, beforeNext + 1);
        expect(await waitForVisiblePageCanvas(session, beforeNext + 1, 20_000)).toBe(true);

        const result = await session.page.evaluate(() => {
            const testWindow = window as Window & {
                __trustedFastScrollRaf?: number;
                __trustedFastScrollSamples?: Array<{
                    occupied: boolean;
                    observedPage: number;
                    requestedPage: number;
                    scrollTop: number;
                    toolbarPage: number | null;
                    visiblePages: number[];
                }>;
                __trustedFastScrollCount?: number;
            };
            if (testWindow.__trustedFastScrollRaf !== undefined) {
                cancelAnimationFrame(testWindow.__trustedFastScrollRaf);
            }
            return {
                samples: testWindow.__trustedFastScrollSamples ?? [],
                trustedScrollCount: testWindow.__trustedFastScrollCount ?? 0,
            };
        });
        const movingSamples = result.samples.filter(sample => sample.scrollTop > 0);
        const blankSamples = movingSamples.filter(sample => !sample.occupied || sample.visiblePages.length === 0);
        const synchronizedSamples = movingSamples.filter(sample => (
            sample.observedPage > 0 && sample.toolbarPage === sample.observedPage
        ));
        writeTraceArtifact({
            beforeNext,
            blankSamples,
            result,
            scenario: 'trusted-fast-scroll-at-533-percent',
            synchronizedSamples,
        }, TRUSTED_FAST_SCROLL_TRACE_OUTPUT_PATH);

        expect(result.trustedScrollCount).toBeGreaterThan(0);
        expect(movingSamples.length).toBeGreaterThan(0);
        expect(blankSamples).toEqual([]);
        expect(synchronizedSamples.length).toBeGreaterThan(0);
        expect(synchronizedSamples.every(sample => sample.requestedPage === 1)).toBe(true);
    }, 90_000);

    it('returns to the first page after trusted fast scroll leaves the requested page stale', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        await jumpToPageAndWaitForCanvas(session, 1);
        await waitForToolbarCurrentPage(session, 1);
        const zoom = await callWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [1.44]);
        expect(zoom.called).toBe(true);
        await session.page.waitForFunction(() => (
            (window as IRapidNavigationProbeWindow).__evbTestApi
                ?.getActiveToolbarSnapshot?.()?.zoomMode === 'custom'
        ), {timeout: 15_000});

        const viewport = await session.page.evaluate(() => {
            const element = document.querySelector<HTMLElement>('#pdf-viewer');
            if (!element) {
                return null;
            }
            const rect = element.getBoundingClientRect();
            return {
                maxScrollTop: Math.max(0, element.scrollHeight - element.clientHeight),
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        });
        expect(viewport).not.toBeNull();
        if (!viewport) {
            return;
        }

        await session.page.mouse.move(viewport.x, viewport.y);
        for (let attempt = 0; attempt < 48; attempt += 1) {
            const scrollState = await session.page.evaluate(() => {
                const element = document.querySelector<HTMLElement>('#pdf-viewer');
                const chassis = document.querySelector<HTMLElement>('.document-viewer-chassis');
                const toolbar = (window as IRapidNavigationProbeWindow).__evbTestApi?.getActiveToolbarSnapshot?.();
                return {
                    currentPage: toolbar?.currentPage ?? 0,
                    maxScrollTop: element ? Math.max(0, element.scrollHeight - element.clientHeight) : 0,
                    observedPage: Number(chassis?.dataset.viewportObservedPage ?? 0),
                    scrollTop: element?.scrollTop ?? 0,
                    totalPages: toolbar?.totalPages ?? 0,
                };
            });
            if (
                scrollState.totalPages > 1
                && scrollState.currentPage === scrollState.totalPages
                && scrollState.observedPage === scrollState.totalPages
                && scrollState.scrollTop >= scrollState.maxScrollTop - 1
            ) {
                break;
            }
            await session.page.mouse.wheel({deltaY: Math.max(
                1_600,
                Math.round(scrollState.maxScrollTop || viewport.maxScrollTop),
            )});
            await delay(120);
        }
        await session.page.waitForFunction(() => {
            const toolbar = (window as IRapidNavigationProbeWindow).__evbTestApi?.getActiveToolbarSnapshot?.();
            const chassis = document.querySelector<HTMLElement>('.document-viewer-chassis');
            return Boolean(
                toolbar
                && toolbar.totalPages > 1
                && toolbar.currentPage === toolbar.totalPages
                && Number(chassis?.dataset.viewportObservedPage ?? 0) === toolbar.totalPages,
            );
        }, {timeout: 20_000});
        await waitForVisibleMountedPdfCanvases(session.page, 20_000);

        const collectState = () => session.page.evaluate(() => {
            const element = document.querySelector<HTMLElement>('#pdf-viewer');
            const chassis = document.querySelector<HTMLElement>('.document-viewer-chassis');
            const toolbar = (window as IRapidNavigationProbeWindow).__evbTestApi?.getActiveToolbarSnapshot?.();
            const viewportRect = element?.getBoundingClientRect() ?? null;
            const visiblePages = element && viewportRect
                ? Array.from(element.querySelectorAll<HTMLElement>('.page_container[data-page]'))
                    .filter(page => {
                        const rect = page.getBoundingClientRect();
                        return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom;
                    })
                    .map(page => Number(page.dataset.page))
                : [];
            return {
                chassis: {...chassis?.dataset},
                clientHeight: element?.clientHeight ?? -1,
                scrollHeight: element?.scrollHeight ?? -1,
                scrollTop: element?.scrollTop ?? -1,
                toolbarPage: toolbar?.currentPage ?? 0,
                totalPages: toolbar?.totalPages ?? 0,
                visiblePages,
            };
        });

        const beforeFirst = await collectState();
        await session.page.evaluate(() => {
            const traceWindow = window as IE2EWindow & {__clearPdfRenderTrace?: () => void};
            traceWindow.__clearPdfRenderTrace?.();
        });
        await clickPageNavigationButton(session, 'First Page');
        await delay(2_000);
        const afterFirst = await collectState();
        const trace = await collectTrace(session);
        writeTraceArtifact({
            afterFirst,
            beforeFirst,
            scenario: 'trusted-fast-scroll-last-to-first-page',
            trace,
        }, TRUSTED_FAST_SCROLL_FIRST_PAGE_TRACE_OUTPUT_PATH);

        expect(Number(beforeFirst.chassis.viewportRequestedPage), JSON.stringify(beforeFirst)).toBe(1);
        expect(Number(beforeFirst.chassis.viewportObservedPage), JSON.stringify(beforeFirst)).toBe(beforeFirst.totalPages);
        expect(afterFirst.toolbarPage, JSON.stringify(afterFirst)).toBe(1);
        expect(afterFirst.visiblePages, JSON.stringify(afterFirst)).toContain(1);
        expect(afterFirst.scrollTop, JSON.stringify(afterFirst)).toBeLessThan(afterFirst.clientHeight);
        expect(await waitForVisiblePageCanvas(session, 1, 20_000)).toBe(true);
    }, 90_000);

    it('recovers when trusted scroll supersedes an in-flight navigation', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        await jumpToPageAndWaitForCanvas(session, 1);
        await waitForToolbarCurrentPage(session, 1);
        const fitWidth = await callWorkspaceCommand(session.page, 'handleFitWidth');
        expect(fitWidth.called).toBe(true);
        await session.page.waitForFunction(() => (
            (window as IRapidNavigationProbeWindow).__evbTestApi
                ?.getActiveToolbarSnapshot?.()?.zoomMode === 'fit-width'
        ), {timeout: 15_000});

        const totalPages = (await getWorkspaceToolbarSnapshot(session.page))?.totalPages ?? 0;
        const targetPage = Math.max(2, Math.floor(totalPages * 0.72));
        const viewport = await session.page.evaluate(() => {
            const element = document.querySelector<HTMLElement>('#pdf-viewer');
            if (!element) {
                return null;
            }
            const rect = element.getBoundingClientRect();
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        });
        expect(viewport).not.toBeNull();
        if (!viewport) {
            throw new Error('PDF viewport disappeared before the half-commit interruption');
        }
        await session.page.mouse.move(viewport.x, viewport.y);
        const client = await session.page.createCDPSession();
        await client.send('Emulation.setCPUThrottlingRate', {rate: 50});
        let inFlight: Record<string, string | undefined> = {};
        let recovered: Record<string, string | undefined> = {};
        try {
            inFlight = await session.page.evaluate(async (target: number) => {
                const api = (window as IRapidNavigationProbeWindow).__evbTestApi;
                if (!api) {
                    return {commandAvailable: 'false'};
                }
                // The command itself is synchronous. Do not await the wrapper:
                // return control to CDP immediately after capturing the
                // transition so the trusted wheel packet can race the render.
                void api.callActiveWorkspaceCommand('handleGoToPage', [target]);
                // Allow Vue's synchronous state projection to flush to the
                // chassis attributes without yielding a compositor frame.
                await Promise.resolve();
                const chassis = document.querySelector<HTMLElement>('.document-viewer-chassis');
                return {
                    ...chassis?.dataset,
                    commandAvailable: 'true',
                };
            }, targetPage);
            // Make the trusted interruption cross the target page even when
            // the throttled navigation commits before Chromium dispatches the
            // wheel packet. A small downward delta can remain inside the
            // target page on hosted runners and therefore never supersede the
            // navigation this scenario is meant to exercise.
            await session.page.mouse.wheel({deltaY: -1_000_000});

            await session.page.waitForFunction(() => {
                const chassis = document.querySelector<HTMLElement>('.document-viewer-chassis');
                const toolbarPage = (window as IRapidNavigationProbeWindow)
                    .__evbTestApi?.getActiveToolbarSnapshot?.()?.currentPage ?? 0;
                const observedPage = Number(chassis?.dataset.viewportObservedPage ?? 0);
                return chassis?.dataset.viewportLifecycle === 'ready'
                    && observedPage > 0
                    && toolbarPage === observedPage
                    && !chassis.dataset.viewportStagedViewportPage
                    && !chassis.dataset.viewportStagedRenderPage;
            }, {timeout: 10_000}).catch(() => undefined);
            const evidence = await session.page.evaluate(() => {
                const chassis = document.querySelector<HTMLElement>('.document-viewer-chassis');
                const viewport = document.querySelector<HTMLElement>('#pdf-viewer');
                const toolbar = (window as IRapidNavigationProbeWindow)
                    .__evbTestApi?.getActiveToolbarSnapshot?.();
                return {recovered: {
                    ...chassis?.dataset,
                    scrollTop: String(viewport?.scrollTop ?? -1),
                    toolbarPage: String(toolbar?.currentPage ?? 0),
                }};
            });
            recovered = evidence.recovered;
        } finally {
            await client.send('Emulation.setCPUThrottlingRate', {rate: 1});
            await client.detach();
        }

        expect(inFlight.commandAvailable).toBe('true');
        expect(Number(inFlight.viewportRequestedPage), JSON.stringify(inFlight)).toBe(targetPage);
        expect(Number(inFlight.viewportCommittedPage), JSON.stringify(inFlight)).toBe(1);
        expect(inFlight.viewportLifecycle, JSON.stringify(inFlight)).toBe('transitioning');
        expect(Number(recovered.viewportRequestedPage), JSON.stringify(recovered)).toBe(1);
        expect(Number(recovered.viewportCommittedPage), JSON.stringify(recovered)).toBe(1);
        const observedPage = Number(recovered.viewportObservedPage);
        expect(observedPage, JSON.stringify(recovered)).toBeGreaterThan(0);
        expect(Number(recovered.toolbarPage), JSON.stringify(recovered)).toBe(observedPage);
        expect(recovered.viewportLifecycle, JSON.stringify(recovered)).toBe('ready');
        expect(recovered.viewportStagedViewportPage, JSON.stringify(recovered)).toBe('');
        expect(recovered.viewportStagedRenderPage, JSON.stringify(recovered)).toBe('');
        expect(observedPage).toBeLessThan(totalPages);

        await clickPageNavigationButton(session, 'Next Page');
        await waitForToolbarCurrentPage(session, observedPage + 1);
        expect(await waitForVisiblePageCanvas(session, observedPage + 1, 20_000)).toBe(true);
        writeTraceArtifact({
            inFlight,
            observedPage,
            recovered,
            scenario: 'trusted-scroll-supersedes-in-flight-navigation',
            targetPage,
        }, IN_FLIGHT_SCROLL_TRACE_OUTPUT_PATH);
    }, 120_000);

    it('never exposes a frame without a page skeleton or committed canvas during rapid Next then Fit Width', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        await jumpToPageAndWaitForCanvas(session, 1);
        await waitForVisibleMountedPdfCanvases(session.page, 15_000);
        const actualSize = await callWorkspaceCommand(session.page, 'handleActualSize');
        expect(actualSize.called).toBe(true);
        await session.page.waitForFunction(() => (
            (window as IRapidNavigationProbeWindow).__evbTestApi?.getActiveToolbarSnapshot?.()?.zoomMode === 'custom'
        ), {timeout: 15_000});
        await waitForVisiblePageCanvas(session, 1, 15_000);
        expect((await getWorkspaceToolbarSnapshot(session.page))?.zoomMode).toBe('custom');
        await installCommittedSurfaceSampler(session.page);

        let surfaceTrace: Awaited<ReturnType<typeof stopCommittedSurfaceSampler>> = {frames: []};
        try {
            await clickPageNavigationButton(session, 'Next Page');
            const fitWidth = await callWorkspaceCommand(session.page, 'handleFitWidth');
            expect(fitWidth.called).toBe(true);
            await waitForToolbarCurrentPage(session, 2);
            await session.page.waitForFunction(() => (
                (window as IRapidNavigationProbeWindow).__evbTestApi?.getActiveToolbarSnapshot?.()?.zoomMode === 'fit-width'
            ), {timeout: 15_000});
            expect(await waitForVisiblePageCanvas(session, 2, 15_000)).toBe(true);
            await waitForAnimationFrames(session.page, 10);
        } finally {
            surfaceTrace = await stopCommittedSurfaceSampler(session.page);
        }

        const missingVisualFrames = findMissingVisualFrames(surfaceTrace.frames);
        writeTraceArtifact({
            missingVisualFrames,
            scenario: 'rapid-next-then-fit-width',
            surfaceTrace,
        }, NEXT_FIT_WIDTH_TRACE_OUTPUT_PATH);

        // A cached target can complete within two browser-presentable RAFs;
        // both frames are still inspected for an owned shell or committed
        // canvas, so fast completion must not be treated as missing evidence.
        expect(surfaceTrace.frames.length).toBeGreaterThanOrEqual(2);
        expect(missingVisualFrames).toEqual([]);
        expect((await getWorkspaceToolbarSnapshot(session.page))?.zoomMode).toBe('fit-width');
    }, 60_000);

    it('keeps page overlays mounted after jumping to page 100', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        await delay(5_000);
        await jumpToPageAndWaitForCanvas(session, TARGET_PAGE);
        await delay(6_000);

        const visiblePages = await collectVisiblePageState(session);
        const navigationControls = await collectNavigationControlState(session);
        const virtualScrollGeometry = await collectVirtualScrollGeometry(session, TARGET_PAGE);
        const trace = await collectTrace(session);
        const blankVisiblePages = visiblePages.filter(page => !page.hasCanvas || !page.renderedClass);
        const targetPageState = visiblePages.find(page => page.page === TARGET_PAGE) ?? null;
        writeTraceArtifact({
            pdfPath: pageJumpPdfPath,
            targetPage: TARGET_PAGE,
            navigationControls,
            virtualScrollGeometry,
            visiblePages,
            targetPageState,
            blankVisiblePages,
            trace,
        });

        expect(targetPageState).not.toBeNull();
        expect(targetPageState?.topmost).toBe(true);
        expect(blankVisiblePages).toEqual([]);
    }, 60_000);
});
