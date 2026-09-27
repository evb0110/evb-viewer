import { requirePageNumber } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { createPdfPageRenderState } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';

describe('pdfPageRenderState', () => {
    it('makes a page not ready as soon as a replacement render begins', () => {
        const state = createPdfPageRenderState();
        state.beginRender(requirePageNumber(4), 1, 10, 'document-a', 1);
        expect(state.commitCanvas(requirePageNumber(4), 1, 10)).toBe(true);
        expect(state.getSlot(requirePageNumber(4)).visual).toBe('ready');

        state.beginRender(requirePageNumber(4), 2, 11, 'document-a', 2);

        expect(state.getSlot(requirePageNumber(4))).toEqual({
            visual: 'none',
            canvasReadiness: 'none',
            layerReadiness: 'none',
            textLayerReadiness: 'none',
            job: 'rendering',
            version: 2,
            contentVersion: 2,
            requestId: 11,
            hydrationRequestId: null,
            documentToken: 'document-a',
            targetScale: 2,
            targetOutputScale: 1,
            targetViewRotation: 0,
            container: null,
            committedRasterQuality: null,
            pendingDocumentToken: 'document-a',
            pendingTargetScale: 2,
            pendingTargetOutputScale: 1,
            pendingTargetViewRotation: 0,
            pendingContainer: null,
        });
        expect(state.renderedPages.has(requirePageNumber(4))).toBe(false);
    });

    it('commits only the matching canonical replacement', () => {
        const state = createPdfPageRenderState();
        state.beginRender(requirePageNumber(1), 1, 10, 'document-a', 1);
        expect(state.commitCanvas(requirePageNumber(1), 1, 10)).toBe(true);

        state.beginRender(requirePageNumber(1), 2, 11, 'document-a', 2);
        expect(state.commitCanvas(requirePageNumber(1), 1, 10)).toBe(false);
        expect(state.getSlot(requirePageNumber(1)).visual).toBe('none');
        expect(state.commitCanvas(requirePageNumber(1), 2, 11)).toBe(true);
        expect(state.getSlot(requirePageNumber(1)).visual).toBe('ready');
    });

    it('keeps the committed rotation until the replacement raster commits', () => {
        const state = createPdfPageRenderState();
        const pageNumber = requirePageNumber(2);
        const container = {} as HTMLElement;
        state.beginRender(pageNumber, 1, 10, 'document-a', 1, 1, container, {targetViewRotation: 0});
        expect(state.commitCanvas(pageNumber, 1, 10)).toBe(true);

        state.beginRender(pageNumber, 2, 11, 'document-a', 1, 1, container, {
            preserveCommittedVisual: true,
            targetViewRotation: 90,
        });

        expect(state.getSlot(pageNumber)).toEqual(expect.objectContaining({
            canvasReadiness: 'ready',
            targetViewRotation: 0,
            pendingTargetViewRotation: 90,
        }));
        expect(state.commitCanvas(pageNumber, 2, 11)).toBe(true);
        expect(state.getSlot(pageNumber).targetViewRotation).toBe(90);
    });

    it('keeps a failed replacement not ready for skeleton or error presentation', () => {
        const state = createPdfPageRenderState();
        state.beginRender(requirePageNumber(6), 10, 14, 'document-a', 1);
        state.commitCanvas(requirePageNumber(6), 10, 14);
        state.beginRender(requirePageNumber(6), 11, 15, 'document-a', 2);
        state.markRenderFailed(requirePageNumber(6), 11, 15);

        expect(state.getSlot(requirePageNumber(6))).toEqual({
            visual: 'none',
            canvasReadiness: 'none',
            layerReadiness: 'none',
            textLayerReadiness: 'none',
            job: 'failed',
            version: 11,
            contentVersion: 11,
            requestId: 15,
            hydrationRequestId: null,
            documentToken: 'document-a',
            targetScale: 2,
            targetOutputScale: 1,
            targetViewRotation: 0,
            container: null,
            committedRasterQuality: null,
            pendingDocumentToken: 'document-a',
            pendingTargetScale: 2,
            pendingTargetOutputScale: 1,
            pendingTargetViewRotation: 0,
            pendingContainer: null,
        });
    });

    it('keeps a clamped buffer visual ready until its settled replacement commits', () => {
        const state = createPdfPageRenderState();
        state.beginRender(requirePageNumber(8), 1, 10, 'document-a', 1, 2);
        expect(state.commitCanvas(requirePageNumber(8), 1, 10, {
            requestedPixels: 8_000_000,
            grantedPixels: 2_000_000,
            pixelScaleFactor: 0.5,
            wasClamped: true,
            intent: 'buffer-preview',
        })).toBe(true);

        state.beginQualityRefine(requirePageNumber(8), 2, 11, 'document-a', 1, 2);

        expect(state.getSlot(requirePageNumber(8)).visual).toBe('ready');
        expect(state.getSlot(requirePageNumber(8)).committedRasterQuality).toEqual({
            requestedPixels: 8_000_000,
            grantedPixels: 2_000_000,
            pixelScaleFactor: 0.5,
            wasClamped: true,
            intent: 'buffer-preview',
        });

        expect(state.commitCanvas(requirePageNumber(8), 2, 11, {
            requestedPixels: 8_000_000,
            grantedPixels: 6_000_000,
            pixelScaleFactor: Math.sqrt(0.75),
            wasClamped: true,
            intent: 'settled',
        })).toBe(true);
        expect(state.getSlot(requirePageNumber(8)).committedRasterQuality?.intent).toBe('settled');
        expect(state.getSlot(requirePageNumber(8)).visual).toBe('ready');
    });

    it('does not let a stale quality refine replace the current committed visual', () => {
        const state = createPdfPageRenderState();
        state.beginRender(requirePageNumber(3), 1, 10, 'document-a', 1, 1);
        state.commitCanvas(requirePageNumber(3), 1, 10);
        state.beginQualityRefine(requirePageNumber(3), 2, 11, 'document-a', 1, 1);
        state.beginQualityRefine(requirePageNumber(3), 3, 12, 'document-a', 1, 1);

        expect(state.commitVisual(requirePageNumber(3), 2, 11, {
            requestedPixels: 4,
            grantedPixels: 4,
            pixelScaleFactor: 1,
            wasClamped: false,
            intent: 'settled',
        })).toBe(false);
        expect(state.getSlot(requirePageNumber(3)).requestId).toBe(12);
        expect(state.getSlot(requirePageNumber(3)).visual).toBe('ready');
    });

    it('tracks canvas and layer readiness independently for the current mounted slot', () => {
        const state = createPdfPageRenderState();
        const container = {} as HTMLElement;
        state.beginRender(requirePageNumber(3), 8, 21, 'document-a', 1.25, 2, container);
        const bufferQuality = {
            requestedPixels: 8_000_000,
            grantedPixels: 2_000_000,
            pixelScaleFactor: 0.5,
            wasClamped: true,
            intent: 'buffer-preview' as const,
        };
        expect(state.commitVisual(requirePageNumber(3), 8, 21, bufferQuality)).toBe(true);
        expect(state.markCanvasOnly(requirePageNumber(3), 8, 21)).toBe(true);
        expect(state.completeRender(requirePageNumber(3), 8, 21)).toBe(true);

        expect(state.getSlot(requirePageNumber(3))).toEqual(expect.objectContaining({
            canvasReadiness: 'ready',
            layerReadiness: 'canvas-only',
            contentVersion: 8,
            container,
        }));
        expect(state.beginLayerHydration(requirePageNumber(3), 8, 22, 'document-a', 1.25, 2, container)).toBe(true);
        expect(state.getSlot(requirePageNumber(3)).layerReadiness).toBe('hydrating');
        expect(state.markTextLayerReady(requirePageNumber(3), 8, 22, container)).toBe(true);
        expect(state.getSlot(requirePageNumber(3)).textLayerReadiness).toBe('ready');
        expect(state.markLayersReady(requirePageNumber(3), 8, 22, container)).toBe(true);
        expect(state.completeRender(requirePageNumber(3), 8, 22)).toBe(true);
        expect(state.getSlot(requirePageNumber(3)).layerReadiness).toBe('ready');
        expect(state.getSlot(requirePageNumber(3)).committedRasterQuality).toEqual(bufferQuality);
        expect(state.adoptCommittedCanvasVersion(requirePageNumber(3), 9)).toBe(true);
        expect(state.getSlot(requirePageNumber(3))).toEqual(expect.objectContaining({
            canvasReadiness: 'ready',
            committedRasterQuality: bufferQuality,
            contentVersion: 9,
            documentToken: 'document-a',
            job: 'idle',
            layerReadiness: 'ready',
        }));

        expect(state.beginLayerHydration(
            requirePageNumber(3),
            8,
            23,
            'document-a',
            1.25,
            2,
            {} as HTMLElement,
        )).toBe(false);
    });

    it('rejects stale optional-layer postconditions after a successor canvas commits', () => {
        const state = createPdfPageRenderState();
        const staleContainer = {} as HTMLElement;
        const currentContainer = {} as HTMLElement;
        state.beginRender(requirePageNumber(3), 8, 21, 'document-a', 1, 1, staleContainer);
        state.commitCanvas(requirePageNumber(3), 8, 21);
        state.markLayersHydrating(requirePageNumber(3), 8, 21);

        state.beginRender(requirePageNumber(3), 9, 22, 'document-a', 2, 1, currentContainer);
        state.commitVisual(requirePageNumber(3), 9, 22);
        state.markCanvasOnly(requirePageNumber(3), 9, 22);
        state.completeRender(requirePageNumber(3), 9, 22);

        expect(state.markLayersReady(requirePageNumber(3), 8, 21, staleContainer)).toBe(false);
        expect(state.failLayerHydration(requirePageNumber(3), 8, 21)).toBe(false);
        expect(state.getSlot(requirePageNumber(3))).toEqual(expect.objectContaining({
            canvasReadiness: 'ready',
            contentVersion: 9,
            container: currentContainer,
            layerReadiness: 'canvas-only',
        }));
    });

    it('gives each layer hydration one owner until that owner settles', () => {
        const state = createPdfPageRenderState();
        const container = {} as HTMLElement;
        state.beginRender(requirePageNumber(3), 8, 21, 'document-a', 1.25, 2, container);
        state.commitVisual(requirePageNumber(3), 8, 21);
        state.markCanvasOnly(requirePageNumber(3), 8, 21);
        state.completeRender(requirePageNumber(3), 8, 21);

        expect(state.beginLayerHydration(requirePageNumber(3), 8, 22, 'document-a', 1.25, 2, container)).toBe(true);
        expect(state.beginLayerHydration(requirePageNumber(3), 8, 23, 'document-a', 1.25, 2, container)).toBe(false);
        expect(state.getSlot(requirePageNumber(3))).toEqual(expect.objectContaining({
            hydrationRequestId: 22,
            layerReadiness: 'hydrating',
        }));
        expect(state.markLayersHydrating(requirePageNumber(3), 8, 22)).toBe(true);
        expect(state.markLayersHydrating(requirePageNumber(3), 8, 23)).toBe(false);
        expect(state.markTextLayerReady(requirePageNumber(3), 8, 23, container)).toBe(false);
        expect(state.markLayersReady(requirePageNumber(3), 8, 23, container)).toBe(false);
        expect(state.markLayersCanvasOnly(requirePageNumber(3), 8, 23, container)).toBe(false);
        expect(state.markLayersCanvasOnly(requirePageNumber(3), 8, 22, container)).toBe(true);
        expect(state.getSlot(requirePageNumber(3))).toEqual(expect.objectContaining({
            hydrationRequestId: null,
            layerReadiness: 'canvas-only',
        }));
    });

    it('promotes only canvas-ready pages whose layers have no active owner', () => {
        const state = createPdfPageRenderState();
        const container = {} as HTMLElement;
        state.beginRender(requirePageNumber(3), 8, 21, 'document-a', 1.25, 2, container);
        state.commitVisual(requirePageNumber(3), 8, 21);
        expect(state.isLayerPromotionEligible(requirePageNumber(3))).toBe(false);
        state.completeRender(requirePageNumber(3), 8, 21);
        expect(state.isLayerPromotionEligible(requirePageNumber(3))).toBe(true);

        expect(state.beginLayerHydration(requirePageNumber(3), 8, 22, 'document-a', 1.25, 2, container)).toBe(true);
        expect(state.getSlot(requirePageNumber(3)).hydrationRequestId).toBe(22);
        expect(state.isLayerPromotionEligible(requirePageNumber(3))).toBe(false);
        state.markTextLayerReady(requirePageNumber(3), 8, 22, container);
        state.markLayersReady(requirePageNumber(3), 8, 22, container);
        state.completeRender(requirePageNumber(3), 8, 22);
        expect(state.isLayerPromotionEligible(requirePageNumber(3))).toBe(false);

        state.beginRender(requirePageNumber(4), 8, 22, 'document-a', 1.25, 2, container);
        expect(state.isLayerPromotionEligible(requirePageNumber(4))).toBe(false);
        state.commitVisual(requirePageNumber(4), 8, 22);
        state.markCanvasOnly(requirePageNumber(4), 8, 22);
        state.completeRender(requirePageNumber(4), 8, 22);
        expect(state.isLayerPromotionEligible(requirePageNumber(4))).toBe(true);
    });

    it('invalidates an active hydration owner when adopting a committed canvas version', () => {
        const state = createPdfPageRenderState();
        const container = {} as HTMLElement;
        state.beginRender(requirePageNumber(3), 8, 21, 'document-a', 1.25, 2, container);
        state.commitCanvas(requirePageNumber(3), 8, 21);
        expect(state.beginLayerHydration(requirePageNumber(3), 8, 22, 'document-a', 1.25, 2, container)).toBe(true);
        expect(state.getSlot(requirePageNumber(3)).hydrationRequestId).toBe(22);

        expect(state.adoptCommittedCanvasVersion(requirePageNumber(3), 9)).toBe(true);
        expect(state.getSlot(requirePageNumber(3))).toEqual(expect.objectContaining({
            contentVersion: 9,
            hydrationRequestId: null,
            layerReadiness: 'canvas-only',
        }));
        expect(state.markLayersReady(requirePageNumber(3), 8, 22, container)).toBe(false);
    });

    it('re-authorizes a committed canvas without letting old-token work commit afterward', () => {
        const state = createPdfPageRenderState();
        const container = {} as HTMLElement;
        state.beginRender(requirePageNumber(3), 8, 21, 'document-a', 1.25, 2, container);
        expect(state.commitCanvas(requirePageNumber(3), 8, 21)).toBe(true);
        state.beginQualityRefine(requirePageNumber(3), 9, 22, 'document-a', 1.25, 2, container);

        expect(state.adoptCommittedCanvasVersion(requirePageNumber(3), 10, 'document-b')).toBe(true);
        expect(state.getSlot(requirePageNumber(3))).toEqual(expect.objectContaining({
            canvasReadiness: 'ready',
            contentVersion: 10,
            documentToken: 'document-b',
            job: 'idle',
            layerReadiness: 'none',
        }));
        expect(state.commitCanvas(requirePageNumber(3), 9, 22)).toBe(false);
        expect(state.getSlot(requirePageNumber(3)).documentToken).toBe('document-b');
    });

    it('removes empty idle slots', () => {
        const state = createPdfPageRenderState();
        state.renderedPages.add(requirePageNumber(2));
        expect(state.getSlot(requirePageNumber(2)).visual).toBe('ready');
        state.renderedPages.delete(requirePageNumber(2));
        expect(state.slots.has(requirePageNumber(2))).toBe(false);
    });
});
