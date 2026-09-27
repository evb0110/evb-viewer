import type { TPageNumber } from '@contracts/pageNumbers';
import type { TPdfViewRotation } from '@contracts/shared';

import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

type TPdfPageRenderVisualState = 'none' | 'ready';
type TPdfPageRenderJobState = 'idle' | 'rendering' | 'failed';
type TPdfPageCanvasReadiness = 'none' | 'ready';
type TPdfPageLayerReadiness = 'none' | 'canvas-only' | 'hydrating' | 'ready';
type TPdfPageTextLayerReadiness = 'none' | 'ready';

export interface IPdfCommittedRasterQuality {
    readonly requestedPixels: number;
    readonly grantedPixels: number;
    readonly pixelScaleFactor: number;
    readonly wasClamped: boolean;
    readonly intent: 'buffer-preview' | 'settled';
}

export function resolvePdfCommittedRasterQuality(
    renderResult: {
        canvas: Pick<HTMLCanvasElement, 'height' | 'width'>;
        grantedPixels?: number;
        pixelScaleFactor?: number;
        requestedPixels?: number;
        wasClamped?: boolean;
    },
    intent: IPdfCommittedRasterQuality['intent'],
): IPdfCommittedRasterQuality {
    const fallbackPixels = Math.max(0, renderResult.canvas.width * renderResult.canvas.height);
    const requestedPixels = renderResult.requestedPixels;
    const grantedPixels = renderResult.grantedPixels;
    const pixelScaleFactor = renderResult.pixelScaleFactor;
    const wasClamped = renderResult.wasClamped;
    if (
        typeof requestedPixels !== 'number'
        || !Number.isFinite(requestedPixels)
        || typeof grantedPixels !== 'number'
        || !Number.isFinite(grantedPixels)
        || typeof pixelScaleFactor !== 'number'
        || !Number.isFinite(pixelScaleFactor)
        || typeof wasClamped !== 'boolean'
    ) {
        return {
            requestedPixels: fallbackPixels,
            grantedPixels: fallbackPixels,
            pixelScaleFactor: 1,
            wasClamped: false,
            intent,
        };
    }
    return {
        requestedPixels,
        grantedPixels,
        pixelScaleFactor,
        wasClamped,
        intent,
    };
}

interface IPdfPageRenderSlot {
    readonly visual: TPdfPageRenderVisualState;
    readonly canvasReadiness: TPdfPageCanvasReadiness;
    readonly layerReadiness: TPdfPageLayerReadiness;
    readonly textLayerReadiness: TPdfPageTextLayerReadiness;
    readonly job: TPdfPageRenderJobState;
    readonly version: number | null;
    readonly contentVersion: number | null;
    readonly requestId: number | null;
    readonly hydrationRequestId: number | null;
    readonly documentToken: string | null;
    readonly targetScale: number | null;
    readonly targetOutputScale: number | null;
    readonly targetViewRotation: TPdfViewRotation | null;
    readonly container: HTMLElement | null;
    readonly committedRasterQuality: IPdfCommittedRasterQuality | null;
    readonly pendingDocumentToken: string | null;
    readonly pendingTargetScale: number | null;
    readonly pendingTargetOutputScale: number | null;
    readonly pendingTargetViewRotation: TPdfViewRotation | null;
    readonly pendingContainer: HTMLElement | null;
}

export interface IPdfPageNumberStateSet extends Iterable<TPageNumber> {
    readonly size: number;
    add: (pageNumber: TPageNumber) => IPdfPageNumberStateSet;
    clear: () => void;
    delete: (pageNumber: TPageNumber) => boolean;
    entries: () => SetIterator<[TPageNumber, TPageNumber]>;
    forEach: (callback: (value: TPageNumber) => void) => void;
    has: (pageNumber: TPageNumber) => boolean;
    keys: () => SetIterator<TPageNumber>;
    values: () => SetIterator<TPageNumber>;
}

export interface IPdfPageNumberStateMap extends Iterable<[TPageNumber, number]> {
    readonly size: number;
    clear: () => void;
    delete: (pageNumber: TPageNumber) => boolean;
    entries: () => MapIterator<[TPageNumber, number]>;
    forEach: (callback: (value: number, key: TPageNumber) => void) => void;
    get: (pageNumber: TPageNumber) => number | undefined;
    has: (pageNumber: TPageNumber) => boolean;
    keys: () => MapIterator<TPageNumber>;
    set: (pageNumber: TPageNumber, value: number) => IPdfPageNumberStateMap;
    values: () => MapIterator<number>;
}

const EMPTY_RENDER_SLOT: IPdfPageRenderSlot = {
    visual: 'none',
    canvasReadiness: 'none',
    layerReadiness: 'none',
    textLayerReadiness: 'none',
    job: 'idle',
    version: null,
    contentVersion: null,
    requestId: null,
    hydrationRequestId: null,
    documentToken: null,
    targetScale: null,
    targetOutputScale: null,
    targetViewRotation: null,
    container: null,
    committedRasterQuality: null,
    pendingDocumentToken: null,
    pendingTargetScale: null,
    pendingTargetOutputScale: null,
    pendingTargetViewRotation: null,
    pendingContainer: null,
};

export function createPdfPageRenderState() {
    const slots = new Map<TPageNumber, IPdfPageRenderSlot>();

    function getSlot(pageNumber: TPageNumber) {
        return slots.get(pageNumber) ?? EMPTY_RENDER_SLOT;
    }

    function setSlot(pageNumber: TPageNumber, slot: IPdfPageRenderSlot) {
        if (
            slot.canvasReadiness === 'none'
            && slot.layerReadiness === 'none'
            && slot.job === 'idle'
        ) {
            slots.delete(pageNumber);
            return;
        }
        slots.set(pageNumber, slot);
    }

    function updateSlot(pageNumber: TPageNumber, patch: Partial<IPdfPageRenderSlot>) {
        setSlot(pageNumber, {
            ...getSlot(pageNumber),
            ...patch,
        });
    }

    function createSetView(options: {
        includes: (slot: IPdfPageRenderSlot) => boolean;
        add: (pageNumber: TPageNumber) => void;
        remove: (pageNumber: TPageNumber) => void;
    }): IPdfPageNumberStateSet {
        const pageNumbers = () => [...slots]
            .filter(([
                , slot,
            ]) => options.includes(slot))
            .map(([pageNumber]) => pageNumber);
        const view: IPdfPageNumberStateSet = {
            get size() {
                return pageNumbers().length;
            },
            add(pageNumber) {
                options.add(pageNumber);
                return view;
            },
            clear() {
                pageNumbers().forEach(options.remove);
            },
            delete(pageNumber) {
                if (!view.has(pageNumber)) {
                    return false;
                }
                options.remove(pageNumber);
                return true;
            },
            entries() {
                return new Set(pageNumbers()).entries();
            },
            forEach(callback) {
                pageNumbers().forEach(pageNumber => callback(pageNumber));
            },
            has(pageNumber) {
                return options.includes(getSlot(pageNumber));
            },
            keys() {
                return new Set(pageNumbers()).keys();
            },
            values() {
                return new Set(pageNumbers()).values();
            },
            [Symbol.iterator]() {
                return view.values();
            },
        };
        return view;
    }

    function createMapView(options: {
        getValue: (slot: IPdfPageRenderSlot) => number | null;
        setValue: (pageNumber: TPageNumber, value: number) => void;
        remove: (pageNumber: TPageNumber) => void;
    }): IPdfPageNumberStateMap {
        const entries = () => [...slots]
            .map(([
                pageNumber,
                slot,
            ]) => [
                pageNumber,
                options.getValue(slot),
            ] as const)
            .filter((entry): entry is readonly [TPageNumber, number] => entry[1] !== null);
        const view: IPdfPageNumberStateMap = {
            get size() {
                return entries().length;
            },
            clear() {
                entries().forEach(([pageNumber]) => options.remove(pageNumber));
            },
            delete(pageNumber) {
                if (!view.has(pageNumber)) {
                    return false;
                }
                options.remove(pageNumber);
                return true;
            },
            entries() {
                return new Map(entries()).entries();
            },
            forEach(callback) {
                entries().forEach(([
                    pageNumber,
                    value,
                ]) => callback(value, pageNumber));
            },
            get(pageNumber) {
                return options.getValue(getSlot(pageNumber)) ?? undefined;
            },
            has(pageNumber) {
                return options.getValue(getSlot(pageNumber)) !== null;
            },
            keys() {
                return new Map(entries()).keys();
            },
            set(pageNumber, value) {
                options.setValue(pageNumber, value);
                return view;
            },
            values() {
                return new Map(entries()).values();
            },
            [Symbol.iterator]() {
                return view.entries();
            },
        };
        return view;
    }

    const renderedPages = createSetView({
        includes: slot => slot.canvasReadiness === 'ready',
        add: pageNumber => updateSlot(pageNumber, {
            visual: 'ready',
            canvasReadiness: 'ready',
        }),
        remove: pageNumber => updateSlot(pageNumber, {
            visual: 'none',
            canvasReadiness: 'none',
            layerReadiness: 'none',
            textLayerReadiness: 'none',
            hydrationRequestId: null,
        }),
    });
    const renderingPages = createMapView({
        getValue: slot => slot.job === 'rendering' ? slot.version : null,
        setValue: (pageNumber, version) => updateSlot(pageNumber, {
            job: 'rendering',
            version,
        }),
        remove: pageNumber => updateSlot(pageNumber, {
            job: 'idle',
            version: null,
            requestId: null,
            hydrationRequestId: null,
            pendingDocumentToken: null,
            pendingTargetScale: null,
            pendingTargetOutputScale: null,
            pendingTargetViewRotation: null,
            pendingContainer: null,
        }),
    });
    const renderingPageRequestIds = createMapView({
        getValue: slot => slot.job === 'rendering' ? slot.requestId : null,
        setValue: (pageNumber, requestId) => updateSlot(pageNumber, {
            job: 'rendering',
            requestId,
        }),
        remove: pageNumber => updateSlot(pageNumber, {
            job: 'idle',
            version: null,
            requestId: null,
            hydrationRequestId: null,
            pendingDocumentToken: null,
            pendingTargetScale: null,
            pendingTargetOutputScale: null,
            pendingTargetViewRotation: null,
            pendingContainer: null,
        }),
    });

    return {
        slots: slots as ReadonlyMap<TPageNumber, IPdfPageRenderSlot>,
        renderedPages,
        renderingPages,
        renderingPageRequestIds,
        getSlot,
        markRenderFailed(pageNumber: TPageNumber, version: number, requestId: number) {
            const current = getSlot(pageNumber);
            if (
                current.job !== 'rendering'
                || current.version !== version
                || current.requestId !== requestId
            ) {
                return false;
            }
            updateSlot(pageNumber, {
                job: 'failed',
                version,
                requestId,
            });
            return true;
        },
        beginRender(
            pageNumber: TPageNumber,
            version: number,
            requestId: number,
            documentToken: string,
            targetScale: number,
            targetOutputScale = 1,
            container: HTMLElement | null = null,
            beginOptions: {
                preserveCommittedVisual?: boolean;
                targetViewRotation?: TPdfViewRotation
            } = {},
        ) {
            const current = getSlot(pageNumber);
            const targetViewRotation = beginOptions.targetViewRotation ?? current.targetViewRotation ?? 0;
            const preserveCommittedVisual = beginOptions.preserveCommittedVisual === true
                && current.canvasReadiness === 'ready'
                && current.container === container;
            updateSlot(pageNumber, {
                visual: preserveCommittedVisual ? 'ready' : 'none',
                canvasReadiness: preserveCommittedVisual ? 'ready' : 'none',
                layerReadiness: preserveCommittedVisual ? current.layerReadiness : 'none',
                textLayerReadiness: preserveCommittedVisual ? current.textLayerReadiness : 'none',
                job: 'rendering',
                version,
                contentVersion: preserveCommittedVisual ? current.contentVersion : version,
                requestId,
                hydrationRequestId: preserveCommittedVisual ? current.hydrationRequestId : null,
                documentToken: preserveCommittedVisual ? current.documentToken : documentToken,
                targetScale: preserveCommittedVisual ? current.targetScale : targetScale,
                targetOutputScale: preserveCommittedVisual
                    ? current.targetOutputScale
                    : targetOutputScale,
                targetViewRotation: preserveCommittedVisual ? current.targetViewRotation : targetViewRotation,
                committedRasterQuality: preserveCommittedVisual
                    ? current.committedRasterQuality
                    : null,
                container: preserveCommittedVisual ? current.container : container,
                pendingDocumentToken: documentToken,
                pendingTargetScale: targetScale,
                pendingTargetOutputScale: targetOutputScale,
                pendingTargetViewRotation: targetViewRotation,
                pendingContainer: container,
            });
            logPdfRenderTrace('renderer-single-page-begin', {
                pageNumber,
                version,
                requestId,
                documentToken,
                targetScale,
                preserveCommittedVisual,
            });
        },
        beginQualityRefine(
            pageNumber: TPageNumber,
            version: number,
            requestId: number,
            documentToken: string,
            targetScale: number,
            targetOutputScale = 1,
            container: HTMLElement | null = getSlot(pageNumber).container,
        ) {
            this.beginRender(
                pageNumber,
                version,
                requestId,
                documentToken,
                targetScale,
                targetOutputScale,
                container,
                {
                    preserveCommittedVisual: true,
                    targetViewRotation: getSlot(pageNumber).targetViewRotation ?? 0,
                },
            );
        },
        commitVisual(
            pageNumber: TPageNumber,
            version: number,
            requestId: number,
            committedRasterQuality: IPdfCommittedRasterQuality = {
                requestedPixels: 0,
                grantedPixels: 0,
                pixelScaleFactor: 1,
                wasClamped: false,
                intent: 'settled',
            },
        ) {
            const current = getSlot(pageNumber);
            if (current.job !== 'rendering' || current.version !== version || current.requestId !== requestId) {
                return false;
            }
            updateSlot(pageNumber, {
                visual: 'ready',
                canvasReadiness: 'ready',
                contentVersion: version,
                documentToken: current.pendingDocumentToken,
                targetScale: current.pendingTargetScale,
                targetOutputScale: current.pendingTargetOutputScale,
                targetViewRotation: current.pendingTargetViewRotation,
                container: current.pendingContainer,
                committedRasterQuality,
            });
            logPdfRenderTrace('renderer-canvas-mounted', {
                pageNumber,
                version,
                requestId,
                intent: committedRasterQuality.intent,
            });
            return true;
        },
        markCanvasOnly(pageNumber: TPageNumber, version: number, requestId: number) {
            const current = getSlot(pageNumber);
            if (
                current.job !== 'rendering'
                || current.version !== version
                || current.requestId !== requestId
                || current.canvasReadiness !== 'ready'
            ) {
                return false;
            }
            updateSlot(pageNumber, {
                layerReadiness: 'canvas-only',
                textLayerReadiness: 'none',
                hydrationRequestId: null,
            });
            return true;
        },
        beginLayerHydration(
            pageNumber: TPageNumber,
            version: number,
            requestId: number,
            documentToken: string,
            targetScale: number,
            targetOutputScale: number,
            container: HTMLElement,
        ) {
            const current = getSlot(pageNumber);
            if (
                current.canvasReadiness !== 'ready'
                || current.documentToken !== documentToken
                || current.contentVersion !== version
                || current.targetScale !== targetScale
                || current.targetOutputScale !== targetOutputScale
                || current.container !== container
                || current.job !== 'idle'
                || (
                    current.layerReadiness !== 'none'
                    && current.layerReadiness !== 'canvas-only'
                )
            ) {
                return false;
            }
            updateSlot(pageNumber, {
                layerReadiness: 'hydrating',
                job: 'rendering',
                version,
                requestId,
                hydrationRequestId: requestId,
            });
            logPdfRenderTrace('renderer-layer-hydration-begin', {
                pageNumber,
                version,
                requestId,
                source: 'promotion',
            });
            return true;
        },
        markLayersHydrating(pageNumber: TPageNumber, version: number, requestId: number) {
            const current = getSlot(pageNumber);
            if (current.layerReadiness === 'hydrating') {
                return current.job === 'rendering'
                    && current.version === version
                    && current.requestId === requestId
                    && current.hydrationRequestId === requestId;
            }
            if (
                current.job !== 'rendering'
                || current.version !== version
                || current.requestId !== requestId
                || current.canvasReadiness !== 'ready'
            ) {
                return false;
            }
            updateSlot(pageNumber, {
                layerReadiness: 'hydrating',
                hydrationRequestId: requestId,
            });
            logPdfRenderTrace('renderer-layer-hydration-begin', {
                pageNumber,
                version,
                requestId,
                source: 'canvas-commit',
            });
            return true;
        },
        markTextLayerReady(
            pageNumber: TPageNumber,
            contentVersion: number,
            hydrationRequestId: number,
            container: HTMLElement,
        ) {
            const current = getSlot(pageNumber);
            if (
                current.canvasReadiness !== 'ready'
                || current.contentVersion !== contentVersion
                || current.layerReadiness !== 'hydrating'
                || current.hydrationRequestId !== hydrationRequestId
                || current.container !== container
            ) {
                return false;
            }
            updateSlot(pageNumber, {textLayerReadiness: 'ready'});
            logPdfRenderTrace('renderer-text-layer-ready', {
                pageNumber,
                contentVersion,
                hydrationRequestId,
            });
            return true;
        },
        markLayersReady(
            pageNumber: TPageNumber,
            contentVersion: number,
            hydrationRequestId: number,
            container: HTMLElement,
        ) {
            const current = getSlot(pageNumber);
            if (
                current.canvasReadiness !== 'ready'
                || current.contentVersion !== contentVersion
                || current.layerReadiness !== 'hydrating'
                || current.textLayerReadiness !== 'ready'
                || current.hydrationRequestId !== hydrationRequestId
                || current.container !== container
            ) {
                return false;
            }
            updateSlot(pageNumber, {
                layerReadiness: 'ready',
                hydrationRequestId: null,
            });
            logPdfRenderTrace('renderer-layer-hydration-settled', {
                pageNumber,
                contentVersion,
                hydrationRequestId,
                outcome: 'ready',
            });
            return true;
        },
        markLayersCanvasOnly(
            pageNumber: TPageNumber,
            contentVersion: number,
            hydrationRequestId: number,
            container: HTMLElement,
        ) {
            const current = getSlot(pageNumber);
            if (
                current.canvasReadiness !== 'ready'
                || current.contentVersion !== contentVersion
                || current.layerReadiness !== 'hydrating'
                || current.hydrationRequestId !== hydrationRequestId
                || current.container !== container
            ) {
                return false;
            }
            updateSlot(pageNumber, {
                layerReadiness: 'canvas-only',
                hydrationRequestId: null,
            });
            logPdfRenderTrace('renderer-layer-hydration-settled', {
                pageNumber,
                contentVersion,
                hydrationRequestId,
                outcome: 'canvas-only',
            });
            return true;
        },
        isLayerPromotionEligible(pageNumber: TPageNumber) {
            const current = getSlot(pageNumber);
            return current.canvasReadiness === 'ready'
                && current.job === 'idle'
                && (current.layerReadiness === 'none' || current.layerReadiness === 'canvas-only');
        },
        failLayerHydration(pageNumber: TPageNumber, version: number, requestId: number) {
            const current = getSlot(pageNumber);
            if (
                current.contentVersion !== version
                || current.hydrationRequestId !== requestId
                || current.layerReadiness !== 'hydrating'
            ) {
                return false;
            }
            updateSlot(pageNumber, {
                layerReadiness: 'canvas-only',
                hydrationRequestId: null,
                ...(current.job === 'rendering' && current.requestId === requestId ? {
                    job: 'idle' as const,
                    version: null,
                    requestId: null,
                    pendingDocumentToken: null,
                    pendingTargetScale: null,
                    pendingTargetOutputScale: null,
                    pendingTargetViewRotation: null,
                    pendingContainer: null,
                } : {}),
            });
            logPdfRenderTrace('renderer-layer-hydration-settled', {
                pageNumber,
                contentVersion: version,
                hydrationRequestId: requestId,
                outcome: 'failed',
            });
            return true;
        },
        completeRender(pageNumber: TPageNumber, version: number, requestId: number) {
            const current = getSlot(pageNumber);
            if (current.job !== 'rendering' || current.version !== version || current.requestId !== requestId) {
                return false;
            }
            updateSlot(pageNumber, {
                job: 'idle',
                version: null,
                requestId: null,
                pendingDocumentToken: null,
                pendingTargetScale: null,
                pendingTargetOutputScale: null,
                pendingTargetViewRotation: null,
                pendingContainer: null,
            });
            return true;
        },
        adoptCommittedCanvasVersion(
            pageNumber: TPageNumber,
            contentVersion: number,
            documentToken = getSlot(pageNumber).documentToken,
        ) {
            const current = getSlot(pageNumber);
            if (current.canvasReadiness !== 'ready') {
                return false;
            }
            updateSlot(pageNumber, {
                contentVersion,
                documentToken,
                layerReadiness: current.layerReadiness === 'hydrating'
                    ? 'canvas-only'
                    : current.layerReadiness,
                hydrationRequestId: null,
                job: 'idle',
                version: null,
                requestId: null,
                pendingDocumentToken: null,
                pendingTargetScale: null,
                pendingTargetOutputScale: null,
                pendingTargetViewRotation: null,
                pendingContainer: null,
            });
            return true;
        },
        commitCanvas(
            pageNumber: TPageNumber,
            version: number,
            requestId: number,
            committedRasterQuality?: IPdfCommittedRasterQuality,
        ) {
            if (!this.commitVisual(pageNumber, version, requestId, committedRasterQuality)) {
                return false;
            }
            return this.completeRender(pageNumber, version, requestId);
        },
        clearPage(pageNumber: TPageNumber) {
            slots.delete(pageNumber);
        },
        clearAll() {
            slots.clear();
        },
    };
}

export type TPdfPageRenderState = ReturnType<typeof createPdfPageRenderState>;
