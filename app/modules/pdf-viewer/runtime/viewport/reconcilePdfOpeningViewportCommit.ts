import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type {
    IDocumentOpenSurfaceRenderFence,
    IDocumentOpenSurfaceSession,
} from '@app/modules/document-viewer/public';
import type { IPdfViewportIntent } from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';

export type TPdfOpeningViewportRejectionReason =
    | 'requested-page-mismatch'
    | 'surface-not-opening'
    | 'active-current-intent'
    | 'stale-intent-retirement-race'
    | 'viewport-commit-rejected';

interface IPdfOpeningViewportReconcileOptions {
    activeIntent: Readonly<Pick<IPdfViewportIntent, 'documentRevision' | 'id' | 'kind'>> | null;
    applyReloadViewport(pageNumber: TPageNumber): boolean;
    commitCurrentViewportIfSettled(pageNumber: TPageNumber): boolean;
    currentDocumentRevision: number;
    surface: IDocumentOpenSurfaceSession;
    suspendActiveIntent(): void;
}

function suspendStalePdfViewportIntent(
    activeIntent: Readonly<Pick<IPdfViewportIntent, 'documentRevision'>> | null,
    currentDocumentRevision: number,
    suspendActiveIntent: () => void,
) {
    if (activeIntent === null || activeIntent.documentRevision === currentDocumentRevision) {
        return false;
    }
    suspendActiveIntent();
    return true;
}

function resolvePdfOpeningViewportCommit(
    surface: IDocumentOpenSurfaceSession,
    activeIntent: Readonly<Pick<IPdfViewportIntent, 'documentRevision'>> | null,
    currentDocumentRevision: number,
    suspendActiveIntent: () => void,
): IDocumentOpenSurfaceRenderFence | null {
    const openingSnapshot = surface.snapshot.value;
    const committedRender = openingSnapshot.committedRender;
    if (
        !committedRender
        || openingSnapshot.committedViewport
        || surface.viewportSession.value.requestedPage !== committedRender.pageNumber
    ) {
        return null;
    }
    if (activeIntent === null) {
        return committedRender;
    }
    if (surface.viewportSession.value.lifecycle !== 'opening') {
        return null;
    }

    if (!suspendStalePdfViewportIntent(activeIntent, currentDocumentRevision, suspendActiveIntent)) {
        return null;
    }
    const currentSnapshot = surface.snapshot.value;
    if (
        currentSnapshot.generation !== openingSnapshot.generation
        || currentSnapshot.identity?.documentRevision !== openingSnapshot.identity?.documentRevision
        || currentSnapshot.committedRender !== committedRender
        || currentSnapshot.committedViewport
        || surface.viewportSession.value.requestedPage !== committedRender.pageNumber
    ) {
        return null;
    }
    return committedRender;
}

export function reconcilePdfOpeningViewportCommit(
    options: IPdfOpeningViewportReconcileOptions,
    observeRejection: (reason: TPdfOpeningViewportRejectionReason | null) => void,
): IDocumentOpenSurfaceRenderFence | null {
    const snapshot = options.surface.snapshot.value;
    const viewport = options.surface.viewportSession.value;
    if (!snapshot.committedRender || snapshot.committedViewport) {
        observeRejection(null);
        return null;
    }
    const committedRender = resolvePdfOpeningViewportCommit(
        options.surface,
        options.activeIntent,
        options.currentDocumentRevision,
        options.suspendActiveIntent,
    );
    if (!committedRender) {
        observeRejection(viewport.lifecycle === 'opening'
            ? resolveOpeningViewportRejectionReason(options)
            : null);
        return null;
    }
    const pageNumber = requirePageNumber(committedRender.pageNumber);
    const observedCommit = options.commitCurrentViewportIfSettled(pageNumber);
    const reloadCommit = !observedCommit && viewport.lifecycle === 'opening'
        ? options.applyReloadViewport(pageNumber)
        : false;
    if (!observedCommit && !reloadCommit) {
        observeRejection(viewport.lifecycle === 'opening' ? 'viewport-commit-rejected' : null);
        return null;
    }
    observeRejection(null);
    return committedRender;
}

function resolveOpeningViewportRejectionReason(
    options: IPdfOpeningViewportReconcileOptions,
): TPdfOpeningViewportRejectionReason {
    const snapshot = options.surface.snapshot.value;
    const viewport = options.surface.viewportSession.value;
    if (viewport.requestedPage !== snapshot.committedRender?.pageNumber) {
        return 'requested-page-mismatch';
    }
    if (viewport.lifecycle !== 'opening') {
        return 'surface-not-opening';
    }
    if (options.activeIntent?.documentRevision === options.currentDocumentRevision) {
        return 'active-current-intent';
    }
    return 'stale-intent-retirement-race';
}
