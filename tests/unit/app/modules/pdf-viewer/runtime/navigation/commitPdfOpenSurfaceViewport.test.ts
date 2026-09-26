import {
    describe,
    expect,
    it,
} from 'vitest';
import {createPageNavigationRequest} from '@app/modules/document-viewer/public';
import {createDocumentOpenSurfaceSession} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import {createPdfOpenSurfaceViewportCallbacks} from '@app/modules/pdf-viewer/runtime/viewport/createPdfOpenSurfaceViewportCallbacks';

describe('PDF open-surface viewport callbacks', () => {
    it('reports placement through the exact live navigation ticket', () => {
        const surface = createReadySurface(1);
        const ticket = surface.navigate(createPageNavigationRequest(2, 'toolbar'))!;
        const emittedPages: number[] = [];
        const completedPages: number[] = [];
        const callbacks = createCallbacks(surface, emittedPages, completedPages);

        expect(callbacks.onViewportPositionCommitted({
            intentId: ticket.id,
            intentKind: 'navigate',
            documentRevision: 1,
            geometryRevision: 7,
            interactionEpoch: 0,
            page: 2,
            left: 0,
            top: 800,
            navigationTicket: ticket,
        })).toBe(true);
        expect(surface.snapshot.value.committedViewport).toMatchObject({
            pageNumber: 2,
            viewportIntentId: ticket.id,
            documentGeometryRevision: 7,
        });
        expect(emittedPages).toEqual([2]);
        expect(completedPages).toEqual([2]);
    });

    it('rejects a late placement after a newer ticket replaces the command', () => {
        const surface = createReadySurface(1);
        const stale = surface.navigate(createPageNavigationRequest(2, 'toolbar'))!;
        const current = surface.navigate(createPageNavigationRequest(3, 'toolbar'))!;
        const emittedPages: number[] = [];
        const completedPages: number[] = [];
        const callbacks = createCallbacks(surface, emittedPages, completedPages);

        expect(callbacks.onViewportPositionCommitted({
            intentId: stale.id,
            intentKind: 'navigate',
            documentRevision: 1,
            geometryRevision: 7,
            interactionEpoch: 0,
            page: 2,
            left: 0,
            top: 800,
            navigationTicket: stale,
        })).toBe(false);
        expect(surface.navigationTicket.value?.id).toBe(current.id);
        expect(surface.snapshot.value.committedViewport?.pageNumber).toBe(1);
        expect(emittedPages).toEqual([]);
        expect(completedPages).toEqual([]);
    });

    it('keeps geometry observation separate from ticket publication', () => {
        const surface = createReadySurface(1);
        const emittedPages: number[] = [];
        const callbacks = createCallbacks(surface, emittedPages, []);

        expect(callbacks.onViewportPositionCommitted({
            intentId: 'relayout-observation',
            intentKind: 'relayout',
            documentRevision: 1,
            geometryRevision: 8,
            interactionEpoch: 0,
            page: 20,
            left: 0,
            top: 10_000,
        })).toBe(true);
        expect(surface.navigationTicket.value?.request.source).toBe('restore');
        expect(surface.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 1,
            committedPage: 1,
            observedPage: 20,
        });
        expect(emittedPages).toEqual([20]);
    });

    it('does not turn a stale ticket into a same-page observation', () => {
        const surface = createReadySurface(1);
        const stale = surface.navigate(createPageNavigationRequest(1, 'toolbar'))!;
        surface.navigate(createPageNavigationRequest(2, 'toolbar'));
        const emittedPages: number[] = [];
        const callbacks = createCallbacks(surface, emittedPages, []);

        expect(callbacks.onViewportPositionCommitted({
            intentId: stale.id,
            intentKind: 'navigate',
            documentRevision: 1,
            geometryRevision: 8,
            interactionEpoch: 0,
            page: 1,
            left: 10,
            top: 20,
            navigationTicket: stale,
        })).toBe(false);
        expect(emittedPages).toEqual([]);
        expect(surface.viewportSession.value.requestedPage).toBe(2);
    });
});

function createCallbacks(
    surface: ReturnType<typeof createDocumentOpenSurfaceSession>,
    emittedPages: number[],
    completedPages: number[],
) {
    const authority = {
        openSurface: surface,
        observePage: (page: number) => surface.observeViewportPage(page),
    };
    return createPdfOpenSurfaceViewportCallbacks(
        authority,
        page => emittedPages.push(page),
        page => completedPages.push(page),
    );
}

function createReadySurface(observedPage: number) {
    const surface = createDocumentOpenSurfaceSession();
    const generation = surface.begin({
        documentId: 'scan.pdf',
        documentRevision: 'load:1',
    });
    surface.metadataReady(348);
    surface.commitGeometry(generation, {
        width: 612,
        height: 792,
        margin: 20,
    });
    const fence = surface.createRenderFence({
        generation,
        documentRevision: 'load:1',
        renderVersion: 1,
        requestId: 1,
        pageNumber: 1,
    })!;
    surface.commitCanvas(fence);
    surface.commitViewport({
        generation,
        documentRevision: 'load:1',
        viewportIntentId: fence.viewportIntentId,
        documentGeometryRevision: 1,
        interactionEpoch: 0,
        pageNumber: 1,
        left: 0,
        top: 0,
    });
    surface.markReady(fence);
    surface.observeViewportPage(observedPage);
    return surface;
}
