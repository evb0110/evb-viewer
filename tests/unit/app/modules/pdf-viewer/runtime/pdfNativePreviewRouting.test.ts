import { requireDocumentRef } from '@contracts/documentRef';
import { requirePageNumber } from '@contracts/pageNumbers';
import { requireEpochMs } from '@contracts/timestamps';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES,
    isPathPdfSource,
    shouldDeferNativePdfOpeningSkeleton,
    shouldStageNativePdfOpeningPreview,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfNativePreviewRouting';

describe('pdfNativePreviewRouting', () => {
    it('recognizes path-backed PDF source objects', () => {
        expect(isPathPdfSource({
            kind: 'path',
            path: requireDocumentRef('/tmp/a.pdf'),
            size: 1,
        })).toBe(true);

        expect(isPathPdfSource(new Blob([Uint8Array.of(1)]))).toBe(false);
        expect(isPathPdfSource(null)).toBe(false);
    });

    it('stages a sub-threshold page-heavy non-linearized PDF without changing its final viewer route', () => {
        const source = {
            kind: 'path' as const,
            path: requireDocumentRef('/tmp/dictionary.pdf'),
            size: 170_496_793,
        };
        const openingGeometry = {
            pageNumber: requirePageNumber(1),
            pageCount: 1_859,
            width: 612,
            height: 792,
            rotation: 0 as const,
            size: source.size,
            modifiedAt: requireEpochMs(1_724_000_000_000),
            linearized: false,
        };

        expect(shouldStageNativePdfOpeningPreview(source, openingGeometry)).toBe(true);
        expect(shouldStageNativePdfOpeningPreview(source, {
            ...openingGeometry,
            linearized: true,
        })).toBe(false);
        expect(shouldStageNativePdfOpeningPreview(source, {
            ...openingGeometry,
            pageCount: 999,
        })).toBe(false);
    });

    it('stages an opening raster for an oversized PDF without changing the final PDF.js viewer', () => {
        const source = {
            kind: 'path' as const,
            path: requireDocumentRef('/tmp/native-dictionary.pdf'),
            size: 722_049_367,
        };
        const openingGeometry = {
            pageNumber: requirePageNumber(1),
            pageCount: 882,
            width: 612,
            height: 792,
            rotation: 0 as const,
            size: source.size,
            modifiedAt: requireEpochMs(1_776_000_000_000),
            linearized: false,
        };

        expect(source.size).toBeGreaterThan(PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES);
        expect(shouldStageNativePdfOpeningPreview(source, openingGeometry)).toBe(true);
        expect(shouldStageNativePdfOpeningPreview(source, {
            ...openingGeometry,
            linearized: true,
        })).toBe(true);

        const atThreshold = {
            ...source,
            size: PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES,
        };
        expect(shouldStageNativePdfOpeningPreview(atThreshold, {
            ...openingGeometry,
            linearized: true,
            size: atThreshold.size,
        })).toBe(true);

        const belowThreshold = {
            ...source,
            size: PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES - 1,
        };
        expect(shouldStageNativePdfOpeningPreview(belowThreshold, {
            ...openingGeometry,
            linearized: true,
            size: belowThreshold.size,
        })).toBe(false);
    });

    it('defers the PDF.js opening surface until an oversized native open is ready', () => {
        const input = {
            documentId: '/tmp/native-dictionary.pdf',
            geometry: { size: PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES },
            isOpening: true,
            rendererKind: 'pdfjs',
            sourceKind: 'pdf',
        };

        expect(shouldDeferNativePdfOpeningSkeleton(input)).toBe(true);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            isOpening: false,
        })).toBe(false);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            rendererKind: 'native-pdf',
        })).toBe(false);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            sourceKind: 'djvu',
        })).toBe(false);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            documentId: 'browser://documents/native-dictionary.pdf',
        })).toBe(false);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            geometry: { size: PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES - 1 },
        })).toBe(false);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            geometry: null,
        })).toBe(false);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            geometry: null,
            declaredSize: PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES,
        })).toBe(true);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            geometry: null,
            declaredSize: PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES - 1,
        })).toBe(false);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            geometry: null,
            source: new Blob(['%PDF-1.7']),
        })).toBe(false);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            documentId: null,
            geometry: null,
            source: {
                kind: 'path' as const,
                path: requireDocumentRef('/tmp/native-dictionary.pdf'),
                size: PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES,
            },
        })).toBe(true);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            documentId: null,
            geometry: null,
            source: {
                kind: 'path' as const,
                path: requireDocumentRef('browser://documents/native-dictionary.pdf'),
                size: PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES,
            },
        })).toBe(false);
    });

    it('uses the open-surface native preview state as the visibility authority', () => {
        const input = {
            documentId: '/tmp/native-dictionary.pdf',
            geometry: { size: PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES },
            isOpening: true,
            nativeOpeningPreviewState: 'inactive' as const,
            rendererKind: 'pdfjs',
            sourceKind: 'pdf',
        };

        expect(shouldDeferNativePdfOpeningSkeleton(input)).toBe(true);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            nativeOpeningPreviewState: 'loading',
        })).toBe(true);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            nativeOpeningPreviewState: 'settled',
        })).toBe(true);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            nativeOpeningPreviewState: 'failed',
        })).toBe(false);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            nativeOpeningPreviewStaged: true,
            nativeOpeningPreviewState: 'loading',
        })).toBe(true);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            nativeOpeningPreviewStaged: true,
            nativeOpeningPreviewState: 'settled',
        })).toBe(true);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            nativeOpeningPreviewStaged: true,
            nativeOpeningPreviewState: 'inactive',
        })).toBe(false);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            nativeOpeningPreviewStaged: false,
            nativeOpeningPreviewState: 'loading',
        })).toBe(false);
        expect(shouldDeferNativePdfOpeningSkeleton({
            ...input,
            nativeOpeningPreviewStaged: false,
            nativeOpeningPreviewState: 'settled',
        })).toBe(false);
    });

    it('keeps a sub-threshold non-linearized page-heavy open deferred until staging settles', () => {
        const source = {
            kind: 'path' as const,
            path: requireDocumentRef('/tmp/page-heavy.pdf'),
            size: 170_496_793,
        };
        expect(shouldDeferNativePdfOpeningSkeleton({
            documentId: source.path,
            geometry: {
                pageCount: 1_859,
                linearized: false,
                size: source.size,
            },
            isOpening: true,
            nativeOpeningPreviewState: 'inactive',
            rendererKind: 'pdfjs',
            source,
            sourceKind: 'pdf',
        })).toBe(true);
    });
});
