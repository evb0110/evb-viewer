import type { Ref } from 'vue';
import type { TPageNumber } from '@contracts/pageNumbers';
import type { TPdfViewRotation } from '@contracts/shared';
import type {
    IPdfPageRasterScheduler,
    IPdfRasterDemand,
    IPdfRasterRenderTarget,
} from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import type {
    IPdfPageRegion,
    usePdfCanvasRenderer,
} from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer';
import type { TPdfPageRenderState } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';
import type { IPdfLayerRenderResult } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

const SCALE_RELATIVE_TOLERANCE = 0.000_1;
// A side keeps at most half the visible size as margin, so a pan renders at
// most four times the visible area.
const MAX_MARGIN_FRACTION = 0.5;
// The margin opposite a pan may shrink to a third of the leading one, as in
// PDF.js's PDFPageDetailView, before the region is re-centred.
const MAX_MARGIN_IMBALANCE = 3;
// A detail raster is made only where it is clearly sharper than the page.
const MIN_DENSITY_GAIN = 1 / 0.9;

type TCanvasRenderer = ReturnType<typeof usePdfCanvasRenderer>;
type TPreparedCanvas = NonNullable<Awaited<ReturnType<TCanvasRenderer['prepareCanvasRender']>>>;

interface IDetailContent {
    readonly document: unknown;
    readonly signature: string;
    readonly rotation: TPdfViewRotation;
}

const isSameContent = (left: IDetailContent, right: IDetailContent) => left.document === right.document
    && left.signature === right.signature
    && left.rotation === right.rotation;

interface IDetailJob {
    readonly pageNumber: TPageNumber;
    readonly area: IPdfPageRegion;
    readonly scale: number;
    readonly outputScale: number;
    readonly base: IPdfLayerRenderResult;
    readonly content: IDetailContent;
    readonly demand: IPdfRasterDemand;
}

interface IShownDetail extends IDetailJob {readonly render: TPreparedCanvas;}

interface IPreparedDetail {
    job: IDetailJob;
    render: TPreparedCanvas;
}

/**
 * The region of a page worth a detail raster, `'current'` when the shown one
 * still covers the visible part with enough margin, or `null` when the
 * whole-page raster is already about as sharp as the budget allows.
 */
export function resolvePdfDetailArea(input: {
    visible: IPdfPageRegion;
    pageWidth: number;
    pageHeight: number;
    outputScale: number;
    budgetPixels: number;
    baseDensity: number;
    current: IPdfPageRegion | null;
}): IPdfPageRegion | 'current' | null {
    const {
        visible, current,
    } = input;
    if (current && current.x0 <= visible.x0 && current.y0 <= visible.y0 && current.x1 >= visible.x1 && current.y1 >= visible.y1) {
        const isLopsided = (before: number, after: number, startsInside: boolean, endsInside: boolean) => (
            startsInside && after > MAX_MARGIN_IMBALANCE * before
            || endsInside && before > MAX_MARGIN_IMBALANCE * after
        );
        const left = visible.x0 - current.x0;
        const right = current.x1 - visible.x1;
        const top = visible.y0 - current.y0;
        const bottom = current.y1 - visible.y1;
        if (!isLopsided(left, right, current.x0 > 0, current.x1 < 1) && !isLopsided(top, bottom, current.y0 > 0, current.y1 < 1)) {
            return 'current';
        }
    }
    const devicePixelsPerArea = input.pageWidth * input.pageHeight * input.outputScale ** 2;
    const visiblePixels = (visible.x1 - visible.x0) * (visible.y1 - visible.y0) * devicePixelsPerArea;
    const margin = Math.min(MAX_MARGIN_FRACTION, Math.max(0, (Math.sqrt(input.budgetPixels / visiblePixels) - 1) / 2));
    const marginX = (visible.x1 - visible.x0) * margin;
    const marginY = (visible.y1 - visible.y0) * margin;
    const quantize = (value: number) => Math.round(value * 10_000) / 10_000;
    const area = {
        x0: quantize(Math.max(0, visible.x0 - marginX)),
        y0: quantize(Math.max(0, visible.y0 - marginY)),
        x1: quantize(Math.min(1, visible.x1 + marginX)),
        y1: quantize(Math.min(1, visible.y1 + marginY)),
    };
    const areaPixels = (area.x1 - area.x0) * (area.y1 - area.y0) * devicePixelsPerArea;
    const density = Math.min(1, Math.sqrt(input.budgetPixels / areaPixels));
    return density > input.baseDensity * MIN_DENSITY_GAIN ? area : null;
}

/**
 * Owns the detail raster of each visible page: a canvas over the part of the
 * page in view, painted at full output scale when the whole-page raster had to
 * be clamped. The whole-page raster stays the page visual and the source of its
 * readiness; a detail raster only adds pixels above it and goes away whenever
 * its page content changes.
 */
export function createPdfDetailRaster(options: {
    sourceId: string;
    budgetPixels: number;
    settledMaxCanvasPixels: number;
    canvasRenderer: TCanvasRenderer;
    pageRenderState: TPdfPageRenderState;
    viewerContainer: Readonly<Ref<HTMLElement | null>>;
    getScheduler: () => IPdfPageRasterScheduler | null;
    getDocument: () => unknown;
    getMountedTarget: (pageNumber: TPageNumber) => {
        container: HTMLElement;
        detailHost: HTMLElement | null
    } | null;
    getScale: () => number;
    getOutputScale: () => number;
    getRotation: () => TPdfViewRotation;
    getHiddenAnnotationIds: () => Set<string>;
    getSourceMaxPixels: (pageNumber: TPageNumber) => number | null;
    isCommittedVisual: (pageNumber: TPageNumber) => boolean;
    canStartWork: () => boolean;
}) {
    const shown = new Map<TPageNumber, IShownDetail>();
    const jobs = new Map<string, IDetailJob>();
    // Render keys the budget evicted or that failed every attempt, per page;
    // asking again while the page stays in view would only repeat that.
    const refused = new Map<TPageNumber, Set<string>>();
    const refuse = (pageNumber: TPageNumber, renderKey: string) => {
        refused.set(pageNumber, (refused.get(pageNumber) ?? new Set<string>()).add(renderKey));
    };
    let scheduler: IPdfPageRasterScheduler | null = null;

    const isSameScale = (left: number, right: number) => Math.abs(left - right) <= Math.max(1, Math.abs(right)) * SCALE_RELATIVE_TOLERANCE;

    function readBaseContent(render: IPdfLayerRenderResult): IDetailContent {
        return {
            document: options.getDocument(),
            signature: render.annotationInput?.signature ?? '',
            rotation: options.getRotation(),
        };
    }

    function isContentCurrent(pageNumber: TPageNumber, content: IDetailContent) {
        const base = options.pageRenderState.getSlot(pageNumber).committedRender;
        return base !== null && isSameContent(readBaseContent(base), content);
    }

    function removeShown(pageNumber: TPageNumber) {
        const detail = shown.get(pageNumber);
        if (!detail) return;
        shown.delete(pageNumber);
        options.canvasRenderer.cleanupCanvasRenderResult(detail.render);
    }

    function isJobCurrent(job: IDetailJob) {
        return jobs.get(job.demand.renderKey) === job
            && options.getMountedTarget(job.pageNumber)?.detailHost != null
            && isContentCurrent(job.pageNumber, job.content);
    }

    const target: IPdfRasterRenderTarget<IPreparedDetail> = {
        id: options.sourceId,
        async prepare(demand, page, signal, captureSettlement) {
            const job = jobs.get(demand.renderKey);
            if (!job || !isJobCurrent(job)) return null;
            const shouldContinue = () => !signal.aborted && isJobCurrent(job);
            const render = await options.canvasRenderer.prepareCanvasRender(page, job.scale, {
                region: {
                    area: job.area,
                    base: job.base,
                },
                maxCanvasPixels: options.budgetPixels,
                hiddenAnnotationIds: options.getHiddenAnnotationIds,
                pageRenderCoordination: {
                    owner: options.sourceId,
                    priority: 50,
                    signal,
                    shouldStart: shouldContinue,
                    shouldContinue,
                    captureSettlement,
                },
            });
            if (render && !shouldContinue()) {
                options.canvasRenderer.cleanupCanvasRenderResult(render);
                return null;
            }
            return render ? {
                job,
                render,
            } : null;
        },
        start: prepared => prepared.render.startRender(),
        additionalResourceBytes: prepared => prepared.render.additionalResourceBytes,
        commit(prepared, _demand, commitRaster) {
            const {
                job, render,
            } = prepared;
            const host = options.getMountedTarget(job.pageNumber)?.detailHost;
            if (!host || !isJobCurrent(job)) return false;
            const previous = shown.get(job.pageNumber);
            // Shown before the scheduler takes it, so a budget eviction during
            // that commit removes this canvas. The scheduler releases the one
            // it replaces as 'raster-replaced', which leaves that to this swap.
            host.append(render.canvas);
            shown.set(job.pageNumber, {
                ...job,
                render,
            });
            if (!commitRaster()) {
                render.canvas.remove();
                if (previous) shown.set(job.pageNumber, previous);
                else shown.delete(job.pageNumber);
                return false;
            }
            if (previous) options.canvasRenderer.cleanupCanvasRenderResult(previous.render);
            jobs.delete(job.demand.renderKey);
            return true;
        },
        discard(prepared) {
            if (shown.get(prepared.job.pageNumber)?.render !== prepared.render) {
                options.canvasRenderer.cleanupCanvasRenderResult(prepared.render);
            }
        },
        release(pageNumber, reason) {
            if (reason === 'raster-replaced') return;
            const evicted = shown.get(pageNumber);
            if (reason === 'surface-budget-eviction' && evicted) refuse(pageNumber, evicted.demand.renderKey);
            removeShown(pageNumber);
        },
        onRenderExhausted(outcome) {
            refuse(outcome.demand.pageNumber, outcome.demand.renderKey);
            jobs.delete(outcome.demand.renderKey);
            logPdfRenderTrace('renderer-detail-raster-exhausted', {
                pageNumber: outcome.demand.pageNumber,
                status: outcome.status,
            });
        },
    };

    function readVisibleArea(pageNumber: TPageNumber): IPdfPageRegion & {
        width: number;
        height: number
    } | null {
        const surface = options.getMountedTarget(pageNumber)?.container.querySelector<HTMLElement>('.page_canvas');
        const viewer = options.viewerContainer.value;
        if (!surface || !viewer) return null;
        const page = surface.getBoundingClientRect();
        const box = viewer.getBoundingClientRect();
        const left = Math.max(page.left, box.left + viewer.clientLeft);
        const top = Math.max(page.top, box.top + viewer.clientTop);
        const right = Math.min(page.right, box.left + viewer.clientLeft + viewer.clientWidth);
        const bottom = Math.min(page.bottom, box.top + viewer.clientTop + viewer.clientHeight);
        if (right - left < 1 || bottom - top < 1) return null;
        return {
            x0: (left - page.left) / page.width,
            y0: (top - page.top) / page.height,
            x1: (right - page.left) / page.width,
            y1: (bottom - page.top) / page.height,
            width: page.width,
            height: page.height,
        };
    }

    /** The job a page needs now, `'keep'` for its shown detail, or `'drop'`. */
    function planPage(pageNumber: TPageNumber, ordinal: number, activeScheduler: IPdfPageRasterScheduler): IDetailJob | 'keep' | 'drop' {
        // While its whole-page raster is replaced, a shown detail stretches
        // with it like any committed raster.
        if (!options.isCommittedVisual(pageNumber)) return 'keep';
        const slot = options.pageRenderState.getSlot(pageNumber);
        const base = slot.committedRender;
        const quality = slot.committedRasterQuality;
        const sourceMaxPixels = options.getSourceMaxPixels(pageNumber);
        if (
            !base || !quality || quality.intent !== 'settled' || !quality.wasClamped
            || sourceMaxPixels !== null && sourceMaxPixels <= options.settledMaxCanvasPixels
        ) return 'drop';
        const visible = readVisibleArea(pageNumber);
        if (!visible) return 'keep';
        const scale = options.getScale();
        const outputScale = options.getOutputScale();
        const rotation = options.getRotation();
        const current = shown.get(pageNumber);
        const area = resolvePdfDetailArea({
            visible,
            pageWidth: visible.width,
            pageHeight: visible.height,
            outputScale,
            budgetPixels: options.budgetPixels,
            baseDensity: quality.pixelScaleFactor,
            current: current && isSameScale(current.scale, scale) && isSameScale(current.outputScale, outputScale)
                && current.content.rotation === rotation ? current.area : null,
        });
        if (area === 'current') return 'keep';
        if (area === null) return 'drop';
        const renderKey = [
            pageNumber,
            scale,
            outputScale,
            rotation,
            area.x0,
            area.y0,
            area.x1,
            area.y1,
        ].join(':');
        if (refused.get(pageNumber)?.has(renderKey)) return 'keep';
        const pending = jobs.get(renderKey);
        if (pending) return pending;
        return {
            pageNumber,
            area,
            scale,
            outputScale,
            base,
            content: readBaseContent(base),
            demand: {
                pageNumber,
                renderKey,
                lane: 'viewport-detail',
                ordinal,
                estimatedPixels: Math.min(
                    options.budgetPixels,
                    Math.ceil((area.x1 - area.x0) * (area.y1 - area.y0) * visible.width * visible.height * outputScale ** 2),
                ),
                retention: 'render-cache',
                documentFence: activeScheduler.documentFence,
                consumerGeneration: 0,
            },
        };
    }

    /**
     * Brings detail rasters in line with the pages in view. Shown details of
     * other pages go; new work starts only when `canStart` says no whole-page
     * raster of a visible page is still owed.
     */
    function reconcile(requiredPages: readonly TPageNumber[], canStart: boolean) {
        const activeScheduler = options.getScheduler();
        if (activeScheduler !== scheduler) {
            void scheduler?.releaseSource(options.sourceId);
            [...shown.keys()].forEach(removeShown);
            jobs.clear();
            refused.clear();
            scheduler = activeScheduler;
        }
        if (!activeScheduler) return;
        const required = new Set(requiredPages);
        for (const pageNumber of refused.keys()) {
            if (!required.has(pageNumber)) refused.delete(pageNumber);
        }
        for (const [
            pageNumber,
            detail,
        ] of shown) {
            if (!required.has(pageNumber) || !isContentCurrent(pageNumber, detail.content)) clear(pageNumber);
        }
        const demands: IPdfRasterDemand[] = [];
        const nextJobs: IDetailJob[] = [];
        requiredPages.forEach((pageNumber, ordinal) => {
            const plan = canStart ? planPage(pageNumber, ordinal, activeScheduler) : 'keep';
            if (plan === 'drop') {
                clear(pageNumber);
            } else if (plan === 'keep') {
                const detail = shown.get(pageNumber);
                if (detail) demands.push(detail.demand);
            } else {
                nextJobs.push(plan);
            }
        });
        if (nextJobs.length > 0 && options.canStartWork()) {
            nextJobs.forEach((job) => {
                jobs.set(job.demand.renderKey, job);
                demands.push(job.demand);
            });
        } else {
            nextJobs.forEach((job) => {
                const detail = shown.get(job.pageNumber);
                if (detail) demands.push(detail.demand);
            });
        }
        const demandKeys = new Set(demands.map(demand => demand.renderKey));
        for (const key of jobs.keys()) {
            if (!demandKeys.has(key)) jobs.delete(key);
        }
        activeScheduler.setDemand({
            sourceId: options.sourceId,
            input: demands,
            policy: {
                expand: (input: readonly IPdfRasterDemand[]) => input,
                compareWithinLane: (left: IPdfRasterDemand, right: IPdfRasterDemand) => left.ordinal - right.ordinal,
            },
            target,
        });
    }

    /** Drops a page's detail raster and any work for it. */
    function clear(pageNumber: TPageNumber) {
        removeShown(pageNumber);
        for (const [
            key,
            job,
        ] of jobs) {
            if (job.pageNumber === pageNumber) jobs.delete(key);
        }
        scheduler?.invalidate({
            pages: [pageNumber],
            reason: 'detail-page-cleared',
            sourceId: options.sourceId,
        });
    }

    return {
        reconcile,
        clear,
        /** Called as a new whole-page raster is published; other content ends the detail. */
        handleBaseCommit(pageNumber: TPageNumber, render: IPdfLayerRenderResult) {
            const content = readBaseContent(render);
            if ([
                shown.get(pageNumber),
                ...jobs.values(),
            ].some(detail => detail?.pageNumber === pageNumber && !isSameContent(detail.content, content))) clear(pageNumber);
        },
        cancel() {
            jobs.clear();
            return scheduler?.cancelSource(options.sourceId) ?? Promise.resolve();
        },
        release() {
            const release = scheduler?.releaseSource(options.sourceId) ?? Promise.resolve();
            [...shown.keys()].forEach(removeShown);
            jobs.clear();
            refused.clear();
            return release;
        },
    };
}
