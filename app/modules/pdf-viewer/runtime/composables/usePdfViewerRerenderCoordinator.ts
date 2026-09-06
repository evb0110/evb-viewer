import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { delay } from 'es-toolkit/promise';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {TFitMode} from '@app/types/pdfContracts';
import type { TPdfViewRotation } from '@contracts/shared';
import type { IPageRange } from '@app/types/pdfUi';
import type { ICurrentPageSyncOptions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import type { TPdfViewerTransactionState } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type { IUsePdfViewerRerenderCoordinatorOptions } from '@app/modules/pdf-viewer/runtime/composables/pdfRerenderCoordinatorTypes';
import { getRequestAnchor } from '@app/modules/pdf-viewer/runtime/navigation/pdfNavigationRequestAnchors';
import {
    PDF_RERENDER_SOURCE,
    isZoomRestorePdfRerenderSource,
    normalizePdfRerenderSource,
    shouldUseMinimalPdfRerenderBuffer,
} from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

const ZOOM_QUEUE_LOG_THROTTLE_MS = 420;

export const usePdfViewerRerenderCoordinator = (options: IUsePdfViewerRerenderCoordinatorOptions) => {
    const {
        viewerContainer,
        pdfDocument,
        isLoading,
        numPages,
        currentPage,
        pagedNavigationTargetPage,
        navigationAnchorPage,
        visibleRange,
        zoom,
        zoomMode,
        fitMode,
        viewMode,
        viewRotation: providedViewRotation,
        isResizing,
        continuousScroll,
        getVisibleRange,
        reRenderAllVisiblePages,
        summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog,
        syncCurrentPageFromViewport,
        buildResizeAnchorContext,
        applyResizeAnchorPreview,
        captureResizeVisualSnapshots,
        scheduleEndResizeTransition,
        enqueueZoomSync,
        cancelInFlightPageRenders,
        ensurePageMetricsInRange,
        computeFitWidthScale,
        syncHorizontalScrollForZoomMode,
        setupPagePlaceholders,
        scrollToPage,
        getMostVisiblePage,
        resetContinuousScrollState,
        cancelDestinationNavigationTarget,
        resetZoomRerenderQueueState,
        getUserViewportInteractionEpoch,
        getUserPhysicalNavigationEpoch,
        beginLayoutGeometryReplacement,
        consumeZoomViewportAnchor,
        submitZoomViewportStateIntent,
        consumeSuppressedZoomRerender,
        transactionController,
    } = options;
    const viewRotation = providedViewRotation ?? computed<TPdfViewRotation>(() => 0);

    let reRenderSyncRunId = 0;
    let fitModeRunId = 0;
    let currentPageFitRerenderRunId = 0;
    let viewModeRunId = 0;
    let continuousScrollRunId = 0;
    let zoomOrchestrationTaskId: ReturnType<typeof setTimeout> | null = null;
    let zoomOrchestrationGeneration = 0;
    let zoomOrchestrationDisposed = false;
    let pendingZoomOrchestration: {
        document: IPdfDocument | null;
        previousZoom: number | null;
        zoomChanged: boolean;
        modeChangedToCustom: boolean;
    } | null = null;

    function cancelPendingZoomOrchestration() {
        zoomOrchestrationGeneration += 1;
        pendingZoomOrchestration = null;
        if (zoomOrchestrationTaskId !== null) {
            clearTimeout(zoomOrchestrationTaskId);
            zoomOrchestrationTaskId = null;
        }
    }

    function runPendingZoomOrchestration(generation: number) {
        zoomOrchestrationTaskId = null;
        const pending = pendingZoomOrchestration;
        pendingZoomOrchestration = null;
        if (zoomOrchestrationDisposed || generation !== zoomOrchestrationGeneration || !pending) {
            return;
        }
        if (pdfDocument.value !== pending.document) {
            return;
        }
        const nextZoom = zoom.value;
        const zoomChanged = pending.zoomChanged
            && pending.previousZoom !== null
            && nextZoom !== pending.previousZoom;
        if (!zoomChanged && !pending.modeChangedToCustom) {
            return;
        }
        if (zoomChanged) {
            submitZoomViewportStateIntent?.(nextZoom);
        }
        if (!pdfDocument.value) {
            return;
        }
        if (
            zoomChanged
            && consumeSuppressedZoomRerender?.(nextZoom)
            && !pending.modeChangedToCustom
        ) {
            return;
        }
        cancelDestinationNavigationTarget?.();
        void cancelInFlightPageRenders?.();
        const zoomViewportAnchor = consumeZoomViewportAnchor?.() ?? null;
        const trustCurrentPageAnchor = canTrustCurrentPageAsZoomAnchor();
        const zoomRerenderSource = zoomViewportAnchor
            ? PDF_RERENDER_SOURCE.ZoomGestureChange
            : pending.modeChangedToCustom
                ? PDF_RERENDER_SOURCE.ZoomModeChange
                : PDF_RERENDER_SOURCE.ZoomChange;
        const zoomAnchor = zoomViewportAnchor?.resizeAnchor ?? buildResizeAnchorContext({
            preferredAnchorPage: currentPage.value,
            trustPreferredAnchorPage: trustCurrentPageAnchor,
        });
        logPdfRenderTrace('zoom-rerender-anchor-captured', () => ({
            previousZoom: pending.previousZoom ?? nextZoom,
            nextZoom,
            currentPage: currentPage.value,
            visibleRange: {...visibleRange.value},
            trustCurrentPageAnchor,
            anchorPage: zoomAnchor.page,
            semanticAnchorPage: zoomAnchor.semanticAnchor?.page ?? null,
            navigationAnchorPage: navigationAnchorPage?.value ?? null,
            pagedNavigationTargetPage: pagedNavigationTargetPage?.value ?? null,
        }));
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'zoom-watch-schedule-rerender', ZOOM_QUEUE_LOG_THROTTLE_MS, '[zoom-watch] schedule zoom rerender', {
            previousZoom: pending.previousZoom ?? nextZoom,
            nextZoom,
            consumedZoomViewportAnchor: zoomViewportAnchor,
            trustCurrentPageAnchor,
            zoomRerenderSource,
            builtZoomAnchor: zoomAnchor,
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
        });
        // The render queue replaces pixels asynchronously. Commit the page
        // shell geometry in the same zoom turn so the DOM reflects the new
        // scale before the replacement canvas is requested.
        if (zoomChanged || pending.modeChangedToCustom) {
            setupPagePlaceholders();
        }
        enqueueZoomSync({
            source: zoomRerenderSource,
            stabilize: true,
            resizeAnchor: zoomAnchor,
            ...(zoomViewportAnchor?.sessionId !== undefined
                ? {zoomGestureSessionId: zoomViewportAnchor.sessionId}
                : {}),
            zoomLockOperationId: zoomViewportAnchor?.zoomLockOperationId ?? null,
        });
    }

    function queueZoomOrchestration(change: {
        previousZoom?: number;
        zoomChanged?: boolean;
        modeChangedToCustom?: boolean;
    }) {
        if (zoomOrchestrationDisposed) {
            return;
        }
        if (
            pendingZoomOrchestration
            && pendingZoomOrchestration.document !== pdfDocument.value
        ) {
            cancelPendingZoomOrchestration();
        }
        pendingZoomOrchestration = {
            document: pdfDocument.value,
            previousZoom: pendingZoomOrchestration?.previousZoom
                ?? (change.zoomChanged === true ? change.previousZoom ?? zoom.value : null),
            zoomChanged: pendingZoomOrchestration?.zoomChanged === true || change.zoomChanged === true,
            modeChangedToCustom:
                pendingZoomOrchestration?.modeChangedToCustom === true
                || change.modeChangedToCustom === true,
        };
        if (zoomOrchestrationTaskId !== null) {
            return;
        }
        const generation = ++zoomOrchestrationGeneration;
        zoomOrchestrationTaskId = setTimeout(() => {
            runPendingZoomOrchestration(generation);
        }, 0);
    }

    function isViewerAsyncRunActive(
        runId: number,
        activeRunId: number,
        document: IPdfDocument | null,
    ) {
        return runId === activeRunId
            && document !== null
            && pdfDocument.value === document
            && !isLoading.value;
    }

    function isFitWidthZoomModeActive() {
        return zoomMode
            ? zoomMode.value === 'fit-width'
            : fitMode.value === 'width';
    }

    function isFitHeightZoomModeActive() {
        return zoomMode
            ? zoomMode.value === 'fit-height'
            : fitMode.value === 'height';
    }

    function syncHorizontalScrollAfterLayoutUpdate() {
        syncHorizontalScrollForZoomMode?.();
    }

    function getCurrentUserViewportInteractionEpoch() {
        const epoch = getUserViewportInteractionEpoch?.() ?? 0;
        return Number.isFinite(epoch) ? epoch : 0;
    }

    /**
     * Physical navigation - wheel, pointer, or a scroll the viewer did not
     * cause - is the only thing allowed to supersede a fit re-anchor. Fit
     * geometry replacement makes the browser emit its own scroll, so the
     * interaction epoch always advances across a fit change and cannot be used
     * to decide whether the user took the viewport.
     */
    function getCurrentUserPhysicalNavigationEpoch() {
        const epoch = getUserPhysicalNavigationEpoch?.() ?? getCurrentUserViewportInteractionEpoch();
        return Number.isFinite(epoch) ? epoch : 0;
    }

    function resolveRerenderBufferOverride(source: string) {
        return shouldUseMinimalPdfRerenderBuffer(source)
            ? 0
            : undefined;
    }

    function canTrustCurrentPageAsZoomAnchor() {
        const page = currentPage.value;
        if (!Number.isFinite(page) || page < 1 || page > numPages.value) {
            return false;
        }
        const range = visibleRange.value;
        return page >= range.start && page <= range.end;
    }

    function resolvePageRowRange(pageNumber: number): IPageRange {
        if (numPages.value <= 0) {
            return {
                start: 1,
                end: 1,
            };
        }
        const rowBounds = getPageRowBoundsForViewMode({
            pageNumber,
            viewMode: viewMode.value,
            totalPages: numPages.value,
        });
        return {
            start: rowBounds.start,
            end: rowBounds.end,
        };
    }

    function isCurrentPageFitRerenderModeActive() {
        return (
            (fitMode.value === 'width' && isFitWidthZoomModeActive())
            || (fitMode.value === 'height' && isFitHeightZoomModeActive())
        );
    }

    function isCurrentPageLatestPagedNavigationIntent(page: number) {
        const targetPage = pagedNavigationTargetPage?.value ?? null;
        return targetPage === null || targetPage === page;
    }

    function isCurrentPageFitRerenderRunActive(
        runId: number,
        document: IPdfDocument | null,
        page: number,
    ) {
        return isViewerAsyncRunActive(runId, currentPageFitRerenderRunId, document)
            && currentPage.value === page
            && isCurrentPageFitRerenderModeActive()
            && isCurrentPageLatestPagedNavigationIntent(page)
            && !continuousScroll.value
            && !isResizing.value;
    }

    async function cancelCurrentPageFitRendersAndWaitForSettle() {
        await cancelInFlightPageRenders?.();
        await nextTick();
    }

    async function runCurrentPageFitRerenderTransition(task: () => Promise<void>) {
        await task();
    }

    /**
     * Prepare the row before fit-current rendering takes over from navigation.
     *
     * The normal paged renderer is suppressed in fit-height/fit-width mode, so
     * this watcher must perform the whole sequence: select the current row,
     * hydrate its page metrics, recompute the fit scale, and refresh skeleton
     * dimensions before starting the only canvas render for that row.
     */
    async function prepareFitPageRerenderLayout(
        runId: number,
        document: IPdfDocument | null,
        page: number,
        isRunActive: () => boolean,
    ) {
        const range = resolvePageRowRange(page);
        await ensurePageMetricsInRange?.(range.start, range.end);
        await nextTick();
        void document;
        void runId;
        if (!isRunActive()) {
            return null;
        }

        computeFitWidthScale(viewerContainer.value, { page });
        setupPagePlaceholders();
        syncHorizontalScrollAfterLayoutUpdate();
        return range;
    }

    function buildRerenderSyncNavLogPayload(runId: number, source: string) {
        return {
            runId,
            source,
            currentPage: currentPage.value,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
        };
    }

    function warnZoomRerenderSync(
        source: string,
        message: string,
        buildPayload: () => Record<string, unknown>,
    ) {
        if (!isZoomRestorePdfRerenderSource(source)) {
            return;
        }
        BrowserLogger.diagnostic('pdf-zoom-debug', message, buildPayload());
    }

    function isSyncTransactionCurrent(syncOptions: ICurrentPageSyncOptions) {
        return syncOptions.transactionId === undefined
            || transactionController?.isTransactionCurrent(syncOptions.transactionId) !== false;
    }

    function advanceSyncTransaction(
        syncOptions: ICurrentPageSyncOptions,
        state: Exclude<TPdfViewerTransactionState, 'preparing' | 'cancelled'>,
    ) {
        if (syncOptions.transactionId === undefined) {
            return true;
        }
        return transactionController?.advanceTransaction(syncOptions.transactionId, state) !== false;
    }

    async function reRenderVisiblePagesAndSyncCurrentPage(
        syncOptions: ICurrentPageSyncOptions = {},
    ) {
        const source = normalizePdfRerenderSource(
            syncOptions.source,
            PDF_RERENDER_SOURCE.ReRender,
        );
        const runId = ++reRenderSyncRunId;
        const resizeAnchor = syncOptions.resizeAnchor ?? null;
        const wheelGestureOwnsViewportAnchor = syncOptions.zoomGestureSessionId !== undefined
            || source === PDF_RERENDER_SOURCE.ZoomGestureChange;
        let transitionOutcome = 'resize-rerender-complete';
        warnZoomRerenderSync(source, `[rerender-sync] begin zoom run=${runId}`, () => ({
            runId,
            source,
            resizeAnchor: syncOptions.resizeAnchor ?? null,
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
        }));
        BrowserLogger.diagnostic(
            'pdf-nav',
            `[re-render-sync] begin run=${runId} source=${source}`,
            buildRerenderSyncNavLogPayload(runId, source),
        );
        try {
            if (!isSyncTransactionCurrent(syncOptions)) {
                transitionOutcome = 'stale-rerender-transaction';
                return;
            }
            const renderBufferOverride = resolveRerenderBufferOverride(source);
            if (!advanceSyncTransaction(syncOptions, 'render-requested')) {
                transitionOutcome = 'rejected-rerender-transaction';
                return;
            }
            if (resizeAnchor && isZoomRestorePdfRerenderSource(source)) {
                // Custom zoom replaces the committed backing canvas after the page
                // geometry has already changed. Keep a raster snapshot outside the
                // render layer until the target-scale canvas commits so the viewer
                // never exposes an old canvas or a bare page shell between frames.
                captureResizeVisualSnapshots?.(resizeAnchor);
            }
            await reRenderAllVisiblePages(getVisibleRange, {
                rerenderSource: source,
                ...(renderBufferOverride !== undefined ? { renderBufferOverride } : {}),
            });
            syncHorizontalScrollAfterLayoutUpdate();
            if (runId !== reRenderSyncRunId) {
                transitionOutcome = 'stale-rerender';
                warnZoomRerenderSync(source, `[rerender-sync] stale zoom run=${runId}`, () => ({
                    runId,
                    activeRunId: reRenderSyncRunId,
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                }));
                BrowserLogger.diagnostic('pdf-nav', 'Skipped stale re-render current-page sync run', {
                    staleRunId: runId,
                    activeRunId: reRenderSyncRunId,
                    source,
                });
                return;
            }
            if (!isSyncTransactionCurrent(syncOptions)) {
                transitionOutcome = 'stale-rerender-transaction';
                return;
            }

            if (resizeAnchor && !wheelGestureOwnsViewportAnchor) {
                // A modifier-wheel gesture already submitted one cursor-point
                // viewport intent against its pre-zoom geometry. Replaying the
                // separately captured resize/visual anchor here would issue a
                // second scroll write when the sharp raster commits, usually
                // moving the cursor's content point to the viewport center.
                // Non-wheel resize and toolbar transitions still need this final
                // projection because they do not own that atomic cursor intent.
                await nextTick();
                const restored = applyResizeAnchorPreview === undefined
                    ? false
                    : applyResizeAnchorPreview(resizeAnchor.semanticAnchor);
                if (restored === false) {
                    await Promise.resolve(scrollToPage(resizeAnchor.page, {
                        preferExactDom: true,
                        suppressRenderAfterSnap: true,
                    }));
                }
                syncHorizontalScrollAfterLayoutUpdate();
            }

            warnZoomRerenderSync(source, `[rerender-sync] end zoom run=${runId}`, () => ({
                runId,
                viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
            }));
            BrowserLogger.diagnostic('pdf-nav', `[re-render-sync] end run=${runId} source=${source}`, {
                ...buildRerenderSyncNavLogPayload(runId, source),
                visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
            });
            await syncCurrentPageFromViewport(syncOptions);
            if (!isSyncTransactionCurrent(syncOptions)) {
                transitionOutcome = 'stale-rerender-transaction-after-sync';
                return;
            }
            syncHorizontalScrollAfterLayoutUpdate();
            if (!advanceSyncTransaction(syncOptions, 'settled')) {
                transitionOutcome = 'rejected-rerender-settle';
            }
        } catch (error) {
            transitionOutcome = 'failed-rerender';
            throw error;
        } finally {
            // Every token that exposes resize-transition UI gets a terminal
            // signal. Token fencing makes this safe for stale runs and prevents
            // a superseded transaction from suppressing scroll forever.
            if (resizeAnchor) {
                scheduleEndResizeTransition(
                    resizeAnchor.transitionToken,
                    transitionOutcome,
                    resizeAnchor.page,
                );
            }
        }
    }

    function canConfirmFitAnchor(
        source: string,
        runId: number,
        capturedPhysicalEpoch: number,
    ) {
        const currentEpoch = getCurrentUserPhysicalNavigationEpoch();
        if (currentEpoch === capturedPhysicalEpoch) {
            return true;
        }
        BrowserLogger.diagnostic('pdf-nav', `[${source}] skipped fit re-anchor after physical navigation`, {
            runId,
            capturedPhysicalEpoch,
            currentPhysicalEpoch: currentEpoch,
            currentPage: currentPage.value,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
            viewer: summarizeViewerMetricsForLog(viewerContainer.value),
        });
        return false;
    }

    async function handleFitScaleModeChange(
        source: string,
        mode: TFitMode,
        runId: number,
        document: IPdfDocument | null,
        physicalNavigationEpoch: number,
        isRunActive: () => boolean,
        options: {forceRerender?: boolean} = {},
    ) {
        // A toolbar fit command moves `fitMode` and `zoomMode` together, so both
        // watchers claim the same change. Yielding once before any geometry is
        // touched lets the superseded claim retire without replacing the layout
        // a second time, which is what turned a single fit change into two
        // rounds of placeholder resizing and cancelled renders.
        await Promise.resolve();
        if (!isRunActive()) {
            return;
        }
        // Navigation/viewport authority owns the semantic anchor across fit
        // geometry changes. Cancelling it here reinterprets the pre-fit pixel
        // scroll position under changing page metrics and can advance the
        // current page without any user navigation.
        resetZoomRerenderQueueState(`${source}-change`);
        const pageToPreserve = navigationAnchorPage?.value ?? currentPage.value;
        const pageToSnapTo = mode === 'height'
            ? pageToPreserve
            : null;
        const updated = pageToSnapTo === null
            ? computeFitWidthScale(viewerContainer.value)
            : computeFitWidthScale(viewerContainer.value, { page: pageToSnapTo });
        if (!(updated || options.forceRerender === true) || !document) {
            return;
        }
        // Both fit modes rewrite every row's physical top, so the pre-fit pixel
        // scrollTop stops describing anything. Re-project the semantic page
        // before the replacement render, so the row the user was reading is
        // already under the viewport when the first replacement pixels land and
        // no intermediate frame shows a different page.
        const fitAnchor = getRequestAnchor(undefined, pageToPreserve);
        // Every scroll the browser emits while the replacement layout settles
        // belongs to the viewer, not to the user. The window has to open before
        // the first geometry write: shrinking every row clamps `scrollTop`, and
        // that clamp is dispatched as an ordinary scroll event which would
        // otherwise look like navigation and cancel the confirmation below.
        const endLayoutGeometryReplacement = beginLayoutGeometryReplacement?.() ?? null;
        try {
            // Cancelling the viewport raster source releases every committed
            // resident it owns, and the renderer answers a release by emptying
            // the canvas host and re-showing the page skeleton. Copy the
            // committed pixels into a snapshot first; it stays on screen - and
            // keeps the skeleton suppressed - until the new-scale canvas
            // commits, so a fit change never blanks a page the user is already
            // reading.
            captureResizeVisualSnapshots?.(buildResizeAnchorContext({
                preferredAnchorPage: pageToPreserve,
                trustPreferredAnchorPage: true,
            }));
            setupPagePlaceholders();
            if (!isRunActive()) {
                return;
            }
            applyResizeAnchorPreview?.(fitAnchor);
            syncHorizontalScrollAfterLayoutUpdate();
            void cancelInFlightPageRenders?.();
            await reRenderAllVisiblePages(getVisibleRange, {
                rerenderSource: normalizePdfRerenderSource(source),
                renderBufferOverride: 0,
            });
            if (!isRunActive()) {
                return;
            }
            await nextTick();
            if (
                !isRunActive()
                || !canConfirmFitAnchor(source, runId, physicalNavigationEpoch)
            ) {
                return;
            }
            applyResizeAnchorPreview?.(fitAnchor);
            syncHorizontalScrollAfterLayoutUpdate();
        } finally {
            endLayoutGeometryReplacement?.();
        }
    }

    watch(fitMode, async (mode) => {
        if (zoomMode && zoomMode.value !== (mode === 'height' ? 'fit-height' : 'fit-width')) {
            return;
        }
        const runId = ++fitModeRunId;
        const physicalNavigationEpoch = getCurrentUserPhysicalNavigationEpoch();
        const document = pdfDocument.value;
        await handleFitScaleModeChange(
            PDF_RERENDER_SOURCE.FitMode,
            mode,
            runId,
            document,
            physicalNavigationEpoch,
            () => (
                isViewerAsyncRunActive(runId, fitModeRunId, document)
                && fitMode.value === mode
            ),
        );
    });

    const stopZoomModeWatch = zoomMode
        ? watch(zoomMode, async (mode, previousMode) => {
            if (mode === previousMode) {
                return;
            }
            if (mode === 'custom') {
                queueZoomOrchestration({modeChangedToCustom: true});
                return;
            }

            cancelPendingZoomOrchestration();

            const modeFitMode: TFitMode = mode === 'fit-height' ? 'height' : 'width';
            if (fitMode.value !== modeFitMode) {
                return;
            }

            const runId = ++fitModeRunId;
            const physicalNavigationEpoch = getCurrentUserPhysicalNavigationEpoch();
            const document = pdfDocument.value;
            await handleFitScaleModeChange(
                PDF_RERENDER_SOURCE.ZoomMode,
                modeFitMode,
                runId,
                document,
                physicalNavigationEpoch,
                () => (
                    isViewerAsyncRunActive(runId, fitModeRunId, document)
                    && zoomMode.value === mode
                    && fitMode.value === modeFitMode
                ),
                { forceRerender: true },
            );
        })
        : null;

    watch([
        viewMode,
        viewRotation,
    ], async ([
        targetViewMode,
        targetViewRotation,
    ], previous) => {
        const runId = ++viewModeRunId;
        const document = pdfDocument.value;
        const activeNavigationAnchorPage = navigationAnchorPage?.value ?? null;
        if (activeNavigationAnchorPage === null) {
            cancelDestinationNavigationTarget?.();
        }
        if (!document || isLoading.value) {
            return;
        }

        const previousViewRotation = previous?.[1];
        const rotationChanged = previousViewRotation !== undefined
            && targetViewRotation !== previousViewRotation;
        resetContinuousScrollState();
        const updated = computeFitWidthScale(viewerContainer.value);
        if (updated) {
            setupPagePlaceholders();
        }

        void cancelInFlightPageRenders?.();
        await reRenderAllVisiblePages(getVisibleRange, {rerenderSource: rotationChanged
            ? PDF_RERENDER_SOURCE.ViewRotation
            : PDF_RERENDER_SOURCE.ViewMode});
        if (
            !isViewerAsyncRunActive(runId, viewModeRunId, document)
            || viewMode.value !== targetViewMode
            || viewRotation.value !== targetViewRotation
        ) {
            return;
        }
        syncHorizontalScrollAfterLayoutUpdate();
        if (activeNavigationAnchorPage !== null) {
            scrollToPage(activeNavigationAnchorPage, { preferExactDom: true });
        }
        syncHorizontalScrollAfterLayoutUpdate();
    });

    watch(currentPage, async (next, previous) => {
        const runId = ++currentPageFitRerenderRunId;
        const document = pdfDocument.value;
        if (
            next === previous
            || !isCurrentPageFitRerenderModeActive()
            || continuousScroll.value
            || !document
            || isLoading.value
            || isResizing.value
            || pagedNavigationTargetPage?.value === next
        ) {
            return;
        }
        await runCurrentPageFitRerenderTransition(async () => {
            /**
             * Coalesce rapid paged toolbar navigation before rerendering fit modes.
             *
             * Fit-height and fit-width recompute scale on every current-page change.
             * If page 2, 3, ..., 30 each starts its own rerender, those stale jobs can
             * keep bumping the renderer version after a later last-page jump and
             * repeatedly cancel the final page. Waiting a short settle window and
             * checking the run id lets ordinary single-page navigation stay prompt
             * while making the last requested page the only rerender authority.
             */
            await delay(50);
            if (!isCurrentPageFitRerenderRunActive(runId, document, next)) {
                return;
            }
            const range = await prepareFitPageRerenderLayout(runId, document, next, () => (
                isCurrentPageFitRerenderRunActive(runId, document, next)
            ));
            if (!range || !isCurrentPageFitRerenderRunActive(runId, document, next)) {
                return;
            }
            if (fitMode.value === 'height') {
                if (
                    !isCurrentPageFitRerenderRunActive(runId, document, next)
                    || fitMode.value !== 'height'
                ) {
                    return;
                }
                await cancelCurrentPageFitRendersAndWaitForSettle();
                if (
                    !isCurrentPageFitRerenderRunActive(runId, document, next)
                    || fitMode.value !== 'height'
                ) {
                    return;
                }
                await reRenderAllVisiblePages(() => range, {
                    rerenderSource: PDF_RERENDER_SOURCE.FitHeightCurrentPage,
                    renderBufferOverride: 0,
                });
                if (
                    !isCurrentPageFitRerenderRunActive(runId, document, next)
                    || fitMode.value !== 'height'
                ) {
                    return;
                }
                await nextTick();
                syncHorizontalScrollAfterLayoutUpdate();
                return;
            }

            const resizeAnchor = buildResizeAnchorContext({
                preferredAnchorPage: next,
                trustPreferredAnchorPage: true,
            });
            if (
                !isCurrentPageFitRerenderRunActive(runId, document, next)
                || fitMode.value !== 'width'
            ) {
                return;
            }
            await cancelCurrentPageFitRendersAndWaitForSettle();
            if (
                !isCurrentPageFitRerenderRunActive(runId, document, next)
                || fitMode.value !== 'width'
            ) {
                return;
            }
            await reRenderVisiblePagesAndSyncCurrentPage({
                source: PDF_RERENDER_SOURCE.FitWidthCurrentPage,
                stabilize: true,
                resizeAnchor,
            });
        });
    });

    watch(
        () => continuousScroll.value,
        async (next, previous) => {
            const runId = ++continuousScrollRunId;
            const document = pdfDocument.value;
            // Capture the page the user is currently looking at BEFORE any
            // state reset, so the post-toggle snap target reflects the
            // pre-toggle viewport — matching pdf.js's scrollMode setter
            // (which calls _setCurrentPageNumber(currentPageNumber, reset=true)
            // anchored at the page top-left), and Adobe / Preview behavior.
            const pageToSnapTo = getMostVisiblePage(
                viewerContainer.value,
                numPages.value,
            );
            resetContinuousScrollState();
            if (fitMode.value === 'height' && pdfDocument.value) {
                computeFitWidthScale(viewerContainer.value);
            }
            if (
                previous !== next
                && document
                && !isLoading.value
            ) {
                await nextTick();
                if (
                    !isViewerAsyncRunActive(runId, continuousScrollRunId, document)
                    || continuousScroll.value !== next
                ) {
                    return;
                }
                scrollToPage(pageToSnapTo, { preferExactDom: true });
                syncHorizontalScrollAfterLayoutUpdate();
            }
        },
    );

    const stopZoomWatch = watch(zoom, (_nextZoom, previousZoom) => {
        queueZoomOrchestration({
            previousZoom,
            zoomChanged: true,
        });
    });

    function cleanupZoomOrchestration() {
        zoomOrchestrationDisposed = true;
        stopZoomModeWatch?.();
        stopZoomWatch();
        cancelPendingZoomOrchestration();
    }

    return {
        reRenderVisiblePagesAndSyncCurrentPage,
        cleanupZoomOrchestration,
    };
};
