import type { IDocumentOpenSurfaceSnapshot } from '@app/modules/document-viewer/public';

export function resolvePdfPreparedOpeningFitScale(
    snapshot: IDocumentOpenSurfaceSnapshot,
    usesCustomZoom: boolean,
): number | null {
    const frame = snapshot.openingPageFrame;
    const geometry = snapshot.openingPageGeometry;
    const isOpening = snapshot.phase === 'pending'
        || snapshot.phase === 'geometry-committed'
        || snapshot.phase === 'canvas-committed'
        || snapshot.phase === 'viewport-committed';
    if (
        usesCustomZoom
        || !isOpening
        || !frame
        || !geometry
        || !frame.ownerId.startsWith('document-viewer-runtime:')
        || frame.generation !== snapshot.generation
        || frame.pageNumber !== geometry.pageNumber
        || geometry.width <= 0
    ) {
        return null;
    }

    // Only the host-prepared frame is an independent synchronous layout
    // authority. A PDF.js-owned frame is derived from this renderer's current
    // scale; feeding it back here would turn a cold-open scale-1 placeholder
    // into the canonical fit scale once page geometry arrives.
    const preparedWidth = Number.parseFloat(frame.style.width ?? '');
    return Number.isFinite(preparedWidth) && preparedWidth > 0
        ? preparedWidth / geometry.width
        : null;
}
