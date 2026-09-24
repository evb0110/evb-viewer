import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import { DEFERRED_WORKSPACE_HOST_POLICY } from '@app/modules/workspace-shell/host/deferredWorkspaceHostPolicy';
import type {IDocumentOpenSurfaceSession} from '@app/modules/document-viewer/public';

interface IUseDocumentOpenVisualSettleOptions {
    tabId: string;
    hasPdf: Ref<boolean>;
    pdfSrc: Ref<unknown>;
    pdfDocument: Ref<unknown>;
    totalPages: Ref<number>;
    pageLabelsResolved: Ref<boolean>;
    isLoading: Ref<boolean>;
    pdfError: Ref<unknown>;
    djvuError: Ref<unknown>;
    showDjvuSource: Ref<boolean>;
    openSurface: Pick<IDocumentOpenSurfaceSession, 'snapshot' | 'viewportSession'>;
    markAnnotationCommentsLoading: () => void;
}

export const useDocumentOpenVisualSettle = (options: IUseDocumentOpenVisualSettleOptions) => {
    const committedInitialVisualIdentity = shallowRef<{
        documentId: string;
        documentRevision: string;
        generation: number;
    } | null>(null);
    watch(
        [
            options.openSurface.snapshot,
            options.openSurface.viewportSession,
        ],
        ([
            surface,
            viewport,
        ]) => {
            const identity = surface.identity;
            if (
                identity === null
                || surface.phase !== 'ready'
                || surface.presentation !== 'committed'
                || viewport.lifecycle !== 'ready'
            ) {
                return;
            }
            const committed = committedInitialVisualIdentity.value;
            if (
                committed?.generation === surface.generation
                && committed.documentId === identity.documentId
                && committed.documentRevision === identity.documentRevision
            ) {
                return;
            }
            committedInitialVisualIdentity.value = {
                generation: surface.generation,
                documentId: identity.documentId,
                documentRevision: identity.documentRevision,
            };
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );
    const initialDocumentVisualReady = computed(() => {
        const surface = options.openSurface.snapshot.value;
        const identity = surface.identity;
        const committed = committedInitialVisualIdentity.value;
        // Initial readiness belongs to the document generation, not to every
        // transient viewport state. A normal page command changes the viewport
        // lifecycle to `transitioning`; allowing that to clear this signal
        // makes the host mistake navigation for a fresh document open and
        // replace the resident canvas with an opening skeleton. The latch only
        // holds while a resident visual exists: when the committed page's own
        // visual degrades to a skeleton (a budget eviction of the on-screen
        // canvas), there is nothing left to protect and readiness must drop
        // until the replacement paint settles. A skeleton for a different page
        // is ordinary navigation - the resident canvas was superseded, not
        // lost - and must not clear the latch.
        const viewport = options.openSurface.viewportSession.value;
        const visual = viewport.visual;
        const residentVisualLost = visual.kind === 'page'
            && visual.presentation === 'skeleton'
            && (viewport.committedPage === null || visual.pageNumber === viewport.committedPage);
        return identity !== null
            && committed?.generation === surface.generation
            && committed.documentId === identity.documentId
            && committed.documentRevision === identity.documentRevision
            && !residentVisualLost;
    });
    let documentOpenVisualSettlePromise: Promise<void> | null = null;
    let resolveDocumentOpenVisualSettlePromise: (() => void) | null = null;
    let documentOpenAcceptedPromise: Promise<void> | null = null;
    let resolveDocumentOpenAcceptedPromise: (() => void) | null = null;

    function ensureDocumentOpenVisualSettlePromise() {
        documentOpenVisualSettlePromise ??= new Promise<void>((resolve) => {
            resolveDocumentOpenVisualSettlePromise = resolve;
        });

        return documentOpenVisualSettlePromise;
    }

    function resolveDocumentOpenVisualSettle() {
        resolveDocumentOpenVisualSettlePromise?.();
        documentOpenVisualSettlePromise = null;
        resolveDocumentOpenVisualSettlePromise = null;
    }

    function ensureDocumentOpenAcceptedPromise() {
        documentOpenAcceptedPromise ??= new Promise<void>((resolve) => {
            resolveDocumentOpenAcceptedPromise = resolve;
        });

        return documentOpenAcceptedPromise;
    }

    function resolveDocumentOpenAccepted() {
        resolveDocumentOpenAcceptedPromise?.();
        documentOpenAcceptedPromise = null;
        resolveDocumentOpenAcceptedPromise = null;
    }

    function hasSettledDocumentOpenVisualState() {
        if (options.pdfError.value || options.djvuError.value) {
            return true;
        }

        if (options.showDjvuSource.value) {
            return Boolean(
                !options.isLoading.value
                && initialDocumentVisualReady.value,
            );
        }

        return Boolean(
            options.pdfSrc.value
            && options.pdfDocument.value
            && options.totalPages.value > 0
            && !options.isLoading.value
            && initialDocumentVisualReady.value,
        );
    }

    function hasAcceptedDocumentOpenState() {
        if (options.pdfError.value || options.djvuError.value) {
            return true;
        }

        if (options.showDjvuSource.value) {
            return Boolean(
                !options.isLoading.value
                && options.totalPages.value > 0,
            );
        }

        return Boolean(
            options.pdfSrc.value
            && options.pdfDocument.value
            && options.totalPages.value > 0
            && !options.isLoading.value,
        );
    }

    function resolveDocumentOpenVisualSettleIfReady() {
        if (hasAcceptedDocumentOpenState()) {
            resolveDocumentOpenAccepted();
        }
        if (hasSettledDocumentOpenVisualState()) {
            resolveDocumentOpenVisualSettle();
        }
    }

    function handlePdfInitialVisualReady() {
        resolveDocumentOpenVisualSettleIfReady();
    }

    function handlePdfInitialVisualPending() {
        options.markAnnotationCommentsLoading();
    }

    function createDocumentOpenVisualSettleTimeout() {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const promise = new Promise<'timeout'>((resolve) => {
            timeoutId = setTimeout(() => {
                timeoutId = null;
                resolve('timeout');
            }, DEFERRED_WORKSPACE_HOST_POLICY.DOCUMENT_OPEN_SETTLE_TIMEOUT_MS);
        });

        return {
            promise,
            cancel: () => {
                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
            },
        };
    }

    async function waitForDocumentOpenSettled(waitOptions?: {
        acceptDocumentWithoutVisual?: boolean;
        signal?: AbortSignal;
    }) {
        const signal = waitOptions?.signal;
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new DOMException('Document open canceled', 'AbortError');
        }
        await nextTick();
        resolveDocumentOpenVisualSettleIfReady();
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new DOMException('Document open canceled', 'AbortError');
        }
        const acceptDocumentWithoutVisual = waitOptions?.acceptDocumentWithoutVisual === true;
        const hasRequiredState = () => acceptDocumentWithoutVisual
            ? hasAcceptedDocumentOpenState()
            : hasSettledDocumentOpenVisualState();
        if (hasRequiredState()) {
            return;
        }

        const timeout = createDocumentOpenVisualSettleTimeout();
        let resolveAbort: (() => void) | null = null;
        const abortPromise = new Promise<'aborted'>((resolve) => {
            resolveAbort = () => resolve('aborted');
            signal?.addEventListener('abort', resolveAbort, {once: true});
        });
        const settleResult = await Promise.race([
            (
                acceptDocumentWithoutVisual
                    ? ensureDocumentOpenAcceptedPromise()
                    : ensureDocumentOpenVisualSettlePromise()
            ).then(() => 'settled' as const),
            timeout.promise,
            abortPromise,
        ]).finally(() => {
            timeout.cancel();
            if (resolveAbort) {
                signal?.removeEventListener('abort', resolveAbort);
            }
        });
        await nextTick();

        if (settleResult === 'aborted') {
            throw signal?.reason instanceof Error
                ? signal.reason
                : new DOMException('Document open canceled', 'AbortError');
        }

        if (hasRequiredState()) {
            return;
        }

        if (settleResult !== 'timeout') {
            return;
        }

        const error = new Error('Document open visual settle timed out');
        const openSurface = options.openSurface.snapshot.value;
        BrowserLogger.warn('recent-open', error.message, {
            tabId: options.tabId,
            hasPdf: options.hasPdf.value,
            hasPdfSrc: Boolean(options.pdfSrc.value),
            hasPdfDocument: Boolean(options.pdfDocument.value),
            totalPages: options.totalPages.value,
            pageLabelsResolved: options.pageLabelsResolved.value,
            isLoading: options.isLoading.value,
            showDjvuSource: options.showDjvuSource.value,
            hasPdfError: Boolean(options.pdfError.value),
            hasDjvuError: Boolean(options.djvuError.value),
            initialVisualReady: initialDocumentVisualReady.value,
            openSurface: {
                generation: openSurface.generation,
                phase: openSurface.phase,
                presentation: openSurface.presentation,
                committedRender: openSurface.committedRender ? {
                    pageNumber: openSurface.committedRender.pageNumber,
                    documentRevision: openSurface.committedRender.documentRevision,
                    renderVersion: openSurface.committedRender.renderVersion,
                    requestId: openSurface.committedRender.requestId,
                } : null,
                committedViewport: openSurface.committedViewport ? {
                    pageNumber: openSurface.committedViewport.pageNumber,
                    documentRevision: openSurface.committedViewport.documentRevision,
                    viewportIntentId: openSurface.committedViewport.viewportIntentId,
                    documentGeometryRevision: openSurface.committedViewport.documentGeometryRevision,
                    interactionEpoch: openSurface.committedViewport.interactionEpoch,
                } : null,
            },
            viewportSession: options.openSurface.viewportSession.value,
            lifecycleHistory: (options.openSurface as IDocumentOpenSurfaceSession).getDiagnosticHistory(),
        });
        throw error;
    }

    watch([
        options.pdfDocument,
        options.totalPages,
        options.pageLabelsResolved,
        options.isLoading,
        options.pdfError,
        options.djvuError,
        options.showDjvuSource,
        initialDocumentVisualReady,
        options.openSurface.snapshot,
    ], () => {
        resolveDocumentOpenVisualSettleIfReady();
    });

    return {
        handlePdfInitialVisualPending,
        handlePdfInitialVisualReady,
        initialDocumentVisualReady,
        resolveDocumentOpenVisualSettleIfReady,
        waitForDocumentOpenSettled,
    };
};
