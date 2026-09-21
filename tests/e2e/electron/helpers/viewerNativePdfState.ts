import type { Page } from 'puppeteer-core';
import { PDF_NATIVE_PAGE_PREVIEW_RASTER_WIDTH_CEILING_PX } from '@contracts/electronApiDocuments';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';

export interface INativePdfOpeningFrame {
    capturedAtMs: number;
    chassisCurrentPage: number | null;
    claimed: boolean;
    committedHighResolutionRasterVisible: boolean;
    committedLowResolutionRasterVisible: boolean;
    documentId: string;
    emptyStateVisible: boolean;
    generation: number;
    nativeSkeletonVisible: boolean;
    nativeViewerVisible: boolean;
    openingPreviewPage: number | null;
    openingPreviewVisible: boolean;
    pdfjsOpeningPageRect: {
        height: number;
        left: number;
        top: number;
        width: number;
    } | null;
    pdfjsOpeningPageVisible: boolean;
    pdfjsOpeningSurfaceDeferred: boolean;
    pdfjsCanvasRects: Array<{
        bottom: number;
        left: number;
        page: number;
        right: number;
        top: number;
    }>;
    pdfjsCanvasVisible: boolean;
    pdfjsTextLayerVisible: boolean;
    pdfjsVisibleCanvasPages: number[];
    transitionCoversViewport: boolean;
    transitionShellRect: {
        height: number;
        left: number;
        top: number;
        width: number;
    } | null;
    transitionSkeletonCount: number;
    transitionSurfaceVisible: boolean;
    viewportCommittedPage: number | null;
    viewportLifecycle: string;
    viewportRequestedPage: number | null;
}

export async function installNativePdfOpeningSampler(page: Page) {
    await evaluateInPage(page, (rasterWidthCeilingPx: number) => {
        const testWindow = window as typeof window & {
            __nativePdfOpeningAnimationFrame?: number;
            __nativePdfOpeningFrames?: INativePdfOpeningFrame[];
        };
        if (testWindow.__nativePdfOpeningAnimationFrame !== undefined) {
            cancelAnimationFrame(testWindow.__nativePdfOpeningAnimationFrame);
        }
        testWindow.__nativePdfOpeningFrames = [];
        const isVisible = (element: HTMLElement | null) => {
            if (!element?.isConnected) {
                return false;
            }
            let current: HTMLElement | null = element;
            while (current) {
                const style = getComputedStyle(current);
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
                    return false;
                }
                current = current.parentElement;
            }
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const intersects = (element: HTMLElement, viewport: HTMLElement | null) => {
            const elementRect = element.getBoundingClientRect();
            const viewportRect = viewport?.getBoundingClientRect() ?? null;
            return viewportRect !== null
                && elementRect.right > viewportRect.left
                && elementRect.left < viewportRect.right
                && elementRect.bottom > viewportRect.top
                && elementRect.top < viewportRect.bottom;
        };
        const capture = () => {
            const host = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
            const viewportHost = chassis?.querySelector<HTMLElement>('[data-open-surface-phase]') ?? null;
            const transitionSurface = host?.querySelector<HTMLElement>('.document-viewer-chassis__opening-page') ?? null;
            const openingPreview = transitionSurface?.querySelector<HTMLElement>(
                '[data-testid="document-opening-native-preview"]',
            ) ?? null;
            const transitionShell = transitionSurface?.querySelector<HTMLElement>('[data-page-number]') ?? transitionSurface;
            const transitionRect = transitionShell?.getBoundingClientRect() ?? null;
            const viewportRect = viewportHost?.getBoundingClientRect() ?? null;
            const nativeViewer = host?.querySelector<HTMLElement>('.native-pdf-viewer') ?? null;
            const pdfjsViewer = host?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
            const pdfjsOpeningPage = pdfjsViewer?.querySelector<HTMLElement>(
                '.page_container[data-page="1"]',
            ) ?? null;
            const pdfjsHost = host?.querySelector<HTMLElement>('[data-pdf-viewer-host]') ?? null;
            const committedRasterImages = Array.from(
                host?.querySelectorAll<HTMLImageElement>(
                    '.native-pdf-page-content.document-page-visual--committed img',
                ) ?? [],
            ).filter(image => (
                isVisible(image)
                && intersects(image, viewportHost)
                && image.complete
                && image.naturalWidth > 0
            ));
            const rasterIsHighResolution = (image: HTMLImageElement) => image.naturalWidth
                >= globalThis.__evbE2E.getRequiredRasterWidth(image, rasterWidthCeilingPx);
            const committedPdfjsCanvases = Array.from(
                pdfjsViewer?.querySelectorAll<HTMLCanvasElement>(
                    '.page_container--rendered .page_canvas__render-layer canvas, .page_container--rendered .page_canvas canvas',
                ) ?? [],
            ).filter(canvas => (
                canvas.width > 0
                && canvas.height > 0
                && isVisible(canvas)
                && intersects(canvas, viewportHost)
            ));
            const pdfjsCanvasIsHighResolution = (canvas: HTMLCanvasElement) => {
                const rect = canvas.getBoundingClientRect();
                return canvas.width >= Math.ceil(rect.width * Math.max(1, window.devicePixelRatio || 1));
            };
            const parsePage = (value: string | undefined) => {
                const parsed = Number(value);
                return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
            };
            const pdfjsCanvasRects = committedPdfjsCanvases.flatMap((canvas) => {
                const pageNumber = Number(
                    canvas.closest<HTMLElement>('.page_container')?.dataset.page ?? 0,
                );
                if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
                    return [];
                }
                const rect = canvas.getBoundingClientRect();
                return [{
                    bottom: rect.bottom,
                    left: rect.left,
                    page: pageNumber,
                    right: rect.right,
                    top: rect.top,
                }];
            });
            testWindow.__nativePdfOpeningFrames!.push({
                capturedAtMs: performance.now(),
                chassisCurrentPage: parsePage(chassis?.dataset.chassisCurrentPage),
                claimed: viewportHost?.dataset.openSurfacePhase !== undefined
                    && viewportHost.dataset.openSurfacePhase !== 'idle'
                    && (chassis?.dataset.openSurfaceDocumentId ?? '').length > 0,
                committedHighResolutionRasterVisible: committedRasterImages.some(rasterIsHighResolution)
                    || committedPdfjsCanvases.some(pdfjsCanvasIsHighResolution),
                committedLowResolutionRasterVisible: committedRasterImages.some(image => !rasterIsHighResolution(image))
                    || committedPdfjsCanvases.some(canvas => !pdfjsCanvasIsHighResolution(canvas)),
                documentId: chassis?.dataset.openSurfaceDocumentId ?? '',
                emptyStateVisible: Array.from(host?.querySelectorAll<HTMLElement>('.empty-state') ?? []).some(isVisible),
                generation: Number(chassis?.dataset.openSurfaceGeneration ?? 0),
                nativeSkeletonVisible: Array.from(
                    nativeViewer?.querySelectorAll<HTMLElement>('.document-page-skeleton') ?? [],
                ).some(element => isVisible(element) && intersects(element, viewportHost)),
                nativeViewerVisible: isVisible(nativeViewer),
                openingPreviewPage: parsePage(transitionShell?.dataset.pageNumber),
                openingPreviewVisible: openingPreview !== null
                    && isVisible(openingPreview)
                    && intersects(openingPreview, viewportHost),
                pdfjsOpeningPageRect: pdfjsOpeningPage === null ? null : (() => {
                    const rect = pdfjsOpeningPage.getBoundingClientRect();
                    return {
                        height: rect.height,
                        left: rect.left,
                        top: rect.top,
                        width: rect.width,
                    };
                })(),
                pdfjsOpeningPageVisible: pdfjsOpeningPage !== null
                    && isVisible(pdfjsOpeningPage)
                    && intersects(pdfjsOpeningPage, viewportHost),
                pdfjsOpeningSurfaceDeferred: pdfjsHost?.dataset.openingSurfaceDeferred === 'true',
                pdfjsCanvasRects,
                pdfjsCanvasVisible: committedPdfjsCanvases.length > 0,
                pdfjsTextLayerVisible: Array.from(
                    pdfjsViewer?.querySelectorAll<HTMLElement>('.text-layer, .textLayer') ?? [],
                ).some(layer => isVisible(layer) && intersects(layer, viewportHost)),
                pdfjsVisibleCanvasPages: pdfjsCanvasRects.map(rect => rect.page),
                transitionShellRect: transitionRect ? {
                    height: transitionRect.height,
                    left: transitionRect.left,
                    top: transitionRect.top,
                    width: transitionRect.width,
                } : null,
                transitionSkeletonCount: Array.from(
                    transitionSurface?.querySelectorAll<HTMLElement>('.document-page-skeleton') ?? [],
                ).filter(isVisible).length,
                transitionCoversViewport: transitionRect !== null
                    && viewportRect !== null
                    && Math.min(transitionRect.right, viewportRect.right, window.innerWidth)
                        > Math.max(transitionRect.left, viewportRect.left, 0)
                    && Math.min(transitionRect.bottom, viewportRect.bottom, window.innerHeight)
                        > Math.max(transitionRect.top, viewportRect.top, 0),
                transitionSurfaceVisible: isVisible(transitionSurface),
                viewportCommittedPage: parsePage(chassis?.dataset.viewportCommittedPage),
                viewportLifecycle: chassis?.dataset.viewportLifecycle ?? '',
                viewportRequestedPage: parsePage(chassis?.dataset.viewportRequestedPage),
            });
            testWindow.__nativePdfOpeningAnimationFrame = requestAnimationFrame(capture);
        };
        capture();
    }, PDF_NATIVE_PAGE_PREVIEW_RASTER_WIDTH_CEILING_PX);
}

export async function stopNativePdfOpeningSampler(page: Page): Promise<INativePdfOpeningFrame[]> {
    return evaluateInPage(page, () => {
        const testWindow = window as typeof window & {
            __nativePdfOpeningAnimationFrame?: number;
            __nativePdfOpeningFrames?: INativePdfOpeningFrame[];
        };
        if (testWindow.__nativePdfOpeningAnimationFrame !== undefined) {
            cancelAnimationFrame(testWindow.__nativePdfOpeningAnimationFrame);
        }
        const frames = testWindow.__nativePdfOpeningFrames ?? [];
        delete testWindow.__nativePdfOpeningAnimationFrame;
        delete testWindow.__nativePdfOpeningFrames;
        return frames;
    });
}
