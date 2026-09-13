import {
    describe,
    expect,
    it,
} from 'vitest';
import { shouldApplyPdfOpeningPageFrame } from '@app/modules/pdf-viewer/engine/pdf-initial-surface-placeholder/shouldApplyPdfOpeningPageFrame';
import type { TDocumentOpenSurfacePhase } from '@app/modules/document-viewer/chassis/documentOpenSurfaceSession';

describe('shouldApplyPdfOpeningPageFrame', () => {
    it.each([
        'pending',
        'geometry-committed',
        'canvas-committed',
        'viewport-committed',
    ] satisfies TDocumentOpenSurfacePhase[])('applies the current generation frame during %s', (phase) => {
        expect(shouldApplyPdfOpeningPageFrame({
            activeGeneration: 9,
            frameGeneration: 9,
            phase,
        })).toBe(true);
    });

    it.each([
        'idle',
        'ready',
        'failed',
    ] satisfies TDocumentOpenSurfacePhase[])('releases the opening frame when the lifecycle reaches %s', (phase) => {
        expect(shouldApplyPdfOpeningPageFrame({
            activeGeneration: 9,
            frameGeneration: 9,
            phase,
        })).toBe(false);
    });

    it('rejects frames from another generation', () => {
        expect(shouldApplyPdfOpeningPageFrame({
            activeGeneration: 9,
            frameGeneration: 8,
            phase: 'pending',
        })).toBe(false);
    });
});
