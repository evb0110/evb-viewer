import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolvePdfPreparedOpeningFitScale } from '@app/modules/pdf-viewer/runtime/lifecycle/resolvePdfPreparedOpeningFitScale';
import type { IDocumentOpenSurfaceSnapshot } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';

function createSnapshot(
    overrides: Partial<IDocumentOpenSurfaceSnapshot> = {},
): IDocumentOpenSurfaceSnapshot {
    return {
        generation: 4,
        identity: null,
        phase: 'geometry-committed',
        presentation: 'page-shell',
        geometry: null,
        openingPageFrame: {
            generation: 4,
            ownerId: 'document-viewer-runtime:1',
            pageNumber: 2,
            intentKey: 'test-intent',
            style: { width: '800px' },
        },
        openingPageGeometry: {
            documentId: 'test-document',
            pageNumber: 2,
            pageCount: 3,
            width: 400,
            height: 600,
            rotation: 0,
        },
        committedRender: null,
        committedViewport: null,
        failure: null,
        ...overrides,
    };
}

describe('resolvePdfPreparedOpeningFitScale', () => {
    it('derives the opening fit scale from the prepared frame and geometry', () => {
        expect(resolvePdfPreparedOpeningFitScale(createSnapshot(), false)).toBe(2);
    });

    it('does not seed custom zoom or a completed opening session', () => {
        expect(resolvePdfPreparedOpeningFitScale(createSnapshot(), true)).toBeNull();
        expect(resolvePdfPreparedOpeningFitScale(createSnapshot({ phase: 'ready' }), false)).toBeNull();
    });

    it('does not feed a renderer-owned cold placeholder frame back into its fit scale', () => {
        const openingPageFrame = {
            ...createSnapshot().openingPageFrame!,
            ownerId: 'pdfjs:1',
            style: {width: '400px'},
        };

        expect(resolvePdfPreparedOpeningFitScale(createSnapshot({openingPageFrame}), false)).toBeNull();
    });

    it('rejects stale frame generations and unusable geometry', () => {
        expect(resolvePdfPreparedOpeningFitScale(createSnapshot({ generation: 5 }), false)).toBeNull();
        const openingPageGeometry = {
            documentId: 'test-document',
            pageNumber: 2,
            pageCount: 3,
            width: 0,
            height: 600,
            rotation: 0,
        };
        const zeroWidthSnapshot = createSnapshot({ openingPageGeometry });
        expect(resolvePdfPreparedOpeningFitScale(zeroWidthSnapshot, false)).toBeNull();
    });
});
