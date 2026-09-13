import {
    describe,
    expect,
    it,
} from 'vitest';
import { createPdfOpenSurfaceViewportCallbacks } from '@app/modules/pdf-viewer/runtime/viewport/createPdfOpenSurfaceViewportCallbacks';
import {
    commitDocumentOpenSurfaceViewport,
    createDocumentOpenSurfaceSession,
    shouldProjectDocumentViewportCommitPage,
} from '@app/modules/document-viewer/chassis/documentOpenSurfaceSession';
import type { IDocumentViewerChassisAuthority } from '@app/modules/document-viewer/chassis/documentViewerChassisAuthority';

describe('commitPdfOpenSurfaceViewport', () => {
    it('settles the exact live surface intent instead of copying a PDF-local intent id', () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'load:1',
        });
        expect(surface.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);
        const renderFence = surface.createRenderFence({
            generation,
            documentRevision: 'load:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        });
        expect(renderFence).not.toBeNull();
        expect(surface.commitCanvas(renderFence!)).toBe(true);

        expect(commitDocumentOpenSurfaceViewport(surface, {
            geometryRevision: 7,
            interactionEpoch: 0,
            page: 1,
            left: 0,
            top: 0,
        })).toBe(true);

        expect(surface.snapshot.value.committedViewport).toMatchObject({
            pageNumber: 1,
            viewportIntentId: renderFence!.viewportIntentId,
            documentGeometryRevision: 7,
        });
        expect(surface.snapshot.value.phase).toBe('viewport-committed');
        expect(surface.markReady(renderFence!)).toBe(true);
        expect(surface.snapshot.value.phase).toBe('ready');
    });

    it('does not relabel a stale page position with a newer surface intent', () => {
        const surface = createDocumentOpenSurfaceSession();
        surface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'load:1',
        });
        surface.requestNavigation(2, 0);

        expect(commitDocumentOpenSurfaceViewport(surface, {
            geometryRevision: 7,
            interactionEpoch: 0,
            page: 1,
            left: 0,
            top: 0,
        })).toBe(false);
        expect(surface.snapshot.value.committedViewport).toBeNull();
    });

    it('commits after close and reopen under the shared generation', () => {
        const surface = createDocumentOpenSurfaceSession();
        surface.begin({
            documentId: 'first.pdf',
            documentRevision: 'load:1',
        });
        surface.reset();
        const generation = surface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'load:2',
        });
        expect(surface.viewportSession.value.generation).toBe(generation);
        expect(surface.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);
        const renderFence = surface.createRenderFence({
            generation,
            documentRevision: 'load:2',
            renderVersion: 2,
            requestId: 2,
            pageNumber: 1,
        });
        expect(renderFence).not.toBeNull();
        expect(surface.commitCanvas(renderFence!)).toBe(true);

        expect(commitDocumentOpenSurfaceViewport(surface, {
            geometryRevision: 8,
            interactionEpoch: 0,
            page: 1,
            left: 0,
            top: 0,
        })).toBe(true);
        expect(surface.snapshot.value.committedViewport?.pageNumber).toBe(1);
    });

    it('requires PDF commits to match the page command already owned by the shared surface', () => {
        const surface = createDocumentOpenSurfaceSession();
        surface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'load:1',
        });
        surface.requestNavigation(348, 0);
        const baseCommit = {
            intentId: 'viewport-state-1',
            documentRevision: 1,
            geometryRevision: 7,
            interactionEpoch: 0,
            page: 1,
            left: 0,
            top: 0,
        } as const;

        expect(shouldProjectDocumentViewportCommitPage(surface, baseCommit)).toBe(false);
    });

    it('rejects a stale requested-page geometry echo after free scrolling changes the semantic page', () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'load:1',
        });
        surface.metadataReady(20);
        surface.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        });
        const openingFence = surface.createRenderFence({
            generation,
            documentRevision: 'load:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;
        surface.commitCanvas(openingFence);
        surface.commitViewport({
            generation,
            documentRevision: 'load:1',
            viewportIntentId: openingFence.viewportIntentId,
            documentGeometryRevision: 1,
            interactionEpoch: 0,
            pageNumber: 1,
            left: 0,
            top: 0,
        });
        surface.markReady(openingFence);
        expect(surface.observeViewportPage(20)).toBe(20);
        expect(surface.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 1,
            committedPage: 1,
            observedPage: 20,
        });

        const stalePageOneCommit = {
            intentId: 'late-fit-page-one',
            documentRevision: 1,
            geometryRevision: 2,
            interactionEpoch: 0,
            page: 1,
            left: 0,
            top: 0,
        } as const;
        expect(shouldProjectDocumentViewportCommitPage(surface, stalePageOneCommit)).toBe(false);
    });

    it('does not let a late PDF navigation commit supersede a newer shared command', () => {
        const surface = createReadySurface(348);
        surface.requestNavigation(1, 0);
        const liveIntentId = surface.viewportSession.value.viewportIntent?.id;
        const emittedPages: number[] = [];
        const completedPages: number[] = [];
        const callbacks = createPdfOpenSurfaceViewportCallbacks(
            {openSurface: surface} as IDocumentViewerChassisAuthority,
            page => emittedPages.push(page),
            page => completedPages.push(page),
        );

        callbacks.onViewportPositionCommitted({
            intentId: 'late-navigate-348',
            intentKind: 'navigate',
            documentRevision: 1,
            geometryRevision: 2,
            interactionEpoch: 0,
            page: 348,
            left: 0,
            top: 100_000,
        });

        expect(surface.viewportSession.value.requestedPage).toBe(1);
        expect(surface.viewportSession.value.viewportIntent?.id).toBe(liveIntentId);
        expect(emittedPages).toEqual([]);
        expect(completedPages).toEqual([]);
    });

    it('does not mint an unsettled shared transition for geometry at an observed page', () => {
        const surface = createReadySurface(20);
        const liveIntentId = surface.viewportSession.value.viewportIntent?.id;
        const callbacks = createPdfOpenSurfaceViewportCallbacks(
            {openSurface: surface} as IDocumentViewerChassisAuthority,
            () => undefined,
            () => undefined,
        );

        callbacks.onViewportPositionCommitted({
            intentId: 'fit-at-observed-page',
            intentKind: 'fit',
            documentRevision: 1,
            geometryRevision: 2,
            interactionEpoch: 0,
            page: 20,
            left: 0,
            top: 10_000,
        });

        expect(surface.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 1,
            observedPage: 20,
        });
        expect(surface.viewportSession.value.viewportIntent?.id).toBe(liveIntentId);
    });

    it('observes a settled PDF-internal search jump only while the shared surface is ready', () => {
        const surface = createReadySurface(1);
        const emittedPages: number[] = [];
        const authority = {
            openSurface: surface,
            observePage: (page: number) => surface.observeViewportPage(page),
        } as IDocumentViewerChassisAuthority;
        const callbacks = createPdfOpenSurfaceViewportCallbacks(
            authority,
            page => emittedPages.push(page),
            () => undefined,
        );

        callbacks.onViewportPositionCommitted({
            intentId: 'pdf-internal-search-50',
            intentKind: 'search',
            documentRevision: 1,
            geometryRevision: 2,
            interactionEpoch: 0,
            page: 50,
            left: 0,
            top: 25_000,
        });

        expect(surface.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 1,
            observedPage: 50,
        });
        expect(emittedPages).toEqual([50]);
    });

    it('does not observe a late PDF-internal jump across a newer shared transition', () => {
        const surface = createReadySurface(1);
        surface.requestNavigation(2, 0);
        const emittedPages: number[] = [];
        const authority = {
            openSurface: surface,
            observePage: (page: number) => surface.observeViewportPage(page),
        } as IDocumentViewerChassisAuthority;
        const callbacks = createPdfOpenSurfaceViewportCallbacks(
            authority,
            page => emittedPages.push(page),
            () => undefined,
        );

        callbacks.onViewportPositionCommitted({
            intentId: 'late-pdf-internal-search-50',
            intentKind: 'search',
            documentRevision: 1,
            geometryRevision: 2,
            interactionEpoch: 0,
            page: 50,
            left: 0,
            top: 25_000,
        });

        expect(surface.viewportSession.value).toMatchObject({
            lifecycle: 'transitioning',
            requestedPage: 2,
        });
        expect(emittedPages).toEqual([]);
    });
});

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
