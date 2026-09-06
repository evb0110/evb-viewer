import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { usePdfViewerTransactionController } from '@app/modules/pdf-viewer/runtime/transactions/usePdfViewerTransactionController';
import type { IPdfNavigationState } from '@app/modules/pdf-viewer/runtime/navigation/createPdfNavigationMachineState';
import { cast } from '@tests/helpers/cast';

function createNavigationState(overrides: Partial<IPdfNavigationState> = {}) {
    return shallowRef<IPdfNavigationState>({
        anchor: 'top',
        currentPage: 1,
        source: 'paged',
        status: 'navigating',
        targetPage: 3,
        txn: 7,
        ...overrides,
    });
}

describe('usePdfViewerTransactionController', () => {
    it('exposes active navigation transaction diagnostics', () => {
        const controller = usePdfViewerTransactionController({
            navigationState: createNavigationState(),
            currentPage: ref(1),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            numPages: ref(10),
            viewMode: ref('single'),
            pdfDocument: shallowRef(null),
            userViewportInteractionEpoch: ref(2),
        });

        expect(controller.activeTransaction.value).toMatchObject({
            id: 7,
            kind: 'navigation',
            source: 'paged-navigation',
            target: {
                page: 3,
                range: {
                    start: 3,
                    end: 3,
                },
            },
            userViewportInteractionEpoch: 2,
        });
    });

    it('commits visible range only for the active transaction id', () => {
        const currentPage = ref(1);
        const visibleRange = ref({
            start: 1,
            end: 1,
        });
        const controller = usePdfViewerTransactionController({
            navigationState: createNavigationState(),
            currentPage,
            visibleRange,
            numPages: ref(10),
            viewMode: ref('single'),
            pdfDocument: shallowRef(null),
            userViewportInteractionEpoch: ref(0),
        });

        expect(controller.commitVisibleRange({
            start: 3,
            end: 3,
        }, { transactionId: 99 })).toBe(false);
        expect(visibleRange.value).toEqual({
            start: 1,
            end: 1,
        });

        expect(controller.commitVisibleRange({
            start: 3,
            end: 3,
        }, { transactionId: 7 })).toBe(true);
        expect(visibleRange.value).toEqual({
            start: 3,
            end: 3,
        });

    });

    it('does not let recovery producer transactions supersede active navigation', () => {
        const controller = usePdfViewerTransactionController({
            navigationState: createNavigationState(),
            currentPage: ref(1),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            numPages: ref(10),
            viewMode: ref('single'),
            pdfDocument: shallowRef(null),
            userViewportInteractionEpoch: ref(0),
        });

        const recoveryTransaction = controller.beginTransaction({
            kind: 'recovery',
            source: 'render-stall-recovery',
            page: 4,
        });

        expect(recoveryTransaction).toBeNull();
        expect(controller.activeTransaction.value).toMatchObject({
            id: 7,
            kind: 'navigation',
            source: 'paged-navigation',
        });
    });

    it('lets a newer navigation supersede an active zoom transaction', () => {
        const navigationState = createNavigationState({
            status: 'idle',
            targetPage: null,
        });
        const controller = usePdfViewerTransactionController({
            navigationState,
            currentPage: ref(1),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            numPages: ref(10),
            viewMode: ref('single'),
            pdfDocument: shallowRef(null),
            userViewportInteractionEpoch: ref(0),
        });

        expect(controller.beginTransaction({
            kind: 'zoom',
            source: 'zoom-change',
            page: 1,
        })).not.toBeNull();

        navigationState.value = {
            ...createNavigationState().value,
            targetPage: 6,
            txn: 12,
        };

        expect(controller.activeTransaction.value).toMatchObject({
            id: 12,
            kind: 'navigation',
            target: {page: 6},
        });
        expect(controller.transactionState.value.active).toBeNull();
        expect(controller.transactionState.value.cancelled.at(-1)).toMatchObject({
            kind: 'zoom',
            cancellation: {reason: 'superseded'},
        });
    });

    it('records cancellation metadata for active producer transactions', () => {
        const executeCancellationEffects = vi.fn();
        const controller = usePdfViewerTransactionController({
            navigationState: createNavigationState({
                status: 'idle',
                targetPage: null,
            }),
            currentPage: ref(1),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            numPages: ref(10),
            viewMode: ref('single'),
            pdfDocument: shallowRef(null),
            userViewportInteractionEpoch: ref(0),
            executeCancellationEffects,
        });

        const transaction = controller.beginTransaction({
            kind: 'reload',
            source: 'reload',
            page: 1,
        });

        expect(transaction?.id).toBe(1);
        expect(controller.cancelActiveTransaction({
            reason: 'reload',
            cancelInFlightRenders: true,
            bumpRenderVersion: true,
            preserveVisualContent: true,
        })).toBe(true);
        expect(executeCancellationEffects).toHaveBeenCalledWith(expect.objectContaining({
            cancelInFlightRenders: true,
            bumpRenderVersion: true,
        }));
        expect(controller.transactionState.value.renderVersion).toBe(1);
        expect(controller.transactionState.value.cancelled[0]).toMatchObject({
            id: 1,
            state: 'cancelled',
            cancellation: {
                reason: 'reload',
                bumpRenderVersion: true,
            },
        });
    });

    it('consumes active and settled paged-target fit render handoffs once', () => {
        const document = cast<IPdfDocument>({});
        const controller = usePdfViewerTransactionController({
            navigationState: createNavigationState({
                status: 'idle',
                targetPage: null,
            }),
            currentPage: ref(1),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            numPages: ref(10),
            viewMode: ref('single'),
            pdfDocument: shallowRef(document),
            userViewportInteractionEpoch: ref(0),
            getDocumentVersion: () => 3,
        });

        const activeTransaction = controller.beginTransaction({
            kind: 'rerender',
            source: 'fit-paged-target',
            page: 4,
            range: {
                start: 4,
                end: 5,
            },
            fitPlan: {
                mode: 'fit-height',
                scalePage: 4,
                hydrateRange: {
                    start: 4,
                    end: 5,
                },
                viewMode: 'facing',
                pagedTargetRenderHandoff: 'pending',
            },
        });

        expect(controller.advanceTransaction(activeTransaction?.id ?? 0, 'render-requested')).toBe(true);
        expect(controller.consumePagedTargetFitRenderHandoff({
            document,
            fitMode: 'height',
            page: 4,
            viewMode: 'facing',
            continuousScroll: false,
            isResizing: false,
        })).toEqual({
            start: 4,
            end: 5,
        });
        expect(controller.consumePagedTargetFitRenderHandoff({
            document,
            fitMode: 'height',
            page: 4,
            viewMode: 'facing',
            continuousScroll: false,
            isResizing: false,
        })).toBeNull();

        const settledTransaction = controller.beginTransaction({
            kind: 'rerender',
            source: 'fit-paged-target',
            page: 6,
            range: {
                start: 6,
                end: 6,
            },
            fitPlan: {
                mode: 'fit-width',
                scalePage: 6,
                hydrateRange: {
                    start: 6,
                    end: 6,
                },
                viewMode: 'single',
                pagedTargetRenderHandoff: 'pending',
            },
        });
        controller.advanceTransaction(settledTransaction?.id ?? 0, 'settled');
        expect(controller.consumePagedTargetFitRenderHandoff({
            document,
            fitMode: 'width',
            page: 6,
            viewMode: 'single',
            continuousScroll: false,
            isResizing: false,
        })).toBeNull();
    });
});
