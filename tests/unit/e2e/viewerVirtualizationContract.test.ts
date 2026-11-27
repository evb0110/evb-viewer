import {describe, expect, it} from 'vitest';
import {
    findMissingVisualFrames,
    findPdfVirtualizationContractViolations,
    PDF_PAGE_TRACK_SELECTOR,
    type IPdfVirtualizationSnapshot,
} from '@tests/e2e/electron/helpers/viewerVirtualizationContract';

function createSnapshot(): IPdfVirtualizationSnapshot {
    return {
        computedGap: 20,
        mountedPages: [
            {
                canvasConnected: true,
                canvasHeight: 792,
                canvasWidth: 612,
                documentTop: 20,
                height: 792,
                pageNumber: 1,
                rendered: true,
                skeletonVisible: false,
                visible: true,
            },
            {
                canvasConnected: true,
                canvasHeight: 792,
                canvasWidth: 612,
                documentTop: 832,
                height: 792,
                pageNumber: 2,
                rendered: true,
                skeletonVisible: false,
                visible: true,
            },
        ],
        paddingBottom: 20,
        paddingTop: 20,
        scrollHeight: 1_644,
        scrollTop: 0,
        totalPages: 2,
        trackDocumentTop: 0,
        trackItems: [
            {
                documentTop: 20,
                height: 792,
                kind: 'page',
                pageNumber: 1,
            },
            {
                documentTop: 832,
                height: 792,
                kind: 'page',
                pageNumber: 2,
            },
        ],
        viewportHeight: 900,
        visiblePages: [],
    };
}

describe('viewer virtualization page-track ownership', () => {
    it('samples the canonical page track instead of the outer scroll viewport', () => {
        expect(PDF_PAGE_TRACK_SELECTOR).toBe('[data-pdf-page-track]');
        expect(PDF_PAGE_TRACK_SELECTOR).not.toContain('.pdfViewer');
    });
});

describe('viewer virtualization E2E contract', () => {
    it('accepts a coherent page-track decomposition and rejects cumulative drift', () => {
        const snapshot = createSnapshot();
        expect(findPdfVirtualizationContractViolations([snapshot])).toEqual([]);

        const drifted = structuredClone(snapshot);
        drifted.trackItems[1]!.documentTop += 8;
        drifted.mountedPages[1]!.documentTop += 8;
        expect(findPdfVirtualizationContractViolations([snapshot, drifted])).toEqual(
            expect.arrayContaining([expect.stringContaining('documentTop'), expect.stringContaining('moved in document coordinates')]),
        );
    });

    it('requires the selected page own the skeleton or committed visual', () => {
        const common = {
            canvasAuthorityReady: false,
            canvasConnected: false,
            canvasPixelHeight: 0,
            canvasPixelWidth: 0,
            pageNumber: 2,
            shellRect: null,
            skeletonSharesShell: false,
        };
        const blankFrame = {
            ...common,
            frame: 1,
            kind: 'blank',
        };
        expect(findMissingVisualFrames([blankFrame])).toEqual([expect.stringContaining('frame 1')]);
        expect(
            findMissingVisualFrames([
                {
                    ...common,
                    frame: 2,
                    kind: 'page-shell',
                    skeletonSharesShell: true,
                },
                {
                    ...common,
                    canvasAuthorityReady: true,
                    canvasConnected: true,
                    canvasPixelHeight: 792,
                    canvasPixelWidth: 612,
                    frame: 3,
                    kind: 'committed-canvas',
                },
            ]),
        ).toEqual([]);
    });
});
