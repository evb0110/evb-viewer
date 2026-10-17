import {getErrorMessage} from '@app/utils/error';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';
import type * as Vue from 'vue';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TPdfRasterDisplayProfile } from '@app/types/pdfRasterDisplayProfile';
import type * as PdfUi from '@app/types/pdfUi';
import type {
    TPdfViewRotation,
    TPdfViewMode,
} from '@app/types/pdfContracts';
import {
    createNativeDocumentRefValue,
    parseDocumentRef,
} from '@contracts/documentRef';
import { runGuardedTask } from '@app/utils/asyncGuard';
import {
    createPdfPageSource,
    type IDocumentViewerRuntime,
    type IDocumentOpenSurfaceRenderOwner,
} from '@app/modules/document-viewer/public';
import { renderPdfDocumentThumbnail } from '@app/modules/pdf-viewer/runtime/renderPdfDocumentThumbnail';
import type { IPdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import { usePdfPageRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer';
import type {IRenderVisiblePagesOptions} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { usePdfCanvasRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer';
import {
    createPdfPageRenderState,
    resolvePdfCommittedRasterQuality,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';
import { getMountedPdfRasterTarget } from '@app/modules/pdf-viewer/runtime/sessions/getMountedPdfRasterTarget';
import type {
    IPdfPageRasterScheduler,
    IPdfRasterDemand,
    IPdfRasterRenderTarget,
    TPdfRasterLane,
} from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import { bindPdfOpenSurfaceRenderContext } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';
import { resolvePdfRasterSourceMaxPixels } from '@app/types/pdfRasterDisplayProfile';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import { usePdfViewerRenderStallRecovery } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerRenderStallRecovery';
import { usePdfViewerActivationRestore } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerActivationRestore';
import { createPdfInitialVisualCommit } from '@app/modules/pdf-viewer/runtime/lifecycle/createPdfInitialVisualCommit';
import { createPdfRasterQualityRefineGate } from '@app/modules/pdf-viewer/runtime/sessions/createPdfRasterQualityRefineGate';
import { resolvePdfRasterJobPages } from '@app/modules/pdf-viewer/runtime/sessions/resolvePdfRasterJobPages';
import type { TPdfDocumentView } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import { createPdfPageTextLayerReadyWaiter } from '@app/modules/pdf-viewer/runtime/sessions/createPdfPageTextLayerReadyWaiter';
import { promotePrioritizedTextLayers } from '@app/modules/pdf-viewer/runtime/sessions/promotePrioritizedTextLayers';
import type {
    IPdfViewportDemand,
    TPdfViewportSession,
} from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type { ILinkAnnotation } from '@app/types/annotations';
import type {
    IPdfViewportRasterJob,
    IViewportRasterJob,
    IPreparedViewportRaster,
    TPdfPageRasterState,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfViewportRasterJob';
const PDF_RASTER_SCALE_RELATIVE_TOLERANCE = 0.000_1;
const singlePageRange = (pageNumber: number) => ({
    start: pageNumber,
    end: pageNumber,
});
export interface ICreatePdfRenderingSessionOptions {
    document: TPdfDocumentView;
    viewport: TPdfViewportSession;
    chassisAuthority: IDocumentViewerRuntime | null;
    openSurfaceRenderOwner: IDocumentOpenSurfaceRenderOwner | undefined;
    performancePolicy: IPdfRenderPerformancePolicy;
    viewerContainer: Vue.Ref<HTMLElement | null>;
    isActive: Vue.ComputedRef<boolean>;
    isResizing: Vue.ComputedRef<boolean>;
    viewMode: Vue.ComputedRef<TPdfViewMode>;
    viewRotation?: Vue.ComputedRef<TPdfViewRotation>;
    outputScale: Vue.Ref<number>;
    rasterDisplayProfile: Vue.ComputedRef<TPdfRasterDisplayProfile | null>;
    bufferPages: Vue.ComputedRef<number>;
    searchPageMatches: Vue.ComputedRef<Map<number, PdfUi.IPdfPageMatches>>;
    currentSearchMatch: Vue.ComputedRef<PdfUi.IPdfSearchMatch | null>;
    currentSearchMatchNavigationId: Vue.ComputedRef<number>;
    workingCopyPath: Vue.ComputedRef<TDocumentRef | null>;
    documentRevisionToken: Vue.ComputedRef<TDocumentRevisionToken | null>;
    maxBufferCanvasPixels: number;
    /** Shared with the annotation session so renderer-owned PDF links reach the portal layer. */
    linkAnnotations?: Vue.Ref<ILinkAnnotation[]> | undefined;
    emitInitialVisualReady: (payload: {pageNumber: TPageNumber}) => void;
    emitLoadError: (error: unknown) => void;
}
export const createPdfRenderingSession = (options: ICreatePdfRenderingSessionOptions) => {
    const documentSession = options.document;
    const viewport = options.viewport;
    // Linked views share one raster scheduler; each view's rasters and
    // thumbnails are its own source and target there.
    const rasterConsumerId = crypto.randomUUID();
    const viewportRasterSourceId = `pdf-viewport:${rasterConsumerId}`;
    const thumbnailRasterSourceId = `pdf-thumbnails:${rasterConsumerId}`;
    const renderedPageStateVersion = ref(0);
    const initialVisual = createPdfInitialVisualCommit({
        chassisAuthority: options.chassisAuthority,
        openSurfaceRenderOwner: options.openSurfaceRenderOwner,
        viewport,
        viewerContainer: options.viewerContainer,
        renderedPageStateVersion,
        isCommittedVisual: pageNumber => isCommittedVisual(pageNumber),
        queueFrame: () => queueFrame(),
        emitInitialVisualReady: options.emitInitialVisualReady,
    });
    const rasterOperational = computed(() => options.isActive.value || viewport.demand.value.mandatoryRaster !== null);
    const toPageNumber = (candidate: number) => requirePageNumber(candidate, documentSession.numPages.value);
    const performanceProfile = getPerformanceProfile();
    const canvasRenderer = usePdfCanvasRenderer({
        outputScale: options.outputScale,
        ...(options.viewRotation === undefined ? {} : {viewRotation: options.viewRotation}),
        defaultMaxCanvasPixels: performanceProfile.settledMaxCanvasPixels,
        prepareAnnotations: (page, coordination) => pageRenderer.prepareCanvasAnnotations(page, coordination?.captureSettlement, coordination?.signal, coordination?.reserveAppearanceBytes),
    });
    const pageRenderState = createPdfPageRenderState();
    const viewportRasterJobs = new Map<string, IViewportRasterJob>();
    let activeRasterScheduler: IPdfPageRasterScheduler | null = null;
    let renderVersion = 0;
    let visibleRenderRequestId = 0;
    let latestDemand: IPdfViewportDemand = viewport.demand.value;
    const rotationPreviewCanvases = new Map<TPageNumber, {
        canvas: HTMLCanvasElement;
        container: HTMLElement;
        canvasStyle: string | null;
        previousPreview: string | null;
    }>();
    const getRevisionSwapInvalidatedPages = () => documentSession.pendingPageMutationRevisionSwap?.invalidatedPages
        ?? (documentSession.activeLoadPlan.isSelectiveReload && documentSession.activeLoadPlan.preserveVisibleContent
            ? documentSession.activeLoadPlan.pagesToInvalidate ?? [] : []);
    const isAwaitingRotationRevision = (pageNumber: number) => {
        const pending = documentSession.pendingPageMutationRevisionSwap;
        const plan = documentSession.activeLoadPlan;
        const expectedRevision = pending?.revision
            ?? (plan?.rotationDelta === undefined ? null : String(options.documentRevisionToken.value ?? ''));
        const affectedPages = pending?.invalidatedPages
            ?? (plan?.isSelectiveReload && plan.rotationDelta !== undefined ? plan.pagesToInvalidate : null);
        const preservesDerivedMetrics = pending?.preservePageMetrics ?? plan?.preservePageMetrics === true;
        return expectedRevision !== null && preservesDerivedMetrics && affectedPages?.includes(pageNumber) === true
            && (String(options.documentRevisionToken.value ?? '') !== expectedRevision
                || documentSession.openSurfaceRevision !== expectedRevision || documentSession.isLoading.value);
    };
    const getRenderDocumentToken = () => `${String(options.workingCopyPath.value ?? '')}\0${String(options.documentRevisionToken.value ?? '')}`;
    const getMountedRasterTarget = (pageNumber: TPageNumber) => getMountedPdfRasterTarget(options.viewerContainer.value, pageNumber);
    const pageTextLayerReadyWaiter = createPdfPageTextLayerReadyWaiter({isReady: pageNumber => (
        pageRenderState.getSlot(pageNumber).textLayerReadiness === 'ready'
        && getMountedRasterTarget(pageNumber)?.container.querySelector<HTMLElement>('.text-layer, .textLayer')
            ?.dataset.pdfTextLayerReady === 'true'
    )});
    function isRasterScaleCurrent(targetScale: number, currentScale: number) {
        return Math.abs(targetScale - currentScale)
            <= Math.max(1, Math.abs(currentScale)) * PDF_RASTER_SCALE_RELATIVE_TOLERANCE;
    }
    function isViewportRasterJobCurrent(job: IPdfViewportRasterJob) {
        return job.targetViewRotation === (options.viewRotation?.value ?? 0)
            && isRasterScaleCurrent(job.targetScale, viewport.scale.effectiveScale.value)
            && isRasterScaleCurrent(job.targetOutputScale, options.outputScale.value);
    }
    function isCommittedVisual(pageNumber: TPageNumber, requireCurrent = true) {
        void renderedPageStateVersion.value;
        const target = getMountedRasterTarget(pageNumber);
        const slot = pageRenderState.getSlot(pageNumber);
        const canvas = slot.committedRender?.canvas;
        if (!target || !canvas) return false;
        const presentable = slot.canvasReadiness === 'ready'
            && slot.container === target.container
            && target.canvasHost.contains(canvas) && canvas.isConnected && canvas.width > 0 && canvas.height > 0;
        if (!presentable || !requireCurrent) return presentable;
        return pageRenderer.isAnnotationInputCurrent(slot.committedRender?.annotationInput)
            && slot.documentToken === getRenderDocumentToken()
            && slot.contentVersion === renderVersion
            && slot.targetViewRotation === (options.viewRotation?.value ?? 0)
            && slot.targetScale !== null
            && isRasterScaleCurrent(slot.targetScale, viewport.scale.effectiveScale.value)
            && slot.targetOutputScale !== null
            && isRasterScaleCurrent(slot.targetOutputScale, options.outputScale.value);
    }
    function getPageRasterState(pageNumber: TPageNumber): TPdfPageRasterState {
        const pendingJob = [...viewportRasterJobs.values()].find(job => (
            job.demand.pageNumber === pageNumber
        ));
        if (pendingJob?.rasterState === 'in-flight' || pendingJob?.rasterState === 'failed') {
            return isViewportRasterJobCurrent(pendingJob) ? pendingJob.rasterState : 'stale-scale';
        }
        if (isCommittedVisual(pageNumber)) {
            return 'current';
        }
        return pageRenderState.renderedPages.has(pageNumber) ? 'stale-scale' : 'absent';
    }
    function isViewportRasterDemanded(pageNumber: TPageNumber, lane?: TPdfRasterLane) {
        const mandatory = latestDemand.mandatoryRaster?.range;
        return latestDemand.operational && (
            latestDemand.currentPage === pageNumber || latestDemand.residentPages.includes(pageNumber)
            || Boolean(mandatory
                && pageNumber >= mandatory.start
                && pageNumber <= mandatory.end)
            || lane === 'navigation-target'
        );
    }
    function isPreparedRasterCurrent(prepared: IPreparedViewportRaster) {
        return !prepared.signal.aborted && viewportRasterJobs.get(prepared.job.demand.renderKey) === prepared.job
            && isViewportRasterJobCurrent(prepared.job)
            && prepared.job.demand.consumerGeneration === renderVersion
            && documentSession.pdfDocument.value !== null
            && (prepared.job.renderOptions.annotationCommit?.isCurrent() ?? pageRenderer.isAnnotationInputCurrent(prepared.render.annotationInput))
            && activeRasterScheduler === documentSession.rasterScheduler
            && prepared.job.demand.documentFence === activeRasterScheduler?.documentFence
            && prepared.container.isConnected !== false
            && prepared.container.dataset.page === String(prepared.job.demand.pageNumber)
            && prepared.canvasHost.closest('.page_container') === prepared.container
            && isViewportRasterDemanded(prepared.job.demand.pageNumber, prepared.job.demand.lane);
    }
    function beginViewportRaster(job: IViewportRasterJob, container: HTMLElement | null) {
        pageRenderState.beginRender(
            job.demand.pageNumber, job.demand.consumerGeneration, job.requestId,
            getRenderDocumentToken(), job.targetScale, job.targetOutputScale, container,
            {
                preserveCommittedVisual: pageRenderState.getSlot(job.demand.pageNumber).canvasReadiness === 'ready',
                targetViewRotation: job.targetViewRotation,
            },
        );
    }
    const viewportRasterTarget: IPdfRasterRenderTarget<IPreparedViewportRaster> = {
        id: viewportRasterSourceId,
        async prepare(demand, page, signal, captureSettlement, reserveAdditionalBytes) {
            const job = viewportRasterJobs.get(demand.renderKey);
            const target = getMountedRasterTarget(demand.pageNumber);
            if (
                !job
                || !target
                || job.demand.consumerGeneration !== renderVersion
                || !isViewportRasterJobCurrent(job)
                || documentSession.pdfDocument.value === null
            ) {
                return null;
            }
            beginViewportRaster(job, target.container);
            const shouldContinue = () => (
                !signal.aborted && demand.consumerGeneration === renderVersion
                && viewportRasterJobs.get(demand.renderKey) === job
                && isViewportRasterJobCurrent(job)
                && (job.renderOptions.annotationCommit?.isCurrent() ?? true)
                && isViewportRasterDemanded(demand.pageNumber, job.demand.lane)
            );
            const sourceMaxPixels = resolvePdfRasterSourceMaxPixels(options.rasterDisplayProfile.value, demand.pageNumber);
            const reserveAppearanceBytes = (bytes: number) => reserveAdditionalBytes(3 * bytes);
            const render = await canvasRenderer.prepareCanvasRender(page, job.targetScale, {
                ...job.renderOptions,
                ...(job.renderOptions.annotationCommit ? {annotationInput: () => job.renderOptions.annotationCommit!.prepare(page, captureSettlement, signal, reserveAppearanceBytes)} : {}),
                hiddenAnnotationIds: () => pageRenderer.canvasHiddenAnnotationIds.value,
                ...(sourceMaxPixels === null ? {} : {sourceMaxPixels}),
                onRenderStall: payload => handlePageRenderStall(payload),
                pageRenderCoordination: {
                    owner: viewportRasterSourceId,
                    priority: 100,
                    signal,
                    shouldStart: shouldContinue,
                    shouldContinue,
                    captureSettlement,
                    reserveAppearanceBytes,
                },
            });
            if (!render || !shouldContinue()) {
                if (render) canvasRenderer.cleanupCanvasRenderResult(render);
                pageRenderState.completeRender(demand.pageNumber, demand.consumerGeneration, job.requestId);
                return null;
            }
            return {
                job,
                ...target,
                signal,
                render,
            };
        },
        start: prepared => prepared.render.startRender(),
        additionalResourceBytes: prepared => prepared.render.additionalResourceBytes,
        onRenderStall: payload => handlePageRenderStall(payload),
        // The scheduler reports exhaustion once; retain any old canvas for Retry.
        onRenderExhausted(outcome) {
            const demand = outcome.demand;
            const pageNumber = demand.pageNumber;
            const job = viewportRasterJobs.get(demand.renderKey);
            if (!job || demand.consumerGeneration !== renderVersion) return;
            job.rasterState = outcome.status === 'failed' ? 'failed' : 'absent';
            if (outcome.status === 'failed') {
                beginViewportRaster(job, pageRenderState.getSlot(pageNumber).container);
                pageRenderState.markRenderFailed(pageNumber, demand.consumerGeneration, job.requestId);
            }
            renderedPageStateVersion.value += 1;
            if (outcome.status !== 'failed') return queueFrame();
            initialVisual.handlePageRasterFailed({
                openSurfaceGeneration: job.renderOptions.openSurfaceGeneration ?? 0,
                documentRevision: job.renderOptions.openSurfaceRevision ?? documentSession.openSurfaceRevision,
                renderVersion: demand.consumerGeneration,
                requestId: job.requestId,
                pageNumber,
            }, getErrorMessage(outcome.error));
            pageRenderer.presentPageRenderFailure(pageNumber, outcome.error, () => cancelInFlightRenders().then(() => renderVisiblePages(singlePageRange(pageNumber), {bufferOverride: 0})), () => demand.lane === 'navigation-target' || viewport.viewportWork.activeWorkKind.value !== 'navigation' && viewport.demand.value.requiredPages.includes(pageNumber));
        },
        async commit(prepared, demand, commitRaster) {
            if (!isPreparedRasterCurrent(prepared) || prepared.job.demand !== demand) {
                return false;
            }
            const pageNumber = demand.pageNumber;
            if (rotationPreviewCanvases.has(pageNumber)) {
                const pageRect = prepared.container.getBoundingClientRect();
                const canvasAspect = prepared.render.canvas.width / prepared.render.canvas.height;
                const pageAspect = pageRect.width / pageRect.height;
                if (
                    !Number.isFinite(canvasAspect)
                    || !Number.isFinite(pageAspect)
                    || canvasAspect <= 0
                    || pageAspect <= 0
                    || Math.abs(Math.log(canvasAspect / pageAspect)) > 0.08
                ) {
                    // The source may still be the pre-mutation PDF while the
                    // new page metrics and Fit Width scale are already active.
                    // Keep the rotated old raster in place until an
                    // aspect-correct raster from the replacement revision is
                    // ready; never expose the interim stretched canvas.
                    return false;
                }
            }
            const previousRender = pageRenderState.getSlot(pageNumber).committedRender;
            const publishRaster = () => {
                if (!isPreparedRasterCurrent(prepared)) return false;
                const annotationCommit = prepared.job.renderOptions.annotationCommit;
                if (annotationCommit) {
                    prepared.render.annotationInput = annotationCommit.commit(prepared.render.annotationInput!);
                    delete prepared.job.renderOptions.annotationCommit;
                }
                if (!pageRenderState.commitVisual(
                    pageNumber, demand.consumerGeneration, prepared.job.requestId,
                    resolvePdfCommittedRasterQuality(prepared.render,
                        prepared.job.renderOptions.contentIntent === 'canvas-only-buffer' ? 'buffer-preview' : 'settled'),
                    prepared.render,
                )) return false;
                canvasRenderer.applyContainerUserUnit(prepared.container, prepared.render.userUnit);
                canvasRenderer.mountCanvas(prepared.canvasHost, prepared.render.canvas, previousRender?.canvas);
                if (!commitRaster()) return false;
                if (previousRender && previousRender.canvas !== prepared.render.canvas) canvasRenderer.cleanupCanvasRenderResult(previousRender);
                prepared.job.rasterState = 'current';
                clearPageRotationPreview(pageNumber, false);
                initialVisual.handlePageCanvasMounted({
                    openSurfaceGeneration: prepared.job.renderOptions.openSurfaceGeneration ?? 0,
                    documentRevision: prepared.job.renderOptions.openSurfaceRevision ?? documentSession.openSurfaceRevision,
                    renderVersion: prepared.job.demand.consumerGeneration,
                    requestId: prepared.job.requestId,
                    pageNumber,
                });
                if (latestDemand.mandatoryRaster && isMandatoryRasterSettled(latestDemand.mandatoryRaster.range, renderVersion)) {
                    viewport.settleMandatoryRaster(latestDemand.mandatoryRaster.id, true);
                }
                return true;
            };
            await pageRenderer.renderCommittedPageLayers({
                pageNumber,
                version: prepared.job.demand.consumerGeneration,
                requestId: prepared.job.requestId,
                scale: prepared.job.targetScale,
                container: prepared.container,
                renderResult: prepared.render,
                signal: prepared.signal,
                renderOptions: prepared.job.renderOptions,
            }, publishRaster);
            return isPreparedRasterCurrent(prepared) && pageRenderState.getSlot(pageNumber).committedRender?.canvas === prepared.render.canvas;
        },
        discard(prepared) {
            const pageNumber = prepared.job.demand.pageNumber;
            if (pageRenderState.getSlot(pageNumber).committedRender === prepared.render) return;
            canvasRenderer.cleanupCanvasRenderResult(prepared.render);
            const generation = prepared.job.demand.consumerGeneration;
            if (!isPreparedRasterCurrent(prepared)) pageRenderState.completeRender(pageNumber, generation, prepared.job.requestId);
        },
        release(pageNumber) {
            if (!isViewportRasterDemanded(pageNumber)) clearAuthoritativePage(pageNumber, false);
        },
    };
    function buildViewportRasterJobs(range: PdfUi.IPageRange, renderOptions: IRenderVisiblePagesOptions, scheduler: IPdfPageRasterScheduler) {
        const buffer = renderOptions.bufferOverride ?? options.bufferPages.value;
        const override = renderOptions.renderWindowOverride;
        const start = Math.max(1, Math.min(range.start, range.start - buffer, override?.start ?? range.start));
        const end = Math.min(documentSession.numPages.value, Math.max(range.end, range.end + buffer, override?.end ?? range.end));
        const scale = viewport.scale.effectiveScale.value;
        const outputScale = options.outputScale.value;
        const jobs: IPdfViewportRasterJob[] = [];
        const pageNumbers = resolvePdfRasterJobPages({
            start,
            end,
            totalPages: documentSession.numPages.value,
            explicitPages: renderOptions.rasterDemandPages,
        }).map(toPageNumber);
        for (const pageNumber of pageNumbers) {
            if (isAwaitingRotationRevision(pageNumber)) {
                continue;
            }
            const metric = documentSession.pageMetrics.value[pageNumber - 1];
            const width = metric?.width ?? documentSession.basePageWidth.value ?? 1;
            const height = metric?.height ?? documentSession.basePageHeight.value ?? 1;
            const requestedPixels = Math.max(1, Math.ceil(width * scale * outputScale))
                * Math.max(1, Math.ceil(height * scale * outputScale));
            const visible = pageNumber >= range.start && pageNumber <= range.end;
            const distance = Math.min(Math.abs(pageNumber - range.start), Math.abs(pageNumber - range.end));
            const lane: TPdfRasterLane = visible
                ? renderOptions.authoritativeRaster === true ? 'navigation-target' : 'viewport-visible'
                : distance <= 1 ? 'viewport-nearby' : 'prefetch';
            const maxCanvasPixels = renderOptions.bufferMaxCanvasPixels ?? renderOptions.maxCanvasPixels;
            const pageRenderOptions = lane === 'viewport-nearby' || lane === 'prefetch' ? {
                ...renderOptions,
                contentIntent: 'canvas-only-buffer' as const,
                ...(maxCanvasPixels !== undefined
                    ? {maxCanvasPixels}
                    : {}),
            } : renderOptions.annotationCommit ? renderOptions : [...viewportRasterJobs.values()].find(job => (
                job.demand.pageNumber === pageNumber && job.renderOptions.annotationCommit?.isCurrent() && isViewportRasterJobCurrent(job)
            ))?.renderOptions ?? renderOptions;
            const committedRasterState = getPageRasterState(pageNumber);
            // A forced rerender replaces current pixels after content changes; it and a
            // deliberate navigation target also retry a page whose earlier raster failed.
            const rasterState = (committedRasterState === 'current' || committedRasterState === 'failed')
                && (renderOptions.forceRerender === true || renderOptions.annotationCommit) || committedRasterState === 'failed' && lane === 'navigation-target'
                ? 'stale-scale' : committedRasterState;
            const rasterIdentity = [
                renderVersion,
                pageNumber,
                outputScale,
                options.viewRotation?.value ?? 0,
                getRenderDocumentToken(),
                pageRenderOptions.contentIntent ?? 'full-visible',
                pageRenderOptions.maxCanvasPixels ?? '',
                pageRenderOptions.openSurfaceGeneration ?? '',
                pageRenderOptions.openSurfaceRevision ?? '',
                pageRenderOptions.annotationCommit?.signature ?? pageRenderer.annotationPaintSignature.value,
            ].join(':');
            // An in-flight raster is already scale-current within tolerance.
            // Keep its key so float drift in a recomputed fit cannot orphan it.
            const retainedJob = [...viewportRasterJobs.values()].find(job => job.demand.pageNumber === pageNumber && (
                rasterState === 'in-flight'
                    ? job.rasterIdentity === rasterIdentity
                    : rasterState === 'current' && renderOptions.contentIntent !== 'canvas-only-refine'
            ));
            const requestId = retainedJob?.requestId ?? ++visibleRenderRequestId;
            const demand: IPdfRasterDemand = {
                consumerGeneration: renderVersion,
                documentFence: scheduler.documentFence,
                estimatedPixels: Math.min(requestedPixels,
                    pageRenderOptions.maxCanvasPixels ?? performanceProfile.settledMaxCanvasPixels),
                lane,
                ordinal: visible
                    ? pageNumber - range.start
                    : distance,
                pageNumber,
                renderKey: retainedJob?.demand.renderKey ?? `${rasterIdentity}:${String(scale)}:${requestId}`,
                retention: 'render-cache',
            };
            const existing = rasterState === 'in-flight' || rasterState === 'current' && pageRenderOptions.contentIntent !== 'canvas-only-refine'
                ? viewportRasterJobs.get(demand.renderKey) : undefined;
            const job = existing ?? {
                requestId,
                demand,
                rasterIdentity,
                rasterState: rasterState === 'in-flight' ? 'absent' : rasterState,
                renderOptions: pageRenderOptions,
                targetOutputScale: outputScale,
                targetScale: scale,
                targetViewRotation: options.viewRotation?.value ?? 0,
            };
            Object.assign(job.demand, demand);
            job.renderOptions = pageRenderOptions;
            job.targetOutputScale = outputScale;
            job.targetScale = scale;
            if (rasterState !== 'in-flight') job.rasterState = rasterState;
            viewportRasterJobs.set(demand.renderKey, job);
            jobs.push(job);
        }
        return jobs;
    }
    function renderVisiblePages(range: PdfUi.IPageRange, options: IRenderVisiblePagesOptions & {annotationCommit: NonNullable<IRenderVisiblePagesOptions['annotationCommit']>}): Promise<Array<Awaited<ReturnType<IPdfPageRasterScheduler['request']>>> | undefined>;
    function renderVisiblePages(range: PdfUi.IPageRange, options?: IRenderVisiblePagesOptions): Promise<void>;
    async function renderVisiblePages(
        range: PdfUi.IPageRange,
        requestedRenderOptions: IRenderVisiblePagesOptions = {},
    ) {
        await pendingRasterCancellation;
        const renderOptions = bindPdfOpenSurfaceRenderContext(
            requestedRenderOptions,
            {
                openSurfaceGeneration: documentSession.openSurfaceGeneration,
                openSurfaceRevision: documentSession.openSurfaceRevision,
            },
        ) ?? {};
        if (renderOptions.contentIntent === 'layers-only-promotion') {
            return pageRenderer.renderLayerPromotions(range, renderOptions);
        }
        const document = documentSession.pdfDocument.value;
        if (!document || !rasterOperational.value) {
            return;
        }
        const didHydrateMetrics = await documentSession.ensurePageMetricsInRange(range.start, range.end);
        if (
            document !== documentSession.pdfDocument.value
            || !rasterOperational.value
        ) {
            return;
        }
        if (didHydrateMetrics) viewport.setupPagePlaceholders();
        const scheduler = documentSession.rasterScheduler;
        if (!scheduler || document !== documentSession.pdfDocument.value) {
            return;
        }
        activeRasterScheduler = scheduler;
        const residentJobs = renderOptions.suppressResidentRasterDemand !== true && latestDemand.operational && latestDemand.residentPages.length
            ? buildViewportRasterJobs(latestDemand.visibleRange, {
                bufferMaxCanvasPixels: options.maxBufferCanvasPixels,
                openSurfaceGeneration: documentSession.openSurfaceGeneration,
                openSurfaceRevision: documentSession.openSurfaceRevision,
                rasterDemandPages: latestDemand.residentPages,
                renderWindowOverride: {
                    start: Math.min(...latestDemand.residentPages),
                    end: Math.max(...latestDemand.residentPages),
                },
            }, scheduler) : [];
        const residentPages = new Set(residentJobs.map(job => job.demand.pageNumber));
        const preservedRenderedJobs = renderOptions.preserveRenderedPages === true
            ? [...pageRenderState.renderedPages]
                .filter(pageNumber => !residentPages.has(pageNumber))
                .flatMap(pageNumber => buildViewportRasterJobs(singlePageRange(pageNumber), {
                    ...renderOptions,
                    bufferOverride: 0,
                    rasterDemandPages: [pageNumber],
                    renderWindowOverride: singlePageRange(pageNumber),
                }, scheduler))
            : [];
        const requestedJobs = buildViewportRasterJobs(range, renderOptions, scheduler);
        const requestedPages = new Set(requestedJobs.map(job => job.demand.pageNumber));
        const jobs = [
            ...residentJobs.filter(job => (
                !requestedPages.has(job.demand.pageNumber)
                && (!renderOptions.retainOnlyCurrentResidentRaster || job.rasterState === 'current')
            )),
            ...preservedRenderedJobs.filter(job => (
                !requestedPages.has(job.demand.pageNumber)
                && (!renderOptions.retainOnlyCurrentResidentRaster || job.rasterState === 'current')
            )),
            ...requestedJobs,
        ];
        const demandKeys = new Set(jobs.map(job => job.demand.renderKey));
        for (const key of viewportRasterJobs.keys()) {
            if (!demandKeys.has(key)) {
                viewportRasterJobs.delete(key);
            }
        }
        const schedulableJobs = jobs
            .filter(job => job.rasterState !== 'failed');
        schedulableJobs.filter(job => (job.rasterState === 'absent' || job.rasterState === 'stale-scale'
            || job.renderOptions.contentIntent === 'canvas-only-refine')).forEach((job) => {job.rasterState = 'in-flight';});
        scheduler.setDemand({
            sourceId: viewportRasterSourceId,
            input: schedulableJobs.map(job => job.demand),
            policy: {
                expand: (input: readonly IPdfRasterDemand[]) => input,
                compareWithinLane: (left: IPdfRasterDemand, right: IPdfRasterDemand) => left.ordinal - right.ordinal,
            },
            target: viewportRasterTarget,
        });
        const outcomes = await Promise.all(schedulableJobs.filter(job => requestedPages.has(job.demand.pageNumber)).map(job => scheduler.request({
            sourceId: viewportRasterSourceId,
            demand: job.demand,
            target: viewportRasterTarget,
        })));
        const failed = outcomes.find(outcome => outcome.status === 'failed');
        if (requestedRenderOptions.annotationCommit && failed?.status === 'failed') throw failed.error;
        await promotePrioritizedTextLayers(pageRenderer, [...requestedPages].filter(page => page >= range.start && page <= range.end), renderOptions);
        // The committed canvas is mounted synchronously, but the page
        // container's rendered class controls its visibility through Vue.
        // Do not release navigation readiness until that projection has
        // reached the DOM, otherwise scroll can expose the hidden canvas for
        // one compositor frame.
        await nextTick();
        return outcomes;
    }
    const pageRenderer = usePdfPageRenderer({
        container: options.viewerContainer,
        document: documentSession,
        viewport,
        ...(options.viewRotation === undefined ? {} : {viewRotation: options.viewRotation}),
        isActive: rasterOperational,
        outputScale: options.outputScale,
        searchPageMatches: options.searchPageMatches,
        currentSearchMatch: options.currentSearchMatch,
        currentSearchMatchNavigationId: options.currentSearchMatchNavigationId,
        workingCopyPath: options.workingCopyPath,
        documentRevisionToken: options.documentRevisionToken,
        linkAnnotations: options.linkAnnotations,
        onRenderedPageStateChanged: () => {
            renderedPageStateVersion.value += 1;
            pageTextLayerReadyWaiter.resolveReady();
            // Reconcile search marks when a target text layer commits. The
            // renderer preserves the outgoing current mark while this target
            // is still hydrating, then clears it in the same refresh that paints
            // the target mark.
            pageRenderer?.applySearchHighlights();
            queueFrame();
        },
        pageRenderState,
        getRenderVersion: () => renderVersion,
        getRenderDocumentToken,
        getCommittedRender: pageNumber => isCommittedVisual(pageNumber) ? pageRenderState.getSlot(pageNumber).committedRender : null,
        requestSearchPageRaster: async (pageNumber, replace) => {
            if (replace) await cancelInFlightRenders();
            return renderVisiblePages(singlePageRange(pageNumber), {
                bufferOverride: 0,
                prioritizeTextLayer: true,
                ...(replace ? {forceRerender: true} : {}),
            });
        },
    });
    function bumpRenderVersion(
        reauthorizeCommittedCanvases = true,
        excludedPages: readonly number[] = getRevisionSwapInvalidatedPages(),
    ) {
        renderVersion += 1;
        viewportRasterJobs.clear();
        if (reauthorizeCommittedCanvases) {
            pageRenderer.adoptCommittedCanvasVersions(
                renderVersion,
                getRenderDocumentToken(),
                excludedPages.map(page => requirePageNumber(page)),
            );
        }
        renderedPageStateVersion.value += 1;
        return renderVersion;
    }
    function cancelRasterDemand() {
        viewportRasterJobs.clear();
        return activeRasterScheduler?.cancelSource(viewportRasterSourceId) ?? Promise.resolve();
    }
    async function cancelInFlightRenders() {
        const cancellation = cancelRasterDemand();
        bumpRenderVersion();
        await cancellation;
    }
    let pendingRasterCancellation = Promise.resolve();
    const stopAnnotationPaintWatch = watch(pageRenderer.annotationPaintSignature, queueFrame, {flush: 'post'});
    // Persist-only revisions reauthorize pixels; replacement documents do not.
    // The load path nulls the document first, so authority tracks the last loaded document instead of the watcher's previous value.
    let canvasAuthority = {
        document: documentSession.pdfDocument.value,
        token: getRenderDocumentToken(),
    };
    const stopRevisionReauthorizationWatch = watch(
        [
            getRenderDocumentToken,
            documentSession.pdfDocument,
        ],
        ([
            token,
            document,
        ]) => {
            if (document === null) {
                return;
            }
            const previous = canvasAuthority;
            canvasAuthority = {
                document,
                token,
            };
            if (document !== previous.document) {
                if (previous.document !== null) {
                    const isPreservedSelectiveReload = documentSession.activeLoadPlan.isSelectiveReload
                        && documentSession.activeLoadPlan.preserveVisibleContent;
                    const invalidatedPages = isPreservedSelectiveReload
                        ? documentSession.activeLoadPlan.pagesToInvalidate ?? []
                        : [];
                    bumpRenderVersion(isPreservedSelectiveReload, invalidatedPages);
                }
            } else if (token !== previous.token) {
                bumpRenderVersion(true, []);
            }
        },
        {flush: 'post'},
    );
    function clearPageRotationPreview(pageNumber: TPageNumber, restoreCanvasStyle: boolean) {
        const preview = rotationPreviewCanvases.get(pageNumber);
        if (!preview) {
            return;
        }
        if (restoreCanvasStyle && preview.canvas.isConnected) {
            if (preview.canvasStyle === null) {
                preview.canvas.removeAttribute('style');
            } else {
                preview.canvas.setAttribute('style', preview.canvasStyle);
            }
        }
        if (preview.container.dataset.pageMutationPreview === 'rotation') {
            if (preview.previousPreview === null) {
                delete preview.container.dataset.pageMutationPreview;
            } else {
                preview.container.dataset.pageMutationPreview = preview.previousPreview;
            }
        }
        rotationPreviewCanvases.delete(pageNumber);
    }
    function preparePageRotationPreview(pages: readonly number[], rotationDelta: 90 | 180 | 270) {
        const isQuarterTurn = rotationDelta === 90 || rotationDelta === 270;
        let preparedCount = 0;
        for (const candidate of pages) {
            if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > documentSession.numPages.value) {
                continue;
            }
            const pageNumber = requirePageNumber(candidate, documentSession.numPages.value);
            if (rotationPreviewCanvases.has(pageNumber)) {
                preparedCount += 1;
                continue;
            }
            const canvas = pageRenderState.getSlot(pageNumber).committedRender?.canvas;
            const target = getMountedRasterTarget(pageNumber);
            if (!canvas || !target || !canvas.isConnected || !target.canvasHost.contains(canvas)) {
                continue;
            }
            const pageRect = target.container.getBoundingClientRect();
            if (pageRect.width <= 0 || pageRect.height <= 0) {
                continue;
            }
            rotationPreviewCanvases.set(pageNumber, {
                canvas,
                container: target.container,
                canvasStyle: canvas.getAttribute('style'),
                previousPreview: target.container.dataset.pageMutationPreview ?? null,
            });
            const previewWidth = isQuarterTurn ? pageRect.height : pageRect.width;
            const previewHeight = isQuarterTurn ? pageRect.width : pageRect.height;
            canvas.style.setProperty('position', 'absolute', 'important');
            canvas.style.setProperty('left', '50%', 'important');
            canvas.style.setProperty('top', '50%', 'important');
            canvas.style.setProperty('width', `${previewWidth}px`, 'important');
            canvas.style.setProperty('height', `${previewHeight}px`, 'important');
            canvas.style.setProperty(
                'transform',
                `translate(-50%, -50%) rotate(${rotationDelta}deg)`,
                'important',
            );
            canvas.style.setProperty('transform-origin', 'center center', 'important');
            target.container.dataset.pageMutationPreview = 'rotation';
            preparedCount += 1;
        }
        if (preparedCount > 0) {
            renderedPageStateVersion.value += 1;
            queueFrame();
        }
        return preparedCount > 0;
    }
    function cancelPageRotationPreview(pages: readonly number[]) {
        let didCancel = false;
        for (const pageNumber of pages) {
            if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
                continue;
            }
            const brandedPageNumber = requirePageNumber(pageNumber);
            if (!rotationPreviewCanvases.has(brandedPageNumber)) {
                continue;
            }
            clearPageRotationPreview(brandedPageNumber, true);
            didCancel = true;
        }
        if (didCancel) {
            renderedPageStateVersion.value += 1;
            queueFrame();
        }
        return didCancel;
    }
    function clearAuthoritativePage(pageNumber: TPageNumber, invalidateScheduler = true) {
        clearPageRotationPreview(pageNumber, true);
        for (const key of viewportRasterJobs.keys()) {
            if (viewportRasterJobs.get(key)?.demand.pageNumber === pageNumber) viewportRasterJobs.delete(key);
        }
        if (invalidateScheduler) {
            activeRasterScheduler?.invalidate({
                pages: [pageNumber],
                reason: 'viewport-page-released',
                sourceId: viewportRasterSourceId,
            });
        }
        const render = pageRenderState.getSlot(pageNumber).committedRender;
        if (render) canvasRenderer.cleanupCanvasRenderResult(render);
        pageRenderState.clearPage(pageNumber);
        pageRenderer.releasePageLayers(pageNumber);
        const target = getMountedRasterTarget(pageNumber);
        if (target) {
            target.canvasHost.replaceChildren();
            const skeleton = target.container.querySelector<HTMLElement>('.document-page-skeleton');
            if (skeleton) skeleton.style.display = '';
        }
        documentSession.evictPage(pageNumber);
        renderedPageStateVersion.value += 1;
    }
    // Drops every page this view shows, with its rasters on the scheduler;
    // another view keeps its own, and the document owns the page cache.
    async function cleanupRenderedPages() {
        const release = activeRasterScheduler?.releaseSource(viewportRasterSourceId);
        bumpRenderVersion();
        new Set([
            ...pageRenderState.renderedPages,
            ...pageRenderState.renderingPages.keys(),
        ]).forEach(pageNumber => clearAuthoritativePage(pageNumber, false));
        await Promise.all([
            release,
            pageRenderer.cleanupAllLayers(),
        ]);
    }
    function isPageRenderFailed(pageNumber: TPageNumber) {
        const slot = pageRenderState.getSlot(pageNumber);
        return slot.job === 'failed' && slot.version === renderVersion;
    }
    // Unsettled only while a range page this pass could paint (mounted, given a job, not failed) has no
    // pixels at the current scale, as when Fit Width moved the scale under it; a retired version settles.
    function isMandatoryRasterSettled(range: PdfUi.IPageRange, version: number) {
        const lastPage = Math.min(range.end, documentSession.numPages.value);
        const pages = Array.from({length: Math.max(0, lastPage - range.start + 1)}, (_, index) => toPageNumber(range.start + index));
        return version !== renderVersion || pages.every(page => !getMountedRasterTarget(page)
            || isCommittedVisual(page) || isPageRenderFailed(page) || isAwaitingRotationRevision(page));
    }
    let frameId: number | null = null;
    let disposed = false;
    let mandatoryDemandTaskId: number | null = null;
    function queueMandatoryDemandTask() {
        if (disposed || mandatoryDemandTaskId !== null) {
            return;
        }
        mandatoryDemandTaskId = window.setTimeout(() => {
            mandatoryDemandTaskId = null;
            if (!disposed) reconcileDemand();
        }, 0);
    }
    const qualityRefineGate = createPdfRasterQualityRefineGate({
        getClampedVisibleRefineMode: () => options.performancePolicy.clampedVisibleRefineMode,
        getUserViewportInteractionEpoch: () => viewport.userViewportInteractionEpoch.value,
        hasActiveTransaction: () => viewport.viewportWork.activeWorkKind.value !== null,
        requestReconcileFrame: () => queueFrame(),
    });
    function queueFrame() {
        if (disposed || frameId !== null) {
            return;
        }
        frameId = window.requestAnimationFrame(() => {
            frameId = null;
            reconcileDemand();
        });
    }
    function reconcileDemand() {
        qualityRefineGate.synchronizeViewportInteractionEpoch();
        const demand = latestDemand;
        if (!demand.operational) {
            if (demand.mandatoryRaster) {
                viewport.settleMandatoryRaster(demand.mandatoryRaster.id, true);
            }
            void cancelRasterDemand();
            return;
        }
        const mandatory = demand.mandatoryRaster;
        if (mandatory) {
            const version = renderVersion;
            void renderVisiblePages(mandatory.range, mandatory.options).finally(() => (
                viewport.settleMandatoryRaster(mandatory.id, isMandatoryRasterSettled(mandatory.range, version))
            ));
            return;
        }
        const requiredPages = demand.requiredPages.map(toPageNumber);
        const requiredStates = requiredPages.map(getPageRasterState);
        // While a pane edge is dragged the scale changes every frame. Stretch
        // the committed canvases and raster the settled scale once.
        if (options.isResizing.value && !requiredStates.includes('absent')) {
            return;
        }
        const repairPages = requiredPages.filter((_, index) => requiredStates[index] === 'stale-scale');
        const rasterPages = repairPages.length ? repairPages : demand.residentPages;
        const rasterRange = repairPages.length ? {
            start: Math.min(...repairPages),
            end: Math.max(...repairPages),
        } : demand.visibleRange;
        void renderVisiblePages(rasterRange, {
            bufferMaxCanvasPixels: options.maxBufferCanvasPixels,
            rasterDemandPages: rasterPages,
            ...(repairPages.length ? {
                forceRerender: true,
                retainOnlyCurrentResidentRaster: true,
                renderWindowOverride: rasterRange,
            } : {}),
        });
        if (repairPages.length || requiredStates.includes('absent')) {
            return;
        }
        if (requiredStates.some(state => state === 'in-flight' || state === 'failed')) {
            return;
        }
        const promotion = pageRenderer.resolveLayerPromotionDemand(requiredPages);
        if (promotion) {
            qualityRefineGate.clearIdleTimer();
            void renderVisiblePages(promotion.range, promotion.options);
            return;
        }
        const refinePage = requiredPages.find((page) => {
            const slot = pageRenderState.getSlot(page);
            return slot.job === 'idle'
                && slot.committedRasterQuality?.wasClamped === true
                && slot.committedRasterQuality.intent === 'buffer-preview';
        });
        if (refinePage === undefined || !qualityRefineGate.canRefineVisibleRaster()) {
            return;
        }
        qualityRefineGate.clearIdleTimer();
        void renderVisiblePages(singlePageRange(refinePage), {
            bufferOverride: 0,
            contentIntent: 'canvas-only-refine',
            forceRerender: true,
            rasterDemandPages: [refinePage],
        });
    }
    const stopDemandWatch = watch(viewport.demand, (demand) => {
        latestDemand = demand;
        if (demand.mandatoryRaster) {
            if (frameId !== null) {
                window.cancelAnimationFrame(frameId);
                frameId = null;
            }
            queueMandatoryDemandTask();
            return;
        }
        queueFrame();
    }, {
        flush: 'sync',
        immediate: true,
    });
    const stopCancelRasterWatch = watch(viewport.cancelRasterRevision, () => {
        pendingRasterCancellation = pendingRasterCancellation.then(() => cancelInFlightRenders());
    }, {flush: 'sync'});
    const stopVisualReadyWatch = watch(viewport.visualReadySignal, (signal, previous) => {
        if (signal.revision !== previous.revision && signal.pageNumber !== null) {
            initialVisual.adoptResidentCanvas(requirePageNumber(signal.pageNumber, documentSession.numPages.value));
        }
    }, {flush: 'sync'});
    const chassisOpenSurface = options.chassisAuthority?.openSurface;
    const stopOpenSurfaceResidentAdoptionWatch = chassisOpenSurface
        ? watch(
            [
                () => chassisOpenSurface.snapshot.value.generation,
                () => chassisOpenSurface.viewportSession.value.requestedPage,
                renderedPageStateVersion,
                options.viewerContainer,
                options.isActive,
            ],
            () => {
                const snapshot = chassisOpenSurface.snapshot.value;
                if (
                    snapshot.committedRender === null
                    && (
                        snapshot.phase === 'pending'
                        || snapshot.phase === 'geometry-committed'
                    )
                ) {
                    initialVisual.adoptResidentCanvas(requirePageNumber(chassisOpenSurface.viewportSession.value.requestedPage));
                } else if (snapshot.committedRender !== null) {
                    initialVisual.reconcileInitialVisual();
                }
            },
            {
                flush: 'post',
                immediate: true,
            },
        )
        : () => {};
    const stopNavigationCommitWatch = watch(viewport.navigationCommittedSignal, (signal, previous) => {
        if (signal.revision !== previous.revision) {
            initialVisual.reconcileInitialVisual();
        }
    }, {flush: 'sync'});
    const {
        resetRenderStallRecoveryState,
        invalidatePages,
        handlePageRenderStall,
    } = usePdfViewerRenderStallRecovery({
        src: computed(() => documentSession.acceptedSource.value),
        numPages: documentSession.numPages,
        currentPage: viewport.currentPage,
        visibleRange: viewport.visibleRange,
        viewerContainer: options.viewerContainer,
        summarizeViewerMetricsForLog: viewport.summarizeViewerMetricsForLog,
    });
    const {
        nextActivationRestoreRunId,
        isActivationRunCurrent,
        renderActiveDocumentAfterActivation,
    } = usePdfViewerActivationRestore({
        viewerContainer: options.viewerContainer,
        pdfDocument: documentSession.pdfDocument,
        isActive: options.isActive,
        isLoading: documentSession.isLoading,
        numPages: documentSession.numPages,
        currentPage: viewport.currentPage,
        visibleRange: viewport.visibleRange,
        viewMode: options.viewMode,
        getVisiblePageRange: viewport.scroll.getVisiblePageRange,
        renderVisiblePages,
        applySearchHighlights: pageRenderer.applySearchHighlights,
    });
    function waitForLoadedDocument(signal: AbortSignal) {
        const isLoaded = () => documentSession.pdfDocument.value !== null && !documentSession.isLoading.value;
        if (isLoaded()) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const stop = watch(isLoaded, (loaded) => {
                if (loaded) {
                    stop();
                    signal.removeEventListener('abort', abort);
                    resolve();
                }
            });
            function abort() {
                stop();
                reject(signal.reason);
            }
            signal.addEventListener('abort', abort, {once: true});
        });
    }
    // The chassis page source. A reload of the same document keeps the bound
    // source until its successor is ready, so the rail keeps its thumbnails
    // through a save.
    watch(
        [
            documentSession.pdfDocument,
            documentSession.acceptedSource,
            options.workingCopyPath,
        ],
        ([
            document,
            source,
            documentRef,
        ], _previous, onCleanup) => {
            const authority = options.chassisAuthority;
            if (!authority || !document) {
                if (!source && authority?.source.value?.kind === 'pdf') {
                    authority.bindSource(null);
                }
                return;
            }
            // The source outlives its document while a reload runs; a page it
            // asks for then belongs to no document, which is no render failure.
            const refuseReplaced = () => {
                if (documentSession.pdfDocument.value !== document) {
                    throw new DOMException('The PDF document was replaced', 'AbortError');
                }
            };
            const pageSource = createPdfPageSource({
                documentRef: documentRef
                    ?? (typeof source === 'string' ? parseDocumentRef(source) : null)
                    ?? createNativeDocumentRefValue('/memory/pdf').path,
                pdfDocument: document,
                getPage: (pageNumber) => {
                    refuseReplaced();
                    return documentSession.getPage(requirePageNumber(pageNumber, document.numPages));
                },
                // The page geometry, including a rotation preview.
                getPageMetrics: async (pageNumber) => {
                    await documentSession.ensurePageMetricsInRange(pageNumber, pageNumber);
                    const metric = documentSession.pageMetrics.value[pageNumber - 1];
                    return metric && {
                        widthPoints: metric.width,
                        heightPoints: metric.height,
                        rotation: ((Math.round((metric.rotation ?? 0) / 90) * 90 % 360 + 360) % 360) as 0 | 90 | 180 | 270,
                    };
                },
                renderThumbnail: async (request) => {
                    refuseReplaced();
                    await waitForLoadedDocument(request.signal);
                    const scheduler = documentSession.rasterScheduler;
                    if (!scheduler) throw new DOMException('The PDF document closed', 'AbortError');
                    return renderPdfDocumentThumbnail({
                        surfaceBudget: authority.surfaceBudget,
                        scheduler,
                        sourceId: thumbnailRasterSourceId,
                        request,
                        rotation: documentSession.pageMetrics.value[request.pageNumber - 1]?.rotation,
                        hiddenAnnotationIds: pageRenderer.thumbnailHiddenAnnotationIds.value,
                    });
                },
            });
            authority.bindSource(pageSource);
            onCleanup(() => pageSource.dispose());
        },
        {immediate: true},
    );
    const unsubscribeDocumentTransitions = documentSession.subscribe(async (transition) => {
        if (!transition.isCurrent()) {
            return;
        }
        if (transition.phase === 'loading') {
            initialVisual.setPendingReadyToken(transition.fence.loadToken);
            initialVisual.reconcileInitialVisual();
            if (transition.plan.isSelectiveReload && transition.plan.pagesToInvalidate) {
                for (const pageNumber of transition.plan.pagesToInvalidate) {
                    const brandedPage = requirePageNumber(pageNumber);
                    if (!transition.plan.preserveVisibleContent) {
                        clearAuthoritativePage(brandedPage);
                    }
                }
            } else if (!transition.plan.preserveVisibleContent) {
                await cleanupRenderedPages();
            }
        } else if (transition.phase === 'invalidated') {
            initialVisual.setPendingReadyToken(null);
            pageRenderer.cancelPendingSearchScroll();
            await cancelInFlightRenders();
            if (!transition.isSameDocumentRewrite) {
                await cleanupRenderedPages();
            }
        } else if (transition.phase === 'restore') {
            const runId = nextActivationRestoreRunId();
            if (!isActivationRunCurrent(runId)) {
                return;
            }
            runGuardedTask(() => renderActiveDocumentAfterActivation(runId), {
                category: 'user-visible-operation',
                scope: 'pdf-viewer',
                message: 'Failed to restore PDF rendering after tab activation',
            });
        } else if (transition.phase === 'settled') {
            await nextTick();
            if (transition.isCurrent()) {
                pageRenderer.applySearchHighlights();
            }
        }
    });
    documentSession.registerDisposable(async () => {
        disposed = true;
        if (options.chassisAuthority?.source.value?.kind === 'pdf') {
            options.chassisAuthority.bindSource(null);
        }
        unsubscribeDocumentTransitions();
        stopDemandWatch();
        stopCancelRasterWatch();
        stopVisualReadyWatch();
        stopOpenSurfaceResidentAdoptionWatch();
        stopNavigationCommitWatch();
        stopRevisionReauthorizationWatch();
        stopAnnotationPaintWatch();
        if (frameId !== null) {
            window.cancelAnimationFrame(frameId);
        }
        if (mandatoryDemandTaskId !== null) window.clearTimeout(mandatoryDemandTaskId);
        qualityRefineGate.clearIdleTimer();
        resetRenderStallRecoveryState();
        initialVisual.setPendingReadyToken(null);
        await cancelRasterDemand();
        pageTextLayerReadyWaiter.settleAll();
        await cleanupRenderedPages(); pageRenderer.dispose();
    });
    return {
        ...pageRenderer,
        renderVisiblePages,
        async publishAnnotationPaint(
            pageNumber: TPageNumber,
            annotationCommit: NonNullable<IRenderVisiblePagesOptions['annotationCommit']>,
        ) {
            if (!rasterOperational.value || !getMountedRasterTarget(pageNumber) || !isViewportRasterDemanded(pageNumber)) return false;
            const outcomes = await renderVisiblePages(singlePageRange(pageNumber), {
                bufferOverride: 0,
                annotationCommit,
            });
            if (!outcomes?.some(outcome => outcome.demand.pageNumber === pageNumber && outcome.status === 'committed')) {
                throw new DOMException('The accepted annotation paint was not published', 'AbortError');
            }
            return true;
        },
        cancelInFlightRenders,
        preparePageRotationPreview,
        cancelPageRotationPreview,
        releaseUnmountedPage: (pageNumber: TPageNumber) => clearAuthoritativePage(pageNumber),
        isPageRendered: (pageNumber: TPageNumber) => pageRenderState.getSlot(pageNumber).canvasReadiness === 'ready',
        isPageRendering: (pageNumber: TPageNumber) => pageRenderState.getSlot(pageNumber).job === 'rendering',
        waitForPageTextLayerReady: pageTextLayerReadyWaiter.waitForPageTextLayerReady,
        renderedPageStateVersion,
        isPageVisualReady: (pageNumber: TPageNumber) => isCommittedVisual(pageNumber),
        getCommittedPageScale: (pageNumber: TPageNumber) => isCommittedVisual(pageNumber, false)
            ? pageRenderState.getSlot(pageNumber).targetScale
            : null,
        isPageRenderedForClass: (pageNumber: TPageNumber) => isCommittedVisual(pageNumber, false)
            && (!latestDemand.requiredPages.includes(pageNumber) || (pageRenderState.getSlot(pageNumber).textLayerReadiness === 'ready'
                && getMountedRasterTarget(pageNumber)?.container.querySelector<HTMLElement>('.text-layer')?.dataset.pdfTextLayerReady === 'true')
                || (pageRenderState.getSlot(pageNumber).layerReadiness === 'canvas-only' && pageRenderState.getSlot(pageNumber).job === 'idle'
                    && pageRenderState.getSlot(pageNumber).committedRasterQuality?.intent === 'settled')),
        isOriginalAppearance: pageRenderState.isOriginalAppearance,
        getCommittedAnnotationInput: (pageNumber: TPageNumber) => pageRenderState.getSlot(pageNumber).committedRender?.annotationInput,
        isNativeTextBoxAppearance: pageRenderState.isNativeTextBoxAppearance,
        isPageRenderFailed,
        invalidatePages,
        handlePageRenderStall,
    };
};
export type TPdfRenderingSession = ReturnType<typeof createPdfRenderingSession>;
