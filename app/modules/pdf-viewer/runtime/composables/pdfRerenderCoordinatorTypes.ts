import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import type {
    TFitMode,
    TPdfViewRotation,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import type {
    ICurrentPageSyncOptions,
    IResizeAnchorContext,
} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import type { IBuildResizeAnchorContextOptions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { IZoomViewportAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewerViewportTypes';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import type {
    IPdfViewerTransaction,
    IPdfViewerTransactionFitPlan,
    TPdfViewerTransactionSource,
    TPdfViewerTransactionState,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type { TPdfRerenderSource } from '@app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocol';

export interface IRerenderCoordinatorTransactionController {
    beginTransaction: (options: {
        kind: 'rerender' | 'resize';
        source: TPdfViewerTransactionSource;
        page?: number | null | undefined;
        range?: IPageRange | undefined;
        anchor?: NonNullable<IPdfViewerTransaction['target']>['anchor'];
        fitPlan?: Partial<IPdfViewerTransactionFitPlan> | undefined;
    }) => IPdfViewerTransaction | null;
    advanceTransaction: (
        transactionId: number,
        state: Exclude<TPdfViewerTransactionState, 'preparing' | 'cancelled'>,
    ) => boolean;
    isTransactionCurrent: (transactionId: number) => boolean;
    consumePagedTargetFitRenderHandoff?: ((options: {
        document: IPdfDocument;
        fitMode: TFitMode;
        page: number;
        viewMode: TPdfViewMode;
        continuousScroll: boolean;
        isResizing: boolean;
    }) => IPageRange | null) | undefined;
}

export interface IUsePdfViewerRerenderCoordinatorOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: Ref<IPdfDocument | null>;
    isLoading: Ref<boolean>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    pagedNavigationTargetPage?: Readonly<Ref<number | null>> | undefined;
    navigationAnchorPage?: Readonly<Ref<number | null>> | undefined;
    visibleRange: Ref<IPageRange>;
    commitVisibleRange?: ((range: IPageRange) => boolean | undefined) | undefined;
    zoom: ComputedRef<number>;
    zoomMode?: ComputedRef<TZoomMode> | undefined;
    fitMode: ComputedRef<TFitMode>;
    viewMode: ComputedRef<TPdfViewMode>;
    viewRotation?: ComputedRef<TPdfViewRotation>;
    isResizing: ComputedRef<boolean>;
    continuousScroll: ComputedRef<boolean>;
    getVisibleRange: () => IPageRange;
    reRenderAllVisiblePages: (
        getVisibleRange: () => IPageRange,
        options?: {
            rerenderSource?: TPdfRerenderSource;
            renderBufferOverride?: number | undefined;
        },
    ) => Promise<void>;
    summarizeViewerMetricsForLog: (container: HTMLElement | null) => unknown;
    summarizeVisiblePageSnapshotForLog: (container: HTMLElement | null) => unknown;
    syncCurrentPageFromViewport: (options?: ICurrentPageSyncOptions) => Promise<void>;
    buildResizeAnchorContext: (options?: IBuildResizeAnchorContextOptions) => IResizeAnchorContext;
    /** True applies, false falls back, and null defers to active navigation. */
    applyResizeAnchorPreview?: ((anchor?: IPdfSemanticAnchor | null) => boolean | null) | undefined;
    captureResizeVisualSnapshots?: ((anchor: IResizeAnchorContext) => void) | undefined;
    scheduleEndResizeTransition: (
        token: number,
        reason: string,
        page: number | null,
    ) => void;
    enqueueZoomSync: (syncOptions: ICurrentPageSyncOptions) => void;
    scheduleResizeAwareRerender: (
        stage: string,
        syncOptions?: ICurrentPageSyncOptions,
    ) => void;
    cancelInFlightPageRenders?: (() => Promise<void> | void) | undefined;
    ensurePageMetricsInRange?: ((startPage: number, endPage: number) => Promise<boolean>) | undefined;
    computeFitWidthScale: (
        container: HTMLElement | null,
        options?: { page?: number | null | undefined },
    ) => boolean;
    syncHorizontalScrollForZoomMode?: (() => boolean) | undefined;
    setupPagePlaceholders: () => void;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => unknown;
    getMostVisiblePage: (container: HTMLElement | null, numPages: number) => number;
    resetContinuousScrollState: () => void;
    cancelDestinationNavigationTarget?: (() => void) | undefined;
    resetZoomRerenderQueueState: (reason: string) => void;
    getUserViewportInteractionEpoch?: (() => number) | undefined;
    /**
     * Advances only for scroll the user aimed at the viewport. A fit change
     * rewrites every row's height and the browser answers with its own scroll,
     * which advances the interaction epoch; guarding the fit re-anchor on that
     * epoch makes the command cancel itself.
     */
    getUserPhysicalNavigationEpoch?: (() => number) | undefined;
    /**
     * Opens a window in which viewer-authored layout replacement, not the user,
     * owns any scroll the browser emits. Returns the closer.
     */
    beginLayoutGeometryReplacement?: (() => () => void) | undefined;
    consumeZoomViewportAnchor?: (() => IZoomViewportAnchor | null) | undefined;
    submitZoomViewportStateIntent?: ((zoom: number) => void) | undefined;
    beginResizeTransition: (source: string, anchorPage: number | null) => number;
    consumeSuppressedZoomRerender?: ((nextZoom: number) => boolean) | undefined;
    transactionController?: IRerenderCoordinatorTransactionController | undefined;
}
