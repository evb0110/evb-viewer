import {
    describe,
    expect,
    it,
} from 'vitest';
import { isAnchoredCurrentPageSyncSource } from '@app/modules/pdf-viewer/runtime/rerender-strategy/isAnchoredCurrentPageSyncSource';
import { isResizeRerenderSource } from '@app/modules/pdf-viewer/runtime/rerender-strategy/isResizeRerenderSource';
import {
    PDF_RERENDER_SOURCE,
    PDF_RERENDER_SOURCE_VALUES,
    isPdfRerenderSource,
    isZoomRestorePdfRerenderSource,
    normalizePdfRerenderSource,
    shouldUseMinimalPdfRerenderBuffer,
    type TPdfRerenderSource,
} from '@app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocol';

interface IExpectedRerenderPolicy {
    anchored: boolean;
    minimalBuffer: boolean;
    resize: boolean;
    zoomRestore: boolean;
}

const EXPECTED_RERENDER_POLICY = {
    [PDF_RERENDER_SOURCE.DprChange]: {
        anchored: false,
        minimalBuffer: true,
        resize: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.FitHeightCurrentPage]: {
        anchored: false,
        minimalBuffer: true,
        resize: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.FitHeightPagedTarget]: {
        anchored: false,
        minimalBuffer: true,
        resize: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.FitMode]: {
        anchored: false,
        minimalBuffer: true,
        resize: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.FitWidthCurrentPage]: {
        anchored: true,
        minimalBuffer: true,
        resize: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.FitWidthExplicit]: {
        anchored: false,
        minimalBuffer: true,
        resize: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.FitWidthPagedTarget]: {
        anchored: false,
        minimalBuffer: true,
        resize: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.ReRender]: {
        anchored: false,
        minimalBuffer: false,
        resize: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.ResizeObserver]: {
        anchored: true,
        minimalBuffer: false,
        resize: true,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.ResizeSettle]: {
        anchored: true,
        minimalBuffer: false,
        resize: true,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.Unknown]: {
        anchored: false,
        minimalBuffer: false,
        resize: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.ViewMode]: {
        anchored: false,
        minimalBuffer: false,
        resize: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.ViewRotation]: {
        anchored: true,
        minimalBuffer: false,
        resize: true,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.ZoomChange]: {
        anchored: true,
        minimalBuffer: true,
        resize: false,
        zoomRestore: true,
    },
    [PDF_RERENDER_SOURCE.ZoomGestureChange]: {
        anchored: true,
        minimalBuffer: true,
        resize: false,
        zoomRestore: true,
    },
    [PDF_RERENDER_SOURCE.ZoomMode]: {
        anchored: false,
        minimalBuffer: true,
        resize: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.ZoomModeChange]: {
        anchored: true,
        minimalBuffer: true,
        resize: false,
        zoomRestore: true,
    },
} satisfies Record<TPdfRerenderSource, IExpectedRerenderPolicy>;

describe('rerenderStrategy', () => {
    it('keeps all known rerender source policies exhaustive', () => {
        expect(PDF_RERENDER_SOURCE_VALUES).toHaveLength(Object.keys(EXPECTED_RERENDER_POLICY).length);

        for (const source of PDF_RERENDER_SOURCE_VALUES) {
            const expected = EXPECTED_RERENDER_POLICY[source];
            expect(isPdfRerenderSource(source)).toBe(true);
            expect(isResizeRerenderSource(source)).toBe(expected.resize);
            expect(isAnchoredCurrentPageSyncSource(source)).toBe(expected.anchored);
            expect(shouldUseMinimalPdfRerenderBuffer(source)).toBe(expected.minimalBuffer);
            expect(isZoomRestorePdfRerenderSource(source)).toBe(expected.zoomRestore);
        }
    });

    it('normalizes unknown sources to the explicit unknown protocol source', () => {
        expect(isPdfRerenderSource('external-caller')).toBe(false);
        expect(normalizePdfRerenderSource('external-caller')).toBe(PDF_RERENDER_SOURCE.Unknown);
        expect(normalizePdfRerenderSource(undefined, PDF_RERENDER_SOURCE.ReRender)).toBe(PDF_RERENDER_SOURCE.ReRender);
    });
});
