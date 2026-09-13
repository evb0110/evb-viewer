// @vitest-environment happy-dom

import { requirePageNumber } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    type Ref,
} from 'vue';
import { createPdfInitialVisualCommit } from '@app/modules/pdf-viewer/runtime/lifecycle/createPdfInitialVisualCommit';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/chassis/documentOpenSurfaceSession';
import type { IDocumentViewerChassisAuthority } from '@app/modules/document-viewer/chassis/documentViewerChassisAuthority';

function createDomRect(shape: object): DOMRect {
    // The visual handshake reads only measured rectangle fields from these
    // browser geometry results.
    return shape as DOMRect;
}

function createViewportFixture(
    currentPage: Ref<number>,
    commitCurrentViewportIfSettled: (pageNumber: number) => boolean,
): TPdfViewportSession {
    // The handshake uses only the scale, opening extent, and page commit slice.
    return Object.assign(Object.create(null), {
        currentPage,
        scale: {scaledMargin: ref(20)},
        openVirtualSurfaceGeometry: {openingVirtualExtentMinimumScrollHeight: ref<number | null>(null)},
        singlePageScroll: {commitCurrentViewportIfSettled},
    });
}

function createChassisAuthority(
    openSurface: ReturnType<typeof createDocumentOpenSurfaceSession>,
): IDocumentViewerChassisAuthority {
    // The lifecycle reads the open-surface session from the full authority.
    return {openSurface} as IDocumentViewerChassisAuthority;
}

function createResidentCanvasFixture(
    connectCanvas = true,
    canvasRect: Partial<DOMRect> = {},
) {
    const surface = createDocumentOpenSurfaceSession();
    surface.begin({
        documentId: 'saved-result.pdf',
        documentRevision: 'open-intent:1',
    }, null, 2);
    surface.metadataReady(315);

    const viewerContainer = document.createElement('div');
    viewerContainer.getBoundingClientRect = vi.fn(() => createDomRect({
        top: 0,
        right: 1200,
        bottom: 900,
        left: 0,
        width: 1200,
        height: 900,
    }));
    const pageContainer = document.createElement('div');
    pageContainer.className = 'page_container';
    pageContainer.dataset.page = '2';
    pageContainer.getBoundingClientRect = vi.fn(() => createDomRect({
        width: 511.459,
        height: 755,
    }));
    const canvasHost = document.createElement('div');
    canvasHost.className = 'page_canvas';
    const canvas = document.createElement('canvas');
    canvas.width = 1023;
    canvas.height = 1510;
    canvas.getBoundingClientRect = vi.fn(() => createDomRect({
        top: 0,
        right: connectCanvas ? 511.459 : 0,
        bottom: connectCanvas ? 755 : 0,
        left: 0,
        width: connectCanvas ? 511.459 : 0,
        height: connectCanvas ? 755 : 0,
        ...canvasRect,
    }));
    if (connectCanvas) {
        canvasHost.append(canvas);
    }
    pageContainer.append(canvasHost);
    viewerContainer.append(pageContainer);
    document.body.append(viewerContainer);

    const currentPage = ref(2);
    const commitCurrentViewportIfSettled = vi.fn((pageNumber: number) => {
        const snapshot = surface.snapshot.value;
        const viewportIntentId = surface.viewportSession.value.viewportIntent!.id;
        return surface.commitViewport({
            generation: snapshot.generation,
            documentRevision: snapshot.identity!.documentRevision,
            viewportIntentId,
            documentGeometryRevision: 8,
            interactionEpoch: 98,
            pageNumber,
            left: 0,
            top: 0,
        });
    });
    const viewport = createViewportFixture(currentPage, commitCurrentViewportIfSettled);
    const chassisAuthority = createChassisAuthority(surface);
    const renderOwner = surface.claimRenderOwner();
    const emitInitialVisualReady = vi.fn();
    const initialVisual = createPdfInitialVisualCommit({
        chassisAuthority,
        openSurfaceRenderOwner: renderOwner,
        viewport,
        viewerContainer: ref(viewerContainer),
        renderedPageStateVersion: ref(0),
        isCommittedVisual: pageNumber => pageNumber === 2,
        queueFrame: vi.fn(),
        emitInitialVisualReady,
    });

    function mountPageCanvas(pageNumber: number) {
        const nextPageContainer = document.createElement('div');
        nextPageContainer.className = 'page_container';
        nextPageContainer.dataset.page = String(pageNumber);
        nextPageContainer.getBoundingClientRect = vi.fn(() => createDomRect({
            width: 511.459,
            height: 755,
        }));
        const nextCanvasHost = document.createElement('div');
        nextCanvasHost.className = 'page_canvas';
        const nextCanvas = document.createElement('canvas');
        nextCanvas.width = 1023;
        nextCanvas.height = 1510;
        nextCanvas.getBoundingClientRect = vi.fn(() => createDomRect({
            top: 0,
            right: 511.459,
            bottom: 755,
            left: 0,
            width: 511.459,
            height: 755,
        }));
        nextCanvasHost.append(nextCanvas);
        nextPageContainer.append(nextCanvasHost);
        viewerContainer.append(nextPageContainer);
        currentPage.value = pageNumber;
        const snapshot = surface.snapshot.value;
        initialVisual.handlePageCanvasMounted({
            openSurfaceGeneration: snapshot.generation,
            documentRevision: snapshot.identity!.documentRevision,
            renderVersion: 1,
            requestId: pageNumber,
            pageNumber: requirePageNumber(pageNumber),
        });
    }

    return {
        initialVisual,
        commitCurrentViewportIfSettled,
        emitInitialVisualReady,
        mountPageCanvas,
        surface,
        viewerContainer,
    };
}

describe('createPdfInitialVisualCommit', () => {
    it('adopts a ready resident canvas into a newly opened surface with no committed geometry', () => {
        const fixture = createResidentCanvasFixture();

        fixture.initialVisual.adoptResidentCanvas(requirePageNumber(2));

        expect(fixture.surface.snapshot.value).toMatchObject({
            generation: 1,
            phase: 'ready',
            presentation: 'committed',
            geometry: {
                width: 511.459,
                height: 755,
                margin: 20,
            },
            committedRender: {
                documentRevision: 'open-intent:1',
                pageNumber: 2,
            },
            committedViewport: {
                documentRevision: 'open-intent:1',
                pageNumber: 2,
            },
        });
        expect(fixture.surface.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 2,
            committedPage: 2,
        });
        expect(fixture.commitCurrentViewportIfSettled).toHaveBeenCalledExactlyOnceWith(2);
        expect(fixture.emitInitialVisualReady).toHaveBeenCalledExactlyOnceWith({pageNumber: 2});

        fixture.initialVisual.adoptResidentCanvas(requirePageNumber(2));
        expect(fixture.emitInitialVisualReady).toHaveBeenCalledOnce();

        fixture.viewerContainer.remove();
    });

    it('does not start a render fence until resident canvas geometry is measurable', () => {
        const fixture = createResidentCanvasFixture(false);

        fixture.initialVisual.adoptResidentCanvas(requirePageNumber(2));

        expect(fixture.surface.snapshot.value).toMatchObject({
            phase: 'pending',
            geometry: null,
            committedRender: null,
        });
        expect(fixture.surface.viewportSession.value.renderFence).toBeNull();
        expect(fixture.commitCurrentViewportIfSettled).not.toHaveBeenCalled();
        expect(fixture.emitInitialVisualReady).not.toHaveBeenCalled();

        fixture.viewerContainer.remove();
    });

    it('returns the viewport to ready after an in-document navigation repaints the new page', () => {
        const fixture = createResidentCanvasFixture();
        fixture.initialVisual.adoptResidentCanvas(requirePageNumber(2));
        expect(fixture.surface.viewportSession.value.lifecycle).toBe('ready');

        fixture.surface.requestNavigation(3, 0);
        expect(fixture.surface.viewportSession.value).toMatchObject({
            lifecycle: 'transitioning',
            requestedPage: 3,
        });

        fixture.mountPageCanvas(3);

        expect(fixture.surface.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 3,
            committedPage: 3,
            visual: {
                pageNumber: 3,
                presentation: 'canvas',
            },
        });
        // The opening handshake is owned by the first visual of the open
        // document; a later page must not republish it.
        expect(fixture.emitInitialVisualReady).toHaveBeenCalledExactlyOnceWith({pageNumber: 2});

        fixture.viewerContainer.remove();
    });

    it('does not publish ready when the committed page canvas is painted but physically offscreen', () => {
        const fixture = createResidentCanvasFixture(true, {
            top: 1_440_000,
            bottom: 1_440_755,
        });

        fixture.initialVisual.adoptResidentCanvas(requirePageNumber(2));

        expect(fixture.surface.snapshot.value.phase).toBe('viewport-committed');
        expect(fixture.surface.viewportSession.value).toMatchObject({
            lifecycle: 'opening',
            committedPage: 2,
        });
        expect(fixture.emitInitialVisualReady).not.toHaveBeenCalled();

        fixture.viewerContainer.remove();
    });
});
