import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {readPageSourceDpi} from '@app/platform/browser-api/browserOcrRaster';
import {
    resolveExportRenderDpi,
    selectDpiProbePages,
} from '@pdf-core/imageExportResolution';

/** Plan the selected document just as desktop plans its prepared PDF subset. */
export async function browserImageExportConfig(pdfDocument: Pick<IPdfDocument, 'getPage'>, pageNumbers: readonly number[]) {
    const probePages = new Set(selectDpiProbePages(pageNumbers.length).map(page => pageNumbers[page - 1]));
    let sourceDpi: number | null = null;
    let longestSidePts = 0;
    for (const pageNumber of pageNumbers) {
        const page = await pdfDocument.getPage(pageNumber);
        try {
            const viewport = page.getViewport({scale: 1});
            longestSidePts = Math.max(longestSidePts, viewport.width, viewport.height);
            if (probePages.has(pageNumber)) {
                const dpi = await page.getOperatorList().then(readPageSourceDpi).catch(() => undefined);
                sourceDpi = Math.max(sourceDpi ?? 0, dpi ?? 0) || null;
            }
        } finally {
            try {
                await Promise.resolve(page.cleanup());
            } catch {
                // Cleanup is best effort.
            }
        }
    }
    return resolveExportRenderDpi(sourceDpi, [{
        widthPts: longestSidePts,
        heightPts: longestSidePts,
    }]);
}
