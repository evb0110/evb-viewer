import type * as Vue from 'vue';
import { Mutex } from 'es-toolkit/promise';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfRasterDisplayProfile } from '@app/types/pdfRasterDisplayProfile';
import type * as PdfUi from '@app/types/pdfUi';
import type {
    TFitMode,
    TPdfViewRotation,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import { runGuardedTask } from '@app/utils/asyncGuard';
import type { IDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import type { IDocumentOpenSurfaceRenderOwner } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { IPdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import { shouldDeferPdfDprRerenderForResize } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerOutputScale';
import { usePdfPageRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
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
import { usePdfViewerRerenderCoordinator } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerRerenderCoordinator';
import { usePdfViewerResizeLifecycle } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle';
import {
    usePdfViewerZoomRerenderQueue,
    type TPdfZoomRerenderBusySetter,
} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerZoomRerenderQueue';
import { usePdfViewerRenderStallRecovery } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerRenderStallRecovery';
import { usePdfViewerInitialRenderRecovery } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerInitialRenderRecovery';
import { usePdfViewerActivationRestore } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerActivationRestore';
import { createPdfInitialVisualCommit } from '@app/modules/pdf-viewer/runtime/lifecycle/createPdfInitialVisualCommit';
import { createPdfRasterQualityRefineGate } from '@app/modules/pdf-viewer/runtime/sessions/createPdfRasterQualityRefineGate';
import { resolvePdfRasterJobPages } from '@app/modules/pdf-viewer/runtime/sessions/resolvePdfRasterJobPages';
import type { ICurrentPageSyncOptions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import type { IZoomViewportAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewerViewportTypes';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import type { TPdfDocumentSession } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import { createPdfPageTextLayerReadyWaiter } from '@app/modules/pdf-viewer/runtime/sessions/createPdfPageTextLayerReadyWaiter';
import { promotePrioritizedTextLayers } from '@app/modules/pdf-viewer/runtime/sessions/promotePrioritizedTextLayers';
import type {
    IPdfViewportDemand,
    TPdfViewportSession,
} from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import { DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS } from '@app/utils/document-viewer/input/documentWheelInteraction';
import type {
    IPdfViewportRasterJob,
    TPdfPageRasterState,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfViewportRasterJob';
const PDF_RASTER_SCALE_RELATIVE_TOLERANCE = 0.000_1;
export interface ICreatePdfRenderingSessionOptions {
    document: TPdfDocumentSession;
    viewport: TPdfViewportSession;
    chassisAuthority: IDocumentViewerChassisAuthority | null;
    openSurfaceRenderOwner: IDocumentOpenSurfaceRenderOwner | undefined;
    performancePolicy: IPdfRenderPerformancePolicy;
    viewerContainer: Vue.Ref<HTMLElement | null>;
    isActive: Vue.ComputedRef<boolean>;
    isResizing: Vue.ComputedRef<boolean>;
    isAnySaving: Vue.ComputedRef<boolean>;
    zoom: Vue.ComputedRef<number>;
    zoomMode: Vue.ComputedRef<TZoomMode>;
    fitMode: Vue.ComputedRef<TFitMode>;
    viewMode: Vue.ComputedRef<TPdfViewMode>;
    viewRotation?: Vue.ComputedRef<TPdfViewRotation>;
    continuousScroll: Vue.ComputedRef<boolean>;
    outputScale: Vue.Ref<number>;
    rasterDisplayProfile: Vue.ComputedRef<TPdfRasterDisplayProfile | null>;
    bufferPages: Vue.ComputedRef<number>;
    showAnnotations: Vue.ComputedRef<boolean>;
    searchPageMatches: Vue.ComputedRef<Map<number, PdfUi.IPdfPageMatches>>;
    currentSearchMatch: Vue.ComputedRef<PdfUi.IPdfSearchMatch | null>;
    currentSearchMatchNavigationId: Vue.ComputedRef<number>;
    workingCopyPath: Vue.ComputedRef<string | null>;
    documentRevisionToken: Vue.ComputedRef<TDocumentRevisionToken | null>;
    maxBufferCanvasPixels: number;
    consumeZoomViewportAnchor: () => IZoomViewportAnchor | null;
    isZoomInteractionLocked: () => boolean;
    setZoomRerenderBusy: TPdfZoomRerenderBusySetter;
    markDelayedSkeletonPageRendered: (pageNumber: number) => void;
    emitInitialVisualReady: (payload: {pageNumber: number}) => void;
    emitLoadError: (error: unknown) => void;
}
export const createPdfRenderingSession = (options: ICreatePdfRenderingSessionOptions) => {
    const documentSession = options.document;
    const viewport = options.viewport;
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
    const performanceProfile = getPerformanceProfile();
    const canvasRenderer = usePdfCanvasRenderer({
        outputScale: options.outputScale,
        ...(options.viewRotation === undefined ? {} : {viewRotation: options.viewRotation}),
        defaultMaxCanvasPixels: performanceProfile.settledMaxCanvasPixels,
        annotationProjectionReady: () => pageRenderer.annotationProjectionReady.value,
    });
    const pageRenderState = createPdfPageRenderState();
    const pageCanvases = new Map<number, HTMLCanvasElement>();
    const viewportRasterJobs = new Map<string, IPdfViewportRasterJob>();
    const viewportRasterWaiters = new Map<number, Set<() => void>>();
    const renderMutex = new Mutex();
    let activeRasterScheduler: IPdfPageRasterScheduler | null = null;
    let viewportDemandGeneration = 0;
    let renderVersion = 0;
    let visibleRenderRequestId = 0;
    let latestDemand: IPdfViewportDemand = viewport.demand.value;
    interface IPreparedViewportRaster {
        job: IPdfViewportRasterJob;
        requestId: number;
        container: HTMLElement;
        canvasHost: HTMLDivElement;
        render: NonNullable<Awaited<ReturnType<typeof canvasRenderer.prepareCanvasRender>>>;
    }
    const getRenderDocumentToken = () => `${String(options.workingCopyPath.value ?? '')}\0${String(options.documentRevisionToken.value ?? '')}`;
    const getMountedRasterTarget = (pageNumber: number) => getMountedPdfRasterTarget(options.viewerContainer.value, pageNumber);
    const pageTextLayerReadyWaiter = createPdfPageTextLayerReadyWaiter({isReady: pageNumber => (
        pageRenderState.getSlot(pageNumber).textLayerReadiness === 'ready'
        && getMountedRasterTarget(pageNumber)?.container.querySelector<HTMLElement>('.text-layer, .textLayer')
            ?.dataset.pdfTextLayerReady === 'true'
    )});
    function isRasterScaleCurrent(targetScale: number, currentScale: number) {
        return Math.abs(targetScale - currentScale)
            <= Math.max(1, Math.abs(currentScale)) * PDF_RASTER_SCALE_RELATIVE_TOLERANCE;
    }
    function isViewportRasterJobScaleCurrent(job: IPdfViewportRasterJob) {
        return isRasterScaleCurrent(job.targetScale, viewport.scale.effectiveScale.value)
            && isRasterScaleCurrent(job.targetOutputScale, options.outputScale.value);
    }
    function isCommittedVisual(pageNumber: number, requireCurrent = true) {
        const target = getMountedRasterTarget(pageNumber);
        const canvas = pageCanvases.get(pageNumber);
        if (!target || !canvas) {
            return false;
        }
        const slot = pageRenderState.getSlot(pageNumber);
        const presentable = slot.canvasReadiness === 'ready'
            && slot.documentToken === getRenderDocumentToken()
            && slot.container === target.container
            && target.canvasHost.contains(canvas) && canvas.isConnected
            && canvas.width > 0 && canvas.height > 0;
        if (!presentable || !requireCurrent) {
            return presentable;
        }
        const scale = viewport.scale.effectiveScale.value;
        const outputScale = options.outputScale.value;
        return slot.contentVersion === renderVersion
            && slot.targetScale !== null
            && isRasterScaleCurrent(slot.targetScale, scale)
            && slot.targetOutputScale !== null
            && isRasterScaleCurrent(slot.targetOutputScale, outputScale);
    }
    function getPageRasterState(pageNumber: number): TPdfPageRasterState {
        const slot = pageRenderState.getSlot(pageNumber);
        const pendingJob = [...viewportRasterJobs.values()].find(job => (
            job.demand.pageNumber === pageNumber
        ));
        if (
            viewportRasterWaiters.has(pageNumber)
            || slot.job === 'rendering' && slot.version === renderVersion
        ) {
            return pendingJob && !isViewportRasterJobScaleCurrent(pendingJob)
                ? 'stale-scale'
                : 'in-flight';
        }
        if (isCommittedVisual(pageNumber)) {
            return 'current';
        }
        if (slot.job === 'failed' && slot.version === renderVersion) {
            return 'failed';
        }
        return slot.canvasReadiness === 'ready' ? 'stale-scale' : 'absent';
    }
    function resolveViewportRasterWaiters(pageNumber: number) {
        const waiters = viewportRasterWaiters.get(pageNumber);
        if (!waiters) {
            return;
        }
        viewportRasterWaiters.delete(pageNumber);
        waiters.forEach(resolve => resolve());
    }
    function waitForViewportRaster(pageNumber: number) {
        if (isCommittedVisual(pageNumber)) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            const waiters = viewportRasterWaiters.get(pageNumber) ?? new Set();
            waiters.add(resolve);
            viewportRasterWaiters.set(pageNumber, waiters);
        });
    }
    function shouldRasterizeViewportJob(job: IPdfViewportRasterJob) {
        return job.rasterState === 'absent'
            || job.rasterState === 'stale-scale'
            || job.rasterState === 'failed' && job.renderOptions.forceRerender === true
            || job.renderOptions.contentIntent === 'canvas-only-refine';
    }
    function isViewportRasterDemanded(pageNumber: number, lane?: TPdfRasterLane) {
        const mandatory = latestDemand.mandatoryRaster?.range;
        return latestDemand.operational && (
            latestDemand.residentPages.includes(pageNumber)
            || Boolean(mandatory
                && pageNumber >= mandatory.start
                && pageNumber <= mandatory.end)
            || lane === 'navigation-target'
        );
    }
    function isPreparedRasterCurrent(prepared: IPreparedViewportRaster) {
        return viewportRasterJobs.get(prepared.job.demand.renderKey) === prepared.job
            && isViewportRasterJobScaleCurrent(prepared.job)
            && prepared.job.demand.consumerGeneration === renderVersion
            && documentSession.pdfDocument.value !== null
            && activeRasterScheduler === documentSession.rasterScheduler
            && prepared.job.demand.documentFence === activeRasterScheduler?.documentFence
            && prepared.container.isConnected !== false
            && prepared.canvasHost.isConnected !== false
            && prepared.container.dataset.page === String(prepared.job.demand.pageNumber)
            && prepared.canvasHost.closest('.page_container') === prepared.container
            && isViewportRasterDemanded(prepared.job.demand.pageNumber, prepared.job.demand.lane);
    }
    const viewportRasterTarget: IPdfRasterRenderTarget<IPreparedViewportRaster> = {
        id: 'pdf-viewport',
        async prepare(demand, page, signal, captureSettlement) {
            const job = viewportRasterJobs.get(demand.renderKey);
            const target = getMountedRasterTarget(demand.pageNumber);
            if (
                !job
                || !target
                || job.demand.consumerGeneration !== renderVersion
                || !isViewportRasterJobScaleCurrent(job)
                || documentSession.pdfDocument.value === null
            ) {
                return null;
            }
            const version = demand.consumerGeneration;
            const scale = job.targetScale;
            const requestId = ++visibleRenderRequestId;
            pageRenderState.beginRender(
                demand.pageNumber,
                version,
                requestId,
                getRenderDocumentToken(),
                scale,
                job.targetOutputScale,
                target.container,
                {preserveCommittedVisual: pageRenderState.getSlot(demand.pageNumber).canvasReadiness === 'ready'},
            );
            const shouldContinue = () => (
                !signal.aborted && version === renderVersion
                && viewportRasterJobs.get(demand.renderKey) === job
                && isViewportRasterJobScaleCurrent(job)
                && isViewportRasterDemanded(demand.pageNumber, job.demand.lane)
            );
            const intent = job.renderOptions.contentIntent;
            const sourceMaxPixels = resolvePdfRasterSourceMaxPixels(options.rasterDisplayProfile.value, demand.pageNumber);
            const render = await canvasRenderer.prepareCanvasRender(page, scale, {
                ...(intent ? {contentIntent: intent} : {}),
                hiddenAnnotationIds: pageRenderer.canvasHiddenAnnotationIds.value,
                ...(job.renderOptions.maxCanvasPixels === undefined
                    ? {}
                    : {maxCanvasPixels: job.renderOptions.maxCanvasPixels}),
                ...(sourceMaxPixels === null ? {} : {sourceMaxPixels}),
                onRenderStall: payload => handlePageRenderStall(payload),
                pageRenderCoordination: {
                    owner: 'pdf-viewport',
                    priority: 100,
                    signal,
                    shouldStart: shouldContinue,
                    shouldContinue,
                    captureSettlement,
                },
            });
            if (!render || !shouldContinue()) {
                if (render) canvasRenderer.cleanupCanvasRenderResult(render);
                pageRenderState.completeRender(demand.pageNumber, version, requestId);
                return null;
            }
            return {
                job,
                requestId,
                ...target,
                render,
            };
        },
        start: prepared => prepared.render.startRender(),
        onRenderStall: payload => handlePageRenderStall(payload),
        commit(prepared, demand) {
            if (!isPreparedRasterCurrent(prepared) || prepared.job.demand !== demand) {
                return false;
            }
            const pageNumber = demand.pageNumber;
            const previousCanvas = pageCanvases.get(pageNumber);
            canvasRenderer.applyContainerUserUnit(prepared.container, prepared.render.userUnit);
            canvasRenderer.mountCanvas(prepared.canvasHost, prepared.render.canvas, previousCanvas);
            if (!pageRenderState.commitVisual(
                pageNumber,
                prepared.job.demand.consumerGeneration,
                prepared.requestId,
                resolvePdfCommittedRasterQuality(
                    prepared.render,
                    prepared.job.renderOptions.contentIntent === 'canvas-only-buffer'
                        ? 'buffer-preview'
                        : 'settled',
                ),
            )) {
                if (previousCanvas) {
                    canvasRenderer.mountCanvas(prepared.canvasHost, previousCanvas, prepared.render.canvas);
                } else {
                    canvasRenderer.cleanupCanvas(prepared.render.canvas);
                }
                return false;
            }
            pageCanvases.set(pageNumber, prepared.render.canvas);
            if (previousCanvas && previousCanvas !== prepared.render.canvas) canvasRenderer.cleanupCanvas(previousCanvas);
            initialVisual.handlePageCanvasMounted({
                openSurfaceGeneration: prepared.job.renderOptions.openSurfaceGeneration ?? 0,
                documentRevision: prepared.job.renderOptions.openSurfaceRevision ?? documentSession.openSurfaceRevision,
                renderVersion: prepared.job.demand.consumerGeneration,
                requestId: prepared.requestId,
                pageNumber,
            });
            resolveViewportRasterWaiters(pageNumber);
            void pageRenderer.renderCommittedPageLayers({
                pageNumber,
                version: prepared.job.demand.consumerGeneration,
                requestId: prepared.requestId,
                scale: prepared.job.targetScale,
                container: prepared.container,
                renderResult: prepared.render,
                renderOptions: prepared.job.renderOptions,
            });
            return true;
        },
        discard(prepared) {
            canvasRenderer.cleanupCanvasRenderResult(prepared.render);
            const pageNumber = prepared.job.demand.pageNumber;
            const generation = prepared.job.demand.consumerGeneration;
            if (isPreparedRasterCurrent(prepared)
                && pageRenderState.getSlot(pageNumber).canvasReadiness !== 'ready') {
                pageRenderState.markRenderFailed(pageNumber, generation, prepared.requestId);
            } else {
                pageRenderState.completeRender(pageNumber, generation, prepared.requestId);
            }
            resolveViewportRasterWaiters(pageNumber);
            renderedPageStateVersion.value += 1;
            queueFrame();
        },
        release(pageNumber) {
            resolveViewportRasterWaiters(pageNumber);
            if (!isViewportRasterDemanded(pageNumber)) clearAuthoritativePage(pageNumber, false);
        },
    };
    function buildViewportRasterJobs(
        range: PdfUi.IPageRange,
        renderOptions: IRenderVisiblePagesOptions,
        scheduler: IPdfPageRasterScheduler,
    ) {
        const buffer = renderOptions.bufferOverride ?? options.bufferPages.value;
        const override = renderOptions.renderWindowOverride;
        const start = Math.max(1, Math.min(range.start, range.start - buffer, override?.start ?? range.start));
        const end = Math.min(
            documentSession.numPages.value,
            Math.max(range.end, range.end + buffer, override?.end ?? range.end),
        );
        const scale = viewport.scale.effectiveScale.value;
        const outputScale = options.outputScale.value;
        const jobs: IPdfViewportRasterJob[] = [];
        const pageNumbers = resolvePdfRasterJobPages({
            start,
            end,
            totalPages: documentSession.numPages.value,
            explicitPages: renderOptions.rasterDemandPages,
        });
        for (const pageNumber of pageNumbers) {
            const metric = documentSession.pageMetrics.value[pageNumber - 1];
            const width = metric?.width ?? documentSession.basePageWidth.value ?? 1;
            const height = metric?.height ?? documentSession.basePageHeight.value ?? 1;
            const requestedPixels = Math.max(1, Math.ceil(width * scale * outputScale))
                * Math.max(1, Math.ceil(height * scale * outputScale));
            const visible = pageNumber >= range.start && pageNumber <= range.end;
            const distance = Math.min(Math.abs(pageNumber - range.start), Math.abs(pageNumber - range.end));
            const lane: TPdfRasterLane = visible
                ? renderOptions.transactionRequest?.priority === 'authoritative'
                    || renderOptions.authoritativeRaster === true
                    ? 'navigation-target' : 'viewport-visible'
                : distance <= 1 ? 'viewport-nearby' : 'prefetch';
            const pageRenderOptions = lane === 'viewport-nearby' || lane === 'prefetch' ? {
                ...renderOptions,
                contentIntent: 'canvas-only-buffer' as const,
                ...(renderOptions.bufferMaxCanvasPixels ?? renderOptions.maxCanvasPixels
                    ? {maxCanvasPixels: renderOptions.bufferMaxCanvasPixels ?? renderOptions.maxCanvasPixels!}
                    : {}),
            } : renderOptions;
            const committedRasterState = getPageRasterState(pageNumber);
            // A forced rerender invalidates otherwise scale-current pixels after content changes.
            const rasterState = committedRasterState === 'current' && renderOptions.forceRerender === true
                ? 'stale-scale'
                : committedRasterState;
            const retainedJob = rasterState === 'current'
                && renderOptions.contentIntent !== 'canvas-only-refine'
                ? [...viewportRasterJobs.values()].find(job => job.demand.pageNumber === pageNumber)
                : undefined;
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
                renderKey: retainedJob?.demand.renderKey ?? [
                    renderVersion,
                    pageNumber,
                    scale,
                    outputScale,
                    getRenderDocumentToken(),
                    pageRenderOptions.contentIntent ?? 'full-visible',
                    pageRenderOptions.maxCanvasPixels ?? '',
                    pageRenderOptions.openSurfaceGeneration ?? '',
                    pageRenderOptions.openSurfaceRevision ?? '',
                ].join(':'),
                retention: 'render-cache',
            };
            const existing = viewportRasterJobs.get(demand.renderKey);
            const job = existing ?? {
                demand,
                rasterState: rasterState === 'in-flight' ? 'absent' : rasterState,
                renderOptions: pageRenderOptions,
                targetOutputScale: outputScale,
                targetScale: scale,
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
    async function renderVisiblePages(
        range: PdfUi.IPageRange,
        requestedRenderOptions: IRenderVisiblePagesOptions = {},
    ) {
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
        const generation = ++viewportDemandGeneration;
        const didHydrateMetrics = await documentSession.ensurePageMetricsInRange(range.start, range.end);
        if (
            generation !== viewportDemandGeneration
            || document !== documentSession.pdfDocument.value
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
            ? [...pageCanvases.keys()]
                .filter(pageNumber => !residentPages.has(pageNumber))
                .flatMap(pageNumber => buildViewportRasterJobs({
                    start: pageNumber,
                    end: pageNumber,
                }, {
                    ...renderOptions,
                    bufferOverride: 0,
                    rasterDemandPages: [pageNumber],
                    renderWindowOverride: {
                        start: pageNumber,
                        end: pageNumber,
                    },
                }, scheduler))
            : [];
        const requestedJobs = buildViewportRasterJobs(range, renderOptions, scheduler);
        const requestedPages = new Set(requestedJobs.map(job => job.demand.pageNumber));
        const targetPages = [...requestedPages].filter(page => page >= range.start && page <= range.end);
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
        for (const job of jobs) {
            if (
                job.rasterState === 'stale-scale'
                || (job.rasterState === 'failed' && job.renderOptions.forceRerender === true)
            ) {
                scheduler.invalidate({
                    pages: [job.demand.pageNumber],
                    reason: 'explicit-viewport-raster-repair',
                    sourceId: 'pdf-viewport',
                });
            }
        }
        const schedulableJobs = jobs
            .filter(job => job.rasterState !== 'failed' || job.renderOptions.forceRerender === true);
        const rasterJobs = schedulableJobs.filter(shouldRasterizeViewportJob);
        const waits = schedulableJobs.filter(job => (
            shouldRasterizeViewportJob(job) || (job.rasterState === 'in-flight'
                && renderOptions.preserveInFlightRequiredPages === true && requestedPages.has(job.demand.pageNumber))
        )).map(job => waitForViewportRaster(job.demand.pageNumber));
        rasterJobs.forEach((job) => {
            job.rasterState = 'in-flight';
        });
        const navigationJobs = rasterJobs.filter(job => job.demand.lane === 'navigation-target');
        if (navigationJobs.length > 0) {
            await Promise.all(navigationJobs.map(job => scheduler.request({
                sourceId: 'pdf-viewport',
                demand: job.demand,
                target: viewportRasterTarget,
            })));
        } else {
            scheduler.setDemand({
                sourceId: 'pdf-viewport',
                input: schedulableJobs.map(job => job.demand),
                policy: {
                    expand: (input: readonly IPdfRasterDemand[]) => input,
                    compareWithinLane: (left: IPdfRasterDemand, right: IPdfRasterDemand) => left.ordinal - right.ordinal,
                },
                target: viewportRasterTarget,
            });
            await Promise.all(waits);
        }
        await promotePrioritizedTextLayers(pageRenderer, targetPages, renderOptions);
    }
    const pageRenderer = usePdfPageRenderer({
        container: options.viewerContainer,
        document: documentSession,
        viewport,
        ...(options.viewRotation === undefined ? {} : {viewRotation: options.viewRotation}),
        isActive: rasterOperational,
        outputScale: options.outputScale,
        showAnnotations: options.showAnnotations,
        searchPageMatches: options.searchPageMatches,
        currentSearchMatch: options.currentSearchMatch,
        currentSearchMatchNavigationId: options.currentSearchMatchNavigationId,
        workingCopyPath: options.workingCopyPath,
        documentRevisionToken: options.documentRevisionToken,
        onPageRendered: options.markDelayedSkeletonPageRendered,
        onRenderedPageStateChanged: () => {
            renderedPageStateVersion.value += 1;
            pageTextLayerReadyWaiter.resolveReady();
            queueFrame();
        },
        pageRenderState,
        getRenderVersion: () => renderVersion,
        getRenderDocumentToken,
        getCommittedCanvas: pageNumber => isCommittedVisual(pageNumber) ? pageCanvases.get(pageNumber) ?? null : null,
        requestSearchPageRaster: pageNumber => renderVisiblePages({
            start: pageNumber,
            end: pageNumber,
        }, {
            bufferOverride: 0,
            prioritizeTextLayer: true,
        }),
    });
    function bumpRenderVersion(reauthorizeCommittedCanvases = true) {
        renderVersion += 1;
        viewportDemandGeneration += 1;
        viewportRasterJobs.clear();
        for (const pageNumber of viewportRasterWaiters.keys()) {
            resolveViewportRasterWaiters(pageNumber);
        }
        if (reauthorizeCommittedCanvases) {
            pageRenderer.adoptCommittedCanvasVersions(renderVersion, getRenderDocumentToken());
        }
        renderedPageStateVersion.value += 1;
        return renderVersion;
    }
    function cancelRasterDemand() {
        viewportRasterJobs.clear();
        const cancellation = activeRasterScheduler?.cancelSource('pdf-viewport') ?? Promise.resolve();
        for (const pageNumber of viewportRasterWaiters.keys()) {
            resolveViewportRasterWaiters(pageNumber);
        }
        return cancellation;
    }
    async function cancelInFlightRenders() {
        const cancellation = cancelRasterDemand();
        bumpRenderVersion();
        await cancellation;
    }
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
                if (previous.document !== null) bumpRenderVersion(false);
            } else if (token !== previous.token) {
                bumpRenderVersion();
            }
        },
        {flush: 'post'},
    );
    function clearAuthoritativePage(pageNumber: number, invalidateScheduler = true) {
        for (const key of viewportRasterJobs.keys()) {
            if (viewportRasterJobs.get(key)?.demand.pageNumber === pageNumber) viewportRasterJobs.delete(key);
        }
        if (invalidateScheduler) {
            activeRasterScheduler?.invalidate({
                pages: [pageNumber],
                reason: 'viewport-page-released',
                sourceId: 'pdf-viewport',
            });
        }
        resolveViewportRasterWaiters(pageNumber);
        const canvas = pageCanvases.get(pageNumber);
        if (canvas) canvasRenderer.cleanupCanvas(canvas);
        pageCanvases.delete(pageNumber);
        pageRenderState.clearPage(pageNumber);
        pageRenderer.releasePageLayers(pageNumber);
        const target = getMountedRasterTarget(pageNumber);
        if (target) {
            for (const child of target.canvasHost.querySelectorAll<HTMLCanvasElement>('canvas')) {
                canvasRenderer.cleanupCanvas(child);
            }
            target.canvasHost.replaceChildren();
            const skeleton = target.container.querySelector<HTMLElement>('.document-page-skeleton');
            if (skeleton) skeleton.style.display = '';
        }
        documentSession.evictPage(pageNumber);
        renderedPageStateVersion.value += 1;
    }
    async function reRenderAllVisiblePages(
        getVisibleRange: () => PdfUi.IPageRange,
        rerenderOptions?: {renderBufferOverride?: number | undefined},
    ) {
        if (!options.isActive.value) {
            return;
        }
        const version = bumpRenderVersion();
        await renderMutex.acquire();
        try {
            if (version !== renderVersion) {
                return;
            }
            const range = getVisibleRange();
            for (const pageNumber of [...pageCanvases.keys()]) {
                if (pageNumber < range.start || pageNumber > range.end) {
                    clearAuthoritativePage(pageNumber);
                }
            }
            viewport.setupPagePlaceholders();
            await nextTick();
            if (version !== renderVersion) {
                return;
            }
            await renderVisiblePages(getVisibleRange(), {
                forceRerender: true,
                suppressResidentRasterDemand: rerenderOptions?.renderBufferOverride === 0,
                ...(rerenderOptions?.renderBufferOverride === undefined
                    ? {}
                    : {bufferOverride: rerenderOptions.renderBufferOverride}),
            });
            if (rerenderOptions?.renderBufferOverride === 0) {
                queueFrame();
            }
        } finally {
            renderMutex.release();
        }
    }
    async function cleanupRenderedPages() {
        bumpRenderVersion();
        new Set([
            ...pageCanvases.keys(),
            ...pageRenderState.renderedPages,
            ...pageRenderState.renderingPages.keys(),
        ]).forEach(pageNumber => clearAuthoritativePage(pageNumber, false));
        await pageRenderer.cleanupAllLayers();
        documentSession.cleanupPageCache();
    }
    function isPageVisualReady(pageNumber: number) {
        void renderedPageStateVersion.value; return isCommittedVisual(pageNumber);
    }
    let frameId: number | null = null;
    let activeMandatoryRasterId: number | null = null;
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
        hasActiveTransaction: () => viewport.transactionController.activeTransaction.value !== null,
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
                viewport.settleMandatoryRaster(demand.mandatoryRaster.id);
            }
            void cancelRasterDemand();
            return;
        }
        const mandatory = demand.mandatoryRaster;
        if (mandatory) {
            if (activeMandatoryRasterId === mandatory.id) {
                return;
            }
            activeMandatoryRasterId = mandatory.id;
            void renderVisiblePages(mandatory.range, mandatory.options).finally(() => {
                if (activeMandatoryRasterId === mandatory.id) {
                    activeMandatoryRasterId = null;
                }
                viewport.settleMandatoryRaster(mandatory.id);
                if (
                    latestDemand.mandatoryRaster
                    && latestDemand.mandatoryRaster.id !== mandatory.id
                ) {
                    queueMandatoryDemandTask();
                }
            });
            return;
        }
        const requiredStates = demand.requiredPages.map(getPageRasterState);
        const repairPages = demand.requiredPages.filter((_, index) => requiredStates[index] === 'stale-scale');
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
        const promotion = pageRenderer.resolveLayerPromotionDemand(demand.requiredPages);
        if (promotion) {
            qualityRefineGate.clearIdleTimer();
            void renderVisiblePages(promotion.range, promotion.options);
            return;
        }
        const refinePage = demand.requiredPages.find((page) => {
            const slot = pageRenderState.getSlot(page);
            return slot.job === 'idle'
                && slot.committedRasterQuality?.wasClamped === true
                && slot.committedRasterQuality.intent === 'buffer-preview';
        });
        if (refinePage === undefined || !qualityRefineGate.canRefineVisibleRaster()) {
            return;
        }
        qualityRefineGate.clearIdleTimer();
        void renderVisiblePages({
            start: refinePage,
            end: refinePage,
        }, {
            bufferOverride: 0,
            contentIntent: 'canvas-only-refine',
            forceRerender: true,
            rasterDemandPages: [refinePage],
        });
    }
    const stopDemandWatch = watch(viewport.demand, (demand) => {
        latestDemand = demand;
        if (demand.mandatoryRaster && activeMandatoryRasterId !== demand.mandatoryRaster.id) {
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
        void cancelInFlightRenders();
    }, {flush: 'sync'});
    const stopVisualReadyWatch = watch(viewport.visualReadySignal, (signal, previous) => {
        if (signal.revision !== previous?.revision) {
            initialVisual.adoptResidentCanvas(signal.pageNumber);
        }
    }, {flush: 'sync'});
    const chassisOpenSurface = options.chassisAuthority?.openSurface;
    const stopOpenSurfaceResidentAdoptionWatch = chassisOpenSurface
        ? watch(
            [
                () => chassisOpenSurface.snapshot.value.generation,
                () => chassisOpenSurface.readyAuthorizationRevision.value,
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
                    initialVisual.adoptResidentCanvas(chassisOpenSurface.viewportSession.value.requestedPage);
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
        if (signal.revision !== previous?.revision) {
            initialVisual.reconcileInitialVisual();
        }
    }, {flush: 'sync'});
    let rerenderVisiblePagesAndSyncCurrentPage = async (_options?: ICurrentPageSyncOptions) => {};
    let scheduleResizeAwareRerender: (stage: string, syncOptions?: ICurrentPageSyncOptions) => void = () => {};
    const {
        buildResizeAnchorContext,
        beginResizeTransition,
        captureResizeVisualSnapshots,
        scheduleEndResizeTransition,
        cleanupResizeLifecycle,
    } = usePdfViewerResizeLifecycle({
        submitResizeIntent: anchor => void viewport.singlePageScroll.submitViewportStateIntent(
            'resize', anchor ? {anchor} : {},
        ),
        applyResizeAnchorPreview: (anchor?: IPdfSemanticAnchor | null) =>
            viewport.singlePageScroll.applyResizeAnchorPreview(anchor),
        viewerContainer: options.viewerContainer,
        isLoading: documentSession.isLoading,
        isActive: options.isActive,
        isResizing: options.isResizing,
        pdfDocument: documentSession.pdfDocument,
        currentPage: viewport.currentPage,
        pendingNavigationAnchorPage: viewport.singlePageScroll.navigationAnchorPage,
        visibleRange: viewport.visibleRange,
        numPages: documentSession.numPages,
        computeFitWidthScale: viewport.scale.computeFitWidthScale,
        settlePreviewFitScale: viewport.scale.settlePreviewFitScale,
        captureViewportAnchor: viewport.singlePageScroll.captureCurrentSemanticAnchor,
        getMostVisiblePage: viewport.scroll.getMostVisiblePage,
        summarizeViewerMetricsForLog: viewport.summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog: viewport.summarizeVisiblePageSnapshotForLog,
        scheduleResizeAwareRerender: (stage, syncOptions) => scheduleResizeAwareRerender(stage, syncOptions),
        setResizeTransitionVisible: viewport.handleResizeTransitionSignal,
        transactionController: viewport.transactionController,
    });
    const zoomRerenderQueue = usePdfViewerZoomRerenderQueue({
        performancePolicy: options.performancePolicy,
        pdfDocument: documentSession.pdfDocument,
        isLoading: documentSession.isLoading,
        viewerContainer: options.viewerContainer,
        summarizeViewerMetricsForLog: viewport.summarizeViewerMetricsForLog,
        reRenderVisiblePagesAndSyncCurrentPage: syncOptions => rerenderVisiblePagesAndSyncCurrentPage(syncOptions),
        buildResizeAnchorContext: () => buildResizeAnchorContext(),
        scheduleEndResizeTransition,
        isZoomInteractionLocked: options.isZoomInteractionLocked,
        setZoomRerenderBusy: options.setZoomRerenderBusy,
        transactionController: viewport.transactionController,
    });
    scheduleResizeAwareRerender = zoomRerenderQueue.scheduleResizeAwareRerender;
    const rerenderCoordinator = usePdfViewerRerenderCoordinator({
        viewerContainer: options.viewerContainer,
        pdfDocument: documentSession.pdfDocument,
        isLoading: documentSession.isLoading,
        numPages: documentSession.numPages,
        currentPage: viewport.currentPage,
        pagedNavigationTargetPage: viewport.singlePageScroll.pagedNavigationTargetPage,
        navigationAnchorPage: viewport.singlePageScroll.navigationAnchorPage,
        visibleRange: viewport.visibleRange,
        commitVisibleRange: range => viewport.commitVisibleRange(range, null),
        zoom: options.zoom,
        fitMode: options.fitMode,
        viewMode: options.viewMode,
        ...(options.viewRotation === undefined ? {} : {viewRotation: options.viewRotation}),
        isResizing: options.isResizing,
        continuousScroll: options.continuousScroll,
        getVisibleRange: viewport.getVisibleRange,
        reRenderAllVisiblePages,
        summarizeViewerMetricsForLog: viewport.summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog: viewport.summarizeVisiblePageSnapshotForLog,
        syncCurrentPageFromViewport: viewport.syncCurrentPageFromViewport,
        buildResizeAnchorContext,
        applyResizeAnchorPreview: anchor => viewport.singlePageScroll.applyResizeAnchorPreview(anchor),
        captureResizeVisualSnapshots,
        scheduleEndResizeTransition,
        enqueueZoomSync: syncOptions => zoomRerenderQueue.enqueueZoomSync(syncOptions),
        scheduleResizeAwareRerender: (stage, syncOptions) => scheduleResizeAwareRerender(stage, syncOptions),
        cancelInFlightPageRenders: cancelInFlightRenders,
        ensurePageMetricsInRange: documentSession.ensurePageMetricsInRange,
        computeFitWidthScale: viewport.scale.computeFitWidthScale,
        zoomMode: options.zoomMode,
        syncHorizontalScrollForZoomMode: viewport.viewModel.syncHorizontalScrollForZoomMode,
        setupPagePlaceholders: viewport.setupPagePlaceholders,
        scrollToPage: (pageNumber, scrollOptions) => viewport.singlePageScroll.scrollToPage(pageNumber, scrollOptions),
        getMostVisiblePage: viewport.scroll.getMostVisiblePage,
        resetContinuousScrollState: () => viewport.singlePageScroll.resetContinuousScrollState(),
        cancelDestinationNavigationTarget: () => viewport.singlePageScroll.cancelDestinationNavigationTarget(),
        resetZoomRerenderQueueState: reason => zoomRerenderQueue.resetZoomRerenderQueueState(reason),
        getUserViewportInteractionEpoch: () => viewport.userViewportInteractionEpoch.value,
        getUserPhysicalNavigationEpoch: () => viewport.userPhysicalNavigationEpoch.value,
        beginLayoutGeometryReplacement: viewport.beginLayoutGeometryReplacement,
        consumeZoomViewportAnchor: options.consumeZoomViewportAnchor,
        submitZoomViewportStateIntent: viewport.submitZoomViewportStateIntent,
        beginResizeTransition,
        transactionController: viewport.transactionController,
    });
    rerenderVisiblePagesAndSyncCurrentPage = rerenderCoordinator.reRenderVisiblePagesAndSyncCurrentPage;
    const {
        resetRenderStallRecoveryState,
        invalidatePages,
        consumePendingInvalidation,
        handlePageRenderStall,
    } = usePdfViewerRenderStallRecovery({
        src: computed(() => documentSession.acceptedSource.value),
        isLoading: documentSession.isLoading,
        isAnySaving: options.isAnySaving,
        numPages: documentSession.numPages,
        currentPage: viewport.currentPage,
        visibleRange: viewport.visibleRange,
        viewerContainer: options.viewerContainer,
        summarizeViewerMetricsForLog: viewport.summarizeViewerMetricsForLog,
        cancelInFlightPageRenders: cancelInFlightRenders,
        renderVisiblePages,
        scheduleReload: (isReload = false) => {
            const pages = consumePendingInvalidation();
            if (pages) {
                documentSession.invalidatePagesOnNextReload(pages);
            }
            documentSession.scheduleLoad(isReload);
        },
        transactionController: viewport.transactionController,
    });
    const { scheduleRecoverInitialRender } = usePdfViewerInitialRenderRecovery({
        viewerContainer: options.viewerContainer,
        pdfDocument: documentSession.pdfDocument,
        numPages: documentSession.numPages,
        isLoading: documentSession.isLoading,
        currentPage: viewport.currentPage,
        computeFitWidthScale: viewport.scale.computeFitWidthScale,
        getVisibleRange: viewport.getVisibleRange,
        updateVisibleRange: viewport.scroll.updateVisibleRange,
        renderVisiblePages,
        syncCurrentPageFromViewport: viewport.syncCurrentPageFromViewport,
        transactionController: viewport.transactionController,
        isInitialCanvasCommitted: () => initialVisual.readExactInitialCommit(false) !== null,
        onTerminalFailure: options.emitLoadError,
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
        updateVisibleRange: viewport.scroll.updateVisibleRange,
        scrollToPage: pageNumber => viewport.singlePageScroll.scrollToPage(pageNumber),
        renderVisiblePages,
        isPageRendered: (pageNumber: number) => pageRenderState.getSlot(pageNumber).canvasReadiness === 'ready',
        applySearchHighlights: pageRenderer.applySearchHighlights,
    });
    watch(options.outputScale, () => {
        if (!documentSession.pdfDocument.value || documentSession.isLoading.value
            || shouldDeferPdfDprRerenderForResize(options.isResizing.value)) {
            return;
        }
        runGuardedTask(
            () => reRenderAllVisiblePages(() => viewport.visibleRange.value, {renderBufferOverride: 0}),
            {
                category: 'user-visible-operation',
                scope: 'pdf-viewer',
                message: 'Failed to re-render PDF pages after display scale change',
            },
        );
    });
    const unsubscribeDocumentTransitions = documentSession.subscribe(async (transition) => {
        if (!transition.isCurrent()) {
            return;
        }
        if (transition.phase === 'loading') {
            initialVisual.setPendingReadyToken(transition.fence.loadToken);
            initialVisual.reconcileInitialVisual();
            if (transition.plan.isSelectiveReload && transition.plan.pagesToInvalidate) {
                for (const pageNumber of transition.plan.pagesToInvalidate) {
                    clearAuthoritativePage(pageNumber);
                }
            } else if (!transition.plan.preserveVisibleContent) {
                await cleanupRenderedPages();
            }
        } else if (transition.phase === 'invalidated') {
            initialVisual.setPendingReadyToken(null);
            pageRenderer.cancelPendingSearchScroll();
            await cancelInFlightRenders();
            await cleanupRenderedPages();
            zoomRerenderQueue.resetZoomRerenderQueueState(transition.reason);
            cleanupResizeLifecycle();
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
            if (!transition.isCurrent()) {
                return;
            }
            pageRenderer.applySearchHighlights();
            const loadedDocument = documentSession.pdfDocument.value;
            const viewportInteractionEpoch = viewport.userViewportInteractionEpoch.value;
            scheduleRecoverInitialRender({isCurrent: () => transition.isCurrent()
                    && documentSession.pdfDocument.value === loadedDocument
                    && viewport.userViewportInteractionEpoch.value === viewportInteractionEpoch});
        }
    });
    documentSession.registerDisposable(async () => {
        disposed = true;
        unsubscribeDocumentTransitions();
        stopDemandWatch();
        stopCancelRasterWatch();
        stopVisualReadyWatch();
        stopOpenSurfaceResidentAdoptionWatch();
        stopNavigationCommitWatch();
        stopRevisionReauthorizationWatch();
        if (frameId !== null) {
            window.cancelAnimationFrame(frameId);
        }
        if (mandatoryDemandTaskId !== null) window.clearTimeout(mandatoryDemandTaskId);
        qualityRefineGate.clearIdleTimer();
        if (latestDemand.mandatoryRaster) {
            viewport.settleMandatoryRaster(latestDemand.mandatoryRaster.id);
        }
        resetRenderStallRecoveryState();
        initialVisual.setPendingReadyToken(null);
        rerenderCoordinator.cleanupZoomOrchestration();
        zoomRerenderQueue.cleanupZoomRerenderQueue();
        cleanupResizeLifecycle();
        await cancelRasterDemand();
        pageTextLayerReadyWaiter.settleAll();
        await cleanupRenderedPages(); pageRenderer.dispose?.();
    });
    return {
        ...pageRenderer,
        renderVisiblePages,
        reRenderAllVisiblePages,
        cancelInFlightRenders,
        releaseUnmountedPage: (pageNumber: number) => clearAuthoritativePage(pageNumber),
        isPageRendered: (pageNumber: number) => pageRenderState.getSlot(pageNumber).canvasReadiness === 'ready',
        isPageRendering: (pageNumber: number) => pageRenderState.getSlot(pageNumber).job === 'rendering',
        waitForPageTextLayerReady: pageTextLayerReadyWaiter.waitForPageTextLayerReady,
        renderedPageStateVersion,
        isPageVisualReady,
        getCommittedPageScale: (pageNumber: number) => isCommittedVisual(pageNumber, false)
            ? pageRenderState.getSlot(pageNumber).targetScale
            : null,
        isPageRenderedForClass: (pageNumber: number) => isCommittedVisual(pageNumber, false),
        isPageRenderFailed: (pageNumber: number) => {
            const slot = pageRenderState.getSlot(pageNumber);
            return slot.job === 'failed' && slot.version === renderVersion;
        },
        invalidatePages,
        handlePageRenderStall,
        captureZoomVisualSnapshots: () => {
            const anchor = buildResizeAnchorContext();
            captureResizeVisualSnapshots(anchor, DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS);
            return anchor;
        },
    };
};
export type TPdfRenderingSession = ReturnType<typeof createPdfRenderingSession>;
