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
        || frame.generation !== snapshot.generation
        || frame.pageNumber !== geometry.pageNumber
        || geometry.width <= 0
    ) {
        return null;
    }

    const preparedWidth = Number.parseFloat(frame.style.width ?? '');
    return Number.isFinite(preparedWidth) && preparedWidth > 0
        ? preparedWidth / geometry.width
        : null;
}
