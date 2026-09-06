import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type {TFitMode} from '@app/types/pdfContracts';
import type { TPdfViewMode } from '@contracts/shared';
import type { IPageRange } from '@app/types/pdfUi';
import type { IPdfNavigationState } from '@app/modules/pdf-viewer/runtime/navigation/createPdfNavigationMachineState';
import type {
    IPdfViewerTransaction,
    IPdfViewerTransactionBeginEvent,
    IPdfViewerTransactionCancellation,
    IPdfViewerTransactionDocumentRef,
    IPdfViewerTransactionFitPlan,
    IPdfViewerTransactionRenderRequest,
    IPdfViewerTransactionScrollPlan,
    TPdfViewerTransactionKind,
    TPdfViewerTransactionSource,
    TPdfViewerTransactionState,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import { DEFAULT_PDF_VIEWER_TRANSACTION_FIT_PLAN } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import {
    canPdfViewerTransactionSupersede,
    createPdfViewerTransactionMachineState,
    reducePdfViewerTransactionMachine,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionReducer';
import {
    createPdfViewerTransactionSinglePageRange,
    doPdfViewerTransactionRangesIntersect,
    getPdfViewerTransactionRowRange,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionRange';
import { isPdfViewerPagedTargetFitRenderHandoffConsumable } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/isPdfViewerPagedTargetFitRenderHandoffConsumable';

interface IUsePdfViewerTransactionControllerOptions {
    navigationState: Ref<IPdfNavigationState>;
    currentPage: Ref<number>;
    visibleRange: Ref<IPageRange>;
    numPages: Ref<number>;
    viewMode: Ref<TPdfViewMode>;
    pdfDocument: ShallowRef<IPdfDocument | null>;
    userViewportInteractionEpoch: Ref<number>;
    getDocumentLoadToken?: (() => number) | undefined;
    getDocumentVersion?: (() => number) | undefined;
    executeCancellationEffects?: ((cancellation: IPdfViewerTransactionCancellation) => void) | undefined;
}

interface IPdfViewerTransactionCommitOptions {transactionId?: number | undefined;}

interface IPdfViewerBeginTransactionOptions {
    kind: TPdfViewerTransactionKind;
    source: TPdfViewerTransactionSource;
    page?: number | null | undefined;
    range?: IPageRange | null | undefined;
    anchor?: NonNullable<IPdfViewerTransaction['target']>['anchor'];
    markerRect?: NonNullable<IPdfViewerTransaction['target']>['markerRect'] | undefined;
    fitPlan?: Partial<IPdfViewerTransactionFitPlan> | undefined;
    scrollPlan?: IPdfViewerTransactionScrollPlan | null | undefined;
    state?: TPdfViewerTransactionState | undefined;
}

interface IPdfViewerConsumePagedTargetFitRenderHandoffOptions {
    document: IPdfDocument;
    fitMode: TFitMode;
    page: number;
    viewMode: TPdfViewMode;
    continuousScroll: boolean;
    isResizing: boolean;
}

function mapNavigationSourceToTransactionSource(
    source: IPdfNavigationState['source'],
): TPdfViewerTransactionSource {
    switch (source) {
        case 'paged':
            return 'paged-navigation';
        case 'continuous':
            return 'continuous-navigation';
        case 'search':
            return 'search-navigation';
        case 'wheel':
            return 'wheel-navigation';
        default:
            return 'public-scroll';
    }
}

function mapNavigationSourceToTransactionKind(
    source: IPdfNavigationState['source'],
): TPdfViewerTransactionKind {
    return source === 'search' ? 'search' : 'navigation';
}

export const usePdfViewerTransactionController = (
    options: IUsePdfViewerTransactionControllerOptions,
) => {
    const transactionMachineState = shallowRef(createPdfViewerTransactionMachineState());
    const documentRef = computed<IPdfViewerTransactionDocumentRef>(() => ({
        document: options.pdfDocument.value,
        documentLoadToken: options.getDocumentLoadToken?.() ?? 0,
        documentVersion: options.getDocumentVersion?.() ?? 0,
    }));

    const navigationTransaction = computed<IPdfViewerTransaction | null>(() => {
        const navigationState = options.navigationState.value;
        if (
            navigationState.status === 'idle'
            || navigationState.targetPage === null
        ) {
            return null;
        }

        const range = navigationState.source === 'paged'
            ? getPdfViewerTransactionRowRange({
                pageNumber: navigationState.targetPage,
                totalPages: options.numPages.value,
                viewMode: options.viewMode.value,
            })
            : createPdfViewerTransactionSinglePageRange(
                navigationState.targetPage,
                options.numPages.value,
            );

        return {
            id: navigationState.txn,
            kind: mapNavigationSourceToTransactionKind(navigationState.source),
            source: mapNavigationSourceToTransactionSource(navigationState.source),
            state: navigationState.status === 'settling'
                ? 'scroll-applied'
                : 'preparing',
            documentRef: documentRef.value,
            target: {
                page: navigationState.targetPage,
                range,
                anchor: navigationState.anchor,
            },
            fitPlan: DEFAULT_PDF_VIEWER_TRANSACTION_FIT_PLAN,
            scrollPlan: {
                preferExactDom: navigationState.source !== 'continuous',
                commitCurrentPageOnScroll: true,
                suppressSnapAfterScroll: navigationState.source !== 'continuous',
                holdProgrammaticNavigationMs: 0,
            },
            renderRequest: null,
            createdAtMs: 0,
            userViewportInteractionEpoch: options.userViewportInteractionEpoch.value,
            cancellation: null,
        };
    });

    const activeTransaction = computed<IPdfViewerTransaction | null>(() => (
        navigationTransaction.value ?? transactionMachineState.value.active
    ));
    const targetPage = computed(() => activeTransaction.value?.target?.page ?? null);
    const targetRange = computed(() => activeTransaction.value?.target?.range ?? null);
    const transactionState = computed(() => transactionMachineState.value);
    const diagnostics = computed(() => ({
        activeTransaction: activeTransaction.value,
        targetPage: targetPage.value,
        targetRange: targetRange.value,
        visibleRange: options.visibleRange.value,
        currentPage: options.currentPage.value,
        transactionState: transactionState.value,
    }));

    function normalizePageNumber(pageNumber: number | null | undefined) {
        const fallbackPage = Number.isFinite(options.currentPage.value)
            ? options.currentPage.value
            : 1;
        const nextPage = typeof pageNumber === 'number' && Number.isFinite(pageNumber)
            ? pageNumber
            : fallbackPage;
        const totalPages = Math.max(1, options.numPages.value);
        return Math.min(Math.max(1, Math.trunc(nextPage)), totalPages);
    }

    function normalizeRange(pageNumber: number, range: IPageRange | null | undefined) {
        if (
            range
            && Number.isFinite(range.start)
            && Number.isFinite(range.end)
            && range.start <= range.end
        ) {
            return {
                start: Math.max(1, Math.trunc(range.start)),
                end: Math.min(Math.max(1, options.numPages.value), Math.trunc(range.end)),
            };
        }
        return createPdfViewerTransactionSinglePageRange(
            pageNumber,
            options.numPages.value,
        );
    }

    function createTransactionFromOptions(
        beginOptions: IPdfViewerBeginTransactionOptions,
    ): IPdfViewerTransactionBeginEvent['transaction'] {
        const page = normalizePageNumber(beginOptions.page);
        const range = normalizeRange(page, beginOptions.range);
        return {
            kind: beginOptions.kind,
            source: beginOptions.source,
            state: beginOptions.state ?? 'preparing',
            documentRef: documentRef.value,
            target: {
                page,
                range,
                anchor: beginOptions.anchor ?? null,
                ...(beginOptions.markerRect !== undefined
                    ? { markerRect: beginOptions.markerRect }
                    : {}),
            },
            fitPlan: {
                ...DEFAULT_PDF_VIEWER_TRANSACTION_FIT_PLAN,
                ...beginOptions.fitPlan,
            },
            scrollPlan: beginOptions.scrollPlan === undefined
                ? null
                : beginOptions.scrollPlan,
            renderRequest: null,
            createdAtMs: Date.now(),
            userViewportInteractionEpoch: options.userViewportInteractionEpoch.value,
        };
    }

    function dispatchTransactionEvent(
        event: Parameters<typeof reducePdfViewerTransactionMachine>[1],
    ) {
        const previousActiveId = transactionMachineState.value.active?.id ?? null;
        const previousCancelledCount = transactionMachineState.value.cancelled.length;
        transactionMachineState.value = reducePdfViewerTransactionMachine(
            transactionMachineState.value,
            event,
        );
        if (
            event.type === 'CANCEL'
            && (
                previousActiveId === null
                || event.transactionId === undefined
                || event.transactionId === previousActiveId
            )
        ) {
            options.executeCancellationEffects?.(event.cancellation);
            return;
        }
        const cancelled = transactionMachineState.value.cancelled;
        if (cancelled.length > previousCancelledCount) {
            const cancellation = cancelled.at(-1)?.cancellation;
            if (cancellation) {
                options.executeCancellationEffects?.(cancellation);
            }
        }
    }

    function beginTransaction(beginOptions: IPdfViewerBeginTransactionOptions) {
        const transaction = createTransactionFromOptions(beginOptions);
        const active = activeTransaction.value;
        if (
            transactionMachineState.value.active === null
            && !canPdfViewerTransactionSupersede(active, {
                kind: transaction.kind,
                renderRequest: transaction.renderRequest ?? null,
            })
        ) {
            return null;
        }

        const previousActiveId = transactionMachineState.value.active?.id ?? null;
        dispatchTransactionEvent({
            type: 'BEGIN',
            transaction,
        });

        const activeAfterBegin = transactionMachineState.value.active;
        if (!activeAfterBegin || activeAfterBegin.id === previousActiveId) {
            return null;
        }
        return activeAfterBegin;
    }

    function advanceTransaction(
        transactionId: number,
        state: Exclude<TPdfViewerTransactionState, 'preparing' | 'cancelled'>,
        renderRequest?: IPdfViewerTransactionRenderRequest | null | undefined,
    ) {
        dispatchTransactionEvent({
            type: 'ADVANCE',
            transactionId,
            state,
            ...(renderRequest !== undefined ? { renderRequest } : {}),
        });
        return isTransactionCurrent(transactionId);
    }

    function cancelActiveTransaction(
        cancellation: IPdfViewerTransactionCancellation,
        transactionId?: number | undefined,
    ) {
        dispatchTransactionEvent({
            type: 'CANCEL',
            ...(transactionId !== undefined ? { transactionId } : {}),
            cancellation,
        });
        return transactionMachineState.value.active === null;
    }

    watch(navigationTransaction, (navigation) => {
        if (!navigation || transactionMachineState.value.active === null) {
            return;
        }
        cancelActiveTransaction({
            reason: 'superseded',
            cancelInFlightRenders: true,
            bumpRenderVersion: true,
            preserveVisualContent: true,
        });
    }, {flush: 'sync'});

    function isTransactionCurrent(transactionId: number) {
        return activeTransaction.value?.id === transactionId;
    }

    function isTargetRangeCurrent(range: IPageRange) {
        const activeRange = targetRange.value;
        if (!activeRange) {
            return doPdfViewerTransactionRangesIntersect(range, options.visibleRange.value);
        }
        return doPdfViewerTransactionRangesIntersect(range, activeRange);
    }

    function commitVisibleRange(
        range: IPageRange,
        commitOptions: Pick<IPdfViewerTransactionCommitOptions, 'transactionId'> = {},
    ) {
        if (commitOptions.transactionId !== undefined && !isTransactionCurrent(commitOptions.transactionId)) {
            return false;
        }
        options.visibleRange.value = range;
        return true;
    }

    function toTransactionFitMode(fitMode: TFitMode) {
        return fitMode === 'height' ? 'fit-height' as const : 'fit-width' as const;
    }

    function consumePagedTargetFitRenderHandoff(
        consumeOptions: IPdfViewerConsumePagedTargetFitRenderHandoffOptions,
    ) {
        if (consumeOptions.continuousScroll || consumeOptions.isResizing) {
            return null;
        }

        const currentDocumentRef = documentRef.value;
        const matchOptions = {
            document: consumeOptions.document,
            documentLoadToken: currentDocumentRef.documentLoadToken,
            documentVersion: currentDocumentRef.documentVersion,
            fitMode: toTransactionFitMode(consumeOptions.fitMode),
            page: consumeOptions.page,
            viewMode: consumeOptions.viewMode,
        };
        // A settled transaction no longer has an interaction/render freshness
        // boundary. Only a live transaction may transfer its fit render.
        const candidate = transactionMachineState.value.active;
        const transaction = isPdfViewerPagedTargetFitRenderHandoffConsumable(candidate, matchOptions)
            ? candidate
            : null;
        const range = transaction?.fitPlan.hydrateRange ?? null;
        if (!transaction || !range) {
            return null;
        }

        dispatchTransactionEvent({
            type: 'CONSUME_FIT_RENDER_HANDOFF',
            transactionId: transaction.id,
        });
        return range;
    }

    return {
        activeTransaction,
        targetPage,
        targetRange,
        diagnostics,
        transactionState,
        beginTransaction,
        advanceTransaction,
        cancelActiveTransaction,
        isTransactionCurrent,
        isTargetRangeCurrent,
        commitVisibleRange,
        consumePagedTargetFitRenderHandoff,
    };
};
