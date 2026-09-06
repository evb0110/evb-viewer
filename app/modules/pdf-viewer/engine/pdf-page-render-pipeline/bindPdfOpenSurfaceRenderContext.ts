import type {
    IPdfPage,
    IPdfRenderTask,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { IPdfViewerTransactionRenderRequest } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type { TPdfRenderContinuationPriority } from '@app/modules/pdf-viewer/engine/pdf-render-continuation-scheduler/pdfRenderContinuationScheduler';
export type TPdfPageRenderContentIntent =
    | 'full-visible'
    | 'canvas-only-buffer'
    | 'canvas-only-refine'
    | 'layers-only-promotion';

export interface IRenderVisiblePagesOptions {
    authoritativeRaster?: boolean;
    openSurfaceGeneration?: number;
    openSurfaceRevision?: string;
    preserveRenderedPages?: boolean;
    bufferOverride?: number;
    renderWindowOverride?: {
        start: number;
        end: number;
    };
    forceRerender?: boolean;
    suppressResidentRasterDemand?: boolean;
    retainOnlyCurrentResidentRaster?: boolean;
    preserveInFlightRequiredPages?: boolean;
    prioritizeTextLayer?: boolean;
    transactionRequest?: IPdfViewerTransactionRenderRequest;
    continuationPriority?: TPdfRenderContinuationPriority;
    contentIntent?: TPdfPageRenderContentIntent;
    maxCanvasPixels?: number;
    preserveCommittedVisual?: boolean;
    coordinatorDemand?: {
        kind: 'required' | 'buffer' | 'prewarm';
        renderGeneration: number;
    };
    rasterSchedulerTaskBridge?: {bind(task: IPdfRenderTask): void;};
    rasterSchedulerPage?: IPdfPage;
    rasterDemandPages?: readonly number[];
    bufferMaxCanvasPixels?: number;
}

export type TPdfOpenSurfaceRenderContext = Pick<
    Required<IRenderVisiblePagesOptions>,
    'openSurfaceGeneration' | 'openSurfaceRevision'
>;

export function bindPdfOpenSurfaceRenderContext(
    renderOptions: IRenderVisiblePagesOptions | undefined,
    context: TPdfOpenSurfaceRenderContext | undefined,
) {
    return context
        ? {
            ...renderOptions,
            ...context,
        }
        : renderOptions;
}
