import type { Ref } from 'vue';
import {useResizeObserver} from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { pdfViewerDomClasses } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomClasses';
import { preservePdfResizeCanvasVisualSnapshot } from '@app/modules/pdf-viewer/engine/pdf-resize-visual-snapshot/preservePdfResizeCanvasVisualSnapshot';
import { schedulePdfResizeCanvasVisualSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-resize-visual-snapshot/schedulePdfResizeCanvasVisualSnapshotRelease';
import type {
    ICurrentPageSyncOptions,
    IResizeAnchorContext,
    summarizeViewerMetrics,
} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import { PDF_RERENDER_SOURCE } from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';
import type {
    IPdfViewerTransaction,
    IPdfViewerTransactionCancellation,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import {
    PDF_RESIZE_DRAG_SETTLE_MS,
    PDF_RESIZE_RERENDER_DEBOUNCE_MS,
    PDF_RESIZE_TRANSITION_HIDE_MS,
} from '@app/constants/timeouts';
import { delay } from 'es-toolkit/promise';
import type { IPdfResizeCanvasVisualSnapshot } from '@app/modules/pdf-viewer/engine/pdf-resize-visual-snapshot/preservePdfResizeCanvasVisualSnapshot';

type TViewerMetrics = ReturnType<typeof summarizeViewerMetrics>;

export interface IBuildResizeAnchorContextOptions {
    preferredAnchorPage?: number | null;
    trustPreferredAnchorPage?: boolean;
}

interface IUsePdfViewerResizeLifecycleOptions {
    submitResizeIntent: (anchor?: IPdfSemanticAnchor | null) => void;
    applyResizeAnchorPreview?: ((anchor?: IPdfSemanticAnchor | null) => boolean | null) | undefined;
    captureViewportAnchor?: (() => IPdfSemanticAnchor | null) | undefined;
    viewerContainer: Ref<HTMLElement | null>;
    isLoading: Ref<boolean>;
    isActive?: Ref<boolean> | undefined;
    isResizing: Ref<boolean>;
    pdfDocument: Ref<unknown | null>;
    currentPage: Ref<number>;
    pendingNavigationAnchorPage?: Readonly<Ref<number | null>> | undefined;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    numPages: Ref<number>;
    computeFitWidthScale: (
        container: HTMLElement | null,
        options?: {
            page?: number | null;
            preview?: boolean
        },
    ) => boolean;
    settlePreviewFitScale?: ((commit?: boolean) => boolean) | undefined;
    getMostVisiblePage: (container: HTMLElement | null, numPages: number) => number;
    summarizeViewerMetricsForLog: (container: HTMLElement | null) => TViewerMetrics;
    summarizeVisiblePageSnapshotForLog: (container: HTMLElement | null) => unknown;
    scheduleResizeAwareRerender: (
        stage: string,
        syncOptions?: ICurrentPageSyncOptions,
    ) => void;
    setResizeTransitionVisible?: ((payload: {
        active: boolean;
        source: string;
        token: number;
        anchorPage: number | null;
    }) => void) | undefined;
    transactionController?: IResizeLifecycleTransactionController | undefined;
}

interface IResizeLifecycleTransactionController {
    activeTransaction?: Readonly<Ref<Pick<IPdfViewerTransaction, 'kind'> | null>> | undefined;
    beginTransaction: (options: {
        kind: 'resize';
        source: 'resize-observer' | 'resize-settle';
        page?: number | null | undefined;
        range?: IResizeAnchorContext['visibleRange'] | undefined;
        anchor?: NonNullable<IPdfViewerTransaction['target']>['anchor'];
    }) => IPdfViewerTransaction | null;
    cancelActiveTransaction: (
        cancellation: IPdfViewerTransactionCancellation,
        transactionId?: number | undefined,
    ) => boolean;
    isTransactionCurrent: (transactionId: number) => boolean;
}

interface IActiveResizeVisualSnapshotLease {
    document: unknown;
    holdForMs: number;
    lastCaptureAtMs: number;
    pageContainer: HTMLElement;
    released: boolean;
    snapshot: IPdfResizeCanvasVisualSnapshot;
    cancelRelease: () => void;
}

// The snapshot exists to hide a blank page while the resize re-renders. If
// that never lands, showing the stale image forever is worse than showing the
// real state, so the lease expires whether or not waitFor ever goes true.
const PDF_RESIZE_VISUAL_SNAPSHOT_MAX_DELAY_MS = 2_500;

export const usePdfViewerResizeLifecycle = (options: IUsePdfViewerResizeLifecycleOptions) => {
    const {
        viewerContainer,
        isLoading,
        isActive,
        isResizing,
        pdfDocument,
        currentPage,
        visibleRange,
        numPages,
        computeFitWidthScale,
        summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog,
        scheduleResizeAwareRerender,
        setResizeTransitionVisible,
    } = options;

    const ZOOM_QUEUE_LOG_THROTTLE_MS = 420;
    let resizeTransitionToken = 0;
    let pendingResizeTransitionHideTimer: ReturnType<typeof setTimeout> | null = null;
    const activeResizeVisualSnapshots = new Map<number, IActiveResizeVisualSnapshotLease>();
    let pendingResizeAnchor: IResizeAnchorContext | null = null;
    let pendingResizeTransactionId: number | null = null;
    let dragResizeAnchor: IResizeAnchorContext | null = null;
    let dragSettleRunId = 0;
    let dragSettleClaimed = false;
    let dragSettleClaimReleaseTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingResizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingTransactionOwnedResize = false;
    let lastObservedViewportSize: {
        width: number;
        height: number
    } | null = null;

    function readViewportSize() {
        const container = viewerContainer.value;
        return container
            ? {
                width: container.clientWidth,
                height: container.clientHeight,
            }
            : null;
    }

    function consumeViewportGeometryChange() {
        const nextSize = readViewportSize();
        const previousSize = lastObservedViewportSize;
        lastObservedViewportSize = nextSize;
        return !nextSize
            || !previousSize
            || nextSize.width !== previousSize.width
            || nextSize.height !== previousSize.height;
    }

    lastObservedViewportSize = readViewportSize();

    function beginResizeTransaction(
        anchor: IResizeAnchorContext,
        source: 'resize-observer' | 'resize-settle',
    ) {
        const transaction = options.transactionController?.beginTransaction({
            kind: 'resize',
            source,
            page: anchor.page,
            range: anchor.visibleRange,
            anchor: 'center',
        }) ?? null;
        pendingResizeTransactionId = transaction?.id ?? null;
        return pendingResizeTransactionId;
    }

    function cancelPendingResizeTransaction(reason: IPdfViewerTransactionCancellation['reason']) {
        if (pendingResizeTransactionId === null) {
            return;
        }
        options.transactionController?.cancelActiveTransaction({
            reason,
            cancelInFlightRenders: true,
            bumpRenderVersion: reason === 'resize',
            preserveVisualContent: true,
        }, pendingResizeTransactionId);
        pendingResizeTransactionId = null;
    }

    function emitResizeTransitionSignal(
        active: boolean,
        source: string,
        token: number,
        anchorPage: number | null,
    ) {
        logPdfRenderTrace('resize-layer-visibility-transition', {
            active,
            source,
            token,
            anchorPage,
        });
        setResizeTransitionVisible?.({
            active,
            source,
            token,
            anchorPage,
        });
    }

    function beginResizeTransition(source: string, anchorPage: number | null) {
        resizeTransitionToken += 1;
        const token = resizeTransitionToken;
        if (pendingResizeTransitionHideTimer !== null) {
            clearTimeout(pendingResizeTransitionHideTimer);
            pendingResizeTransitionHideTimer = null;
        }
        emitResizeTransitionSignal(true, source, token, anchorPage);
        return token;
    }

    function scheduleEndResizeTransition(
        token: number,
        source: string,
        anchorPage: number | null,
    ) {
        // A late completion belongs to an older geometry epoch. It must not
        // clear or replace the current token's hide timer; doing so strands the
        // new transition in its active state permanently.
        if (token !== resizeTransitionToken) {
            return;
        }
        if (pendingResizeTransitionHideTimer !== null) {
            clearTimeout(pendingResizeTransitionHideTimer);
        }
        const hideTimer = setTimeout(() => {
            if (pendingResizeTransitionHideTimer === hideTimer) {
                pendingResizeTransitionHideTimer = null;
            }
            if (token !== resizeTransitionToken) {
                return;
            }
            emitResizeTransitionSignal(false, source, token, anchorPage);
        }, PDF_RESIZE_TRANSITION_HIDE_MS);
        pendingResizeTransitionHideTimer = hideTimer;
    }

    function normalizePreferredAnchorPage(page: number | null | undefined) {
        if (
            typeof page !== 'number'
            || !Number.isFinite(page)
            || page < 1
            || page > numPages.value
        ) {
            return null;
        }
        return Math.trunc(page);
    }

    function getResizePreferredAnchorPage() {
        return options.pendingNavigationAnchorPage?.value ?? currentPage.value;
    }

    function buildResizeAnchorContext(optionsOverride?: IBuildResizeAnchorContextOptions) {
        if (isActive?.value === false) {
            return {
                capturedAtMs: Date.now(),
                page: currentPage.value,
                transitionToken: 0,
                visibleRange: {
                    start: visibleRange.value.start,
                    end: visibleRange.value.end,
                },
                viewerMetrics: summarizeViewerMetricsForLog(viewerContainer.value),
                semanticAnchor: options.captureViewportAnchor?.() ?? null,
            } satisfies IResizeAnchorContext;
        }
        const preferredAnchorPage = optionsOverride?.trustPreferredAnchorPage
            ? normalizePreferredAnchorPage(optionsOverride.preferredAnchorPage)
            : null;
        const anchorPage = preferredAnchorPage ?? currentPage.value;
        const capturedSemanticAnchor = options.captureViewportAnchor?.() ?? null;
        // Geometry may already reflect a new scale while scrollTop still
        // belongs to the preceding geometry epoch. Preserve the trusted page
        // owner and only reuse the point fractions from that physical sample;
        // otherwise a resize caused by zoom can reinterpret page 7 as page 2.
        const semanticAnchor = preferredAnchorPage !== null && capturedSemanticAnchor
            ? {
                ...capturedSemanticAnchor,
                page: preferredAnchorPage,
            }
            : capturedSemanticAnchor;
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'anchor-build-captured', ZOOM_QUEUE_LOG_THROTTLE_MS, '[anchor-build] captured', {
            optionsOverride: optionsOverride ?? null,
            anchorPage,
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
        });
        return {
            capturedAtMs: Date.now(),
            page: anchorPage,
            transitionToken: 0,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
            viewerMetrics: summarizeViewerMetricsForLog(viewerContainer.value),
            semanticAnchor,
        } satisfies IResizeAnchorContext;
    }

    function runDebouncedResizeRender() {
        pendingResizeDebounceTimer = null;
        if (isActive?.value === false || isLoading.value || !pdfDocument.value) {
            if (pendingResizeAnchor) {
                scheduleEndResizeTransition(
                    pendingResizeAnchor.transitionToken,
                    'resize-cancelled',
                    pendingResizeAnchor.page,
                );
            }
            pendingResizeAnchor = null;
            cancelPendingResizeTransaction('resize');
            return;
        }
        const anchor = pendingResizeAnchor;
        const transactionId = pendingResizeTransactionId;
        const isTransactionCurrent = transactionId === null
            || options.transactionController?.isTransactionCurrent(transactionId) !== false;
        pendingResizeAnchor = null;
        pendingResizeTransactionId = null;
        if (!isTransactionCurrent) {
            if (anchor) {
                scheduleEndResizeTransition(
                    anchor.transitionToken,
                    'resize-stale',
                    anchor.page,
                );
            }
            return;
        }
        if (anchor) {
            // ResizeObserver rerenders clear the renderer canvas before the
            // replacement is ready. Preserve the committed pixels just as we
            // do for divider-drag settle so scrollbar admission and other
            // one-shot geometry changes cannot expose a blank page shell.
            captureResizeVisualSnapshots(anchor);
        }
        scheduleResizeAwareRerender('re-render visible pages after resize', {
            source: PDF_RERENDER_SOURCE.ResizeObserver,
            stabilize: true,
            resizeAnchor: anchor,
            ...(transactionId !== null ? { transactionId } : {}),
        });
    }

    function cancelDebouncedResizeRender() {
        if (pendingResizeDebounceTimer !== null) {
            clearTimeout(pendingResizeDebounceTimer);
            pendingResizeDebounceTimer = null;
        }
    }

    function scheduleDebouncedResizeRender() {
        cancelDebouncedResizeRender();
        pendingResizeDebounceTimer = setTimeout(
            runDebouncedResizeRender,
            PDF_RESIZE_RERENDER_DEBOUNCE_MS,
        );
    }

    function reapplyResizeAnchorPreviewAfterLayout(anchor: IResizeAnchorContext) {
        options.applyResizeAnchorPreview?.(anchor.semanticAnchor);
        // Fit-preview scale is reactive: the ResizeObserver updates it before
        // Vue has patched the page geometry. Reapply once that patch lands so
        // the semantic page never leaves the painted viewport while the
        // asynchronous authority hydrates/refines the canonical intent.
        return nextTick(() => options.applyResizeAnchorPreview?.(anchor.semanticAnchor));
    }

    function restoreResizeAnchorAfterLayout(anchor: IResizeAnchorContext, source: string) {
        // The authority resolves its geometry asynchronously. Submitting in
        // the same turn as the reactive fit-preview write lets it observe the
        // preceding page track, then apply its scroll position against the
        // next track. Submit after Vue has committed the preview instead.
        void reapplyResizeAnchorPreviewAfterLayout(anchor).then(() => {
            if (
                isActive?.value === false
                || isLoading.value
                || !pdfDocument.value
            ) {
                return;
            }
            options.submitResizeIntent(anchor.semanticAnchor);
        });
        BrowserLogger.diagnosticThrottled(
            'pdf-zoom-debug',
            'resize-anchor-authority-intent',
            ZOOM_QUEUE_LOG_THROTTLE_MS,
            '[resize-anchor] submitted semantic viewport intent',
            {
                source,
                token: anchor.transitionToken,
                anchorPage: anchor.page,
            },
        );
    }

    function captureResizeVisualSnapshots(
        anchor: IResizeAnchorContext,
        holdForMs = 0,
    ) {
        const container = viewerContainer.value;
        if (!container) {
            return;
        }
        const capturedAtMs = Date.now();
        const normalizedHoldForMs = Number.isFinite(holdForMs)
            ? Math.max(0, holdForMs)
            : 0;
        const candidatePages = new Set<number>();
        container.querySelectorAll<HTMLElement>('.page_container[data-page]').forEach((pageContainer) => {
            const page = Number(pageContainer.dataset.page);
            if (Number.isInteger(page) && page > 0) {
                candidatePages.add(page);
            }
        });
        for (let page = anchor.visibleRange.start; page <= anchor.visibleRange.end; page += 1) {
            candidatePages.add(page);
        }
        for (const page of candidatePages) {
            const pageContainer = container.querySelector<HTMLElement>(
                `.page_container[data-page="${page}"]`,
            );
            const activeLease = activeResizeVisualSnapshots.get(page);
            if (
                activeLease
                && !activeLease.released
                && activeLease.document === pdfDocument.value
                && activeLease.pageContainer === pageContainer
                && pageContainer?.dataset.page === String(page)
                && activeLease.snapshot.isValid()
            ) {
                activeLease.holdForMs = Math.max(activeLease.holdForMs, normalizedHoldForMs);
                activeLease.lastCaptureAtMs = capturedAtMs;
                continue;
            }
            activeLease?.cancelRelease();
            activeLease?.snapshot.release();
            activeResizeVisualSnapshots.delete(page);
            const snapshot = preservePdfResizeCanvasVisualSnapshot(pageContainer);
            if (!snapshot) {
                // A rapid zoom packet can arrive after the renderer has cleared
                // its source canvas but before the replacement commits. Keep the
                // previous snapshot for this page instead of exposing the bare
                // page shell during that gap.
                continue;
            }
            if (!pageContainer) {
                snapshot.release();
                continue;
            }
            const lease: IActiveResizeVisualSnapshotLease = {
                document: pdfDocument.value,
                holdForMs: normalizedHoldForMs,
                lastCaptureAtMs: capturedAtMs,
                pageContainer,
                released: false,
                snapshot,
                cancelRelease: () => {},
            };
            const release = () => {
                if (lease.released) {
                    return;
                }
                lease.released = true;
                snapshot.release();
                if (activeResizeVisualSnapshots.get(page) === lease) {
                    activeResizeVisualSnapshots.delete(page);
                }
            };
            activeResizeVisualSnapshots.set(page, lease);
            lease.cancelRelease = schedulePdfResizeCanvasVisualSnapshotRelease(release, {
                maxDelayMs: PDF_RESIZE_VISUAL_SNAPSHOT_MAX_DELAY_MS,
                minFrames: 2,
                waitFor: () => (
                    !snapshot.isValid()
                    || (
                        Date.now() - lease.lastCaptureAtMs >= lease.holdForMs
                        && snapshot.hasReplacementCanvas()
                        && pageContainer.classList.contains(pdfViewerDomClasses.renderedPageContainer)
                    )
                ),
            });
        }
    }

    function handleResize() {
        if (isActive?.value === false && !isResizing.value) {
            return;
        }
        const activeTransactionKind = options.transactionController?.activeTransaction?.value?.kind;
        if (activeTransactionKind === 'zoom') {
            // A zoom transaction owns both the scale mutation and its semantic
            // anchor. Record the client-size side effect (commonly scrollbar
            // admission at high zoom), but do not replay it as an independent
            // resize after the target-scale canvas commits. Such a replay would
            // clear that crisp canvas and start a second skeleton/render cycle.
            consumeViewportGeometryChange();
            return;
        }
        if (activeTransactionKind === 'reload') {
            // Reload owns a semantic anchor from the geometry epoch that
            // preceded its layout mutation. Reload
            // still replays after settlement because it may replace the whole
            // document surface and therefore require a fresh fit calculation.
            pendingTransactionOwnedResize = true;
            return;
        }
        if (isLoading.value) {
            return;
        }
        if (isResizing.value) {
            const viewportGeometryChanged = consumeViewportGeometryChange();
            const updated = computeFitWidthScale(viewerContainer.value, {
                page: dragResizeAnchor?.page ?? currentPage.value,
                preview: true,
            });
            if (dragResizeAnchor && (updated || viewportGeometryChanged)) {
                // Preview scale updates replace the virtual page geometry
                // immediately. Reapply the drag-start semantic anchor against
                // the new page track in the same resize cycle so the old pixel
                // scroll offset is never interpreted as a different page. This
                // is a preview-only correction, like the later packets of a
                // resize burst: the authority intent, with its geometry
                // hydration and position commit, runs once at settle instead
                // of on every animated frame.
                void reapplyResizeAnchorPreviewAfterLayout(dragResizeAnchor);
            }
            return;
        }
        if (dragSettleClaimed) {
            return;
        }
        const preferredAnchorPage = getResizePreferredAnchorPage();
        const resizeAnchor = buildResizeAnchorContext({
            preferredAnchorPage,
            trustPreferredAnchorPage: true,
        });
        const previousViewportSize = lastObservedViewportSize;
        const viewportGeometryChanged = consumeViewportGeometryChange();
        const updated = computeFitWidthScale(viewerContainer.value, {page: preferredAnchorPage});
        if (!updated && !viewportGeometryChanged) {
            return;
        }
        if (pdfDocument.value) {
            const preserveRenderedLayers = !updated && !pendingResizeAnchor;
            logPdfRenderTrace('resize-observer-render-decision', {
                previousViewportSize,
                viewportSize: lastObservedViewportSize,
                viewportGeometryChanged,
                scaleChanged: updated,
                preserveRenderedLayers,
                pendingNavigationPage: options.pendingNavigationAnchorPage?.value ?? null,
                anchorPage: resizeAnchor.page,
            });
            if (preserveRenderedLayers) {
                // Scrollbar or host-size changes at a fixed scale do not stale
                // canvas pixels or text geometry. The viewport authority still
                // reconciles the anchor and visible render demand, including a
                // pending search destination, without hiding or rebuilding layers.
                options.submitResizeIntent(resizeAnchor.semanticAnchor);
                return;
            }
            if (pendingResizeAnchor) {
                if (updated || viewportGeometryChanged) {
                    // Scrollbar admission/removal can deliver a second resize
                    // packet after the first packet has already changed the fit
                    // scale. Keep projecting the burst's original semantic
                    // anchor through each geometry epoch; otherwise the old
                    // scrollTop is reinterpreted against the later page sizes
                    // and the viewport visibly jumps to a different row.
                    // The first packet already submitted the authoritative
                    // resize intent, so this is a preview-only correction.
                    void reapplyResizeAnchorPreviewAfterLayout(pendingResizeAnchor);
                }
                BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'resize-anchor-preserved', ZOOM_QUEUE_LOG_THROTTLE_MS, '[resize-anchor] preserved first anchor in resize burst', {
                    updated,
                    preservedAnchorPage: pendingResizeAnchor.page,
                    ignoredAnchorPage: resizeAnchor.page,
                    preservedAnchorAgeMs: Date.now() - pendingResizeAnchor.capturedAtMs,
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                });
                scheduleDebouncedResizeRender();
                return;
            }
            const transitionToken = beginResizeTransition(
                PDF_RERENDER_SOURCE.ResizeObserver,
                resizeAnchor.page,
            );
            const anchoredResizeContext: IResizeAnchorContext = {
                ...resizeAnchor,
                transitionToken,
            };
            beginResizeTransaction(anchoredResizeContext, 'resize-observer');
            pendingResizeAnchor = anchoredResizeContext;
            restoreResizeAnchorAfterLayout(anchoredResizeContext, PDF_RERENDER_SOURCE.ResizeObserver);
            BrowserLogger.diagnostic('pdf-nav', 'Resize observer requested re-render'
                + ` anchorPage=${anchoredResizeContext.page}`
                + ` anchorRange=${anchoredResizeContext.visibleRange.start}-${anchoredResizeContext.visibleRange.end}`
                + ` token=${anchoredResizeContext.transitionToken}`, {
                currentPage: currentPage.value,
                visibleRange: {
                    start: visibleRange.value.start,
                    end: visibleRange.value.end,
                },
                anchorViewerMetrics: anchoredResizeContext.viewerMetrics,
                pendingAnchorPage: pendingResizeAnchor.page,
                pendingAnchorAgeMs: Date.now() - pendingResizeAnchor.capturedAtMs,
                viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
            });
            scheduleDebouncedResizeRender();
        }
    }

    useResizeObserver(viewerContainer, handleResize);

    watch(viewerContainer, () => {
        lastObservedViewportSize = readViewportSize();
    }, { flush: 'sync' });

    watch(
        () => options.transactionController?.activeTransaction?.value?.kind ?? null,
        (kind, previousKind) => {
            if (previousKind === 'zoom' && kind !== 'zoom') {
                // ResizeObserver delivery can trail the zoom transaction that
                // caused the geometry change. Advance the observed baseline at
                // settlement so that delayed notification cannot launch a
                // redundant full cleanup after the crisp zoom canvas commits.
                consumeViewportGeometryChange();
                return;
            }
            if (
                previousKind !== 'reload'
                || kind === 'reload'
                || kind === 'zoom'
                || !pendingTransactionOwnedResize
            ) {
                return;
            }
            pendingTransactionOwnedResize = false;
            void nextTick().then(handleResize);
        },
    );

    // A navigation that commits while the sidebar or window is still
    // animating moves the viewport authority to another page. The drag anchor
    // was captured for the page the drag started on, so replaying it would
    // drag the viewport back there while the authority keeps reporting the new
    // page. The authority owns where the viewport is; the anchor only keeps
    // that place stable across per-frame geometry changes, so re-derive it
    // from the committed position. The authority applies its scroll before it
    // publishes the page, so the capture below reads the new position.
    watch(currentPage, (page) => {
        if (!dragResizeAnchor || dragResizeAnchor.page === page) {
            return;
        }
        dragResizeAnchor = {
            ...buildResizeAnchorContext({
                preferredAnchorPage: page,
                trustPreferredAnchorPage: true,
            }),
            transitionToken: dragResizeAnchor.transitionToken,
        };
    }, {flush: 'sync'});

    watch(isResizing, async (value, previous) => {
        const runId = ++dragSettleRunId;
        if (value) {
            dragSettleClaimed = true;
            cancelDebouncedResizeRender();
            if (pendingResizeAnchor) {
                scheduleEndResizeTransition(
                    pendingResizeAnchor.transitionToken,
                    'resize-observer-superseded-by-drag',
                    pendingResizeAnchor.page,
                );
                pendingResizeAnchor = null;
            }
            cancelPendingResizeTransaction('resize');
            const anchor = buildResizeAnchorContext({
                preferredAnchorPage: getResizePreferredAnchorPage(),
                trustPreferredAnchorPage: true,
            });
            dragResizeAnchor = {
                ...anchor,
                transitionToken: beginResizeTransition(PDF_RERENDER_SOURCE.ResizeSettle, anchor.page),
            };
            computeFitWidthScale(viewerContainer.value, {
                page: anchor.page,
                preview: true,
            });
            return;
        }
        if (!previous || !dragResizeAnchor) {
            dragSettleClaimed = false;
            return;
        }

        await nextTick();
        await delay(PDF_RESIZE_DRAG_SETTLE_MS);
        if (
            runId !== dragSettleRunId
            || isResizing.value
        ) {
            return;
        }

        if (
            isActive?.value === false
            || isLoading.value
            || !pdfDocument.value
        ) {
            // A host/tab transition can end while the document is still
            // opening. It legitimately cannot schedule a resize rerender yet,
            // but it must still retire the visual transition it began. Leaving
            // this anchor live permanently marks the ready canvas as resizing
            // and prevents interaction/readiness after Recent close/reopen.
            const cancelledAnchor = dragResizeAnchor;
            dragResizeAnchor = null;
            dragSettleClaimed = false;
            options.settlePreviewFitScale?.();
            scheduleEndResizeTransition(
                cancelledAnchor.transitionToken,
                'resize-settle-cancelled',
                cancelledAnchor.page,
            );
            return;
        }

        const anchor = dragResizeAnchor;
        dragResizeAnchor = null;
        captureResizeVisualSnapshots(anchor);
        computeFitWidthScale(viewerContainer.value, {
            page: anchor.page,
            preview: true,
        });
        if (!options.settlePreviewFitScale?.(true)) {
            computeFitWidthScale(viewerContainer.value, {page: anchor.page});
            options.settlePreviewFitScale?.();
        }
        beginResizeTransaction(anchor, 'resize-settle');
        restoreResizeAnchorAfterLayout(anchor, PDF_RERENDER_SOURCE.ResizeSettle);
        const transactionId = pendingResizeTransactionId;
        pendingResizeTransactionId = null;
        scheduleResizeAwareRerender('re-render visible pages after resize settle', {
            source: PDF_RERENDER_SOURCE.ResizeSettle,
            stabilize: true,
            resizeAnchor: anchor,
            ...(transactionId !== null ? {transactionId} : {}),
        });
        if (dragSettleClaimReleaseTimer !== null) {
            clearTimeout(dragSettleClaimReleaseTimer);
        }
        dragSettleClaimReleaseTimer = setTimeout(() => {
            dragSettleClaimed = false;
            dragSettleClaimReleaseTimer = null;
        }, PDF_RESIZE_TRANSITION_HIDE_MS);
    }, {flush: 'sync'});

    function cleanupResizeLifecycle() {
        activeResizeVisualSnapshots.forEach((lease) => {
            lease.cancelRelease();
            lease.released = true;
            lease.snapshot.release();
        });
        activeResizeVisualSnapshots.clear();
        if (pendingResizeTransitionHideTimer !== null) {
            clearTimeout(pendingResizeTransitionHideTimer);
            pendingResizeTransitionHideTimer = null;
        }
        pendingResizeAnchor = null;
        pendingTransactionOwnedResize = false;
        dragResizeAnchor = null;
        dragSettleRunId += 1;
        dragSettleClaimed = false;
        if (dragSettleClaimReleaseTimer !== null) {
            clearTimeout(dragSettleClaimReleaseTimer);
            dragSettleClaimReleaseTimer = null;
        }
        cancelDebouncedResizeRender();
        options.settlePreviewFitScale?.();
        cancelPendingResizeTransaction('disposed');
        resizeTransitionToken += 1;
        emitResizeTransitionSignal(false, 'unmount', resizeTransitionToken, currentPage.value);
    }

    return {
        buildResizeAnchorContext,
        beginResizeTransition,
        captureResizeVisualSnapshots,
        scheduleEndResizeTransition,
        cleanupResizeLifecycle,
    };
};
