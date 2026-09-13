import type { TDocumentOpenSurfacePhase } from '@app/modules/document-viewer/public';

interface IShouldApplyPdfOpeningPageFrameInput {
    activeGeneration: number;
    frameGeneration: number | null;
    phase: TDocumentOpenSurfacePhase;
}

export function shouldApplyPdfOpeningPageFrame(input: IShouldApplyPdfOpeningPageFrameInput) {
    return input.frameGeneration === input.activeGeneration
        && (
            input.phase === 'pending'
            || input.phase === 'geometry-committed'
            || input.phase === 'canvas-committed'
            || input.phase === 'viewport-committed'
        );
}
