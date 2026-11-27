import type {Page} from 'puppeteer-core';
import {sumBy} from 'es-toolkit/math';
import {evaluateInPage} from '@tests/e2e/electron/helpers/pageRuntime';

interface IWorkspacePressureSnapshot {
    index: number;
    active: boolean;
    visible: boolean;
    pdfViewers: number;
    renderedPages: number;
    canvases: number;
    canvasPixels: number;
    textSpans: number;
    annotationLayerNodes: number;
    djvuPageShells: number;
    djvuImages: number;
    emptyPlaceholders: number;
}

async function readWorkspacePressure(page: Page): Promise<IWorkspacePressureSnapshot[]> {
    return evaluateInPage(page, () => {
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                Number(style.opacity || '1') > 0 &&
                rect.width > 100 &&
                rect.height > 100
            );
        };
        const countCanvasPixels = (root: HTMLElement) =>
            Array.from(root.querySelectorAll<HTMLCanvasElement>('canvas')).reduce(
                (total, canvas) => total + (canvas.width || 0) * (canvas.height || 0),
                0,
            );

        return Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).map((host, index) => {
            const visible = isVisible(host);
            return {
                index,
                active: visible,
                visible,
                pdfViewers: host.querySelectorAll('#pdf-viewer, .pdfViewer').length,
                renderedPages: host.querySelectorAll('.page_container--rendered').length,
                canvases: host.querySelectorAll('canvas').length,
                canvasPixels: countCanvasPixels(host),
                textSpans: host.querySelectorAll('.text-layer span, .textLayer span').length,
                annotationLayerNodes: host.querySelectorAll(
                    '.annotation-layer *, .annotation-editor-layer *, .annotationLayer *, .annotationEditorLayer *',
                ).length,
                djvuPageShells: host.querySelectorAll('[data-testid="document-page-source-page"]').length,
                djvuImages: host.querySelectorAll('[data-testid="document-page-source-image"]').length,
                emptyPlaceholders: host.querySelectorAll('.empty-state, .workspace-empty-state, [class*="empty"]').length,
            };
        });
    });
}

function summarizeInactivePressure(snapshots: IWorkspacePressureSnapshot[]) {
    const inactive = snapshots.filter((host) => !host.active);
    return {
        inactiveCanvases: sumBy(inactive, (host) => host.canvases),
        inactiveRenderedPages: sumBy(inactive, (host) => host.renderedPages),
        inactiveCanvasPixels: sumBy(inactive, (host) => host.canvasPixels),
        inactiveTextSpans: sumBy(inactive, (host) => host.textSpans),
        inactiveDjvuImages: sumBy(inactive, (host) => host.djvuImages),
    };
}

export async function assertInactiveDocumentPressureReleased(page: Page) {
    const snapshots = await readWorkspacePressure(page);
    const inactiveTotals = summarizeInactivePressure(snapshots);
    if (
        inactiveTotals.inactiveCanvases > 0 ||
        inactiveTotals.inactiveRenderedPages > 0 ||
        inactiveTotals.inactiveTextSpans > 0 ||
        inactiveTotals.inactiveDjvuImages > 0
    ) {
        throw new Error(
            `Inactive document pressure was not released: ${JSON.stringify({
                inactiveTotals,
                snapshots,
            })}`,
        );
    }
    return snapshots;
}
