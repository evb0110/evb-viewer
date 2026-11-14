import type { TPageNumber } from '@contracts/pageNumbers';

import type {
    IPdfPage,
    IPdfRenderTask,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    MaybeRefOrGetter,
    Ref,
} from 'vue';
import type {
    IPdfDocumentFence,
    TPdfDocumentView,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import type { TPdfPageResources } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageResources';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type { ILinkAnnotation } from '@app/types/annotations';
import type { IPdfAnnotationRenderInput } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';
export type {
    IPdfAnnotationRenderInput, IRenderVisiblePagesOptions,
} from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';

export interface IPdfRendererSearchNavigationOptions {
    scrollToPage?: (pageNumber: TPageNumber, options?: IScrollToPageOptions) => void;
    suppressSnap?: () => void;
    beginSearchNavigation?: (pageNumber: TPageNumber) => void;
    revealSearchNavigationTarget?: (
        pageNumber: TPageNumber,
        options?: Pick<IScrollToPageOptions, 'markerRect' | 'textAnchor'>,
    ) => void;
    endSearchNavigation?: (settleMs?: number) => void;
    beginSearchTransaction?: (
        pageNumber: TPageNumber,
        options?: Pick<IScrollToPageOptions, 'markerRect' | 'textAnchor'>,
    ) => number | null;
    isSearchTransactionCurrent?: (transactionId: number) => boolean;
    settleSearchTransaction?: (transactionId: number) => void;
    cancelSearchTransaction?: (transactionId: number) => void;
}

export interface IUsePdfPageRendererOptions {
    container: Ref<HTMLElement | null>;
    document: TPdfDocumentView;
    viewport: TPdfViewportSession;
    isActive?: MaybeRefOrGetter<boolean>;
    searchPageMatches?: MaybeRefOrGetter<Map<number, IPdfPageMatches>>;
    currentSearchMatch?: MaybeRefOrGetter<IPdfSearchMatch | null>;
    currentSearchMatchNavigationId?: MaybeRefOrGetter<number>;
    workingCopyPath?: MaybeRefOrGetter<TDocumentRef | null>;
    documentRevisionToken?: MaybeRefOrGetter<TDocumentRevisionToken | null>;
    onPageLayersCommitted?: (
        signal: {
            kind: 'page-layer-committed';
            pageNumber: TPageNumber;
        },
        fence: IPdfDocumentFence,
    ) => void;
    onRenderedPageStateChanged?: () => void;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
    /** RenderingSession owns the page resources; layer work changes them only as their owner. */
    pageResources: TPdfPageResources;
    /** Shared with the annotation session so link overlays follow renderer page lifetime. */
    linkAnnotations?: Ref<ILinkAnnotation[]> | undefined;
    getCommittedRender: (pageNumber: TPageNumber) => IPdfLayerRenderResult | null;
    requestSearchPageRaster: (pageNumber: TPageNumber, replace?: boolean) => Promise<void>;
}

export interface ICancelableRenderTask {
    cancel: () => void;
    promise: Promise<unknown>;
    onContinue?: IPdfRenderTask['onContinue'];
}

export interface IPdfCanvasDomCommit {
    openSurfaceGeneration: number;
    documentRevision: string;
    renderVersion: number;
    requestId: number;
    pageNumber: TPageNumber;
}

export interface IPdfLayerRenderResult {
    canvas: HTMLCanvasElement;
    viewport: ReturnType<IPdfPage['getViewport']>;
    /** Layout occupied by this raster, captured before asynchronous rendering. */
    layoutViewport?: Pick<IPdfLayerRenderResult['viewport'], 'width' | 'height'> | undefined;
    annotationCanvasMap: Map<string, HTMLCanvasElement> | null;
    scaleX: number;
    scaleY: number;
    rawDims: {
        pageWidth: number;
        pageHeight: number;
    };
    userUnit: number;
    totalScaleFactor: number;
    annotationInput?: IPdfAnnotationRenderInput | undefined;
    annotationOutput?: Readonly<{
        annotationMode: number;
        requestedSeparateCanvas: boolean;
        separateAnnots: unknown;
        ownCanvases: ReadonlyArray<readonly [string, HTMLCanvasElement]>;
    }> | undefined;
}
