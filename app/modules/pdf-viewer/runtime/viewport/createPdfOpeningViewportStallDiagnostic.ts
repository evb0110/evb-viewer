import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';
import type { TPdfOpeningViewportRejectionReason } from '@app/modules/pdf-viewer/runtime/viewport/reconcilePdfOpeningViewportCommit';
import { BrowserLogger } from '@app/utils/browserLogger';

const OPENING_VIEWPORT_STALL_WARNING_MS = 5_000;

interface IPdfOpeningViewportStallDiagnosticOptions {
    captureCommitDiagnostics(pageNumber: TPageNumber): unknown;
    getActiveIntent(): {
        readonly documentRevision: number;
        readonly id: string;
        readonly kind: string;
        readonly navigation?: unknown;
    } | null;
    getAuthorityPhase(): string;
    getCurrentDocumentRevision(): number;
    getLayoutRevision(): number;
    getSurface(): IDocumentOpenSurfaceSession | null;
}

export function createPdfOpeningViewportStallDiagnostic(
    options: IPdfOpeningViewportStallDiagnosticOptions,
) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reported = false;
    let latestReason: TPdfOpeningViewportRejectionReason | null = null;

    function cancel() {
        if (timer !== null) {
            clearTimeout(timer);
        }
        timer = null;
        reported = false;
        latestReason = null;
    }

    function observe(reason: TPdfOpeningViewportRejectionReason | null) {
        if (reason === null) {
            cancel();
            return;
        }
        latestReason = reason;
        if (timer !== null || reported) {
            return;
        }
        // eslint-disable-next-line custom/no-core-correctness-timers -- This timer only emits diagnostics and never coordinates viewer state.
        timer = setTimeout(() => {
            timer = null;
            const surface = options.getSurface();
            const snapshot = surface?.snapshot.value;
            const viewport = surface?.viewportSession.value;
            if (
                !snapshot?.committedRender
                || snapshot.committedViewport
                || viewport?.lifecycle !== 'opening'
            ) {
                cancel();
                return;
            }
            reported = true;
            const activeIntent = options.getActiveIntent();
            const pageNumber = requirePageNumber(snapshot.committedRender.pageNumber);
            BrowserLogger.warn('pdf-viewer', 'PDF opening viewport reconciliation remained blocked', {
                rejectionReason: latestReason,
                generation: snapshot.generation,
                surfacePhase: snapshot.phase,
                viewportLifecycle: viewport.lifecycle,
                requestedPage: viewport.requestedPage,
                committedRenderPage: snapshot.committedRender.pageNumber,
                committedViewportPage: null,
                activeIntentId: activeIntent?.id ?? null,
                activeIntentKind: activeIntent?.kind ?? null,
                activeIntentHasNavigation: activeIntent?.navigation !== undefined,
                activeIntentDocumentRevision: activeIntent?.documentRevision ?? null,
                authorityPhase: options.getAuthorityPhase(),
                currentDocumentRevision: options.getCurrentDocumentRevision(),
                layoutRevision: options.getLayoutRevision(),
                commit: options.captureCommitDiagnostics(pageNumber),
            });
        }, OPENING_VIEWPORT_STALL_WARNING_MS);
    }

    return {
        cancel,
        observe,
    };
}
