import {normalizePdfJsAnnotationId} from '@app/utils/pdfAnnotationRefs';
import type { TPageNumber } from '@contracts/pageNumbers';
import type { TPdfViewRotation } from '@contracts/shared';
import type {
    IPdfLayerRenderResult,
    IRenderVisiblePagesOptions,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { IPdfRasterDemand } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import type { IPdfAnnotation } from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';

export type TPdfPageRasterState = 'current' | 'absent' | 'in-flight' | 'stale-scale' | 'failed';
export type TPdfPageLayers = 'none' | 'canvas-only' | 'hydrating' | 'ready' | 'failed';

export interface IPdfCommittedRasterQuality {
    readonly requestedPixels: number;
    readonly grantedPixels: number;
    readonly pixelScaleFactor: number;
    readonly wasClamped: boolean;
    readonly intent: 'buffer-preview' | 'settled';
    readonly paintsAnnotations?: boolean;
}

export function resolvePdfCommittedRasterQuality(
    renderResult: {
        canvas: Pick<HTMLCanvasElement, 'height' | 'width'>;
        grantedPixels?: number;
        paintsAnnotations?: boolean;
        pixelScaleFactor?: number;
        requestedPixels?: number;
        wasClamped?: boolean;
    },
    intent: IPdfCommittedRasterQuality['intent'],
): IPdfCommittedRasterQuality {
    const fallbackPixels = Math.max(0, renderResult.canvas.width * renderResult.canvas.height);
    const {requestedPixels, grantedPixels, pixelScaleFactor, wasClamped} = renderResult;
    const paintsAnnotations = renderResult.paintsAnnotations !== false;
    if (
        typeof requestedPixels !== 'number' || !Number.isFinite(requestedPixels)
        || typeof grantedPixels !== 'number' || !Number.isFinite(grantedPixels)
        || typeof pixelScaleFactor !== 'number' || !Number.isFinite(pixelScaleFactor)
        || typeof wasClamped !== 'boolean'
    ) {
        return {requestedPixels: fallbackPixels, grantedPixels: fallbackPixels, pixelScaleFactor: 1, wasClamped: false, intent, paintsAnnotations};
    }
    return {requestedPixels, grantedPixels, pixelScaleFactor, wasClamped, intent, paintsAnnotations};
}

interface IPdfRasterTarget {
    readonly targetScale: number;
    readonly targetOutputScale: number;
    readonly targetViewRotation: TPdfViewRotation;
}

/** The raster a page wants; the scheduler runs it under `demand.renderKey`. */
export interface IPdfRasterJob extends IPdfRasterTarget {
    readonly requestId: number;
    demand: IPdfRasterDemand;
    /** The render key without its scale. */
    rasterIdentity: string;
    rasterState: TPdfPageRasterState;
    renderOptions: IRenderVisiblePagesOptions;
    targetOutputScale: number;
    targetScale: number;
}

/** The raster a page shows, until a successor publishes or the page is released. */
export interface IPdfShownRaster extends IPdfRasterTarget {
    readonly render: IPdfLayerRenderResult;
    readonly quality: IPdfCommittedRasterQuality;
    readonly container: HTMLElement;
    readonly documentToken: string;
    /** The render version that authorizes these pixels. */
    readonly version: number;
}

/** The one owner of a page's in-flight text and annotation layer work. */
export interface IPdfLayerHydration {
    readonly controller: AbortController;
}

export interface IPdfPageResource {
    readonly job: IPdfRasterJob | null;
    readonly shown: IPdfShownRaster | null;
    readonly layers: TPdfPageLayers;
    /** The mounted text layer of `shown`, once its page accepted it; text readiness keys on it. */
    readonly text: HTMLElement | null;
    readonly hydration: IPdfLayerHydration | null;
    /** Promote this page's layers text-first as soon as it is idle. */
    readonly textFirst: boolean;
}

export interface IPdfPublicationReceipt {
    readonly render: IPdfLayerRenderResult;
    readonly quality: IPdfCommittedRasterQuality;
    readonly container: HTMLElement;
    readonly documentToken: string;
    readonly version: number;
    /** `retain` keeps ready layers of the previous raster, as a quality refine does. */
    readonly layers: 'hydrating' | 'canvas-only' | 'retain';
}

const EMPTY_RESOURCE: IPdfPageResource = {
    job: null,
    shown: null,
    layers: 'none',
    text: null,
    hydration: null,
    textFirst: false,
};

export const isPdfPageBusy = (resource: IPdfPageResource) => resource.hydration !== null || resource.job?.rasterState === 'in-flight';

export function createPdfPageResources() {
    const resources = shallowReactive(new Map<TPageNumber, IPdfPageResource>());

    function get(pageNumber: TPageNumber) {
        return resources.get(pageNumber) ?? EMPTY_RESOURCE;
    }

    function update(pageNumber: TPageNumber, patch: Partial<IPdfPageResource>) {
        const previous = get(pageNumber);
        const next = {...previous, ...patch};
        // The page's DOM readiness mirrors these layers; nothing else writes it.
        if (next.shown && (next.layers !== previous.layers || next.shown.container !== previous.shown?.container)) {
            next.shown.container.dataset.pageLayerReadiness = next.layers;
        }
        if (next.text !== previous.text) markTextLayerReady(previous.text, next.text);
        if (!next.job && !next.shown && !next.hydration) resources.delete(pageNumber);
        else resources.set(pageNumber, next);
        return next;
    }

    /** Ends the layer owner; layers it had published but not settled stay canvas-only. */
    function dropHydration(resource: IPdfPageResource): Partial<IPdfPageResource> {
        resource.hydration?.controller.abort();
        return {
            hydration: null,
            ...(resource.layers === 'hydrating' ? {layers: 'canvas-only' as const} : {}),
        };
    }

    return {
        resources: resources as ReadonlyMap<TPageNumber, IPdfPageResource>,
        get,
        want(pageNumber: TPageNumber, job: IPdfRasterJob | null) {
            update(pageNumber, {job});
        },
        setJobState(pageNumber: TPageNumber, job: IPdfRasterJob, rasterState: TPdfPageRasterState) {
            job.rasterState = rasterState;
            if (get(pageNumber).job === job) update(pageNumber, {job});
        },
        beginRaster(pageNumber: TPageNumber, job: IPdfRasterJob, container: HTMLElement) {
            const current = get(pageNumber);
            if (current.job !== job) return false;
            update(pageNumber, {
                ...dropHydration(current),
                // A remounted page shows nothing until its raster publishes;
                // the same container keeps its old pixels meanwhile.
                ...(current.shown && current.shown.container !== container ? {shown: null, layers: 'none' as const, text: null} : {}),
            });
            logPdfRenderTrace('renderer-single-page-begin', {pageNumber, requestId: job.requestId, targetScale: job.targetScale});
            return true;
        },
        publish(pageNumber: TPageNumber, job: IPdfRasterJob, receipt: IPdfPublicationReceipt) {
            const current = get(pageNumber);
            if (current.job !== job) return false;
            job.rasterState = 'current';
            const retain = receipt.layers === 'retain' && current.layers === 'ready';
            update(pageNumber, {
                job,
                shown: Object.freeze({
                    render: Object.freeze(receipt.render),
                    quality: receipt.quality,
                    container: receipt.container,
                    documentToken: receipt.documentToken,
                    version: receipt.version,
                    targetScale: job.targetScale,
                    targetOutputScale: job.targetOutputScale,
                    targetViewRotation: job.targetViewRotation,
                }),
                layers: retain ? 'ready' : receipt.layers === 'hydrating' ? 'hydrating' : 'canvas-only',
                text: retain ? current.text : null,
            });
            logPdfRenderTrace('renderer-canvas-mounted', {pageNumber, requestId: job.requestId, intent: receipt.quality.intent});
            return true;
        },
        beginHydration(pageNumber: TPageNumber): IPdfLayerHydration {
            const current = get(pageNumber);
            const hydration = {controller: new AbortController()};
            update(pageNumber, {hydration});
            current.hydration?.controller.abort();
            return hydration;
        },
        /** Layers of the shown raster begin replacing in place, as a promotion does. */
        beginLayers(pageNumber: TPageNumber, hydration: IPdfLayerHydration) {
            const current = get(pageNumber);
            if (current.hydration !== hydration || !current.shown) return false;
            update(pageNumber, {layers: 'hydrating', text: null});
            return true;
        },
        /** The owner's text layer is mounted and complete. */
        markText(pageNumber: TPageNumber, hydration: IPdfLayerHydration, textLayer: HTMLElement) {
            const current = get(pageNumber);
            if (current.hydration !== hydration || current.layers !== 'hydrating') return false;
            update(pageNumber, {text: textLayer});
            return true;
        },
        settleHydration(pageNumber: TPageNumber, hydration: IPdfLayerHydration, outcome: 'ready' | 'canvas-only' | 'failed') {
            const current = get(pageNumber);
            if (current.hydration !== hydration) return false;
            if (current.layers !== 'hydrating') {
                update(pageNumber, {hydration: null});
                return false;
            }
            const layers = outcome === 'ready' && !current.text ? 'canvas-only' : outcome;
            update(pageNumber, {hydration: null, layers});
            logPdfRenderTrace('renderer-layer-hydration-settled', {pageNumber, outcome: layers});
            return true;
        },
        requestTextFirst(pageNumber: TPageNumber, requested: boolean) {
            if (get(pageNumber).textFirst !== requested && (!requested || get(pageNumber).shown)) update(pageNumber, {textFirst: requested});
        },
        /** A new render version: no job survives, and only `restamp` keeps shown pixels authorized. */
        reauthorize(version: number, documentToken: string, excludedPages: ReadonlySet<TPageNumber>, restamp: boolean) {
            for (const [pageNumber, resource] of [...resources]) {
                const shown = restamp && resource.shown && !excludedPages.has(pageNumber)
                    ? Object.freeze({...resource.shown, version, documentToken})
                    : resource.shown;
                update(pageNumber, {...dropHydration(resource), job: null, shown});
            }
        },
        release(pageNumber: TPageNumber) {
            const resource = get(pageNumber);
            resource.hydration?.controller.abort();
            markTextLayerReady(resource.text, null);
            resources.delete(pageNumber);
        },
        clear() {
            for (const resource of resources.values()) {
                resource.hydration?.controller.abort();
                markTextLayerReady(resource.text, null);
            }
            resources.clear();
        },
        isOriginalAppearance(pageNumber: TPageNumber, pdfRef: string | null | undefined) {
            const shown = get(pageNumber).shown;
            const id = normalizePdfJsAnnotationId(pdfRef);
            const input = shown?.render.annotationInput;
            const output = shown?.render.annotationOutput;
            const annotation = id && input ? annotationsByNormalizedId(input.annotations).get(id) : undefined;
            if (!shown || !id || !input || !output || input.excludedIds.has(id) || !annotation
                || input.nativeAnnotationAppearance?.annotations.some(entry => entry.id === id && entry.action !== 'retain')) return false;
            if (!annotation.hasOwnCanvas || !output.requestedSeparateCanvas) return true;
            const canvas = output.ownCanvases.find(([ref]) => normalizePdfJsAnnotationId(ref) === id)?.[1];
            return Boolean(canvas?.isConnected && shown.container.contains(canvas));
        },
        isNativeTextBoxAppearance(pageNumber: TPageNumber, annotationId: string) {
            const shown = get(pageNumber).shown;
            const input = shown?.render.annotationInput;
            const entity = input?.semanticInputs.find(entry => entry.id === annotationId);
            const id = entity?.ref ?? annotationId;
            return shown?.render.canvas.isConnected === true
                && shown.container.contains(shown.render.canvas)
                && Boolean(entity && input?.nativeAnnotationAppearance?.annotations.some(entry => (
                    entry.id === id && (entry.action === 'replace' || entry.action === 'append')
                )));
        },
    };
}

export type TPdfPageResources = ReturnType<typeof createPdfPageResources>;

// The text layer's DOM readiness mirrors the resource; nothing else writes it.
function markTextLayerReady(previous: HTMLElement | null, next: HTMLElement | null) {
    if (previous) delete previous.dataset.pdfTextLayerReady;
    if (next) next.dataset.pdfTextLayerReady = 'true';
}

// A committed render's annotations by normalized PDF.js id, the first entry
// for an id winning. Each marker of a dense page asks for its own, and
// scanning the page's 500 annotations for each one is quadratic in the page.
const committedAnnotationIndexes = new WeakMap<readonly IPdfAnnotation[], ReadonlyMap<string, IPdfAnnotation>>();

function annotationsByNormalizedId(annotations: readonly IPdfAnnotation[]) {
    const indexed = committedAnnotationIndexes.get(annotations);
    if (indexed) return indexed;
    const index = new Map<string, IPdfAnnotation>();
    for (const entry of annotations) {
        const id = normalizePdfJsAnnotationId(entry.id);
        if (id && !index.has(id)) index.set(id, entry);
    }
    committedAnnotationIndexes.set(annotations, index);
    return index;
}
