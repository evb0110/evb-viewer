import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type { Ref } from 'vue';
import { markStartupMetricOnce } from '@app/utils/startupMetrics';
import type {
    IDocumentViewerRuntime, IDocumentOpenSurfaceRenderOwner,
} from '@app/modules/document-viewer/public';
import type { IPdfCanvasDomCommit } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { isPdfInitialVisualCanvasReady } from '@app/modules/pdf-viewer/runtime/lifecycle/isPdfInitialVisualCanvasReady';
import { commitPdfPageSkeletonGeometry } from '@app/modules/pdf-viewer/runtime/lifecycle/commitPdfInitialPageSkeletonGeometry';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
export interface ICreatePdfInitialVisualCommitOptions {
    chassisAuthority: IDocumentViewerRuntime | null;
    openSurfaceRenderOwner: IDocumentOpenSurfaceRenderOwner | undefined;
    viewport: TPdfViewportSession;
    viewerContainer: Ref<HTMLElement | null>;
    renderedPageStateVersion: Ref<number>;
    isCommittedVisual: (pageNumber: TPageNumber) => boolean;
    queueFrame: () => void;
    emitInitialVisualReady: (payload: {pageNumber: TPageNumber}) => void;
}
export const createPdfInitialVisualCommit = (options: ICreatePdfInitialVisualCommitOptions) => {
    const chassisAuthority = options.chassisAuthority;
    const viewport = options.viewport;
    let pendingReadyToken: number | null = null;
    let lastEmittedReadyGeneration: number | null = null;
    function readExactInitialCommit(requireViewport: boolean) {
        const surface = chassisAuthority?.openSurface;
        const snapshot = surface?.snapshot.value;
        const render = snapshot?.committedRender;
        const pageNumber = requirePageNumber(viewport.currentPage.value);
        if (!surface || !snapshot || !render
            || render.generation !== snapshot.generation
            || render.documentRevision !== snapshot.identity?.documentRevision
            || render.pageNumber !== pageNumber
            || surface.viewportSession.value.requestedPage !== pageNumber
            || requireViewport && snapshot.committedViewport?.pageNumber !== pageNumber
        ) {
            return null;
        }
        return {
            surface,
            snapshot,
            render,
            pageNumber,
        };
    }
    function reconcileInitialVisual() {
        const current = readExactInitialCommit(true);
        if (
            !current
            || !isPdfInitialVisualCanvasReady(
                options.viewerContainer.value,
                current.pageNumber,
                viewport.currentPage.value,
            )
            // The surface phase reports `ready` for the whole life of an open
            // document once its first visual is committed, because the opening
            // shell stays retired across later page changes. Readiness is owned
            // by the viewport lifecycle, which every navigation returns to
            // `transitioning` until physically painted pixels are confirmed
            // here, so the mark is driven off the fence rather than the phase.
            || !current.surface.markReady(current.render)
        ) {
            return;
        }
        const ready = readExactInitialCommit(true);
        if (!ready
            || ready.snapshot.phase !== 'ready'
            || (
                pendingReadyToken === null
                && lastEmittedReadyGeneration === ready.snapshot.generation
            )
        ) {
            return;
        }
        pendingReadyToken = null;
        lastEmittedReadyGeneration = ready.snapshot.generation;
        markStartupMetricOnce('evb:first-page-painted');
        options.emitInitialVisualReady({pageNumber: ready.pageNumber});
    }
    function adoptResidentCanvas(pageNumber: TPageNumber) {
        if (!chassisAuthority || !options.openSurfaceRenderOwner || !options.isCommittedVisual(pageNumber)) {
            return;
        }
        const surface = chassisAuthority.openSurface;
        let snapshot = surface.snapshot.value;
        if (snapshot.identity === null || surface.viewportSession.value.requestedPage !== pageNumber) {
            return;
        }
        // A new open-surface generation can be established after this PDF
        // session has already painted the requested page (for example when a
        // saved result is adopted by a newly materialized tab). Resident
        // adoption then owns the first visual commit, so it must establish the
        // same measured geometry that a fresh canvas mount commits below.
        // Creating the render fence first would leave an uncommittable fence in
        // the reducer whenever geometry is still null, permanently pinning the
        // chassis-owned opening shell over an already-ready canvas.
        if (snapshot.phase === 'pending' && snapshot.geometry === null) {
            const geometryCommitted = commitPdfPageSkeletonGeometry(
                chassisAuthority,
                options.viewerContainer,
                viewport.currentPage,
                viewport.scale.scaledMargin,
                pageNumber,
                {
                    authoritativePageNumber: pageNumber,
                    expectedGeneration: snapshot.generation,
                    minimumScrollHeight: viewport.openVirtualSurfaceGeometry.openingVirtualExtentMinimumScrollHeight.value,
                    requireVisibleSkeleton: false,
                },
            );
            if (!geometryCommitted) {
                return;
            }
            snapshot = surface.snapshot.value;
            if (snapshot.identity === null || surface.viewportSession.value.requestedPage !== pageNumber) {
                return;
            }
        }
        const fence = surface.createOwnedResidentRenderFence(options.openSurfaceRenderOwner, {
            generation: snapshot.generation,
            documentRevision: snapshot.identity.documentRevision,
            pageNumber,
        });
        if (!fence || !surface.commitCanvas(fence)) {
            return;
        }
        viewport.singlePageScroll.commitCurrentViewportIfSettled(pageNumber);
        reconcileInitialVisual();
    }
    // The fence a settled render of the requested page reports on.
    function claimRequestedPageFence(commit: IPdfCanvasDomCommit) {
        const surface = chassisAuthority?.openSurface;
        if (!surface || commit.pageNumber !== surface.viewportSession.value.requestedPage) {
            return null;
        }
        const fence = options.openSurfaceRenderOwner && surface.createOwnedRenderFence(options.openSurfaceRenderOwner, {
            generation: commit.openSurfaceGeneration,
            documentRevision: commit.documentRevision,
            rendererVersion: commit.renderVersion,
            rendererRequestId: commit.requestId,
            pageNumber: commit.pageNumber,
        });
        return fence ? {
            surface,
            fence,
        } : null;
    }
    function handlePageCanvasMounted(commit: IPdfCanvasDomCommit) {
        options.renderedPageStateVersion.value += 1;
        options.queueFrame();
        const claimed = claimRequestedPageFence(commit);
        if (!chassisAuthority || !claimed) {
            return;
        }
        commitPdfPageSkeletonGeometry(
            chassisAuthority,
            options.viewerContainer,
            viewport.currentPage,
            viewport.scale.scaledMargin,
            commit.pageNumber,
            {
                authoritativePageNumber: commit.pageNumber,
                expectedGeneration: claimed.surface.snapshot.value.generation,
                minimumScrollHeight: viewport.openVirtualSurfaceGeometry.openingVirtualExtentMinimumScrollHeight.value,
                requireVisibleSkeleton: false,
            },
        );
        if (claimed.surface.commitCanvas(claimed.fence)) {
            viewport.singlePageScroll.commitCurrentViewportIfSettled(commit.pageNumber);
            reconcileInitialVisual();
        }
    }
    // The requested page's raster failed for good. Its error is that page's
    // visual on the open surface, as a DjVu page source reports one, and the
    // navigation waiting for its pixels ends there instead of placing the page
    // and rastering it again.
    function handlePageRasterFailed(commit: IPdfCanvasDomCommit, reason: string) {
        const claimed = claimRequestedPageFence(commit);
        claimed?.surface.reject(claimed.fence, reason);
    }
    return {
        readExactInitialCommit,
        reconcileInitialVisual,
        adoptResidentCanvas,
        handlePageCanvasMounted,
        handlePageRasterFailed,
        setPendingReadyToken: (token: number | null) => {
            pendingReadyToken = token;
        },
    };
};
