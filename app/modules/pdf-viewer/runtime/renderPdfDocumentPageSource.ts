import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { IWorkspaceSurfaceBudgetController } from '@app/utils/document-viewer/workspaceSurfaceBudget';
import type {
    IDocumentPageRenderRequest,
    IDocumentSurfaceLease,
} from '@app/utils/document-viewer/source/documentPageSource';
import { resolveBoundedRasterDimensions } from '@app/utils/document-viewer/resolveBoundedRasterDimensions';

const PDF_PAGE_SOURCE_MAX_PIXELS = 16 * 1024 * 1024;
const PDF_PAGE_SOURCE_MAX_DIMENSION = 32_767;

export async function renderPdfDocumentPageSource(options: {
    document: IPdfDocument;
    request: IDocumentPageRenderRequest;
    scopeId: string;
    surfaceBudget: IWorkspaceSurfaceBudgetController;
}): Promise<IDocumentSurfaceLease> {
    const {
        document,
        request,
        scopeId,
        surfaceBudget,
    } = options;
    request.signal.throwIfAborted();
    const page = await document.getPage(request.pageNumber);
    const baseViewport = page.getViewport({scale: 1});
    const requestedScale = request.widthPx / Math.max(1, baseViewport.width);
    const requestedViewport = page.getViewport({scale: requestedScale});
    const dimensions = resolveBoundedRasterDimensions({
        width: requestedViewport.width,
        height: requestedViewport.height,
        maxPixels: PDF_PAGE_SOURCE_MAX_PIXELS,
        maxDimension: PDF_PAGE_SOURCE_MAX_DIMENSION,
    });
    const viewport = page.getViewport({scale: requestedScale * dimensions.scale});
    const bytes = dimensions.width * dimensions.height * 4;
    const budgetLease = surfaceBudget.tryReserve({
        scopeId,
        category: 'pdf-page-canvas',
        bytes,
        priority: request.priority === 'navigation' ? 100 : 50,
        canEvict: () => false,
    });
    if (!budgetLease) {
        throw new RangeError('PDF page source exceeds the available workspace surface budget');
    }
    const canvas = window.document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const canvasContext = canvas.getContext('2d');
    if (!canvasContext) {
        budgetLease.release();
        throw new Error('PDF page-source canvas context is unavailable');
    }
    const renderTask = page.render({
        canvas,
        canvasContext,
        viewport,
    });
    const cancelRender = () => renderTask.cancel();
    request.signal.addEventListener('abort', cancelRender, {once: true});
    if (request.signal.aborted) {
        cancelRender();
    }
    try {
        await renderTask.promise;
        request.signal.throwIfAborted();
    } catch (error) {
        budgetLease.release();
        canvas.width = 0;
        canvas.height = 0;
        throw error;
    } finally {
        request.signal.removeEventListener('abort', cancelRender);
    }
    let released = false;
    return {
        widthPx: canvas.width,
        heightPx: canvas.height,
        bytes,
        surface: canvas,
        release() {
            if (released) {
                return;
            }
            released = true;
            budgetLease.release();
            canvas.width = 0;
            canvas.height = 0;
        },
    };
}
