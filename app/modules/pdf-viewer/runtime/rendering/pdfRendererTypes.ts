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
    TPdfDocumentSession,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfViewRotation } from '@contracts/shared';
import type { IPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import type { TPdfPageRenderState } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type { ILinkAnnotation } from '@app/types/annotations';
export type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';

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
    document: TPdfDocumentSession;
    viewport: TPdfViewportSession;
    viewRotation?: MaybeRefOrGetter<TPdfViewRotation>;
    isActive?: MaybeRefOrGetter<boolean>;
    outputScale?: MaybeRefOrGetter<number>;
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
    /** RenderingSession owns this state; the post-canvas runtime only derives from it. */
    pageRenderState: TPdfPageRenderState;
    /** Shared with the annotation session so link overlays follow renderer page lifetime. */
    linkAnnotations?: Ref<ILinkAnnotation[]> | undefined;
    getRenderVersion: () => number;
    getRenderDocumentToken: () => string;
    getCommittedCanvas: (pageNumber: TPageNumber) => HTMLCanvasElement | null;
    requestSearchPageRaster: (pageNumber: TPageNumber) => Promise<void>;
}

export interface ICancelableRenderTask {
    cancel: () => void;
    promise: Promise<unknown>;
    onContinue?: IPdfRenderTask['onContinue'];
}

export interface IActivePdfTextLayerTask {
    version: number;
    requestId: number;
    controller: AbortController;
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
    annotationCanvasMap: Map<string, HTMLCanvasElement> | null;
    scaleX: number;
    scaleY: number;
    rawDims: {
        pageWidth: number;
        pageHeight: number;
    };
    userUnit: number;
    totalScaleFactor: number;
}

export interface IPdfPageLayerRenderContext {
    container: HTMLElement;
    pdfPage: IPdfPage;
    renderResult: IPdfLayerRenderResult;
    textLayerDiv: HTMLDivElement | null;
    annotationLayerInstance: unknown;
    preserveCanvasOnStale?: boolean;
}

export type TPdfTextLayerCleanup = () => void;

export type TClearSelectionBeforePageLayerTeardown = (pageNumber: TPageNumber) => boolean;
