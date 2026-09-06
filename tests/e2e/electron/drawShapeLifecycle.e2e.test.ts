import type { Page } from 'puppeteer-core';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import {
    createBlankFixturePdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAnnotationTool,
    setAnnotationColor,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    clickToolbarButtonWhenEnabled,
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
    readWorkspaceStateValues,
    waitForWorkspaceToolbarIdle,
} from '@tests/e2e/electron/helpers/workspaceExpose';

interface IRendererErrorTracker {
    errors: string[];
    detach: () => void;
}

interface IManagedShapeDebugShape {
    annotationId?: string | null;
    height?: number;
    id: string;
    pageIndex?: number;
    points?: Array<{
        x: number;
        y: number;
    }>;
    source?: string;
    stableKey?: string | null;
    strokeWidth?: number;
    strokes?: Array<Array<{
        x: number;
        y: number;
    }>>;
    type?: string;
    width?: number;
    x?: number;
    y?: number;
}

function createRendererErrorTracker(page: Page): IRendererErrorTracker {
    const errors: string[] = [];

    const onConsole = (message: {
        type: () => string;
        text: () => string;
    }) => {
        const text = message.text();
        if (message.type() !== 'error') {
            return;
        }

        if (text.includes('[renderer-guard]') || text.includes('Unhandled window error')) {
            errors.push(text);
        }
    };

    const onPageError = (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        errors.push(`pageerror:${detail}`);
    };

    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    return {
        errors,
        detach: () => {
            page.off('console', onConsole);
            page.off('pageerror', onPageError);
        },
    };
}

async function waitForShapeCount(page: Page, expectedCount: number) {
    await waitForFunctionInPage(page, (count: number) => {
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
        const shapes = host?.querySelectorAll('.pdf-annotation-editor-layer g[data-annotation-kind="shape"][data-annotation-id]') ?? [];
        return shapes.length === count;
    }, { timeout: 20_000 }, expectedCount);
}

async function waitForShapeSidebarCount(page: Page, expectedCount: number) {
    await waitForFunctionInPage(page, (count: number) => {
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisible);
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const shapeItems = Array.from(host?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [])
            .filter(isVisible);
        return shapeItems.length === count;
    }, { timeout: 20_000 }, expectedCount);
}

async function clickEnabledToolbarAction(page: Page, label: string) {
    const clicked = await evaluateInPage(page, (targetLabel: string) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
            .find(candidate => (
                candidate.getAttribute('aria-label')?.trim() === targetLabel
                && !candidate.disabled
                && candidate.getAttribute('aria-disabled') !== 'true'
            ));
        button?.click();
        return Boolean(button);
    }, label);

    if (!clicked) {
        const state = await evaluateInPage(page, () => {
            const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
                .map(button => ({
                    label: button.getAttribute('aria-label')?.trim() ?? '',
                    disabled: button.disabled || button.getAttribute('aria-disabled') === 'true',
                    className: button.className,
                }))
                .filter(button => button.label === 'Undo' || button.label === 'Redo');

            return { buttons };
        });
        const toolbarSnapshot = await getWorkspaceToolbarSnapshot(page);
        throw new Error(`Enabled toolbar action not found: ${label}. State: ${JSON.stringify({
            ...state,
            toolbarSnapshot,
        })}`);
    }
}

async function waitForAnnotationSubtypeCountOnDisk(
    filePath: string,
    subtype: string,
    expectedCount: number,
    timeoutMs = 10_000,
) {
    const startedAt = Date.now();

    while ((Date.now() - startedAt) < timeoutMs) {
        const summary = await readPdfAnnotationSummary(filePath);
        if ((summary.bySubtype[subtype] ?? 0) === expectedCount) {
            return summary;
        }
        await delay(250);
    }

    return readPdfAnnotationSummary(filePath);
}

async function waitForInkCountOnDisk(filePath: string, expectedCount: number, timeoutMs = 10_000) {
    return waitForAnnotationSubtypeCountOnDisk(filePath, 'Ink', expectedCount, timeoutMs);
}

async function waitForLineCountOnDisk(filePath: string, expectedCount: number, timeoutMs = 10_000) {
    return waitForAnnotationSubtypeCountOnDisk(filePath, 'Line', expectedCount, timeoutMs);
}

async function dragInkStroke(
    page: Page,
    points: ReadonlyArray<{
        x: number;
        y: number;
    }>,
    pageNumber = 1,
) {
    await dragInkStrokeWithMouse(page, points, pageNumber);
}

async function dragLineSegment(
    page: Page,
    segment: {
        start: {
            x: number;
            y: number;
        };
        end: {
            x: number;
            y: number;
        };
    },
    pageNumber = 1,
) {
    await dragInkStrokeWithMouse(page, [
        segment.start,
        segment.end,
    ], pageNumber, 'Line');
}

async function dragInkStrokeWithMouse(
    page: Page,
    points: ReadonlyArray<{
        x: number;
        y: number;
    }>,
    pageNumber = 1,
    tool: 'Draw' | 'Line' = 'Draw',
) {
    await clickAnnotationTool(page, tool);
    await waitForViewerInteractive(page);
    await waitForFunctionInPage(page, (targetPageNumber: number) => {
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
        const overlay = host?.querySelector<SVGElement>(`.page_container[data-page="${targetPageNumber}"] .pdf-annotation-editor-layer`) ?? null;
        return Boolean(overlay);
    }, { timeout: 10_000 }, pageNumber);

    const clientPoints = await evaluateInPage(page, async ({
        targetPageNumber,
        ratios,
    }: {
        targetPageNumber: number;
        ratios: ReadonlyArray<{
            x: number;
            y: number;
        }>;
    }) => {
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
        const overlay = host?.querySelector<SVGElement>(`.page_container[data-page="${targetPageNumber}"] .pdf-annotation-editor-layer`) ?? null;
        if (!overlay || ratios.length < 2) {
            return null;
        }

        const pageContainer = overlay.closest<HTMLElement>('.page_container');
        pageContainer?.scrollIntoView({
            block: 'center',
            inline: 'center',
        });
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

        const scrollViewport = overlay.closest<HTMLElement>('[data-document-viewer-chassis-viewport], .pdfViewer');
        if (pageContainer && scrollViewport && host) {
            const pageRect = overlay.getBoundingClientRect();
            const hostRect = host.getBoundingClientRect();
            const visibleTop = Math.max(hostRect.top, 24);
            const visibleBottom = Math.min(hostRect.bottom, window.innerHeight - 24);
            if (visibleBottom > visibleTop) {
                const targetY = pageRect.top + pageRect.height * (ratios[0]?.y ?? 0.5);
                scrollViewport.scrollTop += targetY - ((visibleTop + visibleBottom) / 2);
                await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            }
        }

        const rect = overlay.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }

        return ratios.map(point => ({
            clientX: rect.left + rect.width * point.x,
            clientY: rect.top + rect.height * point.y,
        }));
    }, {
        targetPageNumber: pageNumber,
        ratios: [...points],
    });

    if (!clientPoints || clientPoints.length < 2) {
        throw new Error('Unable to resolve client points for mouse ink stroke');
    }

    const start = clientPoints[0]!;
    await page.mouse.move(start.clientX, start.clientY);
    await page.mouse.down();
    for (const point of clientPoints.slice(1)) {
        await page.mouse.move(point.clientX, point.clientY, { steps: 6 });
    }
    const end = clientPoints[clientPoints.length - 1]!;
    await page.mouse.move(end.clientX, end.clientY);
    await page.mouse.up();
}

async function clickPagePoint(page: Page, point: {
    x: number;
    y: number;
}, pageNumber = 1, button: 'left' | 'right' = 'left') {
    await clickAnnotationTool(page, 'Select');
    await waitForViewerInteractive(page);
    await waitForFunctionInPage(page, (targetPageNumber: number) => {
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
        const overlay = host?.querySelector<SVGElement>(`.page_container[data-page="${targetPageNumber}"] .pdf-annotation-editor-layer`) ?? null;
        return Boolean(overlay);
    }, { timeout: 10_000 }, pageNumber);

    const targetPoint = await evaluateInPage(page, async ({
        targetPageNumber,
        ratioX,
        ratioY,
    }: {
        targetPageNumber: number;
        ratioX: number;
        ratioY: number;
    }) => {
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
        const overlay = host?.querySelector<SVGElement>(`.page_container[data-page="${targetPageNumber}"] .pdf-annotation-editor-layer`) ?? null;
        if (!overlay) {
            return null;
        }

        const pageContainer = overlay.closest<HTMLElement>('.page_container');
        pageContainer?.scrollIntoView({
            block: 'center',
            inline: 'center',
        });
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

        const scrollViewport = overlay.closest<HTMLElement>('[data-document-viewer-chassis-viewport], .pdfViewer');
        if (pageContainer && scrollViewport && host) {
            const pageRect = overlay.getBoundingClientRect();
            const hostRect = host.getBoundingClientRect();
            const visibleTop = Math.max(hostRect.top, 24);
            const visibleBottom = Math.min(hostRect.bottom, window.innerHeight - 24);
            if (visibleBottom > visibleTop) {
                const targetY = pageRect.top + pageRect.height * ratioY;
                scrollViewport.scrollTop += targetY - ((visibleTop + visibleBottom) / 2);
                await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            }
        }

        const rect = overlay.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }

        const clientX = rect.left + rect.width * ratioX;
        const clientY = rect.top + rect.height * ratioY;

        return {
            clientX,
            clientY,
        };
    }, {
        targetPageNumber: pageNumber,
        ratioX: point.x,
        ratioY: point.y,
    });

    if (!targetPoint) {
        throw new Error('Unable to resolve click target for shape');
    }

    await page.mouse.move(targetPoint.clientX, targetPoint.clientY);
    await page.mouse.click(targetPoint.clientX, targetPoint.clientY, {button});
}

async function waitForNoVisibleInkAtPoints(page: Page, points: ReadonlyArray<{
    x: number;
    y: number;
}>, pageNumber = 1) {
    for (const point of points) {
        await waitForNoVisibleInkAtPoint(page, point, pageNumber);
    }
}

async function deleteSelectedShape(page: Page) {
    await page.keyboard.press('Delete');
}

async function deleteSelectedShapeViaPropertiesPopup(page: Page) {
    await waitForFunctionInPage(page, () => Boolean(document.querySelector('.annotation-properties-delete')), {timeout: 10_000});

    const buttonPoint = await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('.annotation-properties-delete');
        if (!button) {
            return null;
        }

        const rect = button.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }

        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    });
    if (!buttonPoint) {
        throw new Error('Delete button in annotation properties popup is not visible');
    }

    await page.mouse.click(buttonPoint.x, buttonPoint.y);
}

async function getToolbarSaveDebugState(page: Page) {
    const state = await evaluateInPage(page, () => {
        const saveButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
            .map((button) => ({
                label: button.getAttribute('aria-label')?.trim() ?? '',
                disabled: button.disabled || button.getAttribute('aria-disabled') === 'true',
                className: button.className,
                text: button.textContent?.trim() ?? '',
            }))
            .filter(button => button.label === 'Save' || button.label.startsWith('Save ('));

        const activeTabDirty = Boolean(document.querySelector('.tab.is-active .tab-dirty-dot'));

        return {
            activeTabDirty,
            saveButtons,
        };
    });
    return {
        ...state,
        toolbarSnapshot: await getWorkspaceToolbarSnapshot(page),
    };
}

async function saveViaToolbarButton(page: Page) {
    try {
        await clickToolbarButtonWhenEnabled(page, 'Save', 20_000);
    } catch (error) {
        const state = await getToolbarSaveDebugState(page);
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Save toolbar action was not clickable: ${detail}. State: ${JSON.stringify(state)}`);
    }

    await waitForWorkspaceToolbarIdle(page, { timeoutMs: 20_000 });
    await page.waitForFunction(() => {
        const hasPendingToolbarLoading = document.querySelector('.toolbar-btn.is-loading, .save-split-primary.is-loading');
        if (hasPendingToolbarLoading) {
            return false;
        }

        const savingStatuses = Array.from(document.querySelectorAll('.note-window__status, .pdf-annotation-note-window__status'));
        return savingStatuses.length === 0;
    }, { timeout: 20_000 });
}

async function waitForNoShapeSelectionUi(page: Page) {
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
        const selectionOutline = host?.querySelector('.pdf-annotation-selection-handles');
        const propertiesPopup = document.querySelector('.annotation-properties');
        return !selectionOutline && !propertiesPopup;
    }, { timeout: 10_000 });
}

async function waitForShapeSelectionUi(page: Page) {
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
        return Boolean(host?.querySelector('.pdf-annotation-editor-layer g[data-annotation-kind="shape"][data-annotation-id].is-selected'));
    }, { timeout: 10_000 });
}

async function waitForActiveColorIndicator(page: Page) {
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
        const swatches = Array.from(host?.querySelectorAll<HTMLButtonElement>('.notes-panel .swatch') ?? []);
        return swatches.some(swatch => swatch.classList.contains('is-active'));
    }, { timeout: 10_000 });
}

async function waitForNoVisibleInkAtPoint(page: Page, point: {
    x: number;
    y: number;
}, pageNumber = 1) {
    await waitForFunctionInPage(page, ({
        targetPageNumber,
        ratioX,
        ratioY,
    }: {
        targetPageNumber: number;
        ratioX: number;
        ratioY: number;
    }) => {
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
        const pageContainer = host?.querySelector<HTMLElement>(
            `.page_container[data-page="${targetPageNumber}"]`,
        ) ?? null;
        if (!pageContainer) {
            return false;
        }

        const pageRect = pageContainer.getBoundingClientRect();
        if (pageRect.width <= 0 || pageRect.height <= 0) {
            return false;
        }

        const canvases = Array.from(pageContainer.querySelectorAll<HTMLCanvasElement>('canvas'));
        if (canvases.length === 0) {
            return false;
        }

        const hasVisibleInk = canvases.some((canvas) => {
            const rect = canvas.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) {
                return false;
            }

            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) {
                return false;
            }

            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const centerX = Math.round((rect.width * ratioX) * scaleX);
            const centerY = Math.round((rect.height * ratioY) * scaleY);
            const radius = Math.max(2, Math.round(Math.max(scaleX, scaleY) * 5));
            const startX = Math.max(0, centerX - radius);
            const startY = Math.max(0, centerY - radius);
            const width = Math.min(canvas.width - startX, (radius * 2) + 1);
            const height = Math.min(canvas.height - startY, (radius * 2) + 1);

            if (width <= 0 || height <= 0) {
                return false;
            }

            const imageData = context.getImageData(startX, startY, width, height).data;
            for (let index = 0; index < imageData.length; index += 4) {
                const alpha = imageData[index + 3] ?? 0;
                if (alpha === 0) {
                    continue;
                }

                const red = imageData[index] ?? 0;
                const green = imageData[index + 1] ?? 0;
                const blue = imageData[index + 2] ?? 0;
                const isBlankPagePixel = red >= 248 && green >= 248 && blue >= 248;
                if (!isBlankPagePixel) {
                    return true;
                }
            }

            return false;
        });

        const clientX = pageRect.left + pageRect.width * ratioX;
        const clientY = pageRect.top + pageRect.height * ratioY;
        const overlay = pageContainer.querySelector<SVGElement>('.pdf-annotation-editor-layer');
        const isVisibleGhostElement = (element: Element) => {
            if (overlay?.contains(element) || element.closest('.pdf-annotation-editor-layer')) {
                return false;
            }

            const rect = element.getBoundingClientRect();
            if (
                rect.width <= 0
                || rect.height <= 0
                || clientX < (rect.left - 2)
                || clientX > (rect.right + 2)
                || clientY < (rect.top - 2)
                || clientY > (rect.bottom + 2)
            ) {
                return false;
            }

            const style = window.getComputedStyle(element);
            if (
                style.display === 'none'
                || style.visibility === 'hidden'
                || Number(style.opacity || '1') === 0
            ) {
                return false;
            }

            if (element instanceof HTMLElement && element.hidden) {
                return false;
            }

            return true;
        };
        const hasVisibleLayerGhost = (
            Array.from(pageContainer.querySelectorAll(
                '.pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind="shape"]',
            )).some(isVisibleGhostElement)
            || Array.from(pageContainer.querySelectorAll(
                '.pdf-annotation-editor-layer svg polyline',
            )).some(isVisibleGhostElement)
            || document.elementsFromPoint(clientX, clientY).some((element) => {
                if (!(element instanceof Element)) {
                    return false;
                }

                const layerElement = element.closest('.pdf-annotation-editor-layer');
                if (!layerElement || !pageContainer.contains(layerElement) || element === layerElement) {
                    return false;
                }

                return isVisibleGhostElement(element)
                    && Boolean(
                        element instanceof SVGElement
                        || Boolean(element.closest('[data-annotation-id]')),
                    );
            })
        );

        return !hasVisibleInk && !hasVisibleLayerGhost;
    }, { timeout: 15_000 }, {
        targetPageNumber: pageNumber,
        ratioX: point.x,
        ratioY: point.y,
    });
}

async function hasVisibleCanvasInkAtPointWithOverlayHidden(page: Page, point: {
    x: number;
    y: number;
}, pageNumber = 1) {
    return evaluateInPage(page, ({
        targetPageNumber,
        ratioX,
        ratioY,
    }: {
        targetPageNumber: number;
        ratioX: number;
        ratioY: number;
    }) => {
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
        const pageContainer = host?.querySelector<HTMLElement>(
            `.page_container[data-page="${targetPageNumber}"]`,
        ) ?? null;
        if (!pageContainer) {
            return false;
        }

        const overlay = pageContainer.querySelector<SVGElement>('.pdf-annotation-editor-layer');
        const previousDisplay = overlay?.style.display ?? '';
        if (overlay) {
            overlay.style.display = 'none';
        }

        try {
            const canvases = Array.from(pageContainer.querySelectorAll<HTMLCanvasElement>('canvas'));
            return canvases.some((canvas) => {
                const rect = canvas.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) {
                    return false;
                }

                const context = canvas.getContext('2d', { willReadFrequently: true });
                if (!context) {
                    return false;
                }

                const scaleX = canvas.width / rect.width;
                const scaleY = canvas.height / rect.height;
                const centerX = Math.round((rect.width * ratioX) * scaleX);
                const centerY = Math.round((rect.height * ratioY) * scaleY);
                const radius = Math.max(4, Math.round(Math.max(scaleX, scaleY) * 8));
                const startX = Math.max(0, centerX - radius);
                const startY = Math.max(0, centerY - radius);
                const width = Math.min(canvas.width - startX, (radius * 2) + 1);
                const height = Math.min(canvas.height - startY, (radius * 2) + 1);

                if (width <= 0 || height <= 0) {
                    return false;
                }

                const imageData = context.getImageData(startX, startY, width, height).data;
                for (let index = 0; index < imageData.length; index += 4) {
                    const alpha = imageData[index + 3] ?? 0;
                    if (alpha === 0) {
                        continue;
                    }

                    const red = imageData[index] ?? 0;
                    const green = imageData[index + 1] ?? 0;
                    const blue = imageData[index + 2] ?? 0;
                    const isBlankPagePixel = red >= 248 && green >= 248 && blue >= 248;
                    if (!isBlankPagePixel) {
                        return true;
                    }
                }

                return false;
            });
        } finally {
            if (overlay) {
                overlay.style.display = previousDisplay;
            }
        }
    }, {
        targetPageNumber: pageNumber,
        ratioX: point.x,
        ratioY: point.y,
    });
}

async function getManagedShapeDebugState(page: Page) {
    const [
        domState,
        shapeResult,
        deletedAnnotationIds,
        deletedStableKeys,
        viewerState,
    ] = await Promise.all([
        evaluateInPage(page, () => {
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
            return {
                hasWorkspace: Boolean(host),
                domShapeCount: host?.querySelectorAll('.pdf-annotation-editor-layer g[data-annotation-kind="shape"][data-annotation-id]').length ?? 0,
                domShapeIds: Array.from(host?.querySelectorAll<SVGGElement>('.pdf-annotation-editor-layer g[data-annotation-kind="shape"][data-annotation-id]') ?? [])
                    .map(shape => shape.getAttribute('data-annotation-id')),
            };
        }),
        callWorkspaceCommand<IManagedShapeDebugShape[]>(page, 'getAllShapes'),
        callWorkspaceCommand<string[]>(page, 'getDeletedEmbeddedShapeAnnotationIds'),
        callWorkspaceCommand<string[]>(page, 'getDeletedEmbeddedShapeStableKeys'),
        readWorkspaceStateValues<{
            hasShapes?: boolean;
            hiddenEmbeddedAnnotationIds?: string[];
            selectedShapeId?: string | null;
        }>(page, [
            'hasShapes',
            'hiddenEmbeddedAnnotationIds',
            'selectedShapeId',
        ], {
            requiredMethods: ['getAllShapes'],
            requiredProperties: [],
        }),
    ]);
    const shapes = shapeResult.value ?? [];
    return {
        ...domState,
        hasPdfViewer: shapeResult.called,
        hasShapes: Boolean(viewerState.hasShapes),
        selectedShapeId: viewerState.selectedShapeId ?? null,
        shapes: shapes.map(shape => ({
            id: shape.id,
            pageIndex: shape.pageIndex ?? null,
            type: shape.type ?? null,
            x: shape.x ?? null,
            y: shape.y ?? null,
            width: shape.width ?? null,
            height: shape.height ?? null,
            strokeWidth: shape.strokeWidth ?? null,
            source: shape.source ?? null,
            annotationId: shape.annotationId ?? null,
            stableKey: shape.stableKey ?? null,
            points: shape.points?.slice(0, 6) ?? null,
            strokes: shape.strokes?.slice(0, 2).map(points => points.slice(0, 6)) ?? null,
        })),
        deletedAnnotationIds: deletedAnnotationIds.value ?? [],
        deletedStableKeys: deletedStableKeys.value ?? [],
        hiddenIds: viewerState.hiddenEmbeddedAnnotationIds ?? [],
    };
}

async function getFirstManagedShapeStrokeMetrics(page: Page) {
    const [
        shapeResult,
        paint,
    ] = await Promise.all([
        callWorkspaceCommand<IManagedShapeDebugShape[]>(page, 'getAllShapes'),
        evaluateInPage(page, () => {
            const pageContainer = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .page_container[data-page="1"]',
            );
            const visual = pageContainer?.querySelector<SVGGeometryElement>(
                '.pdf-annotation-editor-layer g[data-annotation-kind="shape"][data-annotation-id] polyline',
            );
            if (!pageContainer || !visual) {
                return null;
            }
            const pageStyle = window.getComputedStyle(pageContainer);
            return {
                renderedStrokeWidth: Number.parseFloat(window.getComputedStyle(visual).strokeWidth),
                scaleFactor: Number.parseFloat(pageStyle.getPropertyValue('--scale-factor')),
                userUnit: Number.parseFloat(pageStyle.getPropertyValue('--user-unit')),
                strokeWidthAttribute: visual.getAttribute('stroke-width'),
            };
        }),
    ]);
    const strokeWidth = shapeResult.value?.[0]?.strokeWidth;
    if (!paint || typeof strokeWidth !== 'number') {
        return null;
    }
    return {
        ...paint,
        strokeWidth,
    };
}

async function getPointInteractionDebugState(page: Page, point: {
    x: number;
    y: number;
}, pageNumber = 1) {
    return evaluateInPage(page, ({
        ratioX,
        ratioY,
        targetPageNumber,
    }: {
        ratioX: number;
        ratioY: number;
        targetPageNumber: number;
    }) => {
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
        const pageContainer = host?.querySelector<HTMLElement>(`.page_container[data-page="${targetPageNumber}"]`) ?? null;
        const overlay = pageContainer?.querySelector<SVGElement>('.pdf-annotation-editor-layer') ?? null;
        if (!pageContainer || !overlay) {
            return null;
        }

        const overlayRect = overlay.getBoundingClientRect();
        const clientX = overlayRect.left + overlayRect.width * ratioX;
        const clientY = overlayRect.top + overlayRect.height * ratioY;
        const elementStack = document.elementsFromPoint(clientX, clientY)
            .slice(0, 12)
            .map((element) => ({
                tag: element.tagName,
                className: element instanceof HTMLElement || element instanceof SVGElement
                    ? element.className.baseVal ?? element.className ?? ''
                    : '',
                dataAnnotationId: element instanceof HTMLElement ? element.dataset.annotationId ?? null : null,
            }));

        const overlayShapes = Array.from(overlay.querySelectorAll('g'))
            .map((group, index) => ({
                index,
                className: group.getAttribute('class') ?? '',
                bbox: (() => {
                    try {
                        const box = group.getBBox();
                        return {
                            x: box.x,
                            y: box.y,
                            width: box.width,
                            height: box.height,
                        };
                    } catch {
                        return null;
                    }
                })(),
            }));

        return {
            clientX,
            clientY,
            elementStack,
            overlayShapes,
        };
    }, {
        ratioX: point.x,
        ratioY: point.y,
        targetPageNumber: pageNumber,
    });
}

async function waitForAllShapesEmbedded(page: Page, expectedCount: number) {
    const startedAt = Date.now();
    let shapes: IManagedShapeDebugShape[] = [];
    while (Date.now() - startedAt < 20_000) {
        shapes = (await callWorkspaceCommand<IManagedShapeDebugShape[]>(page, 'getAllShapes')).value ?? [];
        if (
            shapes.length === expectedCount
            && shapes.every(shape => shape.source === 'embedded' && typeof shape.annotationId === 'string' && shape.annotationId.length > 0)
        ) {
            return;
        }
        await delay(150);
    }
    throw new Error(`Timed out waiting for ${expectedCount} embedded shapes: ${JSON.stringify(shapes)}`);
}

interface IDrawShapePoint {
    x: number;
    y: number;
}

type TScenarioShapeKind = 'ink' | 'line';
type TScenarioSaveVia = 'handle' | 'toolbar';
type TScenarioDeleteVia = 'keyboard' | 'popup';
type TScenarioSaveSettle = 'shape-count' | 'embedded';
type TScenarioShapeSource = 'local' | 'embedded';

interface IInkScenarioShape {
    kind: 'ink';
    color: string;
    hit: IDrawShapePoint;
    points: readonly IDrawShapePoint[];
    drawMode?: 'mouse' | 'pointer';
}

interface ILineScenarioShape {
    kind: 'line';
    color: string;
    start: IDrawShapePoint;
    end: IDrawShapePoint;
    hit: IDrawShapePoint;
}

type TScenarioShape = IInkScenarioShape | ILineScenarioShape;

interface IDrawScenarioStep {
    action: 'draw';
    shapeIndexes: readonly number[];
    expectCount: number;
}

interface ISaveScenarioStep {
    action: 'save';
    via: TScenarioSaveVia;
    settle?: TScenarioSaveSettle;
    expectDiskCount?: number;
    expectToolbarClean?: boolean;
    expectNoCanvasInkForShapes?: readonly number[];
}

interface IDeleteScenarioStep {
    action: 'delete';
    shapeIndex: number;
    via?: TScenarioDeleteVia;
    expectCount: number;
    expectDeletedAnnotationIds?: number;
    expectSource?: TScenarioShapeSource;
    expectKind?: TScenarioShapeKind;
    expectDiskCount?: number;
}

interface IReopenScenarioStep {
    action: 'reopen';
    expectCount: number;
    expectNoCanvasInkForShapes?: readonly number[];
}

type TScenarioStep =
    | IDrawScenarioStep
    | ISaveScenarioStep
    | IDeleteScenarioStep
    | IReopenScenarioStep;

interface ISavedShapeDeleteScenario {
    name: string;
    fixturePrefix: string;
    viewport?: {
        width: number;
        height: number;
    };
    shapes: readonly TScenarioShape[];
    steps: readonly TScenarioStep[];
}

const p = (x: number, y: number): IDrawShapePoint => ({
    x,
    y,
});

const ink = (
    color: string,
    hit: IDrawShapePoint,
    points: readonly IDrawShapePoint[],
    drawMode: IInkScenarioShape['drawMode'] = 'pointer',
): IInkScenarioShape => ({
    kind: 'ink',
    color,
    hit,
    points,
    drawMode,
});

const line = (
    color: string,
    start: IDrawShapePoint,
    end: IDrawShapePoint,
    hit: IDrawShapePoint,
): ILineScenarioShape => ({
    kind: 'line',
    color,
    start,
    end,
    hit,
});

const baseInkStrokes = [
    ink('#ef4444', p(0.24, 0.24), [
        p(0.18, 0.2),
        p(0.24, 0.24),
        p(0.31, 0.3),
    ]),
    ink('#22c55e', p(0.56, 0.34), [
        p(0.46, 0.28),
        p(0.56, 0.34),
        p(0.66, 0.42),
    ]),
    ink('#3b82f6', p(0.34, 0.62), [
        p(0.22, 0.58),
        p(0.34, 0.62),
        p(0.46, 0.7),
    ]),
] as const;

const mouseInkStrokes = [
    ink('#ef4444', p(0.24, 0.24), [
        p(0.14, 0.18),
        p(0.18, 0.2),
        p(0.22, 0.225),
        p(0.24, 0.24),
        p(0.265, 0.262),
        p(0.29, 0.285),
        p(0.31, 0.3),
    ], 'mouse'),
    ink('#22c55e', p(0.56, 0.34), [
        p(0.42, 0.255),
        p(0.46, 0.28),
        p(0.5, 0.305),
        p(0.56, 0.34),
        p(0.6, 0.365),
        p(0.63, 0.39),
        p(0.66, 0.42),
    ], 'mouse'),
    ink('#3b82f6', p(0.34, 0.62), [
        p(0.18, 0.555),
        p(0.22, 0.58),
        p(0.27, 0.595),
        p(0.34, 0.62),
        p(0.39, 0.652),
        p(0.43, 0.678),
        p(0.46, 0.7),
    ], 'mouse'),
] as const;

const fiveInkStrokes = [
    ink('#ef4444', p(0.18, 0.2), [
        p(0.14, 0.17),
        p(0.18, 0.2),
        p(0.24, 0.24),
    ]),
    ink('#22c55e', p(0.34, 0.3), [
        p(0.3, 0.27),
        p(0.34, 0.3),
        p(0.4, 0.35),
    ]),
    ink('#3b82f6', p(0.54, 0.38), [
        p(0.48, 0.34),
        p(0.54, 0.38),
        p(0.6, 0.43),
    ]),
    ink('#ffd400', p(0.3, 0.58), [
        p(0.24, 0.54),
        p(0.3, 0.58),
        p(0.36, 0.63),
    ]),
    ink('#8b5cf6', p(0.62, 0.66), [
        p(0.56, 0.61),
        p(0.62, 0.66),
        p(0.69, 0.71),
    ]),
] as const;

const multiRoundInkStrokes = [
    ...fiveInkStrokes.slice(0, 3),
    ink('#ffd400', p(0.28, 0.56), [
        p(0.23, 0.52),
        p(0.28, 0.56),
        p(0.34, 0.61),
    ]),
    ink('#8b5cf6', p(0.5, 0.6), [
        p(0.45, 0.56),
        p(0.5, 0.6),
        p(0.56, 0.65),
    ]),
    ink('#f59e0b', p(0.7, 0.67), [
        p(0.64, 0.62),
        p(0.7, 0.67),
        p(0.76, 0.72),
    ]),
    ink('#06b6d4', p(0.16, 0.14), [
        p(0.12, 0.1),
        p(0.16, 0.14),
        p(0.22, 0.19),
    ]),
    ink('#ec4899', p(0.44, 0.18), [
        p(0.39, 0.14),
        p(0.44, 0.18),
        p(0.5, 0.23),
    ]),
    ink('#111827', p(0.7, 0.22), [
        p(0.64, 0.18),
        p(0.7, 0.22),
        p(0.76, 0.26),
    ]),
] as const;

const successiveCycleInkStrokes = [
    ...baseInkStrokes,
    ink('#f59e0b', p(0.65, 0.64), [
        p(0.54, 0.56),
        p(0.65, 0.64),
        p(0.74, 0.72),
    ]),
] as const;

const baseLines = [
    line('#ef4444', p(0.18, 0.18), p(0.38, 0.34), p(0.28, 0.26)),
    line('#22c55e', p(0.52, 0.2), p(0.52, 0.56), p(0.52, 0.38)),
    line('#3b82f6', p(0.2, 0.62), p(0.44, 0.78), p(0.32, 0.7)),
] as const;

const savedShapeDeleteScenarios = [
    {
        name: 'keeps multiple saved strokes fully managed after save so delete clears them visually before the next save',
        fixturePrefix: 'draw-shape-multi',
        shapes: mouseInkStrokes,
        steps: [
            {
                action: 'draw',
                shapeIndexes: [
                    0,
                    1,
                    2,
                ],
                expectCount: 3,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 3,
                expectNoCanvasInkForShapes: [
                    0,
                    1,
                    2,
                ],
            },
            {
                action: 'delete',
                shapeIndex: 0,
                expectCount: 2,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'delete',
                shapeIndex: 1,
                expectCount: 1,
                expectDeletedAnnotationIds: 2,
            },
            {
                action: 'save',
                via: 'handle',
                expectDiskCount: 1,
            },
        ],
    },
    {
        name: 'keeps later saved-stroke deletions stable when removing several saved strokes in a row',
        fixturePrefix: 'draw-shape-many-delete',
        shapes: fiveInkStrokes,
        steps: [
            {
                action: 'draw',
                shapeIndexes: [
                    0,
                    1,
                    2,
                    3,
                    4,
                ],
                expectCount: 5,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 5,
            },
            {
                action: 'delete',
                shapeIndex: 0,
                expectCount: 4,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'delete',
                shapeIndex: 1,
                expectCount: 3,
                expectDeletedAnnotationIds: 2,
            },
            {
                action: 'delete',
                shapeIndex: 2,
                expectCount: 2,
                expectDeletedAnnotationIds: 3,
            },
            {
                action: 'delete',
                shapeIndex: 3,
                expectCount: 1,
                expectDeletedAnnotationIds: 4,
            },
            {
                action: 'save',
                via: 'handle',
                expectDiskCount: 1,
            },
        ],
    },
    {
        name: 'keeps deleting the second saved stroke stable after deleting and saving the first saved stroke',
        fixturePrefix: 'draw-shape-first-then-second',
        shapes: baseInkStrokes,
        steps: [
            {
                action: 'draw',
                shapeIndexes: [
                    0,
                    1,
                    2,
                ],
                expectCount: 3,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
            },
            {
                action: 'delete',
                shapeIndex: 0,
                expectCount: 2,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 2,
            },
            {
                action: 'delete',
                shapeIndex: 1,
                expectCount: 1,
                expectDeletedAnnotationIds: 1,
                expectDiskCount: 2,
            },
        ],
    },
    {
        name: 'keeps the popup-delete path stable after saving via the visible toolbar button',
        fixturePrefix: 'draw-shape-toolbar-popup',
        viewport: {
            width: 1600,
            height: 1000,
        },
        shapes: baseInkStrokes,
        steps: [
            {
                action: 'draw',
                shapeIndexes: [
                    0,
                    1,
                    2,
                ],
                expectCount: 3,
            },
            {
                action: 'save',
                via: 'toolbar',
                settle: 'embedded',
            },
            {
                action: 'delete',
                shapeIndex: 0,
                via: 'popup',
                expectCount: 2,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'save',
                via: 'toolbar',
                settle: 'embedded',
                expectDiskCount: 2,
            },
            {
                action: 'delete',
                shapeIndex: 1,
                via: 'popup',
                expectCount: 1,
                expectDeletedAnnotationIds: 1,
                expectDiskCount: 2,
            },
        ],
    },
    {
        name: 'keeps the popup-delete path stable after saving through the workspace save hook',
        fixturePrefix: 'draw-shape-hook-popup',
        shapes: baseInkStrokes,
        steps: [
            {
                action: 'draw',
                shapeIndexes: [
                    0,
                    1,
                    2,
                ],
                expectCount: 3,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
            },
            {
                action: 'delete',
                shapeIndex: 0,
                via: 'popup',
                expectCount: 2,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
            },
            {
                action: 'delete',
                shapeIndex: 1,
                via: 'popup',
                expectCount: 1,
                expectDeletedAnnotationIds: 1,
            },
        ],
    },
    {
        name: 'keeps deleting the second saved stroke stable when the second delete happens immediately after saving the first delete',
        fixturePrefix: 'draw-shape-immediate-second-delete',
        shapes: baseInkStrokes,
        steps: [
            {
                action: 'draw',
                shapeIndexes: [
                    0,
                    1,
                    2,
                ],
                expectCount: 3,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'shape-count',
            },
            {
                action: 'delete',
                shapeIndex: 0,
                expectCount: 2,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'shape-count',
            },
            {
                action: 'delete',
                shapeIndex: 1,
                expectCount: 1,
                expectDeletedAnnotationIds: 1,
            },
        ],
    },
    {
        name: 'keeps shapes fully managed when one local stroke is deleted before the first save and another is deleted right after that save',
        fixturePrefix: 'draw-shape-delete-before-first-save',
        shapes: baseInkStrokes,
        steps: [
            {
                action: 'draw',
                shapeIndexes: [
                    0,
                    1,
                    2,
                ],
                expectCount: 3,
            },
            {
                action: 'delete',
                shapeIndex: 0,
                expectCount: 2,
                expectDeletedAnnotationIds: 0,
                expectSource: 'local',
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 2,
                expectToolbarClean: true,
            },
            {
                action: 'delete',
                shapeIndex: 1,
                expectCount: 1,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 1,
                expectToolbarClean: true,
            },
        ],
    },
    {
        name: 'keeps the popup-delete path stable when the second delete happens immediately after a toolbar save',
        fixturePrefix: 'draw-shape-toolbar-popup-immediate',
        viewport: {
            width: 1600,
            height: 1000,
        },
        shapes: baseInkStrokes,
        steps: [
            {
                action: 'draw',
                shapeIndexes: [
                    0,
                    1,
                    2,
                ],
                expectCount: 3,
            },
            {
                action: 'save',
                via: 'toolbar',
                settle: 'shape-count',
            },
            {
                action: 'delete',
                shapeIndex: 0,
                via: 'popup',
                expectCount: 2,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'save',
                via: 'toolbar',
                settle: 'shape-count',
            },
            {
                action: 'delete',
                shapeIndex: 1,
                via: 'popup',
                expectCount: 1,
                expectDeletedAnnotationIds: 1,
            },
        ],
    },
    {
        name: 'keeps the popup-delete path stable when the second delete happens immediately after a save handle round-trip',
        fixturePrefix: 'draw-shape-popup-immediate-save-handle',
        shapes: baseInkStrokes,
        steps: [
            {
                action: 'draw',
                shapeIndexes: [
                    0,
                    1,
                    2,
                ],
                expectCount: 3,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'shape-count',
            },
            {
                action: 'delete',
                shapeIndex: 0,
                via: 'popup',
                expectCount: 2,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'shape-count',
            },
            {
                action: 'delete',
                shapeIndex: 1,
                via: 'popup',
                expectCount: 1,
                expectDeletedAnnotationIds: 1,
            },
        ],
    },
    {
        name: 'keeps deleting saved strokes stable across multiple save rounds',
        fixturePrefix: 'draw-shape-multi-round',
        shapes: multiRoundInkStrokes,
        steps: [
            {
                action: 'draw',
                shapeIndexes: [
                    0,
                    1,
                    2,
                ],
                expectCount: 3,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 3,
            },
            {
                action: 'delete',
                shapeIndex: 0,
                expectCount: 2,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'delete',
                shapeIndex: 1,
                expectCount: 1,
                expectDeletedAnnotationIds: 2,
            },
            {
                action: 'save',
                via: 'handle',
                expectDiskCount: 1,
            },
            {
                action: 'draw',
                shapeIndexes: [
                    3,
                    4,
                    5,
                ],
                expectCount: 4,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 4,
            },
            {
                action: 'delete',
                shapeIndex: 3,
                expectCount: 3,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'delete',
                shapeIndex: 4,
                expectCount: 2,
                expectDeletedAnnotationIds: 2,
            },
            {
                action: 'save',
                via: 'handle',
                expectDiskCount: 2,
            },
            {
                action: 'draw',
                shapeIndexes: [
                    6,
                    7,
                    8,
                ],
                expectCount: 5,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 5,
            },
            {
                action: 'delete',
                shapeIndex: 6,
                expectCount: 4,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'delete',
                shapeIndex: 7,
                expectCount: 3,
                expectDeletedAnnotationIds: 2,
            },
            {
                action: 'save',
                via: 'handle',
                expectDiskCount: 3,
            },
        ],
    },
    {
        name: 'allows deleting a saved stroke immediately after save without leaving a ghost layer',
        fixturePrefix: 'draw-shape-immediate-delete',
        shapes: baseInkStrokes,
        steps: [
            {
                action: 'draw',
                shapeIndexes: [
                    0,
                    1,
                    2,
                ],
                expectCount: 3,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'shape-count',
            },
            {
                action: 'delete',
                shapeIndex: 0,
                expectCount: 2,
                expectDeletedAnnotationIds: 1,
            },
        ],
    },
    {
        name: 'allows deleting a preexisting saved stroke after reopening the file without leaving a ghost layer',
        fixturePrefix: 'draw-shape-reopen-delete',
        shapes: baseInkStrokes,
        steps: [
            {
                action: 'draw',
                shapeIndexes: [
                    0,
                    1,
                    2,
                ],
                expectCount: 3,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'shape-count',
            },
            {
                action: 'reopen',
                expectCount: 3,
                expectNoCanvasInkForShapes: [0],
            },
            {
                action: 'delete',
                shapeIndex: 0,
                expectCount: 2,
                expectDeletedAnnotationIds: 1,
            },
        ],
    },
    {
        name: 'keeps deleting saved survivors stable across successive save cycles',
        fixturePrefix: 'draw-shape-successive-delete',
        shapes: successiveCycleInkStrokes,
        steps: [
            {
                action: 'draw',
                shapeIndexes: [
                    0,
                    1,
                    2,
                ],
                expectCount: 3,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 3,
            },
            {
                action: 'delete',
                shapeIndex: 0,
                expectCount: 2,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 2,
            },
            {
                action: 'delete',
                shapeIndex: 2,
                expectCount: 1,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 1,
            },
            {
                action: 'draw',
                shapeIndexes: [3],
                expectCount: 2,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 2,
            },
            {
                action: 'delete',
                shapeIndex: 1,
                expectCount: 1,
                expectDeletedAnnotationIds: 1,
            },
        ],
    },
    {
        name: 'keeps deleting the second saved line stable after deleting and saving the first saved line',
        fixturePrefix: 'draw-shape-line-first-then-second',
        shapes: baseLines,
        steps: [
            {
                action: 'draw',
                shapeIndexes: [
                    0,
                    1,
                    2,
                ],
                expectCount: 3,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 3,
            },
            {
                action: 'delete',
                shapeIndex: 0,
                expectCount: 2,
                expectDeletedAnnotationIds: 1,
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 2,
            },
            {
                action: 'delete',
                shapeIndex: 1,
                expectCount: 1,
                expectDeletedAnnotationIds: 1,
                expectKind: 'line',
                expectSource: 'embedded',
            },
            {
                action: 'save',
                via: 'handle',
                settle: 'embedded',
                expectDiskCount: 1,
                expectToolbarClean: true,
            },
        ],
    },
] satisfies readonly ISavedShapeDeleteScenario[];

function getScenarioGhostPoints(shape: TScenarioShape) {
    if (shape.kind === 'line') {
        return [
            shape.start,
            shape.hit,
            shape.end,
        ];
    }

    return shape.points;
}

function getScenarioAnnotationSubtype(scenario: ISavedShapeDeleteScenario) {
    const firstShape = scenario.shapes[0];
    if (!firstShape) {
        throw new Error(`Scenario has no shapes: ${scenario.name}`);
    }

    return firstShape.kind === 'line' ? 'Line' : 'Ink';
}

async function expectScenarioAnnotationCount(
    scenario: ISavedShapeDeleteScenario,
    fixturePath: string,
    expectedCount: number,
) {
    const subtype = getScenarioAnnotationSubtype(scenario);
    const summary = await waitForAnnotationSubtypeCountOnDisk(fixturePath, subtype, expectedCount);
    expect(summary.bySubtype[subtype] ?? 0).toBe(expectedCount);
}

async function expectNoCanvasInkForScenarioShapes(
    page: Page,
    scenario: ISavedShapeDeleteScenario,
    shapeIndexes: readonly number[],
) {
    for (const shapeIndex of shapeIndexes) {
        const shape = scenario.shapes[shapeIndex];
        if (!shape) {
            throw new Error(`Scenario references missing shape ${shapeIndex}: ${scenario.name}`);
        }
        expect(await hasVisibleCanvasInkAtPointWithOverlayHidden(page, shape.hit)).toBe(false);
    }
}

async function expectToolbarClean(page: Page) {
    const toolbarState = await getToolbarSaveDebugState(page);
    expect(toolbarState.activeTabDirty).toBe(false);
    if (toolbarState.toolbarSnapshot) {
        expect(toolbarState.toolbarSnapshot).toMatchObject({ canSave: false });
    }
}

async function saveForScenario(page: Page, step: ISaveScenarioStep, shapeCount: number) {
    if (step.via === 'toolbar') {
        await saveViaToolbarButton(page);
    } else {
        await saveViaWindowHandle(page);
    }

    await waitForShapeCount(page, shapeCount);
    if (step.settle === 'embedded') {
        await waitForAllShapesEmbedded(page, shapeCount);
    }
    if (step.expectToolbarClean) {
        await expectToolbarClean(page);
    }
}

async function drawScenarioShape(page: Page, shape: TScenarioShape) {
    await setAnnotationColor(page, shape.color);
    if (shape.kind === 'line') {
        await dragLineSegment(page, {
            start: shape.start,
            end: shape.end,
        });
        return;
    }

    await dragInkStrokeWithMouse(page, shape.points);
}

async function drawScenarioShapes(
    page: Page,
    scenario: ISavedShapeDeleteScenario,
    step: IDrawScenarioStep,
) {
    const firstShape = scenario.shapes[step.shapeIndexes[0] ?? -1];
    await clickAnnotationTool(page, firstShape?.kind === 'line' ? 'Line' : 'Draw');
    await waitForActiveColorIndicator(page);

    for (const shapeIndex of step.shapeIndexes) {
        const shape = scenario.shapes[shapeIndex];
        if (!shape) {
            throw new Error(`Scenario references missing shape ${shapeIndex}: ${scenario.name}`);
        }
        await drawScenarioShape(page, shape);
    }

    await waitForShapeCount(page, step.expectCount);
    await waitForNoShapeSelectionUi(page);
}

async function waitForShapeCountWithScenarioDiagnostics(
    page: Page,
    scenario: ISavedShapeDeleteScenario,
    shape: TScenarioShape,
    expectedCount: number,
    stateAfterClick: Awaited<ReturnType<typeof getManagedShapeDebugState>>,
) {
    try {
        await waitForShapeCount(page, expectedCount);
    } catch (error) {
        const [
            managedShapeState,
            toolbarState,
            canvasGhostVisible,
            pointInteractionState,
        ] = await Promise.all([
            getManagedShapeDebugState(page),
            getToolbarSaveDebugState(page),
            hasVisibleCanvasInkAtPointWithOverlayHidden(page, shape.hit),
            getPointInteractionDebugState(page, shape.hit),
        ]);
        throw new Error([
            `${scenario.name}: ${error instanceof Error ? error.message : String(error)}`,
            `stateAfterClick=${JSON.stringify(stateAfterClick)}`,
            `managedShapeState=${JSON.stringify(managedShapeState)}`,
            `toolbarState=${JSON.stringify(toolbarState)}`,
            `canvasGhostVisible=${JSON.stringify(canvasGhostVisible)}`,
            `pointInteractionState=${JSON.stringify(pointInteractionState)}`,
        ].join('\n'));
    }
}

async function deleteScenarioShape(
    page: Page,
    scenario: ISavedShapeDeleteScenario,
    fixturePath: string,
    step: IDeleteScenarioStep,
) {
    const shape = scenario.shapes[step.shapeIndex];
    if (!shape) {
        throw new Error(`Scenario references missing shape ${step.shapeIndex}: ${scenario.name}`);
    }

    await clickPagePoint(page, shape.hit, 1, step.via === 'popup' ? 'right' : 'left');
    await waitForShapeSelectionUi(page);
    const stateAfterClick = await getManagedShapeDebugState(page);
    if (step.via === 'popup') {
        await deleteSelectedShapeViaPropertiesPopup(page);
    } else {
        await deleteSelectedShape(page);
    }

    await waitForShapeCountWithScenarioDiagnostics(page, scenario, shape, step.expectCount, stateAfterClick);
    await waitForNoVisibleInkAtPoints(page, getScenarioGhostPoints(shape));

    const stateAfterDelete = await getManagedShapeDebugState(page);
    if (typeof step.expectDeletedAnnotationIds === 'number') {
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(step.expectDeletedAnnotationIds);
    }
    if (step.expectSource) {
        expect(stateAfterDelete.shapes).toHaveLength(step.expectCount);
        expect(stateAfterDelete.shapes.every(candidate => candidate.source === step.expectSource)).toBe(true);
    }
    if (step.expectKind) {
        expect(stateAfterDelete.shapes).toHaveLength(step.expectCount);
        expect(stateAfterDelete.shapes.every(candidate => candidate.type === step.expectKind)).toBe(true);
    }
    if (typeof step.expectDiskCount === 'number') {
        await expectScenarioAnnotationCount(scenario, fixturePath, step.expectDiskCount);
    }
}

async function runSavedShapeDeleteScenario(page: Page, scenario: ISavedShapeDeleteScenario) {
    if (scenario.viewport) {
        await page.setViewport(scenario.viewport);
    }

    const fixturePath = await createBlankFixturePdf(`${scenario.fixturePrefix}-${Date.now()}.pdf`, 1);
    await openPdfInApp(page, fixturePath);
    await waitForPdfLoaded(page);

    let shapeCount = 0;
    for (const [
        stepIndex,
        step,
    ] of scenario.steps.entries()) {
        try {
            switch (step.action) {
                case 'draw':
                    await drawScenarioShapes(page, scenario, step);
                    shapeCount = step.expectCount;
                    break;
                case 'save':
                    await saveForScenario(page, step, shapeCount);
                    if (typeof step.expectDiskCount === 'number') {
                        await expectScenarioAnnotationCount(scenario, fixturePath, step.expectDiskCount);
                    }
                    if (step.expectNoCanvasInkForShapes) {
                        await expectNoCanvasInkForScenarioShapes(page, scenario, step.expectNoCanvasInkForShapes);
                    }
                    break;
                case 'delete':
                    await deleteScenarioShape(page, scenario, fixturePath, step);
                    shapeCount = step.expectCount;
                    break;
                case 'reopen':
                    await openPdfInApp(page, fixturePath);
                    await waitForPdfLoaded(page);
                    await waitForViewerInteractive(page);
                    shapeCount = step.expectCount;
                    await waitForShapeCount(page, shapeCount);
                    if (step.expectNoCanvasInkForShapes) {
                        await expectNoCanvasInkForScenarioShapes(page, scenario, step.expectNoCanvasInkForShapes);
                    }
                    break;
                default: {
                    const exhaustiveStep: never = step;
                    throw new Error(`Unsupported scenario step: ${JSON.stringify(exhaustiveStep)}`);
                }
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const managedShapeState = await getManagedShapeDebugState(page);
            throw new Error([
                `${scenario.name}: step ${stepIndex + 1} (${step.action}) failed`,
                `step=${JSON.stringify(step)}`,
                `shapeCount=${shapeCount}`,
                `detail=${detail}`,
                `managedShapeState=${JSON.stringify(managedShapeState)}`,
            ].join('\n'));
        }
    }
}

describe('Electron E2E - Draw Shape Lifecycle', () => {
    let rendererErrorTracker: IRendererErrorTracker | null = null;

    // Every draw-shape test owns a full session relaunch: it starts one under a
    // fresh name and stops it in afterEach so managed-shape state cannot leak
    // between save cycles. The fixture must not also reset a session this suite
    // has already stopped.
    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: false,
        sessionName: () => `e2e-draw-shapes-${Date.now()}`,
    });

    const startDrawShapeSession = async () => {
        const session = await sessionFixture.start({sessionName: () => `e2e-draw-shapes-${Date.now()}`});
        if (session?.page) {
            rendererErrorTracker = createRendererErrorTracker(session.page);
        }
        return session;
    };

    afterEach(async () => {
        try {
            expect(rendererErrorTracker?.errors ?? []).toEqual([]);
        } finally {
            rendererErrorTracker?.detach();
            rendererErrorTracker = null;
            await sessionFixture.stop();
        }
    });

    it('preserves repeated draw-save-delete-redraw cycles without ghost shapes or auto-selecting new strokes', async () => {
        const session = await startDrawShapeSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const fixturePath = await createBlankFixturePdf(`draw-shape-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);

        await dragInkStroke(page, [
            {
                x: 0.18,
                y: 0.22,
            },
            {
                x: 0.28,
                y: 0.27,
            },
            {
                x: 0.42,
                y: 0.35,
            },
        ]);

        await waitForShapeCount(page, 1);
        await waitForNoShapeSelectionUi(page);

        const initialStrokeMetrics = await getFirstManagedShapeStrokeMetrics(page);
        expect(initialStrokeMetrics).not.toBeNull();
        expect(initialStrokeMetrics?.strokeWidth).toBe(1);
        expect(initialStrokeMetrics?.renderedStrokeWidth).toBeGreaterThan(0);
        expect(initialStrokeMetrics?.renderedStrokeWidth).toBeCloseTo(
            (initialStrokeMetrics?.strokeWidth ?? 0)
            * (initialStrokeMetrics?.scaleFactor ?? 0)
            * (initialStrokeMetrics?.userUnit ?? 0),
            2,
        );

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 1);
        let annotationSummary = await waitForInkCountOnDisk(fixturePath, 1);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(1);
        expect(await hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
            x: 0.28,
            y: 0.27,
        })).toBe(false);

        await clickPagePoint(page, {
            x: 0.28,
            y: 0.27,
        });
        await deleteSelectedShape(page);
        await waitForShapeCount(page, 0);
        await waitForNoVisibleInkAtPoint(page, {
            x: 0.28,
            y: 0.27,
        });

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 0);

        annotationSummary = await waitForInkCountOnDisk(fixturePath, 0);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(0);

        await dragInkStroke(page, [
            {
                x: 0.5,
                y: 0.28,
            },
            {
                x: 0.6,
                y: 0.38,
            },
            {
                x: 0.7,
                y: 0.48,
            },
        ]);

        await waitForShapeCount(page, 1);
        await waitForNoShapeSelectionUi(page);
        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 1);

        annotationSummary = await waitForInkCountOnDisk(fixturePath, 1);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(1);
        expect(await hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
            x: 0.6,
            y: 0.38,
        })).toBe(false);

        await clickPagePoint(page, {
            x: 0.6,
            y: 0.38,
        });
        await deleteSelectedShape(page);
        await waitForShapeCount(page, 0);
        await waitForNoVisibleInkAtPoint(page, {
            x: 0.6,
            y: 0.38,
        });

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 0);
        annotationSummary = await waitForInkCountOnDisk(fixturePath, 0);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(0);

        await dragInkStroke(page, [
            {
                x: 0.2,
                y: 0.55,
            },
            {
                x: 0.34,
                y: 0.6,
            },
            {
                x: 0.46,
                y: 0.68,
            },
        ]);

        await waitForShapeCount(page, 1);
        await waitForNoShapeSelectionUi(page);
        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 1);
        annotationSummary = await waitForInkCountOnDisk(fixturePath, 1);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(1);
        expect(await hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
            x: 0.34,
            y: 0.6,
        })).toBe(false);
    });

    it('keeps drawing undo and redo coherent after saving the new shape', async () => {
        const session = await startDrawShapeSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const fixturePath = await createBlankFixturePdf(`draw-shape-save-undo-redo-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await dragLineSegment(page, {
            start: {
                x: 0.18,
                y: 0.22,
            },
            end: {
                x: 0.66,
                y: 0.48,
            },
        });
        await waitForShapeCount(page, 1);
        await waitForShapeSidebarCount(page, 1);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 1);
        await waitForShapeSidebarCount(page, 1);
        const annotationSummary = await waitForLineCountOnDisk(fixturePath, 1);
        expect(annotationSummary.bySubtype.Line ?? 0).toBe(1);

        await clickEnabledToolbarAction(page, 'Undo');
        await waitForShapeCount(page, 0);
        await waitForShapeSidebarCount(page, 0);

        await clickEnabledToolbarAction(page, 'Redo');
        await waitForShapeCount(page, 1);
        await waitForShapeSidebarCount(page, 1);
    });

    for (const scenario of savedShapeDeleteScenarios) {
        it(scenario.name, async () => {
            const session = await startDrawShapeSession();
            if (!session) {
                return;
            }
            await runSavedShapeDeleteScenario(session.page, scenario);
        });
    }
});
