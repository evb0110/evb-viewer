export interface IViewerInteractionReadinessSnapshot {
    mode: 'chassis' | 'legacy';
    hasPageTrack: boolean;
    openSurfacePhase: string | null;
    openSurfacePresentation: string | null;
    pageTrackDisplay: string;
    pageTrackOpacity: number;
    pageTrackVisibility: string;
    viewportDisplay: string;
    viewportOpacity: number;
    viewportVisibility: string;
}

function isPresented(display: string, visibility: string, opacity: number) {
    return display !== 'none'
        && visibility !== 'hidden'
        && opacity > 0;
}

/**
 * The chassis owns the scrolling viewport; the nested PDF page track is not a
 * legacy `.pdfViewer` element. Interaction is ready only after the chassis has
 * committed its open-surface authority and both viewport layers are presented.
 */
export function isViewerInteractionReady(snapshot: IViewerInteractionReadinessSnapshot) {
    if (
        !snapshot.hasPageTrack
        || !isPresented(
            snapshot.pageTrackDisplay,
            snapshot.pageTrackVisibility,
            snapshot.pageTrackOpacity,
        )
        || !isPresented(
            snapshot.viewportDisplay,
            snapshot.viewportVisibility,
            snapshot.viewportOpacity,
        )
    ) {
        return false;
    }

    return snapshot.mode === 'legacy' || (
        snapshot.openSurfacePhase === 'ready'
        && snapshot.openSurfacePresentation === 'committed'
    );
}
